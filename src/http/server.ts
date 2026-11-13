import * as http from "node:http"

import { NodeHttpServer } from "@effect/platform-node"
import * as McpServer from "effect/ai/McpServer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Layer from "effect/Layer"

import type { Config } from "../config.ts"
import { daemonLayer } from "../droid/daemon-service.ts"
import { restLayer } from "../droid/rest-service.ts"
import { sessionHubLayer } from "../droid/turns.ts"
import type { SessionHubOptions } from "../droid/turns.ts"
import { effectLoggingLayer } from "../log.ts"
import { createLogger } from "../log.ts"
import { MCP_PROTOCOLS } from "../mcp-protocols.ts"
import { surfaceFor } from "../tools/compact.ts"
import { resultStoreLayer } from "../tools/results.ts"
import {
  INSTRUCTIONS,
  instructionsFor,
  registrations as skillRegistrations,
  skillGateLayer,
} from "../tools/skill.ts"
import { VERSION } from "../version.ts"
import * as auth from "./auth.ts"
import { keyringFrom } from "./auth.ts"

export { INSTRUCTIONS }

export interface ServerOptions {
  readonly config: Config
  readonly keys: ReadonlyArray<string>
  readonly allowedOrigins?: ReadonlyArray<string>
}

/** The `layerHttp` options this server is built from. */
type HttpLayerOptions = Parameters<typeof McpServer.layerHttp>[0]

/** Options for `McpServer.layerHttp`; origins are omitted rather than empty. */
const httpLayerOptions = (options: ServerOptions): HttpLayerOptions => {
  const base: HttpLayerOptions = {
    name: "droid-mcp",
    version: VERSION,
    instructions: instructionsFor(options.config.toolProfile),
    path: "/mcp",
    protocols: [...MCP_PROTOCOLS],
    allowSessionTermination: true,
  }

  const origins = options.allowedOrigins

  if (origins === undefined || origins.length === 0) return base

  return { ...base, allowedOrigins: origins }
}

/**
 * The MCP endpoint: Streamable HTTP on `/mcp`, every request behind a bearer
 * key, and the negotiated protocol revisions in the order the design chose
 * (2025-11-25 first, because it binds `initialize`).
 */
const hubOptions = (config: Config): SessionHubOptions => ({
  droidPath: config.droidPath,
  version: VERSION,
  logger: createLogger(config.logLevel),
  env:
    config.factoryApiKey === undefined
      ? process.env
      : { ...process.env, FACTORY_API_KEY: config.factoryApiKey },
  promptTimeoutMs: config.promptTimeoutMs,
  requestTimeoutMs: config.requestTimeoutMs,
})

export const mcpLayer = (options: ServerOptions) => {
  const { toolkit, handlers } = surfaceFor(options.config)
  const skillGate = skillGateLayer(options.config.requireSkill)

  // SAFETY: every handler this layer needs is provided just above; the
  // registration's requirement type is widened by the generated toolkit.
  const toolRegistrations = McpServer.toolkit(toolkit).pipe(
    Layer.provide(handlers),
    Layer.provide(skillGate),
    Layer.provide(resultStoreLayer),
    Layer.provide(sessionHubLayer(hubOptions(options.config))),
    Layer.provide(daemonLayer(options.config)),
    Layer.provide(restLayer(options.config, options.keys)),
  ) as Layer.Layer<never, never, never>

  const registrations = Layer.mergeAll(
    toolRegistrations,
    skillRegistrations.pipe(Layer.provide(skillGate)),
  )

  return McpServer.layerHttp({ ...httpLayerOptions(options), registrations })
}

/**
 * The server socket starts listening before the MCP route exists, so a request
 * that arrives during startup is accepted. Node would drop it silently and the
 * client would wait forever. This early handler answers those requests with
 * `503` until the router attaches its own `request` listener; from then on it
 * stands aside and the router owns the response.
 */
const createServer = (): http.Server => {
  const server = http.createServer()

  server.on("request", (_request, response) => {
    if (server.listenerCount("request") > 1) return

    response.writeHead(503, { "content-type": "application/json", "retry-after": "1" })
    response.end(JSON.stringify({ error: "starting" }))
  })

  return server
}

/**
 * Auth wraps the MCP layer, so a request without a valid key never reaches a
 * tool handler.
 */
export const serve = (options: ServerOptions) => {
  const keyring = keyringFrom(options.keys)
  const App = mcpLayer(options).pipe(Layer.provide(auth.layer(keyring)))

  return HttpRouter.serve(App).pipe(
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        host: options.config.host,
        port: options.config.port,
      }),
    ),
    Layer.provide(effectLoggingLayer(options.config.logLevel)),
  )
}
