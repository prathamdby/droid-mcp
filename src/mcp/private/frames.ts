/**
 * Frame admission: checks an externally supplied `Schema.Json` value into a
 * typed `McpFrame` without ever trusting the peer's shape. A malformed frame
 * fails before any dispatch, guidance gate or session lookup.
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { InvalidFrame, type McpFrame } from "./types.ts"

/** Methods the endpoint implements. Anything else is method-not-found. */
export const KNOWN_METHODS: ReadonlyArray<string> = [
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "skills/list",
  "skills/get",
]

const invalid = (reason: string, message: string): InvalidFrame =>
  new InvalidFrame({ message, reason })

const isRecord = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  value !== null && !Array.isArray(value) && value instanceof Object

/**
 * Validates one raw frame object. `params` is normalized to `{}` when
 * absent — a present non-object `params` is rejected.
 */
export const checkFrame = (raw: Schema.Json): McpFrame | InvalidFrame => {
  if (!isRecord(raw)) {
    return invalid("not_an_object", "frame must be a JSON object")
  }

  if (raw.jsonrpc !== undefined && raw.jsonrpc !== "2.0") {
    return invalid("bad_jsonrpc", 'frame jsonrpc must be "2.0" when present')
  }

  const method = raw.method

  if (!Predicate.isString(method) || method.length === 0) {
    return invalid("missing_method", "frame method must be a non-empty string")
  }

  const params = raw.params

  if (params !== undefined && !isRecord(params)) {
    return invalid("bad_params", "frame params must be an object when present")
  }

  const normalizedParams: Schema.Json = params === undefined ? {} : params

  const id = raw.id

  if (id === undefined) {
    return { kind: "notification", method, params: normalizedParams }
  }

  if (!Predicate.isString(id) && !(Predicate.isNumber(id) && Number.isFinite(id))) {
    return invalid("bad_id", "frame id must be a string or finite number")
  }

  return { kind: "request", id, method, params: normalizedParams }
}

/** Reads one object field as a string when it is one. */
export const stringField = (params: Schema.Json, field: string): string | undefined => {
  if (!isRecord(params)) return undefined

  const value = params[field]

  return Predicate.isString(value) ? value : undefined
}

/** Reads one object field as a finite number when it is one. */
export const numberField = (params: Schema.Json, field: string): number | undefined => {
  if (!isRecord(params)) return undefined

  const value = params[field]

  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined
}

/** Whether the params value is an object record. */
export const recordOf = (
  params: Schema.Json,
): { readonly [key: string]: Schema.Json } | undefined => (isRecord(params) ? params : undefined)
