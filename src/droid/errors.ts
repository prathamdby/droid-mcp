import * as Schema from "effect/Schema"

/**
 * Every failure the server reports crosses a boundary as `{ code, message }`.
 * The code is the `_tag`; nothing is thrown as a bare string.
 *
 * Tagged schemas (rather than plain classes) keep error branching on tags, so
 * handlers can use `Effect.catchTag` and the anti-slop Effect rules stay happy.
 */
export class WsError extends Schema.TaggedError<WsError>()("WsError", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class DaemonUnavailable extends Schema.TaggedError<DaemonUnavailable>()(
  "DaemonUnavailable",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
    /**
     * True only after the socket accepted the request bytes. Callers must not
     * send that request again unless the method is a pure read: the daemon may
     * already have executed it. Absent or false means it was not handed off.
     */
    delivered: Schema.optional(Schema.Boolean),
  },
) {}

export class DaemonAuthRejected extends Schema.TaggedError<DaemonAuthRejected>()(
  "DaemonAuthRejected",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export class DaemonProtocolError extends Schema.TaggedError<DaemonProtocolError>()(
  "DaemonProtocolError",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export class DaemonMethodUnsupported extends Schema.TaggedError<DaemonMethodUnsupported>()(
  "DaemonMethodUnsupported",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export class DaemonTimeout extends Schema.TaggedError<DaemonTimeout>()("DaemonTimeout", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class ExecFailed extends Schema.TaggedError<ExecFailed>()("ExecFailed", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class ExecTimeout extends Schema.TaggedError<ExecTimeout>()("ExecTimeout", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class FactoryApiKeyMissing extends Schema.TaggedError<FactoryApiKeyMissing>()(
  "FactoryApiKeyMissing",
  {
    message: Schema.String,
  },
) {}

export class ContextBaseUrlMissing extends Schema.TaggedError<ContextBaseUrlMissing>()(
  "ContextBaseUrlMissing",
  {
    message: Schema.String,
  },
) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export type ExecError = ExecFailed | ExecTimeout

export type DaemonError =
  | DaemonUnavailable
  | DaemonAuthRejected
  | DaemonProtocolError
  | DaemonMethodUnsupported
  | DaemonTimeout
  | FactoryApiKeyMissing
  | WsError

/** Every tagged failure the CLI and server can report. */
export const AppErrors = Schema.Union([
  WsError,
  DaemonUnavailable,
  DaemonAuthRejected,
  DaemonProtocolError,
  DaemonMethodUnsupported,
  DaemonTimeout,
  ExecFailed,
  ExecTimeout,
  FactoryApiKeyMissing,
  ContextBaseUrlMissing,
  ConfigError,
])

/** Snake-case codes are the stable contract; `_tag` stays for Effect matching. */
const ERROR_CODES = {
  WsError: "websocket_error",
  DaemonUnavailable: "daemon_unavailable",
  DaemonAuthRejected: "daemon_auth_rejected",
  DaemonProtocolError: "daemon_protocol_error",
  DaemonMethodUnsupported: "daemon_method_unsupported",
  DaemonTimeout: "daemon_timeout",
  ExecFailed: "exec_failed",
  ExecTimeout: "exec_timeout",
  FactoryApiKeyMissing: "factory_api_key_missing",
  ContextBaseUrlMissing: "context_base_url_missing",
  ConfigError: "config_invalid",
} satisfies { readonly [Tag in (typeof AppErrors.Type)["_tag"]]: string }

export const errorCode = (cause: unknown): string =>
  Schema.is(AppErrors)(cause) ? ERROR_CODES[cause._tag] : "unknown_error"

export const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message

  if (Schema.is(Schema.String)(cause)) return cause

  return "unknown error"
}
