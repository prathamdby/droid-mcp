import * as AiError from "effect/ai/AiError"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import type { Config } from "../config.ts"
import { ToolFailure } from "./failure.ts"
import { toolsFor } from "./index.ts"
import { annotate, annotateWith, policyOf } from "./policy.ts"
import type { ToolPolicy } from "./policy.ts"
import {
  DEFAULT_RESULT_BYTES,
  JsonPointer,
  MAX_RESULT_BYTES,
  MIN_RESULT_BYTES,
  ResultBytes,
  ResultStore,
  bound,
  isJsonObject,
  pointerGet,
  select,
  utf8Slice,
} from "./results.ts"
import type { Bounded, ResultStoreApi } from "./results.ts"

/**
 * The compact profile: a fixed list of 15 tools instead of one per operation.
 * The turn loop keeps its own tools; every other operation is found with
 * tools_search, read with tools_describe, and run with tool_call or batch,
 * through the same handlers, decoding, and autonomy checks the full profile
 * uses. Large results come back bounded, with result_read for the rest.
 */

/** Operations that stay first-class tools, because every turn uses them. */
export const DIRECT_TOOLS: ReadonlyArray<string> = [
  "server_info",
  "session_create",
  "session_stream",
  "session_events",
  "session_interrupt",
  "session_close",
  "session_list",
  "session_respond_permission",
  "session_answer_question",
  "session_pick_options",
]

export const MAX_BATCH_STEPS = 20

const DEFAULT_BATCH_BYTES = 2 * DEFAULT_RESULT_BYTES

const SEARCH_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 15
const DESCRIBE_LIMIT = 20
const SUMMARY_CHARS = 140

const FAMILIES = ["server", "session", "rest", "context", "daemon", "droid"] as const

const Arguments = Schema.Record(Schema.String, Schema.Json).annotate({
  description: "The operation's arguments, as tools_describe shows its inputSchema.",
})

const OperationName = Schema.String.annotate({
  description: "An operation name from tools_search, such as daemon_list_models.",
})

const PolicySchema = Schema.Struct({
  readOnly: Schema.Boolean,
  destructive: Schema.Boolean,
  idempotent: Schema.Boolean,
  openWorld: Schema.Boolean,
})

const BoundedSchema = Schema.Struct({
  result: Schema.optional(Schema.Json),
  truncated: Schema.optional(Schema.Literal(true)),
  ref: Schema.optional(Schema.String),
  totalBytes: Schema.optional(Schema.Int),
  preview: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
})

const strict = <T extends Tool.Any>(tool: T): T =>
  // SAFETY: `annotate` returns a clone of the same tool.
  tool.annotate(Tool.Strict, true) as T

const Search = Tool.make("tools_search", {
  description:
    "Find operations by keyword among every Droid operation: local sessions, the daemon " +
    "(daemon_*, droid_*), hosted REST (rest_*), and Context (context_*). Returns names, " +
    "one-line summaries, and hints; call tools_describe for a schema, tool_call to run one.",
  parameters: Schema.Struct({
    query: Schema.optional(Schema.String).annotate({
      description: "Words to match in names and descriptions; omit to list in catalog order.",
    }),
    family: Schema.optional(Schema.Literals(FAMILIES)),
    readOnly: Schema.optional(Schema.Boolean).annotate({
      description: "true for reads only, false for writes only.",
    }),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_LIMIT })),
    ),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  success: Schema.Struct({
    total: Schema.Int,
    nextOffset: Schema.optional(Schema.Int),
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        summary: Schema.String,
        readOnly: Schema.Boolean,
        destructive: Schema.Boolean,
      }),
    ),
  }),
  failure: ToolFailure,
})

const Describe = Tool.make("tools_describe", {
  description:
    "Full description, input schema, and hints for up to 20 operations, before calling them " +
    "with tool_call or batch.",
  parameters: Schema.Struct({
    names: Schema.Array(OperationName).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(DESCRIBE_LIMIT),
    ),
  }),
  success: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        inputSchema: Schema.Json,
        policy: PolicySchema,
      }),
    ),
    unknown: Schema.Array(Schema.String),
  }),
  failure: ToolFailure,
})

