/**
 * Pure CLI and environment parsing for the products. Nothing here imports a
 * service layer, a carrier or a provider: this file turns `argv` and `env`
 * into a narrow `CliConfig` that `runCli` dispatches to a product root.
 *
 * Security defaults hold in every mode: `sharedSessions` is `false` unless
 * `--shared-sessions` is passed, and `allowUnverifiedDaemonAuthority` is
 * `false` unless `--allow-unverified-daemon-authority` is passed. Neither a
 * profile choice, a transport choice, nor any other flag ever flips either
 * one; they are independent operator startup choices.
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../../authority/index.ts"
import type { DaemonAuthOptions, ProductProfile } from "./types.ts"

export class CliParseError extends Schema.TaggedError<CliParseError>()("CliParseError", {
  message: Schema.String,
}) {}

export interface CliEnv {
  readonly [key: string]: string | undefined
}

export interface CliIo {
  readonly input?: NodeJS.ReadableStream | undefined
  readonly output?: NodeJS.WritableStream | undefined
  readonly stderr?: NodeJS.WritableStream | undefined
  readonly onSignal?: ((handler: () => void) => void) | undefined
}

export interface CliConfig {
  readonly command: "serve" | "doctor" | "help" | "version"
  readonly transport: "stdio" | "http"
  readonly profile: ProductProfile
  readonly host: string
  readonly port: number
  readonly authTokens: ReadonlyArray<string>
  readonly sharedSessions: boolean
  readonly allowUnverifiedDaemonAuthority: boolean
  readonly maxAutonomy: AutonomyLevel
  readonly daemonUrl: string | undefined
  /** Resolved daemon endpoint: an explicit `--daemon-url`, else the runtime socket. */
  readonly daemonEndpoint:
    | { readonly socketPath: string }
    | { readonly host: string; readonly port: number }
  /** Credentials for the daemon handshake, derived from the Factory API key. */
  readonly daemonAuth: (DaemonAuthOptions & { readonly apiKey: string }) | undefined
  /**
   * Command that launches an owned daemon on the runtime socket when no
   * `--daemon-url` names an existing one. Always the local executable.
   */
  readonly daemonSpawn:
    | { readonly command: string; readonly args: ReadonlyArray<string> }
    | undefined
  readonly factoryApiKey: string | undefined
  readonly factoryBaseUrl: string | undefined
  readonly contextBaseUrl: string | undefined
  readonly contextHeaders: Readonly<Record<string, string>> | undefined
  readonly includeDaemon: boolean
  readonly guidanceRequired: boolean
  readonly droidPath: string
  /** Permitted workspace roots; `undefined` lets the assembly admit `cwd`. */
  readonly workspaceRoots: ReadonlyArray<string> | undefined
}

const PROFILES: ReadonlyArray<string> = ["compact", "full"]
const AUTONOMY_LEVELS: ReadonlyArray<string> = ["off", "low", "medium", "high"]
const CLI_VERSION = "0.1.0"

const error = (message: string): CliParseError => new CliParseError({ message })

const parsePort = (raw: string): number => {
  const value = Number(raw)

  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value > 65_535) {
    throw error("--port must be an integer between 0 and 65535")
  }

  return value
}

const splitTokens = (raw: string | undefined): ReadonlyArray<string> => {
  if (raw === undefined) return []

  const tokens: Array<string> = []

  for (const part of raw.split(",")) {
    const token = part.trim()

    if (token.length > 0) tokens.push(token)
  }

  return tokens
}

const nonEmpty = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.trim().length === 0 ? undefined : raw

/** Headers the server owns or that would break routing, authentication, negotiation or framing. */
const RESERVED_HEADERS: ReadonlyArray<string> = [
  "accept",
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

/** Whether a value carries a control character other than tab, or anything past Latin-1. */
const hasForbiddenHeaderValueCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code <= 0x08 || (code >= 0x0b && code <= 0x1f) || code === 0x7f || code > 0xff) {
      return true
    }
  }

  return false
}

/** Fetch strips surrounding spaces and tabs before sending, so the stored value matches the wire. */
const HEADER_WHITESPACE = /^[ \t]+|[ \t]+$/g

const HeaderRecord = Schema.Record(Schema.String, Schema.String)

/**
 * Parses `FACTORY_CONTEXT_HEADERS` under its documented contract: one JSON
 * object with string values, no reserved or case-insensitively duplicated
 * names, and no value an HTTP header cannot carry. Errors name the variable
 * and the offending header name, never a configured value.
 */
