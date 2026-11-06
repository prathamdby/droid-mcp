import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { ConfigError, errorMessage } from "./droid/errors.ts"
import { LOG_LEVELS, isLogLevel } from "./log.ts"
import type { LogLevel } from "./log.ts"

export { ConfigError }

export type Command = "doctor" | "serve" | "help" | "version"

export type AutonomyLevel = "off" | "low" | "medium" | "high"

export const AUTONOMY_LEVELS: ReadonlyArray<AutonomyLevel> = ["off", "low", "medium", "high"]

export interface Config {
  readonly command: Command
  readonly socketPath: string
  readonly runtimeDir: string
  readonly droidPath: string
  readonly host: string
  readonly port: number
  readonly keys: ReadonlyArray<string>
  readonly keysFile: string | undefined
  readonly maxAutonomy: AutonomyLevel
  readonly allowedOrigins: ReadonlyArray<string>
  readonly daemonUrl: string | undefined
  readonly factoryApiKey: string | undefined
  readonly factoryBaseUrl: string
  /** A Prem origin serving `/api/context`; never defaulted to the hosted API. */
  readonly factoryContextBaseUrl: string | undefined
  /** Extra headers for Context requests, such as a deployment's organization header. */
  readonly factoryContextHeaders: Readonly<Record<string, string>>
  readonly logLevel: LogLevel
  readonly promptTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly initializeTimeoutMs: number
}

const DEFAULT_PORT = 7337
const DEFAULT_KEYS_SEPARATOR = ","

const flagValues: ReadonlyArray<string> = [
  "--socket",
  "--droid-path",
  "--host",
  "--port",
  "--keys-file",
  "--max-autonomy",
  "--allow-origin",
  "--runtime-dir",
  "--daemon-url",
  "--factory-base-url",
  "--log-level",
  "--prompt-timeout",
  "--request-timeout",
  "--initialize-timeout",
]

const isFlagValue = (name: string): boolean => flagValues.some((flag) => flag === name)

const parseNumber = (name: string, raw: string): number => {
  const value = Number(raw)

  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError({ message: name + " must be a positive number" })
  }

  return value
}

const parsePort = (raw: string): number => {
  const value = Number(raw)

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError({ message: "--port must be an integer between 1 and 65535" })
  }

  return value
}

const splitKeys = (raw: string | undefined): ReadonlyArray<string> =>
  raw === undefined
    ? []
    : raw
        .split(DEFAULT_KEYS_SEPARATOR)
        .map((key) => key.trim())
        .filter((key) => key.length > 0)

const parseAutonomy = (raw: string): AutonomyLevel => {
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") return raw
  throw new ConfigError({
    message: "--max-autonomy must be one of " + AUTONOMY_LEVELS.join(", "),
  })
}

const parseLogLevel = (raw: string): LogLevel => {
  if (isLogLevel(raw)) return raw
  throw new ConfigError({ message: "--log-level must be one of " + LOG_LEVELS.join(", ") })
}

/**
 * A base URL must be a bare http(s) origin: request paths are appended to it,
 * so a path, query, or embedded credentials would silently change every call.
 */
export const parseOrigin = (name: string, raw: string): string => {
  const invalid = (reason: string): ConfigError =>
    new ConfigError({ message: name + " must be an http(s) origin: " + reason })

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw invalid("not a URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("unsupported scheme")

  if (url.username !== "" || url.password !== "") throw invalid("credentials are not allowed")

  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw invalid("query and fragment are not allowed")
  }

  if (url.pathname !== "/") throw invalid("a path is not allowed")

  return url.origin
}

/** Headers the server owns or that would break framing; operators cannot set them. */
const RESERVED_HEADERS: ReadonlyArray<string> = [
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "te",
  "upgrade",
  "keep-alive",
  "expect",
  "trailer",
]

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/

const HeaderRecord = Schema.Record(Schema.String, Schema.String)

export const parseContextHeaders = (raw: string | undefined): Readonly<Record<string, string>> => {
  if (raw === undefined || raw.trim().length === 0) return {}

  const invalid = (reason: string): ConfigError =>
    new ConfigError({ message: "FACTORY_CONTEXT_HEADERS " + reason })

  let parsed: Schema.Json

  try {
    parsed = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(raw))
  } catch {
    throw invalid("must be a JSON object of string values")
  }

  const headers = Option.getOrUndefined(Schema.decodeUnknownOption(HeaderRecord)(parsed))

  if (headers === undefined) {
    throw invalid("must be a JSON object of string values")
  }

  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw invalid("has an invalid header name")

    if (RESERVED_HEADERS.includes(name.toLowerCase())) {
      throw invalid("may not set " + name.toLowerCase())
    }

    if (HEADER_VALUE_FORBIDDEN.test(value)) throw invalid("has an invalid value for " + name)
  }

  return headers
}