const Call = Tool.make("tool_call", {
  description:
    "Run one operation by name with its arguments, exactly as its own tool would run in the " +
    "full profile: same validation, autonomy cap, and failure { code, message }. Returns " +
    "{ result }, or a preview and ref for result_read when the result exceeds maxBytes. " +
    "Confirm with the user before an operation whose hints say destructive.",
  parameters: Schema.Struct({
    name: OperationName,
    arguments: Schema.optional(Arguments),
    select: Schema.optional(JsonPointer),
    maxBytes: Schema.optional(ResultBytes),
  }),
  success: BoundedSchema,
  failure: ToolFailure,
})

const BatchStep = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({
    description: "Name later steps use to reference this step's result; defaults to its index.",
  }),
  name: OperationName,
  arguments: Schema.optional(Arguments),
  select: Schema.optional(JsonPointer),
})

const Batch = Tool.make("batch", {
  description:
    "Run up to 20 operations in order in one call. An argument value " +
    '{ "$from": "<step id>", "path": "<JSON Pointer>" } is replaced by that part of an earlier ' +
    "step's full result, so intermediate results never need to come back. Stops at the first " +
    "failure unless stopOnError is false. Not a transaction: completed steps stay done.",
  parameters: Schema.Struct({
    steps: Schema.Array(BatchStep).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_BATCH_STEPS),
    ),
    stopOnError: Schema.optional(Schema.Boolean),
    maxBytes: Schema.optional(ResultBytes),
  }),
  success: Schema.Struct({
    completed: Schema.Int,
    failed: Schema.Int,
    skipped: Schema.Int,
    steps: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        status: Schema.Literals(["ok", "failed", "skipped"]),
        error: Schema.optional(ToolFailure),
        ...BoundedSchema.fields,
      }),
    ),
  }),
  failure: ToolFailure,
})

const Read = Tool.make("result_read", {
  description:
    "Read a stored result from tool_call or batch: a byte range of its JSON text from offset, " +
    "or the part a select pointer names. Refs expire 15 minutes after last use.",
  parameters: Schema.Struct({
    ref: Schema.String,
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    length: Schema.optional(ResultBytes),
    select: Schema.optional(JsonPointer),
  }),
  success: Schema.Struct({
    ref: Schema.String,
    totalBytes: Schema.Int,
    offset: Schema.optional(Schema.Int),
    nextOffset: Schema.optional(Schema.Int),
    chunk: Schema.optional(Schema.String),
    selected: Schema.optional(BoundedSchema),
  }),
  failure: ToolFailure,
})

/** Running arbitrary operations is a write that may reach anywhere. */
const DISPATCH_POLICY: ToolPolicy = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true,
}

export const META_TOOLS: ReadonlyArray<Tool.Any> = [
  strict(annotate(Search)),
  strict(annotate(Describe)),
  strict(annotateWith(Call, DISPATCH_POLICY)),
  strict(annotateWith(Batch, DISPATCH_POLICY)),
  strict(annotate(Read)),
]

interface SearchResult {
  readonly total: number
  nextOffset?: number
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly summary: string
    readonly readOnly: boolean
    readonly destructive: boolean
  }>
}

interface Page {
  readonly ref: string
  readonly totalBytes: number
  readonly offset: number
  nextOffset?: number
  readonly chunk: string
}

interface CatalogEntry {
  readonly name: string
  readonly description: string
  readonly family: string
  readonly policy: ToolPolicy
  readonly words: string
  readonly tool: Tool.Any
}

const catalogOf = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<CatalogEntry> =>
  tools.map((tool) => {
    const description = Tool.getDescription(tool) ?? ""

    return {
      name: tool.name,
      description,
      family: tool.name.slice(0, tool.name.indexOf("_")),
      policy: policyOf(tool.name, description),
      words: (tool.name.replaceAll("_", " ") + " " + description).toLowerCase(),
      tool,
    }
  })

const summaryOf = (description: string): string => {
  const end = description.indexOf(". ")
  const sentence = end === -1 ? description : description.slice(0, end + 1)

  return sentence.length <= SUMMARY_CHARS ? sentence : sentence.slice(0, SUMMARY_CHARS - 1) + "…"
}