const parseContextHeaders = (
  raw: string | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined

  const invalid = (reason: string): CliParseError => error("FACTORY_CONTEXT_HEADERS " + reason)

  const headers = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(HeaderRecord))(raw),
  )

  if (headers === undefined) {
    throw invalid("must be a JSON object of string values")
  }

  const seen = new Set<string>()

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()

    if (!HEADER_NAME.test(name)) throw invalid("has an invalid header name")

    if (RESERVED_HEADERS.includes(lower)) throw invalid("may not set " + lower)

    if (seen.has(lower)) throw invalid("sets " + lower + " twice")

    if (hasForbiddenHeaderValueCharacter(value)) throw invalid("has an invalid value for " + name)

    seen.add(lower)
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, value.replace(HEADER_WHITESPACE, "")]),
  )
}

/** Port the `droid daemon` websocket listener binds when a URL names none. */
const DEFAULT_DAEMON_PORT = 7338

const DAEMON_ENDPOINT_FORMS = "unix:<path>, http://host:port, or ws://host:port"
const PLAINTEXT_DAEMON_URL_SCHEMES: ReadonlyArray<string> = ["http:", "ws:"]
const SECURE_DAEMON_URL_SCHEMES: ReadonlyArray<string> = ["https:", "wss:"]

/**
 * Resolves a `--daemon-url` into an endpoint. `unix:<path>` names a socket;
 * plaintext `http://` and `ws://` URLs name a host and port (defaulting the
 * port to the daemon websocket default). Secure schemes are rejected because
 * the daemon transport does not implement TLS. Any other shape is rejected up
 * front instead of being silently ignored at dial time.
 */
const parseDaemonEndpoint = (
  raw: string,
): { readonly socketPath: string } | { readonly host: string; readonly port: number } => {
  if (raw.startsWith("unix:")) {
    const socketPath = raw.slice("unix:".length)

    if (socketPath.length === 0) {
      throw error("--daemon-url unix: needs a socket path")
    }

    return { socketPath }
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw error("--daemon-url must be " + DAEMON_ENDPOINT_FORMS)
  }

  if (SECURE_DAEMON_URL_SCHEMES.includes(url.protocol)) {
    throw error(
      "--daemon-url scheme " + url.protocol + " is not supported; use " + DAEMON_ENDPOINT_FORMS,
    )
  }

  if (!PLAINTEXT_DAEMON_URL_SCHEMES.includes(url.protocol) || url.hostname.length === 0) {
    throw error("--daemon-url must be " + DAEMON_ENDPOINT_FORMS)
  }

  return url.port === ""
    ? { host: url.hostname, port: DEFAULT_DAEMON_PORT }
    : { host: url.hostname, port: parsePort(url.port) }
}

/** Socket the owned daemon listens on when no `--daemon-url` names a daemon. */
const defaultDaemonSocket = (env: CliEnv): string => {
  const runtimeDir =
    env["DROID_MCP_RUNTIME_DIR"] ?? (env["XDG_RUNTIME_DIR"] ?? "/tmp") + "/droid-mcp"

  return runtimeDir + "/daemon.sock"
}

/** The owned-daemon command line, mirroring the documented spawn default. */
const daemonSpawnArgs = (socketPath: string, parentPid: number): ReadonlyArray<string> => [
  "daemon",
  "--unix",
  socketPath,
  "--listen",
  "websocket",
  "--remote-control",
  "--parent-pid",
  String(parentPid),
]

const VALUE_FLAGS: ReadonlyArray<string> = [
  "--profile",
  "--host",
  "--port",
  "--auth-token",
  "--max-autonomy",
  "--daemon-url",
  "--factory-api-key",
  "--factory-base-url",
  "--context-base-url",
  "--workspace-root",
  "--droid-path",
]

const BOOLEAN_FLAGS: ReadonlyArray<string> = [
  "--http",
  "--shared-sessions",
  "--allow-unverified-daemon-authority",
  "--no-daemon",
  "--no-guidance",
]

/**
 * Parses `argv` (already sliced past the node/script entries) and `env` into
 * a narrow configuration. Unknown flags, missing values and invalid levels
 * raise `CliParseError`. Flags beat environment variables; absent both, the
 * locked defaults apply.
 */
