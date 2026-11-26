/**
 * Level 9 `products` module: configuration, operator flags, product entry
 * points and lifecycle.
 *
 * This module is the sole cross-module composition root. Importing this
 * file loads only pure configuration parsing — neither `mcp` nor any
 * carrier (`node:http`, `effect/ai/McpServer`) is touched. Each product
 * root is reached through a lazy literal `import()`:
 *
 *   - `embedded` composes the caller-scoped capability pipeline without any
 *     carrier at all: no MCP endpoint, no HTTP server, no stdio framing.
 *   - `stdioServer` composes the same pipeline plus the MCP endpoint and
 *     newline-delimited JSON-RPC framing over the given or process streams.
 *   - `httpServer` composes the pipeline plus bearer admission (full
 *     64-hex SHA-256 principal identity, never a short prefix) and a
 *     Streamable HTTP listener on a real ephemeral-capable bind.
 *
 * Security defaults hold at the product boundary: `sharedSessions` defaults
 * to `false` and is implied by nothing else; `allowUnverifiedDaemonAuthority`
 * defaults to `false` and is implied by nothing else. Neither a profile
 * choice, a transport choice, nor a missing credential flips either one.
 */
import { CliParseError, parseCliArgs, runCli } from "./private/parse.ts"
import type { CliConfig, CliEnv, CliIo } from "./private/parse.ts"
import type {
  DiagnosticReport,
  EmbeddedOptions,
  EmbeddedResult,
  EmbeddedRuntime,
  ExistingEndpoint,
  HttpOptions,
  HttpServerHandle,
  StdioOptions,
  StdioServerHandle,
} from "./private/types.ts"

export type {
  CliConfig,
  CliEnv,
  CliIo,
  DiagnosticReport,
  EmbeddedOptions,
  EmbeddedResult,
  EmbeddedRuntime,
  ExistingEndpoint,
  HttpOptions,
  HttpServerHandle,
  StdioOptions,
  StdioServerHandle,
}

export { CliParseError, parseCliArgs, runCli }

/**
 * Headless programmatic product. No MCP endpoint, no HTTP listener, no
 * stdio framing: importing this module and calling `embedded` never loads
 * `node:http` or `effect/ai/McpServer` even transitively.
 */
export const embedded = (options: EmbeddedOptions): Promise<EmbeddedRuntime> =>
  import("./private/embedded.ts").then((module) => module.embedded(options))

/**
 * Stdio MCP server product: binds a single local trusted caller, mounts
 * presentation and MCP, frames newline-delimited JSON-RPC over the given
 * or process streams, and closes cleanly.
 */
export const stdioServer = (options: StdioOptions): Promise<StdioServerHandle> =>
  import("./private/stdio.ts").then((module) => module.stdioServer(options))

/**
 * Streamable HTTP MCP server product: bearer admission through `caller`
 * with the full verified digest as principal identity, per-caller session
 * isolation by default, fail-closed daemon authority by default, and a real
 * ephemeral-capable listener that disposes every acquired resource on close.
 */
export const httpServer = (options: HttpOptions): Promise<HttpServerHandle> =>
  import("./private/http.ts").then((module) => module.httpServer(options))

/** Probes an existing endpoint without starting a listener or daemon. */
export const doctor = (options: ExistingEndpoint): Promise<DiagnosticReport> =>
  import("./private/doctor.ts").then((module) => module.doctor(options))
