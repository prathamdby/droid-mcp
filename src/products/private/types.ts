/**
 * Shared product types. These shapes carry narrow options into the product
 * roots; a lower module never sees a global configuration object.
 */
import type * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../../authority/index.ts"

/** The presentation profile a server product advertises. */
export type ProductProfile = "compact" | "full"

/** Options every product assembly shares. */
export interface AssemblyOptions {
  /** Hard autonomy cap for every authority decision; defaults to `medium`. */
  readonly maxAutonomy?: AutonomyLevel | undefined
  /**
   * Legacy `--shared-sessions` operator opt-in. Defaults to `false`: strict
   * per-caller session isolation. Never shares artifacts, guidance receipts
   * or authority grants across callers.
   */
  readonly sharedSessions?: boolean | undefined
  /**
   * Legacy `--allow-unverified-daemon-authority` operator passthrough.
   * Defaults to `false`: daemon load/queued-work operations whose effective
   * authority cannot be proven fail closed with `authority_unverifiable`.
   * The passthrough never bypasses a known denial and is never reported as
   * verified.
   */
  readonly allowUnverifiedDaemonAuthority?: boolean | undefined
  /** Require the guidance receipt before session operations; default true. */
  readonly guidanceRequired?: boolean | undefined
  /** Paths the workspace owner accepts as permitted roots. */
  readonly workspaceRoots?: ReadonlyArray<string> | undefined
  /** Executable used for local sessions. Defaults to `"droid"`. */
  readonly droidPath?: string | undefined
  /** Executable arguments for local sessions; defaults to the exec dialect's. */
  readonly droidArgs?: ReadonlyArray<string> | undefined
  /** Extra environment entries handed to the local executable. */
  readonly droidEnv?: Readonly<Record<string, string>> | undefined
  /** Daemon endpoint the link dials, when the daemon provider is installed. */
  readonly daemonEndpoint?: DaemonEndpointOptions | undefined
  /** Credentials for the daemon handshake. */
  readonly daemonAuth?: DaemonAuthOptions | undefined
  /** Hosted API origin; installs the hosted provider when present. */
  readonly factoryBaseUrl?: string | undefined
  /** Hosted API bearer key. */
  readonly factoryApiKey?: string | undefined
  /** Prem Context origin; installs the context provider when present. */
  readonly contextBaseUrl?: string | undefined
  /** Extra headers for Context requests. */
  readonly contextHeaders?: Readonly<Record<string, string>> | undefined
  /**
   * Explicit provider omission control. `includeDaemon: false` drops the
   * daemon provider from the roster entirely — its operations, facets and
   * connection attempt never exist. Defaults to installing the daemon
   * provider.
   */
  readonly includeDaemon?: boolean | undefined
  /** Operations the daemon installation serves; unset means all served ones. */
  readonly daemonServedMethods?: ReadonlySet<string> | undefined
  /** Presentation profile. Defaults to `"compact"`. */
  readonly profile?: ProductProfile | undefined
  /** Server name reported in MCP negotiation. */
  readonly serverName?: string | undefined
  /** Server version reported in MCP negotiation. */
  readonly serverVersion?: string | undefined
}

export interface DaemonEndpointOptions {
  readonly socketPath?: string | undefined
  readonly host?: string | undefined
  readonly port?: number | undefined
}

export interface DaemonAuthOptions {
  readonly apiKey?: string | undefined
  readonly caller?: string | undefined
}

/** Options for the embedded product. */
export interface EmbeddedOptions extends AssemblyOptions {
  /** Trusted local principal name; there is no anonymous fallback. */
  readonly principal: string
}

/** Options for the stdio product. */
export interface StdioOptions extends AssemblyOptions {
  /** Trusted local principal name; defaults to `"stdio"`. */
  readonly principal?: string | undefined
  /** Input stream; defaults to `process.stdin`. */
  readonly input?: NodeJS.ReadableStream | undefined
  /** Output stream; defaults to `process.stdout`. */
  readonly output?: NodeJS.WritableStream | undefined
}

/** Options for the HTTP product. */
export interface HttpOptions extends AssemblyOptions {
  /** Bearer keys admitted on the listener; at least one is required. */
  readonly authTokens: ReadonlyArray<string>
  /** Bind host; defaults to `127.0.0.1`. */
  readonly host?: string | undefined
  /** Bind port; `0` selects an ephemeral port. Defaults to `0`. */
  readonly port?: number | undefined
  /** MCP path on the listener. Defaults to `/mcp`. */
  readonly path?: string | undefined
}

/** The headless runtime handle returned by `embedded`. */
export interface EmbeddedRuntime {
  /** Run one typed operation by name with its JSON input. */
  readonly invoke: (name: string, input: Schema.Json) => Promise<EmbeddedResult>
  /** Names of every installed operation in roster order. */
  readonly operations: () => ReadonlyArray<string>
  /** Close every acquired resource exactly once. Idempotent. */
  readonly close: () => Promise<void>
}

/** One embedded invocation outcome: the released value or its failure. */
export type EmbeddedResult =
  | { readonly ok: true; readonly value: Schema.Json }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** The running stdio server handle. */
export interface StdioServerHandle {
  /** Close the endpoint, framing pump and every acquired resource. */
  readonly close: () => Promise<void>
}

/** The running HTTP listener handle. */
export interface HttpServerHandle {
  /** The real bound port; never `0` once listening. */
  readonly port: number
  /** The host the listener is bound to. */
  readonly host: string
  /** The MCP path the listener serves. */
  readonly path: string
  /** Origin URL of the listener. */
  readonly url: string
  /** Stop listening, close every open connection and drain resources. */
  readonly close: () => Promise<void>
}

/** A probe target that must already exist. Neither variant owns a server. */
export type ExistingEndpoint =
  | { readonly transport: "http"; readonly url: string; readonly bearerToken?: string }
  | {
      readonly transport: "daemon"
      readonly endpoint:
        | { readonly socketPath: string }
        | { readonly host: string; readonly port: number }
      readonly auth?: DaemonAuthOptions
    }

/** No addresses, credentials, raw peer response or platform error messages. */
export type DiagnosticReport =
  | { readonly transport: "http"; readonly reachable: true; readonly status: number }
  | { readonly transport: "http"; readonly reachable: false }
  | { readonly transport: "daemon"; readonly reachable: boolean }
