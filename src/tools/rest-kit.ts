import * as Tool from "effect/ai/Tool"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { presentFields } from "../droid/protocol.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { encodePathSegment, isWellFormed } from "../droid/rest-http.ts"
import { RestService } from "../droid/rest-service.ts"
import type { RestError, RestMethod, RestResponse, RestResult } from "../droid/rest-service.ts"
import { ToolFailure } from "./failure.ts"

/**
 * One descriptor per hosted REST tool. A descriptor names the route, its
 * named inputs, which of them travel as query parameters, and how the body is
 * formed; the builder turns that into an MCP tool and a handler that sends
 * exactly one request through `RestService`.
 */

export const DESTRUCTIVE = "Destructive; confirm before calling."

export const Id = Schema.NonEmptyString

export const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))

export const Cursor = Schema.String

/** Sent on the wire as `"true"` or `"false"`. */
export const BooleanFlag = Schema.Boolean

export const JsonBody = Schema.Record(Schema.String, Schema.Json)

/** An object whose listed fields are checked; upstream accepts more members, kept as given. */
export const openStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [JsonBody])

const QueryScalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])

export const ExtraQuery = Schema.Record(
  Schema.String,
  Schema.Union([QueryScalar, Schema.Array(QueryScalar)]),
)

const EXTRA_QUERY_FIELD = "query"
const BODY_FIELD = "body"

/** Decoded tool arguments; every tool's parameters are a JSON object. */
export interface RestParams {
  readonly [key: string]: JsonValue | undefined
}

export type RestHandler = (params: RestParams) => Effect.Effect<JsonValue, ToolFailure, RestService>

interface ParamFields {
  [name: PropertyKey]: Schema.Struct.Fields[string]
}

export interface RestToolSpec<Fields extends Schema.Struct.Fields> {
  readonly name: string
  /** The upstream operation id, used in failure messages. */
  readonly operation: string
  readonly description: string
  readonly method: RestMethod
  /** `{param}` placeholders name inputs; each is encoded as one path segment. */
  readonly path: string
  readonly inputs?: Fields
  /** Inputs sent as query parameters; arrays repeat the key, booleans are "true"/"false". */
  readonly query?: ReadonlyArray<keyof Fields & string>
  /**
   * `"optional"` accepts any JSON object as `body`; a field record makes `body`
   * required with those fields required and every other member kept.
   */
  readonly body?: "optional" | Schema.Struct.Fields
  /** Lets a field-record `body` be omitted, so upstream applies its defaults. */
  readonly bodyOptional?: boolean
  /** Inputs gathered into a flat JSON body; omitted when none is present. */
  readonly bodyFields?: ReadonlyArray<keyof Fields & string>
  readonly response?: RestResponse
  /** Projection of the upstream result; the default passes JSON and maps empty to `{ ok: true }`. */
  readonly result?: (json: RestResult) => JsonValue
  readonly success?: Schema.Top
  /** Per-call values that must be scrubbed from results and errors. */
  readonly secrets?: (params: RestParams) => ReadonlyArray<string>
}

export interface RestToolEntry {
  readonly tool: Tool.Any
  readonly handler: RestHandler
}