const tokensOf = (query: string): ReadonlyArray<string> =>
  query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)

/** A name hit counts three times a description hit; every token must hit somewhere. */
const scoreOf = (entry: CatalogEntry, tokens: ReadonlyArray<string>): number => {
  let score = 0

  for (const token of tokens) {
    if (entry.name.includes(token)) score += 3
    else if (entry.words.includes(token)) score += 1
    else return 0
  }

  return score
}

export type Outcome =
  | { readonly ok: true; readonly value: Schema.Json | undefined }
  | { readonly ok: false; readonly failure: ToolFailure }

/** Maps a dispatch error onto the `{ code, message }` contract. */
const failureOfAi = (error: AiError.AiError): ToolFailure =>
  Match.value(error.reason).pipe(
    Match.tag("ToolParameterValidationError", (reason): ToolFailure => ({
      code: "invalid_arguments",
      message: "Invalid parameters for tool '" + reason.toolName + "': " + reason.description,
    })),
    Match.tag("ToolNotFoundError", (reason): ToolFailure => ({
      code: "unknown_tool",
      message: "no operation named " + reason.toolName + "; find one with tools_search",
    })),
    Match.orElse((reason): ToolFailure => ({ code: "internal_error", message: reason.message })),
  )

const UNEXPECTED: ToolFailure = {
  code: "internal_error",
  message: "the operation failed unexpectedly",
}

const decodeFailure = Schema.decodeUnknownOption(ToolFailure)

/**
 * Handlers fail with a ToolFailure, and the toolkit with an AiError, but the
 * widened toolkit types cannot say which, so this checks at runtime.
 */
const failureOf = (error: AiError.AiError | ToolFailure): ToolFailure =>
  AiError.isAiError(error)
    ? failureOfAi(error)
    : Option.getOrElse(decodeFailure(error), () => UNEXPECTED)

const DECODE_OPTIONS = { onExcessProperty: "ignore", errors: "all" } as const

const decodeJson = Schema.decodeUnknownSync(Schema.Json)

/** Plain JSON from its text: members the encoder left `undefined` are gone. */
const parseJson = (text: string | undefined): Schema.Json | undefined =>
  text === undefined ? undefined : decodeJson(JSON.parse(text))

const FromReference = Schema.Struct({ $from: Schema.String, path: Schema.optional(Schema.String) })

const isFromReference = Schema.is(FromReference)

const isReference = (value: Schema.Json): value is Schema.Json & typeof FromReference.Type =>
  isFromReference(value) && Object.keys(value).every((key) => key === "$from" || key === "path")

/** Replaces every `{ $from, path }` with the part of an earlier step's result it names. */
const resolveReferences = (
  value: Schema.Json,
  results: ReadonlyMap<string, Schema.Json | undefined>,
): Schema.Json => {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, results))

  if (!isJsonObject(value)) return value

  if (isReference(value)) {
    const source = results.get(value.$from)
    const found = source === undefined ? undefined : pointerGet(source, value.path ?? "")

    if (found === undefined) {
      throw new ReferenceProblem(
        "$from " + value.$from + (value.path ?? "") + " does not name an earlier result",
      )
    }

    return found
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveReferences(item, results)]),
  )
}

class ReferenceProblem extends Error {}

const describeEntry = (entry: CatalogEntry) => ({
  name: entry.name,
  description: entry.description,
  // SAFETY: a JSON Schema document is JSON by construction.
  inputSchema: Tool.getJsonSchema(entry.tool) as Schema.Json,
  policy: entry.policy,
})

/**
 * The compact toolkit and its handlers. Dispatch goes through the full
 * toolkit's own `handle`, so every operation decodes, validates, and runs
 * exactly as it does when it is a tool of its own.
 */
