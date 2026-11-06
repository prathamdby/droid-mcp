import * as Schema from "effect/Schema"

import type { JsonValue } from "./protocol.ts"
import { JSONRPC_VERSION, LEGACY_FACTORY_API_VERSION } from "./protocol.ts"

/**
 * `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
 * speaks the same envelope as the daemon, so both transports share
 * `protocol.ts` parsing. Only the method names and the process lifecycle differ.
 */
export const EXEC_METHOD = {
  initialize: "droid.initialize_session",
  updateSettings: "droid.update_session_settings",
  addUserMessage: "droid.add_user_message",
  interrupt: "droid.interrupt_session",
  close: "droid.close_session",
  requestPermission: "droid.request_permission",
  askUser: "droid.ask_user",
  pickOptions: "droid.pick_options",
  sessionNotification: "droid.session_notification",
} as const

/** The CLI rejects `--auto` and friends in this mode; settings go through JSON-RPC. */
export const EXEC_ARGS = [
  "exec",
  "--input-format",
  "stream-jsonrpc",
  "--output-format",
  "stream-jsonrpc",
] as const

/**
 * The upstream identity the SDK sends. The CLI records it for telemetry and
 * accepts ours, which is what makes the server distinguishable from the SDK.
 */
export const execEnvironment = (
  base: Readonly<Record<string, string | undefined>>,
  version: string,
) => ({
  ...base,
  FACTORY_UPSTREAM_CLIENT_TYPE: "sdk",
  FACTORY_UPSTREAM_SDK: "droid-mcp/" + version,
})

export const InitializeResultSchema = Schema.Struct({
  sessionId: Schema.String,
  hostId: Schema.optional(Schema.String),
  settings: Schema.optional(Schema.Json),
})

export type InitializeResult = typeof InitializeResultSchema.Type

export const SessionNotificationSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  notification: Schema.Struct({
    type: Schema.String,
  }),
})

export type SessionNotification = typeof SessionNotificationSchema.Type

/** Server-initiated requests the hub either answers or bridges to the caller. */
export const PROMPT_METHODS = [
  EXEC_METHOD.requestPermission,
  EXEC_METHOD.askUser,
  EXEC_METHOD.pickOptions,
] as const

export type PromptMethod = (typeof PROMPT_METHODS)[number]

export const isPromptMethod = (method: string): method is PromptMethod =>
  PROMPT_METHODS.some((candidate) => candidate === method)

export const responseEnvelope = (
  id: string,
  result: JsonValue,
  protocolVersion: string,
): JsonValue => ({
  jsonrpc: JSONRPC_VERSION,
  factoryApiVersion: LEGACY_FACTORY_API_VERSION,
  factoryProtocolVersion: protocolVersion,
  type: "response",
  id,
  result,
})

export const errorResponseEnvelope = (
  id: string,
  code: number,
  message: string,
  protocolVersion: string,
): JsonValue => ({
  jsonrpc: JSONRPC_VERSION,
  factoryApiVersion: LEGACY_FACTORY_API_VERSION,
  factoryProtocolVersion: protocolVersion,
  type: "response",
  id,
  error: { code, message },
})