export interface RestDomain {
  readonly tools: Array<Tool.Any>
  readonly handlers: Record<string, RestHandler>
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g

const placeholdersOf = (template: string): ReadonlyArray<string> =>
  Array.from(template.matchAll(PLACEHOLDER), (match) => match[1] ?? "")

export const invalidParams = (tool: string, message: string): ToolFailure => ({
  code: "invalid_params",
  message: tool + ": " + message,
})

export const restFailure = (error: RestError): ToolFailure =>
  Match.value(error).pipe(
    Match.tag("RestRejected", (value) => ({ code: "rest_rejected", message: value.message })),
    Match.tag("RestUnavailable", (value) => ({ code: "rest_unavailable", message: value.message })),
    Match.tag("FactoryApiKeyMissing", (value) => ({
      code: "factory_api_key_missing",
      message: value.message,
    })),
    Match.tag("ContextBaseUrlMissing", (value) => ({
      code: "context_base_url_missing",
      message: value.message,
    })),
    Match.exhaustive,
  )

const scalarText = (value: JsonValue): string => {
  if (Predicate.isString(value)) return value

  if (Predicate.isBoolean(value)) return value ? "true" : "false"

  if (Predicate.isNumber(value)) return String(value)

  return JSON.stringify(value)
}

const queryEntries = (
  name: string,
  value: JsonValue | undefined,
): ReadonlyArray<readonly [string, string]> => {
  if (value === undefined || value === null) return []

  if (Array.isArray(value)) return value.map((entry) => [name, scalarText(entry)] as const)

  return [[name, scalarText(value)]]
}

/** Only an empty success is acknowledged; a JSON `null` body is a result like any other. */
const defaultResult = (json: RestResult): JsonValue => (json === undefined ? { ok: true } : json)

/** Builds one hosted REST tool and its handler from a descriptor. */
export const restTool = <const Fields extends Schema.Struct.Fields>(
  spec: RestToolSpec<Fields>,
): RestToolEntry => {
  const fields: ParamFields = { ...spec.inputs }
  const pathParams = placeholdersOf(spec.path)

  for (const name of pathParams) {
    if (!(name in fields)) {
      throw new Error(spec.name + ": path placeholder {" + name + "} is not a named input")
    }
  }

  if (spec.body !== undefined && spec.bodyFields !== undefined) {
    throw new Error(spec.name + ": body and bodyFields are mutually exclusive")
  }

  if (spec.body === "optional") {
    fields[BODY_FIELD] = Schema.optional(JsonBody)
  } else if (spec.body !== undefined) {
    const body = openStruct(spec.body)

    fields[BODY_FIELD] = spec.bodyOptional === true ? Schema.optional(body) : body
  }

  const named = new Set(Object.keys(fields))

  fields[EXTRA_QUERY_FIELD] = Schema.optional(
    ExtraQuery.annotate({
      description: "Extra query parameters sent unchanged; a key may not repeat a named input.",
    }),
  )

  const tool: Tool.Any = Tool.make(spec.name, {
    description: spec.description,
    parameters: Schema.Struct(fields),
    success: spec.success ?? Schema.Json,
    failure: ToolFailure,
    dependencies: [RestService],
  })

  const buildPath = (params: RestParams): Effect.Effect<string, ToolFailure> => {
    let path = spec.path

    for (const name of pathParams) {
      const value = params[name]

      const segment =
        Predicate.isString(value) && value.length > 0 ? encodePathSegment(value) : undefined

      if (segment === undefined) {
        return Effect.fail(
          invalidParams(
            spec.name,
            name + " must be a non-empty, well-formed path segment other than . or ..",
          ),
        )
      }

      path = path.replace("{" + name + "}", segment)
    }

    return Effect.succeed(path)
  }

  const buildQuery = (
    params: RestParams,
  ): Effect.Effect<ReadonlyArray<readonly [string, string]>, ToolFailure> => {
    const entries = (spec.query ?? []).flatMap((name) => queryEntries(name, params[name]))

    const extra = Option.getOrUndefined(
      Schema.decodeUnknownOption(ExtraQuery)(params[EXTRA_QUERY_FIELD]),
    )

    for (const [key, value] of Object.entries(extra ?? {})) {
      if (named.has(key)) {
        return Effect.fail(
          invalidParams(spec.name, "query." + key + " duplicates the named input " + key),
        )
      }

      entries.push(...queryEntries(key, value))
    }

    const malformed = entries.find(([key, value]) => !isWellFormed(key) || !isWellFormed(value))

    if (malformed !== undefined) {
      return Effect.fail(
        invalidParams(spec.name, "query parameter " + malformed[0] + " is not well-formed Unicode"),
      )
    }

    return Effect.succeed(entries)
  }

  const buildBody = (params: RestParams): JsonValue | undefined => {
    if (spec.body !== undefined) return params[BODY_FIELD]

    if (spec.bodyFields === undefined) return undefined

    const picked: Record<string, JsonValue | undefined> = {}

    for (const name of spec.bodyFields) picked[name] = params[name]

    const body = presentFields(picked)

    return Object.keys(body).length === 0 ? undefined : body
  }

  const project = spec.result ?? defaultResult

  const handler: RestHandler = (params) =>
    Effect.gen(function* () {
      const path = yield* buildPath(params)
      const query = yield* buildQuery(params)
      const rest = yield* RestService

      const json = yield* rest
        .request({
          operation: spec.operation,
          method: spec.method,
          path,
          query,
          body: buildBody(params),
          response: spec.response ?? "json",
          secrets: spec.secrets?.(params) ?? [],
        })
        .pipe(Effect.mapError(restFailure))

      return project(json)
    })

  return { tool, handler }
}

/** Collects a domain's descriptors into the `{ tools, handlers }` pair `toolsFor` merges. */
export const restDomain = (entries: ReadonlyArray<RestToolEntry>): RestDomain => {
  const tools: Array<Tool.Any> = []
  const handlers: Record<string, RestHandler> = {}

  for (const entry of entries) {
    if (entry.tool.name in handlers) throw new Error("duplicate REST tool " + entry.tool.name)

    tools.push(entry.tool)
    handlers[entry.tool.name] = entry.handler
  }

  return { tools, handlers }
}

/** Concatenates domains, refusing a tool name that two domains both define. */
export const mergeDomains = (domains: ReadonlyArray<RestDomain>): RestDomain => {
  const tools: Array<Tool.Any> = []
  const handlers: Record<string, RestHandler> = {}

  for (const domain of domains) {
    for (const [name, handler] of Object.entries(domain.handlers)) {
      if (name in handlers) throw new Error("duplicate REST tool " + name)

      handlers[name] = handler
    }

    tools.push(...domain.tools)
  }

  return { tools, handlers }
}