export const compactSurface = (config: Config) => {
  const full = toolsFor(config, {
    profile: "compact",
    toolCount: DIRECT_TOOLS.length + META_TOOLS.length,
  })

  const direct = full.tools.filter((tool) => DIRECT_TOOLS.includes(tool.name))
  const tools: Array<Tool.Any> = [...direct, ...META_TOOLS]
  const catalog = catalogOf(full.tools)
  const byName = new Map(catalog.map((entry) => [entry.name, entry]))

  // SAFETY: as in `toolsFor`, the widened key type lets one layer serve a runtime list.
  const toolkit = Toolkit.make(...tools) as Toolkit.Toolkit<Record<string, Tool.Any>>

  const directHandlers = Object.fromEntries(
    Object.entries(full.handlerRecord).filter(([name]) => DIRECT_TOOLS.includes(name)),
  )

  const build = Effect.gen(function* () {
    const operations = yield* full.toolkit
    const store: ResultStoreApi = yield* ResultStore

    // SAFETY: the widened toolkit types parameters per tool and the handler
    // decodes them; each handler's services were captured when its layer was built.
    const invoke = (name: string, args: Schema.Json): Effect.Effect<Outcome> =>
      operations.handle(name, args as never, undefined, DECODE_OPTIONS).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.map((last): Outcome =>
          Option.match(last, {
            onNone: () => ({ ok: true, value: undefined }),
            onSome: (output) =>
              output.isFailure
                ? {
                    ok: false,
                    failure: AiError.isAiError(output.result)
                      ? failureOfAi(output.result)
                      : Option.getOrElse(decodeFailure(output.result), () => UNEXPECTED),
                  }
                : { ok: true, value: parseJson(JSON.stringify(output.encodedResult)) },
          }),
        ),
        Effect.catch((error) => Effect.succeed<Outcome>({ ok: false, failure: failureOf(error) })),
      ) as Effect.Effect<Outcome>

    const known = (name: string): Effect.Effect<void, ToolFailure> =>
      byName.has(name)
        ? Effect.void
        : Effect.fail({
            code: "unknown_tool",
            message: "no operation named " + name + "; find one with tools_search",
          })

    const deliver = (
      value: Schema.Json | undefined,
      pointer: string | undefined,
      maxBytes: number,
    ): Effect.Effect<Bounded, ToolFailure> =>
      Effect.flatMap(select(value, pointer), (selected) => bound(store, selected, maxBytes))

    const meta = {
      tools_search: (params: {
        readonly query?: string
        readonly family?: string
        readonly readOnly?: boolean
        readonly limit?: number
        readonly offset?: number
      }) =>
        Effect.sync(() => {
          const tokens = tokensOf(params.query ?? "")

          const matches = catalog
            .filter((entry) => params.family === undefined || entry.family === params.family)
            .filter(
              (entry) => params.readOnly === undefined || entry.policy.readOnly === params.readOnly,
            )
            .map((entry) => ({ entry, score: tokens.length === 0 ? 1 : scoreOf(entry, tokens) }))
            .filter((match) => match.score > 0)
            .sort((left, right) => right.score - left.score)

          const offset = params.offset ?? 0
          const limit = params.limit ?? DEFAULT_SEARCH_LIMIT
          const page = matches.slice(offset, offset + limit)
          const next = offset + page.length

          const found: SearchResult = {
            total: matches.length,
            tools: page.map(({ entry }) => ({
              name: entry.name,
              summary: summaryOf(entry.description),
              readOnly: entry.policy.readOnly,
              destructive: entry.policy.destructive,
            })),
          }

          if (next < matches.length) found.nextOffset = next

          return found
        }),
      tools_describe: (params: { readonly names: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          const found: Array<ReturnType<typeof describeEntry>> = []
          const unknown: Array<string> = []

          for (const name of params.names) {
            const entry = byName.get(name)

            if (entry === undefined) unknown.push(name)
            else found.push(describeEntry(entry))
          }

          return { tools: found, unknown }
        }),
      tool_call: (params: {
        readonly name: string
        readonly arguments?: Readonly<Record<string, Schema.Json>>
        readonly select?: string
        readonly maxBytes?: number
      }) =>
        Effect.gen(function* () {
          yield* known(params.name)

          const outcome = yield* invoke(params.name, params.arguments ?? {})

          if (!outcome.ok) return yield* Effect.fail(outcome.failure)

          return yield* deliver(
            outcome.value,
            params.select,
            params.maxBytes ?? DEFAULT_RESULT_BYTES,
          )
        }),
      batch: (params: {
        readonly steps: ReadonlyArray<{
          readonly id?: string
          readonly name: string
          readonly arguments?: Readonly<Record<string, Schema.Json>>
          readonly select?: string
        }>
        readonly stopOnError?: boolean
        readonly maxBytes?: number
      }) =>
        Effect.gen(function* () {
          const ids = params.steps.map((step, index) => step.id ?? String(index))

          if (new Set(ids).size !== ids.length) {
            return yield* Effect.fail({
              code: "invalid_arguments",
              message: "step ids must be unique",
            })
          }

          const stopOnError = params.stopOnError ?? true

          const perStep = Math.min(
            MAX_RESULT_BYTES,
            Math.max(
              MIN_RESULT_BYTES,
              Math.floor((params.maxBytes ?? DEFAULT_BATCH_BYTES) / params.steps.length),
            ),
          )

          const results = new Map<string, Schema.Json | undefined>()

          const steps: Array<
            {
              readonly id: string
              readonly name: string
              readonly status: "ok" | "failed" | "skipped"
              readonly error?: ToolFailure
            } & Partial<Bounded>
          > = []

          let stopped = false

          for (const [index, step] of params.steps.entries()) {
            const id = ids[index] ?? String(index)

            if (stopped) {
              steps.push({ id, name: step.name, status: "skipped" })
              continue
            }

            const outcome = yield* Effect.gen(function* () {
              yield* known(step.name)

              const args = yield* Effect.try({
                try: () => resolveReferences(step.arguments ?? {}, results),
                catch: (error): ToolFailure => ({
                  code: "invalid_reference",
                  message:
                    error instanceof ReferenceProblem ? error.message : "bad $from reference",
                }),
              })

              const done = yield* invoke(step.name, args)

              if (!done.ok) return yield* Effect.fail(done.failure)

              results.set(id, done.value)

              return yield* deliver(done.value, step.select, perStep)
            }).pipe(Effect.result)

            if (Result.isSuccess(outcome)) {
              steps.push({ id, name: step.name, status: "ok", ...outcome.success })
            } else {
              steps.push({ id, name: step.name, status: "failed", error: outcome.failure })
              stopped = stopOnError
            }
          }

          return {
            completed: steps.filter((step) => step.status === "ok").length,
            failed: steps.filter((step) => step.status === "failed").length,
            skipped: steps.filter((step) => step.status === "skipped").length,
            steps,
          }
        }),
      result_read: (params: {
        readonly ref: string
        readonly offset?: number
        readonly length?: number
        readonly select?: string
      }) =>
        Effect.gen(function* () {
          const stored = yield* store.get(params.ref)
          const length = params.length ?? DEFAULT_RESULT_BYTES

          if (params.select !== undefined) {
            const value = parseJson(stored.text)
            const selected = yield* deliver(value, params.select, length)

            return { ref: params.ref, totalBytes: stored.bytes, selected }
          }

          const offset = params.offset ?? 0
          const chunk = utf8Slice(stored.text, offset, length)
          const next = offset + Buffer.byteLength(chunk, "utf8")

          const page: Page = { ref: params.ref, totalBytes: stored.bytes, offset, chunk }

          if (next < stored.bytes) page.nextOffset = next

          return page
        }),
    }

    return { ...directHandlers, ...meta }
  })

  // SAFETY: the record covers every tool in the compact toolkit; the widened
  // key type cannot express each tool's parameter schema.
  const handlers = toolkit
    .toLayer(build as Parameters<typeof toolkit.toLayer>[0])
    .pipe(Layer.provide(full.handlers))

  return { toolkit, handlers, count: tools.length, operations: full.count }
}

/** The toolkit and handlers the configured profile advertises. */
export const surfaceFor = (config: Config) => {
  if (config.toolProfile === "full") {
    const full = toolsFor(config)

    return {
      toolkit: full.toolkit,
      handlers: full.handlers,
      count: full.count,
      operations: full.count,
    }
  }

  return compactSurface(config)
}
