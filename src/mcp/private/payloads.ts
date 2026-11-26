/**
 * Typed inspection of wire payloads. `Schema.Json` values produced by the
 * sessions pipeline are decoded into named domain shapes at the boundary —
 * never probed with `Reflect.get` — so every read carries checked evidence.
 */
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { OPERATION_FAMILIES } from "../../capabilities/index.ts"
import { SEARCH_LIMIT_MAX } from "../../presentation/index.ts"
import type { DiscoveryQuery } from "../../presentation/index.ts"

export type JsonObject = { readonly [key: string]: Schema.Json }

export const isJsonObject = (value: Schema.Json): value is JsonObject =>
  value !== null && !Array.isArray(value) && value instanceof Object

/** The fields of an encoded session turn payload this module reads. */
const SessionTurnPayloadSchema = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.Number),
  truncated: Schema.optionalKey(Schema.Boolean),
  omittedCount: Schema.optionalKey(Schema.Number),
  outstandingDecisions: Schema.optionalKey(Schema.Array(Schema.Json)),
})

export interface SessionTurnPayload {
  readonly sessionId: string | undefined
  readonly status: string | undefined
  readonly cursor: number | undefined
  readonly truncated: boolean
  readonly omittedCount: number | undefined
  readonly decisions: ReadonlyArray<Schema.Json>
}

/** Decodes the readable fields of an encoded session turn payload. */
export const readSessionTurnPayload = (value: Schema.Json): SessionTurnPayload | undefined => {
  if (!isJsonObject(value)) return undefined

  const decoded = Schema.decodeUnknownOption(SessionTurnPayloadSchema)(value)

  if (Option.isNone(decoded)) return undefined

  return {
    sessionId: decoded.value.sessionId,
    status: decoded.value.status,
    cursor: decoded.value.cursor,
    truncated: decoded.value.truncated === true,
    omittedCount: decoded.value.omittedCount,
    decisions: decoded.value.outstandingDecisions ?? [],
  }
}

/** One encoded outstanding decision's wire shape. */
const OutstandingDecisionSchema = Schema.Struct({
  requestId: Schema.String,
  kind: Schema.Literals(["permission", "question", "options"]),
})

export interface OutstandingDecision {
  readonly requestId: string
  readonly kind: "permission" | "question" | "options"
  readonly raw: JsonObject
}

/** Decodes one encoded outstanding decision; anything else is not a decision. */
export const readOutstandingDecision = (value: Schema.Json): OutstandingDecision | undefined => {
  if (!isJsonObject(value)) return undefined

  const decoded = Schema.decodeUnknownOption(OutstandingDecisionSchema)(value)

  if (Option.isNone(decoded)) return undefined

  return { requestId: decoded.value.requestId, kind: decoded.value.kind, raw: value }
}

/** The `tools/call` params envelope. */
const ToolCallParamsSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
})

export interface ToolCallParams {
  readonly name: string
  readonly callArguments: Schema.Json
}

export const readToolCallParams = (value: Schema.Json): ToolCallParams | undefined => {
  if (!isJsonObject(value)) return undefined

  const decoded = Schema.decodeUnknownOption(ToolCallParamsSchema)(value)

  if (Option.isNone(decoded)) return undefined

  return { name: decoded.value.name, callArguments: decoded.value.arguments ?? {} }
}

/** The delivery field of session_stream arguments. */
const StreamArgumentsSchema = Schema.Struct({
  delivery: Schema.optionalKey(Schema.Literals(["detach", "block"])),
})

export const readStreamDelivery = (value: Schema.Json): "detach" | "block" | undefined => {
  if (!isJsonObject(value)) return undefined

  const decoded = Schema.decodeUnknownOption(StreamArgumentsSchema)(value)

  if (Option.isNone(decoded)) return undefined

  return decoded.value.delivery
}

/** The filter fields of `tools_search` arguments. */
const SearchArgumentsSchema = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.Literals(OPERATION_FAMILIES)),
  readOnly: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_LIMIT_MAX })),
  ),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})

/** Decodes the complete `tools_search` filter object, rejecting invalid values. */
export const readSearchArguments = (value: Schema.Json): DiscoveryQuery | undefined => {
  if (!isJsonObject(value)) return undefined

  const decoded = Schema.decodeUnknownOption(SearchArgumentsSchema)(value)

  if (Option.isNone(decoded)) return undefined

  return decoded.value
}

/** One batch step's wire shape inside `batch` arguments. */
const BatchStepSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
  select: Schema.optionalKey(Schema.String),
})

const BatchArgumentsSchema = Schema.Struct({
  steps: Schema.Array(BatchStepSchema),
  stopOnError: Schema.optionalKey(Schema.Boolean),
  maxBytes: Schema.optionalKey(Schema.Number),
})

export interface BatchStepInput {
  readonly id: string | undefined
  readonly name: string
  readonly stepArguments: Schema.Json | undefined
  readonly select: string | undefined
}

export interface BatchArguments {
  readonly steps: ReadonlyArray<BatchStepInput>
  readonly stopOnError: boolean
  readonly maxBytes: number | undefined
}

/** Decodes the entire batch before any step can execute. */
export const readBatchArguments = (value: Schema.Json): BatchArguments | undefined => {
  if (!isJsonObject(value)) return undefined

  const decoded = Schema.decodeUnknownOption(BatchArgumentsSchema)(value)

  if (Option.isNone(decoded)) return undefined

  const steps = decoded.value.steps.map((step) => ({
    id: step.id,
    name: step.name,
    stepArguments: step.arguments,
    select: step.select,
  }))

  return {
    steps,
    stopOnError: decoded.value.stopOnError !== false,
    maxBytes: decoded.value.maxBytes,
  }
}

/** The optional paging fields of `result_read` and `tool_call` arguments. */
export const readOptionalNumber = (object: JsonObject, field: string): number | undefined => {
  const value = object[field]

  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined
}

export const readOptionalString = (object: JsonObject, field: string): string | undefined => {
  const value = object[field]

  return Predicate.isString(value) ? value : undefined
}

/** The names array of `tools_describe` arguments. */
export const readNamesList = (value: Schema.Json): ReadonlyArray<string> => {
  if (!isJsonObject(value)) return []

  const names = value.names

  if (!Array.isArray(names)) return []

  const out: Array<string> = []

  for (const entry of names) {
    if (Predicate.isString(entry)) out.push(entry)
  }

  return out
}
