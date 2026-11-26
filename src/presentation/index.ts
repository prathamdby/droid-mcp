/**
 * Level 7 `presentation`: compact and full views, discovery, aliases,
 * ranking, sequential batch and recovery after completion.
 *
 * A `View` is assembled strictly from an installed `OperationRoster` —
 * nothing that is not installed is ever advertised, and every count is
 * derived dynamically from the assembled view. The compact profile publishes
 * the intersection of the roster with the direct names plus the five
 * dispatch operations (`tools_search`, `tools_describe`, `tool_call`,
 * `batch`, `result_read`); the full profile publishes every installed
 * operation directly and no dispatch operation at all. There is never a
 * full toolkit beneath compact: undiscovered names are not direct handles,
 * but discovery, describe and dispatch reach exactly the same installed
 * catalog.
 *
 * Invariants:
 * - Direct and discovered calls enter the exact same bound operation through
 *   `Capabilities.invoke`; aliases resolve to canonical ids before dispatch.
 * - `call` and `batch` never read a description for policy, annotations,
 *   prerequisites, target demands or grants (Structural Proof 2).
 * - `Presented` distinguishes `Inline`, `Continuation` and
 *   `CompletedUnpresentable` results. A selection failure after completion
 *   is not an execution failure: the operation already ran exactly once,
 *   and the full safe result is recoverable through the ref.
 * - `batch` is ordered and nontransactional: `$from` reads the full safe
 *   earlier result, never its preview or selected part; `stopOnError`
 *   defaults to true.
 * - `continueResult` delegates paging and selection to `artifacts`, scoped
 *   strictly to `who.caller`; a foreign caller gets the same refusal as a
 *   missing ref.
 *
 * The `daemon-operations`, `hosted-factory` and `prem-context` edges are
 * type-only, so omitted providers contribute zero runtime code.
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { Artifacts, Delivery, parseArtifactRef } from "../artifacts/index.ts"
import type { ArtifactRef } from "../artifacts/index.ts"
import { Capabilities } from "../capabilities/index.ts"
import type {
  BoundOperation,
  Catalog,
  Invocation,
  OperationFamily,
  OperationId,
} from "../capabilities/index.ts"
// Type-only edges to the optional providers. These imports are erased at
// compile time; they exist so the boundary checker sees the declared edges
// and so omitted providers never load runtime code.
import type {} from "../daemon-operations/index.ts"
import type {} from "../hosted-factory/index.ts"
import type {} from "../prem-context/index.ts"
import { ReferenceProblem, containsReference, isReferenceObject } from "./private/refs.ts"
import { indexOf, scoreOf, tokensOf } from "./private/search.ts"
import type { SearchEntry } from "./private/search.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Operations that stay first-class tools, because every turn uses them. */
export const DEFAULT_DIRECT_NAMES: ReadonlyArray<OperationId> = [
  "server_info",
  "skill_read",
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

/** The compact dispatch operations, in advertisement order. */
export const COMPACT_DISPATCH_NAMES: ReadonlyArray<OperationId> = [
  "tools_search",
  "tools_describe",
  "tool_call",
  "batch",
  "result_read",
]

export const SEARCH_LIMIT_MAX = 50
export const SEARCH_LIMIT_DEFAULT = 15
export const DESCRIBE_NAMES_MAX = 20
export const BATCH_STEPS_MAX = 20
export const DEFAULT_MAX_INLINE_BYTES = 16_384
export const MIN_MAX_INLINE_BYTES = 1_024
export const MAX_MAX_INLINE_BYTES = 262_144

const SUMMARY_CHARS = 140

// ---------------------------------------------------------------------------
// Roster and view assembly
// ---------------------------------------------------------------------------

const rosterBrand: unique symbol = Symbol("droid-mcp-v2/presentation/OperationRoster")
const viewBrand: unique symbol = Symbol("droid-mcp-v2/presentation/View")

/** The structural facts of one installed operation, captured at assembly. */
export interface OperationSnapshot {
  readonly id: OperationId
  readonly aliases: ReadonlyArray<OperationId>
  readonly family: OperationFamily
  readonly description: string
  readonly inputSchema: { readonly [key: string]: Schema.Json }
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
  readonly effect: string
  readonly replay: string
  readonly requiresGuidance: boolean
}

/**
 * An immutable snapshot of installed operations: the catalog of bound
 * entries plus the structural facts of each. Optional providers contribute
 * entries or they contribute nothing; an omitted provider contributes zero
 * runtime code and zero inventory entries.
 */
export interface OperationRoster {
  readonly [rosterBrand]: true
  readonly catalog: Catalog
  readonly descriptions: ReadonlyArray<OperationSnapshot>
}

/**
 * Builds a roster from a catalog and the exact entries it was assembled
 * from. Snapshots are derived from each operation's structural facts — the
 * same facts the binder enforces — so discovery can never drift from what
 * invocation enforces.
 */
export const buildRoster = (
  catalog: Catalog,
  entries: ReadonlyArray<BoundOperation>,
): OperationRoster => ({
  [rosterBrand]: true,
  catalog,
  descriptions: entries.map((entry) => ({
    id: entry.facts.id,
    aliases: entry.facts.aliases ?? [],
    family: entry.facts.family,
    description: entry.facts.description,
    inputSchema: entry.facts.inputSchema,
    annotations: entry.facts.annotations,
    effect: entry.facts.effect,
    replay: entry.facts.replay,
    requiresGuidance: entry.facts.prerequisite !== undefined,
  })),
})

export interface ViewOptions {
  readonly roster: OperationRoster
  readonly profile: "compact" | "full"
  readonly directNames?: ReadonlyArray<OperationId>
  readonly aliases?: Readonly<Record<string, OperationId>>
  readonly unservedHints?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly maxInlineBytes?: number
  readonly serverName?: string
}

/**
 * An immutable presentation view. Compact advertises only the installed
 * intersection of `directNames` plus the five dispatch tools; full
 * advertises every installed operation. All counts are derived dynamically
 * at assembly — never hand-maintained.
 */
export interface View {
  readonly [viewBrand]: true
  readonly roster: OperationRoster
  readonly profile: "compact" | "full"
  readonly serverName: string
  readonly maxInlineBytes: number
  readonly directNames: ReadonlyArray<OperationId>
  readonly advertisedNames: ReadonlyArray<OperationId>
  readonly toolCount: number
  readonly operationCount: number
  readonly familyCounts: Readonly<Record<OperationFamily, number>>
  readonly providerKinds: ReadonlyArray<string>
}

interface ViewBody extends View {
  readonly aliasMap: ReadonlyMap<string, OperationId>
  readonly unserved: ReadonlyMap<string, ReadonlyArray<string>>
  readonly index: ReadonlyMap<OperationId, SearchEntry<OperationSnapshot>>
  readonly rosterOrder: ReadonlyArray<OperationId>
}

const readView = (view: View): ViewBody =>
  // SAFETY: the brand is module-private, so every `View` in existence was
  // constructed by `createView` below with exactly this body.
  view as ViewBody

const clampInlineBytes = (maxInlineBytes: number | undefined): number => {
  if (maxInlineBytes === undefined) return DEFAULT_MAX_INLINE_BYTES

  return Math.min(MAX_MAX_INLINE_BYTES, Math.max(MIN_MAX_INLINE_BYTES, Math.floor(maxInlineBytes)))
}

/**
 * Assembles a view strictly from the installed roster. `directNames` is
 * intersected with what is actually installed: omitting a provider
 * automatically adjusts the advertisement, the counts and the family
 * coverage, because every number below is derived from the filtered arrays.
 */
export const createView = (options: ViewOptions): View => {
  const snapshots = options.roster.descriptions
  const directNames = options.directNames ?? DEFAULT_DIRECT_NAMES

  const installed = new Set(snapshots.map((snapshot) => snapshot.id))
  const installedDirects = directNames.filter((name) => installed.has(name))

  const advertised =
    options.profile === "compact"
      ? [...installedDirects, ...COMPACT_DISPATCH_NAMES]
      : snapshots.map((snapshot) => snapshot.id)

  const counts: Record<OperationFamily, number> = {
    server: 0,
    skill: 0,
    session: 0,
    rest: 0,
    context: 0,
    daemon: 0,
    droid: 0,
  }

  for (const snapshot of snapshots) {
    counts[snapshot.family] += 1
  }

  const providerKinds: Array<string> = []

  if (counts.daemon > 0 || counts.droid > 0) providerKinds.push("daemon")

  if (counts.rest > 0) providerKinds.push("hosted")

  if (counts.context > 0) providerKinds.push("context")

  const index = new Map<OperationId, SearchEntry<OperationSnapshot>>()

  for (const snapshot of snapshots) {
    index.set(snapshot.id, indexOf(snapshot))
  }

  const aliasMap = new Map<string, OperationId>()

  if (options.aliases !== undefined) {
    for (const [alias, canonical] of Object.entries(options.aliases)) {
      aliasMap.set(alias, canonical)
    }
  }

  const unserved = new Map<string, ReadonlyArray<string>>()

  if (options.unservedHints !== undefined) {
    for (const [name, replacements] of Object.entries(options.unservedHints)) {
      unserved.set(name, replacements)
    }
  }

  const body: ViewBody = {
    [viewBrand]: true,
    roster: options.roster,
    profile: options.profile,
    serverName: options.serverName ?? "droid-mcp",
    maxInlineBytes: clampInlineBytes(options.maxInlineBytes),
    directNames: Object.freeze(installedDirects.slice()),
    advertisedNames: Object.freeze(advertised.slice()),
    toolCount: advertised.length,
    operationCount: snapshots.length,
    familyCounts: Object.freeze({ ...counts }),
    providerKinds: Object.freeze(providerKinds),
    aliasMap,
    unserved,
    index,
    rosterOrder: snapshots.map((snapshot) => snapshot.id),
  }

  return body
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One advertised tool in the wire inventory. */
export interface InventoryEntry {
  readonly name: OperationId
  readonly direct: boolean
  readonly description: string
  readonly inputSchema: { readonly [key: string]: Schema.Json }
  readonly annotations?: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
}

export interface Inventory {
  readonly profile: "compact" | "full"
  readonly serverName: string
  readonly toolCount: number
  readonly operationCount: number
  readonly familyCounts: Readonly<Record<OperationFamily, number>>
  readonly providerKinds: ReadonlyArray<string>
  readonly tools: ReadonlyArray<InventoryEntry>
}

export interface DiscoveryQuery {
  readonly query?: string
  readonly family?: OperationFamily
  readonly readOnly?: boolean
  readonly limit?: number
  readonly offset?: number
  readonly names?: ReadonlyArray<string>
}

export interface DiscoverySummary {
  readonly name: OperationId
  readonly summary: string
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly family: OperationFamily
  readonly requiresGuidance: boolean
}

export interface DiscoveryDetail {
  readonly name: OperationId
  readonly description: string
  readonly inputSchema: { readonly [key: string]: Schema.Json }
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
  readonly effect: string
  readonly replay: string
  readonly family: OperationFamily
  readonly requiresGuidance: boolean
}

export type DiscoveryPage = Data.TaggedEnum<{
  readonly Search: {
    readonly total: number
    readonly nextOffset: number | null
    readonly entries: ReadonlyArray<DiscoverySummary>
  }
  readonly Describe: {
    readonly entries: ReadonlyArray<DiscoveryDetail>
    readonly unknown: ReadonlyArray<string>
  }
}>

export const DiscoveryPage = Data.taggedEnum<DiscoveryPage>()

export interface CallRequest {
  readonly name: string
  readonly arguments?: Schema.Json
  readonly select?: string
  readonly maxBytes?: number
}

export interface BatchStepRequest {
  readonly id?: string
  readonly name: string
  readonly arguments?: Schema.Json
  readonly select?: string
}

export interface BatchRequest {
  readonly steps: ReadonlyArray<BatchStepRequest>
  readonly stopOnError?: boolean
  readonly maxBytes?: number
}

/**
 * The three shapes a completed call can take. `Inline` fits the byte
 * budget; `Continuation` retains the encoded result for paging through
 * `continueResult`; `CompletedUnpresentable` means the operation SUCCEEDED
 * and presentation failed afterwards — never a reason to repeat the write.
 */
export type Presented = Data.TaggedEnum<{
  readonly Inline: { readonly value: Schema.Json }
  readonly Continuation: {
    readonly ref: string
    readonly totalBytes: number
    readonly preview: string
    readonly hint: string
  }
  readonly CompletedUnpresentable: {
    readonly code: string
    readonly message: string
    readonly ref: string | undefined
    readonly reason: string
  }
}>

export const Presented = Data.taggedEnum<Presented>()

/** The `{ code, message }` failure shape of a call or a batch step. */
export interface StepFailure {
  readonly code: string
  readonly message: string
  readonly ref?: string
}

export interface BatchStepReport {
  readonly id: string
  readonly name: string
  readonly status: "ok" | "failed" | "skipped"
  readonly presented?: Presented
  readonly failure?: StepFailure
}

export interface BatchReport {
  readonly completed: number
  readonly failed: number
  readonly skipped: number
  readonly steps: ReadonlyArray<BatchStepReport>
}

/**
 * A continuation page read through `continueResult`. A module-owned shape:
 * byte paging and UTF-8 boundary discipline belong to `artifacts` and are
 * translated here without re-exporting cross-module types.
 */
export interface ResultPage {
  readonly ref: string
  readonly chunk: string
  readonly offset: number
  readonly nextOffset: number | null
  readonly totalBytes: number
  readonly done: boolean
  readonly selected?: Presented
}

export interface ResultPageRequest {
  readonly offset?: number
  readonly length?: number
  readonly select?: string
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class ViewRefused extends Schema.TaggedError<ViewRefused>()("ViewRefused", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export class CallFailure extends Schema.TaggedError<CallFailure>()("CallFailure", {
  code: Schema.String,
  message: Schema.String,
  operation: Schema.String,
  ref: Schema.optional(Schema.String),
}) {}

export class InvalidBatch extends Schema.TaggedError<InvalidBatch>()("InvalidBatch", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** One refusal shape for missing, expired or foreign continuation refs. */
export class ResultRefUnavailable extends Schema.TaggedError<ResultRefUnavailable>()(
  "ArtifactUnavailable",
  {
    message: Schema.String,
    ref: Schema.String,
  },
) {}

export class InvalidResultRange extends Schema.TaggedError<InvalidResultRange>()("InvalidRange", {
  message: Schema.String,
  offset: Schema.Number,
  totalBytes: Schema.Number,
  reason: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PresentationApi {
  readonly advertise: (view: View, who: Invocation) => Effect.Effect<Inventory, ViewRefused>
  readonly describe: (
    view: View,
    who: Invocation,
    query: DiscoveryQuery,
  ) => Effect.Effect<DiscoveryPage, ViewRefused>
  readonly call: (
    view: View,
    who: Invocation,
    request: CallRequest,
  ) => Effect.Effect<Presented, CallFailure>
  readonly batch: (
    view: View,
    who: Invocation,
    request: BatchRequest,
  ) => Effect.Effect<BatchReport, InvalidBatch>
  readonly continueResult: (
    who: Invocation,
    ref: string,
    range: ResultPageRequest,
  ) => Effect.Effect<ResultPage, ResultRefUnavailable | InvalidResultRange>
  readonly instructions: (view: View) => string
}

export class Presentation extends Context.Service<Presentation, PresentationApi>()(
  "droid-mcp/presentation",
) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const summaryOf = (description: string): string => {
  const end = description.indexOf(". ")
  const sentence = end === -1 ? description : description.slice(0, end + 1)

  return sentence.length <= SUMMARY_CHARS ? sentence : sentence.slice(0, SUMMARY_CHARS - 1) + "…"
}

interface DispatchToolMeta {
  readonly description: string
  readonly inputSchema: { readonly [key: string]: Schema.Json }
}

const searchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    family: { type: "string" },
    readOnly: { type: "boolean" },
    limit: { type: "integer" },
    offset: { type: "integer" },
  },
} satisfies { readonly [key: string]: Schema.Json }

const describeSchema = {
  type: "object",
  properties: { names: { type: "array", items: { type: "string" } } },
  required: ["names"],
} satisfies { readonly [key: string]: Schema.Json }

const callSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    arguments: { type: "object" },
    select: { type: "string" },
    maxBytes: { type: "integer" },
  },
  required: ["name"],
} satisfies { readonly [key: string]: Schema.Json }

const batchSchema = {
  type: "object",
  properties: {
    steps: { type: "array", items: { type: "object" } },
    stopOnError: { type: "boolean" },
    maxBytes: { type: "integer" },
  },
  required: ["steps"],
} satisfies { readonly [key: string]: Schema.Json }

const readSchema = {
  type: "object",
  properties: {
    ref: { type: "string" },
    offset: { type: "integer" },
    length: { type: "integer" },
    select: { type: "string" },
  },
  required: ["ref"],
} satisfies { readonly [key: string]: Schema.Json }

const dispatchTools: ReadonlyArray<readonly [string, DispatchToolMeta]> = [
  [
    "tools_search",
    {
      description:
        "Find operations by keyword among every installed operation. Returns names, one-line summaries and hints; call tools_describe for a schema, tool_call to run one.",
      inputSchema: searchSchema,
    },
  ],
  [
    "tools_describe",
    {
      description:
        "Full description, input schema and hints for up to 20 operations, before calling them with tool_call or batch.",
      inputSchema: describeSchema,
    },
  ],
  [
    "tool_call",
    {
      description:
        "Run one operation by name with its arguments, exactly as its own tool would run in the full profile: same validation, autonomy cap and failure { code, message }. Returns the result, or a preview and ref for result_read when the result exceeds maxBytes. An invalid_select completion includes a ref to the finished result; do not repeat the operation.",
      inputSchema: callSchema,
    },
  ],
  [
    "batch",
    {
      description:
        'Run up to 20 operations in order in one call. An argument value { "$from": "<step id>", "path": "<JSON Pointer>" } is replaced by that part of an earlier step\'s full result, so intermediate results never need to come back. Stops at the first failure unless stopOnError is false. Not a transaction: completed steps stay done.',
      inputSchema: batchSchema,
    },
  ],
  [
    "result_read",
    {
      description:
        "Read a stored result from tool_call or batch: a byte range of its JSON text from offset, or the part a select pointer names. Offsets must be UTF-8 character boundaries. Refs expire after idle time.",
      inputSchema: readSchema,
    },
  ],
]

const dispatchMeta = new Map<string, DispatchToolMeta>(dispatchTools)

// ---------------------------------------------------------------------------
// Invocation failure translation into the { code, message } vocabulary
// ---------------------------------------------------------------------------

const translateFailure = (failure: {
  readonly _tag: string
  readonly message?: string
  readonly detail?: string
}): StepFailure =>
  Match.value(failure._tag).pipe(
    Match.when("InvalidInput", () => {
      const detail =
        failure.detail !== undefined && failure.detail !== failure.message
          ? failure.detail
          : undefined

      return {
        code: "invalid_arguments",
        message: (failure.message ?? "invalid input") + (detail !== undefined ? ": " + detail : ""),
      }
    }),
    Match.when("OperationNotFound", () => ({
      code: "unknown_operation",
      message: failure.message ?? "no operation with that name is visible",
    })),
    Match.when("GuidanceRequired", () => ({
      code: "guidance_required",
      message: failure.message ?? "the guide must be delivered before this operation",
    })),
    Match.when("Denied", () => ({
      code: "denied",
      message: failure.message ?? "the operation exceeds the granted authority",
    })),
    Match.when("authority_unverifiable", () => ({
      code: "authority_unverifiable",
      message: failure.message ?? "effective authority cannot be proven",
    })),
    Match.when("OperationUnverifiable", () => ({
      code: "authority_unverifiable",
      message: failure.message ?? "effective authority cannot be proven",
    })),
    Match.when("TargetUnavailable", () => ({
      code: "target_unavailable",
      message: failure.message ?? "the target is unavailable",
    })),
    Match.when("PeerFailure", () => ({
      code: "peer_failure",
      message: failure.message ?? "the peer rejected the operation",
    })),
    Match.when("MalformedPeerReply", () => ({
      code: "malformed_reply",
      message: failure.message ?? "the peer reply was malformed",
    })),
    Match.when("DeliveryUncertain", () => ({
      code: "delivery_uncertain",
      message: failure.message ?? "delivery of the operation is uncertain; do not repeat it",
    })),
    Match.when("OperationConflict", () => ({
      code: "conflict",
      message: failure.message ?? "the operation conflicts with current state",
    })),
    Match.when("OperationNotVisible", () => ({
      code: "not_visible",
      message: failure.message ?? "the target is not visible to this caller",
    })),
    Match.when("OperationDenied", () => ({
      code: "denied",
      message: failure.message ?? "the operation was denied",
    })),
    Match.when("DisclosureRefused", () => ({
      code: "disclosure_refused",
      message: failure.message ?? "the result cannot cross the disclosure boundary",
    })),
    Match.when("ProtectedBytes", () => ({
      code: "protected_bytes",
      message: failure.message ?? "the result carries protected binary data",
    })),
    Match.orElse(() => ({
      code: "internal_error",
      message: failure.message ?? "the operation failed unexpectedly",
    })),
  )

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * The released client value as seen through the capabilities boundary. The
 * type is inferred structurally from `Capabilities.invoke`'s public return
 * type — presentation never imports the disclosure module that owns it.
 */
type ClientReleased = Capabilities["Service"]["invoke"] extends (
  ...args: never
) => Effect.Effect<infer A, infer _E, infer _R>
  ? A
  : never

/**
 * Extracts the JSON payload of a released value structurally, without
 * importing disclosure. Only the JsonValue variant carries presentable
 * content; other payloads are not JSON-presentable.
 */
const jsonOfReleased = (released: ClientReleased): Option.Option<Schema.Json> =>
  Match.value(released.payload).pipe(
    Match.when({ _tag: "JsonValue" }, (variant) => Option.some(variant.value)),
    Match.orElse(() => Option.none<Schema.Json>()),
  )

interface StepSuccess {
  readonly ok: true
  readonly released: ClientReleased
}

interface StepFailureOutcome {
  readonly ok: false
  readonly failure: StepFailure
}

type StepOutcome = StepSuccess | StepFailureOutcome

export const presentationLayer: Layer.Layer<Presentation, never, Capabilities | Artifacts> =
  Layer.effect(
    Presentation,
    Effect.gen(function* () {
      const capabilities = yield* Capabilities
      const artifacts = yield* Artifacts

      /**
       * Resolves a caller-supplied name to the canonical operation id: view
       * aliases first, then the discovery index. A name absent from the
       * index may still be a catalog alias the owner declared; the catalog
       * itself decides at invoke time.
       */
      const resolveName = (body: ViewBody, name: string): OperationId =>
        body.aliasMap.get(name) ?? name

      const unknownMessage = (body: ViewBody, name: string): string => {
        const hint = body.unserved.get(name)

        return hint === undefined
          ? "no operation named " + name + "; find one with tools_search"
          : name + " is not served; use " + hint.join(" or ")
      }

      /**
       * Runs one operation through the bound pipeline. Direct names and
       * discovered names enter the exact same `Capabilities.invoke` — there
       * is no second dispatch path.
       */
      const runOperation = (
        view: View,
        who: Invocation,
        name: string,
        args: Schema.Json,
      ): Effect.Effect<StepOutcome, never> =>
        Effect.match(
          capabilities.invoke(view.roster.catalog, who, resolveName(readView(view), name), args),
          {
            onFailure: (failure): StepOutcome => ({
              ok: false,
              failure: translateFailure(failure),
            }),
            onSuccess: (released): StepOutcome => ({
              ok: true,
              released,
            }),
          },
        )

      const isKnown = (view: View, name: string): boolean => {
        const body = readView(view)
        const canonical = resolveName(body, name)

        return body.index.has(canonical)
      }

      /**
       * Presents one completed released value. Selection failure after
       * completion is not an execution failure — the operation already ran —
       * so the recovery ref carries the full safe result inside a
       * `CompletedUnpresentable` report.
       */
      const presentValue = (
        who: Invocation,
        released: ClientReleased,
        select: string | undefined,
        maxBytes: number,
      ): Effect.Effect<Presented, never> =>
        Effect.match(artifacts.present(who.caller, released, { maxBytes, select }), {
          onFailure: (failure): Presented =>
            Match.value(failure).pipe(
              Match.when({ _tag: "ArtifactTooLarge" }, (variant) =>
                Presented.CompletedUnpresentable({
                  code: "result_too_large",
                  message: variant.message,
                  ref: undefined,
                  reason: "single_value_limit",
                }),
              ),
              Match.when({ _tag: "ArtifactUnavailable" }, (variant) =>
                Presented.CompletedUnpresentable({
                  code: "result_unavailable",
                  message: variant.message,
                  ref: undefined,
                  reason: "artifact_unavailable",
                }),
              ),
              Match.when({ _tag: "SelectionFailed" }, (variant) =>
                Presented.CompletedUnpresentable({
                  code: "invalid_select",
                  message:
                    variant.message +
                    "; the operation completed. Read its result with result_read using the ref; do not repeat it.",
                  ref: variant.recoveryRef,
                  reason: "invalid_select",
                }),
              ),
              Match.exhaustive,
            ),
          onSuccess: (delivery): Presented =>
            Delivery.$match(delivery, {
              Inline: (variant) =>
                Presented.Inline({
                  value: Option.getOrElse(jsonOfReleased(variant.value), () => null),
                }),
              Preview: (variant) =>
                Presented.Continuation({
                  ref: variant.ref,
                  totalBytes: variant.totalBytes,
                  preview: variant.preview,
                  hint: "result truncated; continue reading with result_read using the ref",
                }),
            }),
        })

      /**
       * Resolves `{ $from, path }` references recursively against the full
       * safe released results of earlier steps. Selection inside a step
       * result goes through `artifacts.part`, which rewraps the selected
       * part into a safe released value rather than reconstructing one.
       */
      const resolveArgs = (
        who: Invocation,
        value: Schema.Json,
        results: ReadonlyMap<string, ClientReleased>,
      ): Effect.Effect<Schema.Json, ReferenceProblem> =>
        Effect.gen(function* () {
          if (!containsReference(value)) return value

          return yield* rewrite(who, value, results)
        })

      const rewrite = (
        who: Invocation,
        value: Schema.Json,
        results: ReadonlyMap<string, ClientReleased>,
      ): Effect.Effect<Schema.Json, ReferenceProblem> =>
        Effect.gen(function* () {
          if (Array.isArray(value)) {
            const items: Array<Schema.Json> = []

            for (const item of value) {
              items.push(yield* rewrite(who, item, results))
            }

            // SAFETY: every element was rewritten from a Schema.Json input
            // through this same total function, so the array is Json.
            return items as Schema.Json
          }

          if (value === null || !isPlainRecord(value)) return value

          if (isReferenceObject(value)) {
            const source = results.get(value.$from)

            if (source === undefined) {
              return yield* Effect.fail(
                new ReferenceProblem({
                  reason: "unknown_step",
                  detail:
                    "$from " + JSON.stringify(value.$from) + " does not name an earlier result",
                }),
              )
            }

            const pointer = value.path ?? ""

            if (pointer === "") {
              return Option.getOrElse(jsonOfReleased(source), () => null)
            }

            const part = yield* artifacts.part(who.caller, source, pointer).pipe(
              Effect.mapError(
                () =>
                  new ReferenceProblem({
                    reason: "missing_part",
                    detail:
                      "$from " +
                      JSON.stringify(value.$from) +
                      (value.path ?? "") +
                      " does not name a part of an earlier result",
                  }),
              ),
            )

            return Option.getOrElse(jsonOfReleased(part), () => null)
          }

          const members: Array<readonly [string, Schema.Json]> = []

          for (const key of Object.keys(value)) {
            const member = value[key]

            members.push([key, yield* rewrite(who, member, results)])
          }

          // SAFETY: every member value was rewritten from a Schema.Json
          // input through this same total function, so the record is Json.
          return Object.fromEntries(members) as Schema.Json
        })

      const isPlainRecord = (
        value: Schema.Json,
      ): value is { readonly [key: string]: Schema.Json } =>
        // SAFETY: Schema.Json's object variant is exactly a record of Json
        // values; arrays and null are excluded above by the caller's check.
        !Array.isArray(value) && value !== null && value instanceof Object

      const clampMaxBytes = (maxBytes: number | undefined, fallback: number): number => {
        if (maxBytes === undefined) return fallback

        return Math.min(MAX_MAX_INLINE_BYTES, Math.max(MIN_MAX_INLINE_BYTES, Math.floor(maxBytes)))
      }

      // -------------------------------------------------------------------
      // advertise
      // -------------------------------------------------------------------

      const advertise: PresentationApi["advertise"] = (view, _who) =>
        Effect.suspend(() => {
          const body = readView(view)

          const tools: Array<InventoryEntry> = []

          for (const name of body.advertisedNames) {
            const snapshot = body.index.get(name)

            if (snapshot !== undefined) {
              tools.push({
                name: snapshot.description.id,
                direct: true,
                description: snapshot.description.description,
                inputSchema: snapshot.description.inputSchema,
                annotations: snapshot.description.annotations,
              })

              continue
            }

            const meta = dispatchMeta.get(name)

            tools.push({
              name,
              direct: false,
              description: meta?.description ?? name,
              inputSchema: meta?.inputSchema ?? {},
            })
          }

          return Effect.succeed({
            profile: body.profile,
            serverName: body.serverName,
            toolCount: body.toolCount,
            operationCount: body.operationCount,
            familyCounts: body.familyCounts,
            providerKinds: body.providerKinds,
            tools: Object.freeze(tools),
          })
        })

      // -------------------------------------------------------------------
      // describe
      // -------------------------------------------------------------------

      const describe: PresentationApi["describe"] = (view, _who, query) =>
        Effect.suspend((): Effect.Effect<DiscoveryPage, ViewRefused> => {
          const body = readView(view)

          if (query.names !== undefined) {
            if (query.names.length < 1 || query.names.length > DESCRIBE_NAMES_MAX) {
              return Effect.fail(
                new ViewRefused({
                  message:
                    "describe accepts between 1 and " + String(DESCRIBE_NAMES_MAX) + " names",
                  reason: "names_out_of_range",
                }),
              )
            }

            const entries: Array<DiscoveryDetail> = []
            const unknown: Array<string> = []

            for (const requested of query.names) {
              const canonical = resolveName(body, requested)
              const snapshot = body.index.get(canonical)

              if (snapshot === undefined) {
                unknown.push(requested)

                continue
              }

              const detail = snapshot.description

              entries.push({
                name: detail.id,
                description: detail.description,
                inputSchema: detail.inputSchema,
                annotations: detail.annotations,
                effect: detail.effect,
                replay: detail.replay,
                family: detail.family,
                requiresGuidance: detail.requiresGuidance,
              })
            }

            return Effect.succeed(DiscoveryPage.Describe({ entries, unknown }))
          }

          const limit = clampLimit(query.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX)
          const offset = Math.max(0, Math.floor(query.offset ?? 0))
          const tokens = tokensOf(query.query ?? "")

          const matches: Array<{
            readonly entry: SearchEntry<OperationSnapshot>
            readonly score: number
          }> = []

          for (const id of body.rosterOrder) {
            const entry = body.index.get(id)

            if (entry === undefined) continue

            if (query.family !== undefined && entry.description.family !== query.family) continue

            if (
              query.readOnly !== undefined &&
              entry.description.annotations.readOnlyHint !== query.readOnly
            ) {
              continue
            }

            const score = tokens.length === 0 ? 1 : scoreOf(entry, tokens)

            if (score > 0) matches.push({ entry, score })
          }

          // Stable order for equal scores: roster order. Execution never
          // depends on discovery tie order.
          matches.sort((left, right) => right.score - left.score)

          const page = matches.slice(offset, offset + limit)
          const next = offset + page.length

          return Effect.succeed(
            DiscoveryPage.Search({
              total: matches.length,
              nextOffset: next < matches.length ? next : null,
              entries: page.map(({ entry }) => ({
                name: entry.description.id,
                summary: summaryOf(entry.description.description),
                readOnly: entry.description.annotations.readOnlyHint,
                destructive: entry.description.annotations.destructiveHint,
                family: entry.description.family,
                requiresGuidance: entry.description.requiresGuidance,
              })),
            }),
          )
        })

      const clampLimit = (limit: number | undefined, fallback: number, maximum: number): number => {
        if (limit === undefined) return fallback

        return Math.min(maximum, Math.max(1, Math.floor(limit)))
      }

      // -------------------------------------------------------------------
      // call
      // -------------------------------------------------------------------

      const call: PresentationApi["call"] = (view, who, request) =>
        Effect.gen(function* () {
          const body = readView(view)

          if (!isKnown(view, request.name)) {
            return yield* Effect.fail(
              new CallFailure({
                code: "unknown_operation",
                message: unknownMessage(body, request.name),
                operation: request.name,
              }),
            )
          }

          const outcome = yield* runOperation(view, who, request.name, request.arguments ?? {})

          if (!outcome.ok) {
            return yield* Effect.fail(
              new CallFailure({
                code: outcome.failure.code,
                message: outcome.failure.message,
                operation: request.name,
              }),
            )
          }

          return yield* presentValue(
            who,
            outcome.released,
            request.select,
            clampMaxBytes(request.maxBytes, body.maxInlineBytes),
          )
        })

      // -------------------------------------------------------------------
      // batch
      // -------------------------------------------------------------------

      const batch: PresentationApi["batch"] = (view, who, request) =>
        Effect.gen(function* () {
          if (request.steps.length < 1) {
            return yield* Effect.fail(
              new InvalidBatch({
                code: "invalid_arguments",
                message: "a batch needs at least one step",
              }),
            )
          }

          if (request.steps.length > BATCH_STEPS_MAX) {
            return yield* Effect.fail(
              new InvalidBatch({
                code: "invalid_arguments",
                message: "a batch accepts at most " + String(BATCH_STEPS_MAX) + " steps",
              }),
            )
          }

          const ids = request.steps.map((step, index) => step.id ?? String(index))

          if (new Set(ids).size !== ids.length) {
            return yield* Effect.fail(
              new InvalidBatch({
                code: "invalid_arguments",
                message: "step ids must be unique",
              }),
            )
          }

          const stopOnError = request.stopOnError ?? true
          const body = readView(view)

          const perStepBytes = Math.min(
            MAX_MAX_INLINE_BYTES,
            Math.max(
              MIN_MAX_INLINE_BYTES,
              Math.floor(
                clampMaxBytes(request.maxBytes, body.maxInlineBytes * 2) / request.steps.length,
              ),
            ),
          )

          const results = new Map<string, ClientReleased>()
          const steps: Array<BatchStepReport> = []

          let stopped = false

          for (const [index, step] of request.steps.entries()) {
            const id = ids[index] ?? String(index)

            if (stopped) {
              steps.push({ id, name: step.name, status: "skipped" })

              continue
            }

            if (!isKnown(view, step.name)) {
              steps.push({
                id,
                name: step.name,
                status: "failed",
                failure: {
                  code: "unknown_operation",
                  message: unknownMessage(body, step.name),
                },
              })

              if (stopOnError) stopped = true

              continue
            }

            const report = yield* Effect.gen(function* () {
              const args = yield* resolveArgs(who, step.arguments ?? {}, results)

              const outcome = yield* runOperation(view, who, step.name, args)

              if (!outcome.ok) {
                return yield* Effect.fail(outcome.failure)
              }

              // The FULL safe released result feeds later references —
              // before select or preview truncation of the step report.
              results.set(id, outcome.released)

              return yield* presentValue(who, outcome.released, step.select, perStepBytes)
            }).pipe(
              Effect.match({
                onFailure: (failure: StepFailure | ReferenceProblem): BatchStepReport => {
                  if (failure instanceof ReferenceProblem) {
                    return {
                      id,
                      name: step.name,
                      status: "failed",
                      failure: { code: "invalid_reference", message: failure.message },
                    }
                  }

                  return { id, name: step.name, status: "failed", failure }
                },
                onSuccess: (presented): BatchStepReport => ({
                  id,
                  name: step.name,
                  status: "ok",
                  presented,
                }),
              }),
            )

            steps.push(report)

            if (report.status === "failed" && stopOnError) stopped = true
          }

          return {
            completed: countStatus(steps, "ok"),
            failed: countStatus(steps, "failed"),
            skipped: countStatus(steps, "skipped"),
            steps,
          }
        })

      const countStatus = (steps: ReadonlyArray<BatchStepReport>, status: string): number => {
        let count = 0

        for (const step of steps) {
          if (step.status === status) count += 1
        }

        return count
      }

      // -------------------------------------------------------------------
      // continueResult
      // -------------------------------------------------------------------

      const continueResult: PresentationApi["continueResult"] = (who, ref, range) =>
        Effect.gen(function* () {
          const parsed = parseArtifactRef(ref)

          if (Option.isNone(parsed)) {
            return yield* Effect.fail(
              new ResultRefUnavailable({
                message:
                  "artifact is unavailable; it expired, never existed or belongs to another caller",
                ref,
              }),
            )
          }

          const artifactRef: ArtifactRef = parsed.value

          const mapFailure = (failure: {
            readonly _tag: string
            readonly message: string
            readonly ref?: string
            readonly offset?: number
            readonly totalBytes?: number
            readonly reason?: string
          }): ResultRefUnavailable | InvalidResultRange =>
            Match.value(failure).pipe(
              Match.when(
                { _tag: "InvalidRange" },
                (variant) =>
                  new InvalidResultRange({
                    message: variant.message,
                    offset: variant.offset ?? 0,
                    totalBytes: variant.totalBytes ?? 0,
                    reason: variant.reason ?? "invalid_range",
                  }),
              ),
              Match.orElse(
                (variant) => new ResultRefUnavailable({ message: variant.message, ref }),
              ),
            )

          const page = yield* artifacts
            .read(who.caller, artifactRef, {
              offset: range.offset,
              length: range.length,
              select: range.select,
            })
            .pipe(Effect.mapError(mapFailure))

          return {
            ref,
            chunk: page.chunk,
            offset: page.offset,
            nextOffset: page.nextOffset,
            totalBytes: page.totalBytes,
            done: page.done,
          }
        })

      // -------------------------------------------------------------------
      // instructions
      // -------------------------------------------------------------------

      const instructions: PresentationApi["instructions"] = (view) => {
        const body = readView(view)

        if (body.profile === "full") {
          return (
            "This server exposes " +
            String(body.toolCount) +
            " direct operation tools covering " +
            String(body.operationCount) +
            " installed operations across the " +
            familyList(body) +
            " families. Each tool validates its own arguments, enforces the authority " +
            "ceiling and guidance prerequisites, and reports failures as " +
            "{ code, message }. Confirm with the user before an operation whose hints " +
            "say destructive."
          )
        }

        return (
          "This server exposes " +
          String(body.toolCount) +
          " tools: " +
          String(body.directNames.length) +
          " direct tools plus tools_search, tools_describe, tool_call, batch and " +
          "result_read, covering " +
          String(body.operationCount) +
          " installed operations across the " +
          familyList(body) +
          " families. Find operations with tools_search, read their schemas with " +
          "tools_describe, and run them with tool_call or batch — dispatch enters the " +
          "same validation, authority and disclosure pipeline as a direct call. Large " +
          "results return a preview and ref; continue with result_read. An " +
          "invalid_select completion carries the finished result's ref; do not repeat " +
          "the operation. Confirm with the user before an operation whose hints say " +
          "destructive."
        )
      }

      const familyList = (body: ViewBody): string => {
        const families: Array<OperationFamily> = [
          "server",
          "skill",
          "session",
          "rest",
          "context",
          "daemon",
          "droid",
        ]

        return families.filter((family) => body.familyCounts[family] > 0).join(", ")
      }

      return { advertise, describe, call, batch, continueResult, instructions }
    }),
  )
