import { connect } from "node:net"

import * as Schema from "effect/Schema"

import type { Config } from "../../src/config.ts"

/** Test bodies are JSON, never `unknown`: the boundary decode happens here. */
export type Json = Schema.Json

/**
 * Waits until a spawned server answers on its port.
 *
 * A port that was just released sits in `TIME_WAIT`, and this host answers a
 * connect to it by holding the SYN rather than refusing it, so a plain `fetch`
 * can hang until its own timeout. A bounded connect, retried, is the reliable
 * readiness check, and a `GET` that is not the startup `503` proves the MCP
 * route is attached.
 */
export const waitForPort = async (port: number, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" })

      const settle = (value: boolean): void => {
        socket.destroy()
        resolve(value)
      }

      socket.setTimeout(1_000)
      socket.once("connect", () => {
        settle(true)
      })
      socket.once("timeout", () => {
        settle(false)
      })
      socket.once("error", () => {
        settle(false)
      })
    })

    if (connected) {
      const ready = await fetch("http://127.0.0.1:" + String(port) + "/mcp", {
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      }).then(
        (response) => response.status !== 503,
        () => false,
      )

      if (ready) return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error("nothing accepted on 127.0.0.1:" + String(port))
}

export interface TestServer {
  readonly post: (body: Json, headers?: Record<string, string>) => Promise<Response>
  readonly request: (method: string, headers?: Record<string, string>) => Promise<Response>
  readonly dispose: () => Promise<void>
}

export interface TestServerOptions {
  readonly config: Config
  readonly keys: ReadonlyArray<string>
  readonly allowedOrigins?: ReadonlyArray<string>
}

/**
 * The same layers the server runs, exposed as a web handler. No port, no
 * subprocess, so the transport tests exercise real HTTP semantics.
 */
export const startServer = async (options: TestServerOptions): Promise<TestServer> => {
  const { mcpLayer } = await import("../../src/http/server.ts")
  const auth = await import("../../src/http/auth.ts")
  const Layer = await import("effect/Layer")
  const HttpRouter = await import("effect/http/HttpRouter")

  const keyring = auth.keyringFrom(options.keys)

  const serverOptions = { config: options.config, keys: options.keys }

  const layerOptions =
    options.allowedOrigins === undefined
      ? serverOptions
      : { ...serverOptions, allowedOrigins: options.allowedOrigins }

  const app = mcpLayer(layerOptions).pipe(Layer.provide(auth.layer(keyring)))

  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

  return {
    post: (body, headers = {}) =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      ),
    request: (method, headers = {}) =>
      handler(
        new Request("http://localhost/mcp", {
          method,
          headers: { accept: "application/json, text/event-stream", ...headers },
        }),
      ),
    dispose,
  }
}

export interface InitializeResult {
  readonly body: Json | undefined
  readonly sessionId: string | null
  readonly response: Response
}

export const initialize = async (
  server: TestServer,
  protocolVersion: string,
  headers: Record<string, string> = {},
): Promise<InitializeResult> => {
  const response = await server.post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    },
    headers,
  )

  const body = await readBody(response)

  return { body, sessionId: response.headers.get("mcp-session-id"), response }
}

const decodeJson = (text: string): Json => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text))

/** Reads a JSON response or the first SSE `data:` line. */
export const readBody = async (response: Response): Promise<Json | undefined> => {
  const text = await response.text()

  if (text.trim().length === 0) return undefined

  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim()

        if (payload.length > 0) return decodeJson(payload)
      }
    }

    return undefined
  }

  return decodeJson(text)
}

/** Decodes a response body into a test's expected shape, failing on mismatch. */
export const expectBody = <A>(schema: Schema.Codec<A>, body: Json | undefined): A =>
  Schema.decodeUnknownSync(schema)(body)