const nonEmpty = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.trim().length === 0 ? undefined : raw

const parseCommand = (raw: string | undefined): Command => {
  if (raw === undefined) return "help"

  if (raw === "doctor" || raw === "serve") return raw
  throw new ConfigError({ message: "unknown command " + raw })
}

export const parseConfig = (
  argv: ReadonlyArray<string>,
  env: { readonly [key: string]: string | undefined },
): Config => {
  const values = new Map<string, string>()
  const origins: Array<string> = []
  let commandArgument: string | undefined
  let help = false
  let version = false

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]

    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }

    if (argument === "--version" || argument === "-v") {
      version = true
      continue
    }

    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=")
      const name = equals < 0 ? argument : argument.slice(0, equals)

      if (!isFlagValue(name)) {
        throw new ConfigError({ message: "unknown flag " + name })
      }

      const inline = equals < 0 ? undefined : argument.slice(equals + 1)
      const value = inline ?? argv[index + 1]

      if (value === undefined) {
        throw new ConfigError({ message: "missing value for " + name })
      }

      if (inline === undefined) index += 1

      if (name === "--allow-origin") {
        origins.push(value)
      } else {
        values.set(name, value)
      }

      continue
    }

    if (commandArgument !== undefined) {
      throw new ConfigError({ message: "unexpected argument " + argument })
    }

    commandArgument = argument
  }

  const command: Command = help ? "help" : version ? "version" : parseCommand(commandArgument)

  const runtimeDir =
    values.get("--runtime-dir") ??
    env["DROID_MCP_RUNTIME_DIR"] ??
    (env["XDG_RUNTIME_DIR"] ?? "/tmp") + "/droid-mcp"

  const socketPath =
    values.get("--socket") ?? env["DROID_MCP_SOCKET"] ?? runtimeDir + "/daemon.sock"

  const maxAutonomyRaw = values.get("--max-autonomy") ?? env["DROID_MCP_MAX_AUTONOMY"] ?? "medium"
  const logLevelRaw = values.get("--log-level") ?? env["DROID_MCP_LOG_LEVEL"] ?? "info"
  const allowedOrigins = origins.length > 0 ? origins : splitKeys(env["DROID_MCP_ALLOWED_ORIGINS"])

  return {
    command,
    socketPath,
    runtimeDir,
    droidPath: values.get("--droid-path") ?? env["DROID_MCP_DROID_PATH"] ?? "droid",
    host: values.get("--host") ?? env["DROID_MCP_HOST"] ?? "127.0.0.1",
    port:
      values.get("--port") !== undefined
        ? parsePort(values.get("--port") ?? "")
        : env["DROID_MCP_PORT"] !== undefined
          ? parsePort(env["DROID_MCP_PORT"] ?? "")
          : DEFAULT_PORT,
    keys: splitKeys(env["DROID_MCP_KEYS"]),
    keysFile: values.get("--keys-file"),
    maxAutonomy: parseAutonomy(maxAutonomyRaw),
    allowedOrigins,
    daemonUrl: values.get("--daemon-url") ?? env["DROID_MCP_DAEMON_URL"],
    factoryApiKey: env["FACTORY_API_KEY"],
    factoryBaseUrl: parseOrigin(
      "FACTORY_BASE_URL",
      values.get("--factory-base-url") ??
        nonEmpty(env["FACTORY_BASE_URL"]) ??
        "https://api.factory.ai",
    ),
    factoryContextBaseUrl:
      nonEmpty(env["FACTORY_CONTEXT_BASE_URL"]) === undefined
        ? undefined
        : parseOrigin("FACTORY_CONTEXT_BASE_URL", env["FACTORY_CONTEXT_BASE_URL"] ?? ""),
    factoryContextHeaders: parseContextHeaders(env["FACTORY_CONTEXT_HEADERS"]),
    logLevel: parseLogLevel(logLevelRaw),
    promptTimeoutMs:
      values.get("--prompt-timeout") !== undefined
        ? parseNumber("--prompt-timeout", values.get("--prompt-timeout") ?? "")
        : 300_000,
    requestTimeoutMs:
      values.get("--request-timeout") !== undefined
        ? parseNumber("--request-timeout", values.get("--request-timeout") ?? "")
        : 30_000,
    initializeTimeoutMs:
      values.get("--initialize-timeout") !== undefined
        ? parseNumber("--initialize-timeout", values.get("--initialize-timeout") ?? "")
        : 60_000,
  }
}

export const configError = (cause: unknown): ConfigError =>
  cause instanceof ConfigError ? cause : new ConfigError({ message: errorMessage(cause) })