export const parseCliArgs = (argv: ReadonlyArray<string>, env: CliEnv): CliConfig => {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  const workspaceRoots: Array<string> = []
  const authTokens: Array<string> = []
  let commandArgument: string | undefined
  let help = false
  let version = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === undefined) continue

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

      if (BOOLEAN_FLAGS.includes(name)) {
        if (equals >= 0) throw error(name + " does not take a value")

        booleans.add(name)
        continue
      }

      if (!VALUE_FLAGS.includes(name)) {
        throw error("unknown flag " + name)
      }

      const inline = equals < 0 ? undefined : argument.slice(equals + 1)
      const value = inline ?? argv[index + 1]

      if (
        value === undefined ||
        value.trim().length === 0 ||
        (inline === undefined && value.startsWith("--"))
      ) {
        throw error("missing value for " + name)
      }

      if (inline === undefined) index += 1

      if (name === "--auth-token") {
        authTokens.push(value)
        continue
      }

      if (name === "--workspace-root") {
        workspaceRoots.push(value)
        continue
      }

      values.set(name, value)
      continue
    }

    if (commandArgument !== undefined) {
      throw error("unexpected argument " + argument)
    }

    commandArgument = argument
  }

  if (
    commandArgument !== undefined &&
    commandArgument !== "serve" &&
    commandArgument !== "doctor" &&
    commandArgument !== "help" &&
    commandArgument !== "version"
  ) {
    throw error("unknown command " + commandArgument)
  }

  const command: "serve" | "doctor" | "help" | "version" = help
    ? "help"
    : version
      ? "version"
      : (commandArgument ?? "serve")

  const profileRaw = values.get("--profile") ?? env["DROID_MCP_PROFILE"] ?? "compact"

  if (!PROFILES.includes(profileRaw)) {
    throw error("--profile must be one of " + PROFILES.join(", "))
  }

  const maxAutonomyRaw = values.get("--max-autonomy") ?? env["DROID_MCP_MAX_AUTONOMY"] ?? "medium"

  if (!AUTONOMY_LEVELS.includes(maxAutonomyRaw)) {
    throw error("--max-autonomy must be one of " + AUTONOMY_LEVELS.join(", "))
  }

  const envTokens = splitTokens(env["DROID_MCP_KEYS"])
  const tokens = authTokens.length > 0 ? authTokens : envTokens

  const host = values.get("--host") ?? env["DROID_MCP_HOST"] ?? "127.0.0.1"
  const portRaw = values.get("--port") ?? env["DROID_MCP_PORT"]
  const droidPath = values.get("--droid-path") ?? env["DROID_MCP_DROID_PATH"] ?? "droid"
  const daemonUrl = nonEmpty(values.get("--daemon-url") ?? env["DROID_MCP_DAEMON_URL"])
  const factoryApiKey = nonEmpty(values.get("--factory-api-key") ?? env["FACTORY_API_KEY"])
  const daemonSocket = defaultDaemonSocket(env)

  // SAFETY: both enumerations are checked against their literal member
  // lists immediately above, so the narrowed value is exactly the union.
  return {
    command,
    transport: booleans.has("--http") ? "http" : "stdio",
    profile: profileRaw as ProductProfile,
    host,
    port: portRaw === undefined ? 0 : parsePort(portRaw),
    authTokens: tokens,
    sharedSessions: booleans.has("--shared-sessions"),
    allowUnverifiedDaemonAuthority: booleans.has("--allow-unverified-daemon-authority"),
    maxAutonomy: maxAutonomyRaw as AutonomyLevel,
    daemonUrl,
    daemonEndpoint:
      daemonUrl === undefined ? { socketPath: daemonSocket } : parseDaemonEndpoint(daemonUrl),
    daemonAuth:
      factoryApiKey === undefined
        ? undefined
        : {
            apiKey: factoryApiKey,
            metadata: { sdk: { language: "typescript", version: CLI_VERSION } },
          },
    daemonSpawn:
      daemonUrl === undefined
        ? { command: droidPath, args: daemonSpawnArgs(daemonSocket, process.pid) }
        : undefined,
    factoryApiKey,
    factoryBaseUrl: nonEmpty(values.get("--factory-base-url") ?? env["FACTORY_BASE_URL"]),
    contextBaseUrl: nonEmpty(values.get("--context-base-url") ?? env["FACTORY_CONTEXT_BASE_URL"]),
    contextHeaders: parseContextHeaders(env["FACTORY_CONTEXT_HEADERS"]),
    includeDaemon: !booleans.has("--no-daemon"),
    guidanceRequired: !booleans.has("--no-guidance"),
    droidPath,
    workspaceRoots: workspaceRoots.length > 0 ? workspaceRoots : undefined,
  }
}

