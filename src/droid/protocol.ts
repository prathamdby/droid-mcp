import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The daemon's JSON-RPC envelope.
 *
 * The SDK pins `1.269.0`, but a daemon reports its own version in every
 * response and rejects requests that carry a different one. The client adopts
 * the version a daemon reports and retries once (`daemon-client.ts`).
 */

export const JSONRPC_VERSION = "2.0"
export const LEGACY_FACTORY_API_VERSION = "1.0.0"

/** The version the SDK at 0.10.0 pins. Used only until a daemon reports its own. */
export const SDK_PROTOCOL_VERSION = "1.269.0"

export const METHOD = {
  authenticate: "daemon.authenticate",
  /**
   * The outline calls this `daemon.list_sessions`; that method does not exist.
   * The daemon lists its session store through `daemon.list_available_sessions`
   * (paginated, `limit` required) and its live handles through
   * `daemon.list_opened_sessions`.
   */
  listSessions: "daemon.list_available_sessions",
  listOpenedSessions: "daemon.list_opened_sessions",
} as const

/** First page of the session store, matching the SDK's default listing window. */
export const SESSION_LIST_LIMIT = 50

export type JsonValue = Schema.Json

export const JsonRpcErrorSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Json),
})

export type JsonRpcError = typeof JsonRpcErrorSchema.Type

/** A response the daemon sends, before or after a protocol-version adoption. */
export const ResponseEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.String,
  factoryApiVersion: Schema.optional(Schema.String),
  factoryProtocolVersion: Schema.optional(Schema.String),
  type: Schema.Literal("response"),
  id: Schema.NullOr(Schema.String),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(JsonRpcErrorSchema),
})

export type ResponseEnvelope = typeof ResponseEnvelopeSchema.Type

export const NotificationEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("notification"),
  method: Schema.String,
  params: Schema.optional(Schema.Json),
})

export type NotificationEnvelope = typeof NotificationEnvelopeSchema.Type

export const IncomingRequestEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("request"),
  id: Schema.String,
  method: Schema.String,
  params: Schema.optional(Schema.Json),
})

export type IncomingRequestEnvelope = typeof IncomingRequestEnvelopeSchema.Type

export const ServerMessageSchema = Schema.Union([
  ResponseEnvelopeSchema,
  NotificationEnvelopeSchema,
  IncomingRequestEnvelopeSchema,
])

export type ServerMessage = typeof ServerMessageSchema.Type

export const RequestEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.String,
  factoryApiVersion: Schema.String,
  factoryProtocolVersion: Schema.String,
  type: Schema.Literal("request"),
  id: Schema.String,
  method: Schema.String,
  params: Schema.optional(Schema.Json),
})

export type RequestEnvelope = typeof RequestEnvelopeSchema.Type

/** Builds the envelope the daemon accepts; omitted params are absent, not null. */
export const requestEnvelope = (
  id: string,
  method: string,
  params: JsonValue | undefined,
  protocolVersion: string,
): RequestEnvelope => {
  const base = {
    jsonrpc: JSONRPC_VERSION,
    factoryApiVersion: LEGACY_FACTORY_API_VERSION,
    factoryProtocolVersion: protocolVersion,
    type: "request" as const,
    id,
    method,
  }

  return params === undefined ? base : { ...base, params }
}

/**
 * Validates a hand-built payload at the wire boundary. Every caller keeps its
 * typed options object; this is where it becomes JSON.
 */
export const toJsonValue = <T>(value: T): JsonValue => Schema.decodeUnknownSync(Schema.Json)(value)

/** A payload whose omitted fields are simply absent. */
export interface JsonFields {
  readonly [key: string]: JsonValue
}

/** Drops omitted fields so a hand-built payload is JSON, not JSON plus undefined. */
export const presentFields = (payload: Record<string, JsonValue | undefined>): JsonFields => {
  const result: Record<string, JsonValue> = {}

  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) result[key] = value
  }

  return result
}

export const isResponseEnvelope = (value: unknown): value is ResponseEnvelope =>
  Schema.is(ResponseEnvelopeSchema)(value)

export const isServerRequestEnvelope = (value: unknown): value is IncomingRequestEnvelope =>
  Schema.is(IncomingRequestEnvelopeSchema)(value)

export const isNotificationEnvelope = (value: unknown): value is NotificationEnvelope =>
  Schema.is(NotificationEnvelopeSchema)(value)

/** Parses one socket line; anything the daemon could not have sent is dropped. */
export const parseServerMessage = (line: string): ServerMessage | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(ServerMessageSchema)(JSON.parse(line)))
  } catch {
    return undefined
  }
}

export interface ProtocolMismatch {
  readonly local: string
  readonly peer: string
}

const ProtocolMismatchSchema = Schema.Struct({
  protocolVersionMismatch: Schema.Struct({
    localFactoryProtocolVersion: Schema.String,
    peerFactoryProtocolVersion: Schema.String,
  }),
})

/**
 * A mismatch arrives two ways: `-32601` with `data.protocolVersionMismatch`
 * (the outline's observation) and `-32001` with the same data (auth requests on
 * CLI 1.4.1). Both are recoverable by adopting `local`.
 */
export const protocolMismatch = (error: JsonRpcError | undefined): ProtocolMismatch | undefined => {
  if (error?.data === undefined) return undefined

  const decoded = Schema.decodeUnknownOption(ProtocolMismatchSchema)(error.data)

  return Option.getOrUndefined(
    Option.map(decoded, (value): ProtocolMismatch => ({
      local: value.protocolVersionMismatch.localFactoryProtocolVersion,
      peer: value.protocolVersionMismatch.peerFactoryProtocolVersion,
    })),
  )
}

export const isAuthenticationErrorCode = (code: number): boolean => code === -32001
export const isMethodNotFoundCode = (code: number): boolean => code === -32601