const USAGE = `droid-mcp

Usage:
  droid-mcp serve [flags]
  droid-mcp doctor [flags]

Flags:
  --profile <compact|full>              Tool profile (DROID_MCP_PROFILE, default: compact)
  --http                                Serve over HTTP instead of stdio
  --host <host>                         Bind host (DROID_MCP_HOST, default: 127.0.0.1)
  --port <port>                         Bind port (DROID_MCP_PORT, default: 0 ephemeral)
  --auth-token <key>                    Bearer key; repeatable (DROID_MCP_KEYS comma-separated)
  --shared-sessions                     Share the session directory across callers (opt-in)
  --allow-unverified-daemon-authority   Permit daemon authority passthrough (opt-in)
  --max-autonomy <off|low|medium|high>  Authority ceiling (default: medium)
  --daemon-url <url>                    Use an existing daemon: unix:<path>,
                                        http://host:port, or ws://host:port.
                                        Default: spawn one on the runtime socket
  --no-daemon                           Omit the daemon provider entirely
  --no-guidance                         Disable the guidance receipt gate
  --factory-api-key <key>               Factory API key (FACTORY_API_KEY)
  --factory-base-url <url>              Factory API origin (FACTORY_BASE_URL)
  --context-base-url <url>              Prem Context origin (FACTORY_CONTEXT_BASE_URL)
                                        FACTORY_CONTEXT_HEADERS adds JSON object headers
  --workspace-root <path>               Permitted workspace root; repeatable
  --droid-path <path>                   Local executable path (DROID_MCP_DROID_PATH)
  -h, --help                            Show this help
  -v, --version                         Show the version
`

const writeErr = (io: CliIo | undefined, text: string): void => {
  io?.stderr?.write(text + "\n")
}

/**
 * Dispatches a parsed CLI configuration to the matching product root and
 * runs it until signal or stream end. `serve` over stdio needs no bearer
 * keys; `serve --http` refuses to bind without at least one configured key,
 * because an unauthenticated listener is never a product this host serves.
 */
export const runCli = async (
  argv: ReadonlyArray<string>,
  env: CliEnv,
  io?: CliIo,
): Promise<number> => {
  let config: CliConfig

  try {
    config = parseCliArgs(argv, env)
  } catch (failure) {
    const message = failure instanceof CliParseError ? failure.message : "invalid arguments"

    writeErr(io, "droid-mcp: " + message)

    return 2
  }

  if (config.command === "help") {
    io?.output?.write(USAGE + "\n")

    return 0
  }

  if (config.command === "version") {
    io?.output?.write(CLI_VERSION + "\n")

    return 0
  }

  if (config.command === "doctor") {
    const { doctor } = await import("./doctor.ts")

    const report =
      config.transport === "http"
        ? await doctor({
            transport: "http",
            url: "http://" + config.host + ":" + String(config.port) + "/mcp",
            bearerToken: config.authTokens[0],
          })
        : await doctor({
            transport: "daemon",
            endpoint:
              "socketPath" in config.daemonEndpoint
                ? { socketPath: config.daemonEndpoint.socketPath }
                : { host: config.daemonEndpoint.host, port: config.daemonEndpoint.port },
            auth: config.daemonAuth,
          })

    io?.output?.write(JSON.stringify(report) + "\n")

    return report.reachable ? 0 : 1
  }

  const baseOptions = {
    maxAutonomy: config.maxAutonomy,
    sharedSessions: config.sharedSessions,
    allowUnverifiedDaemonAuthority: config.allowUnverifiedDaemonAuthority,
    guidanceRequired: config.guidanceRequired,
    workspaceRoots: config.workspaceRoots,
    droidPath: config.droidPath,
    daemonEndpoint: config.daemonEndpoint,
    daemonAuth: config.daemonAuth,
    daemonSpawn: config.daemonSpawn,
    factoryBaseUrl: config.factoryBaseUrl,
    factoryApiKey: config.factoryApiKey,
    contextBaseUrl: config.contextBaseUrl,
    contextHeaders: config.contextHeaders,
    includeDaemon: config.includeDaemon,
    profile: config.profile,
  } as const

  if (config.transport === "stdio") {
    const { stdioServer } = await import("./stdio.ts")

    const handle = await stdioServer({
      ...baseOptions,
      input: io?.input,
      output: io?.output,
    })

    await new Promise<void>((resolve) => {
      const input = io?.input ?? process.stdin

      if ("on" in input) {
        input.on("end", resolve)
        input.on("close", resolve)
      }

      io?.onSignal?.(() => {
        void handle.close().then(resolve, resolve)
      })
    })

    await handle.close()

    return 0
  }

  if (config.authTokens.length === 0) {
    writeErr(io, "droid-mcp: serving HTTP requires at least one bearer key")

    return 2
  }

  const { httpServer } = await import("./http.ts")

  const handle = await httpServer({
    ...baseOptions,
    authTokens: config.authTokens,
    host: config.host,
    port: config.port,
  })

  io?.output?.write("listening on " + handle.url + handle.path + "\n")

  await new Promise<void>((resolve) => {
    io?.onSignal?.(() => {
      void handle.close().then(resolve, resolve)
    })
  })

  return 0
}
