/**
 * The Streamable HTTP MCP server product. This is the only file in the
 * tree allowed to touch `node:http`; the kernel never sees it.
 *
 * Admission is bearer evidence verified through `caller`'s timing-safe
 * verifier: possession of a configured key admits the caller whose
 * principal identity is the FULL 64-hex SHA-256 digest of the key — never
 * the legacy eight-hex prefix, so two keys sharing a prefix stay distinct
 * (locked divergence `full_digest_principal`).
 *
 * Per-caller session isolation is the default: the assembly builds the
 * callers registry and session directory with `sharedSessions: false`, and
 * only the explicit `--shared-sessions` opt-in (`sharedSessions: true`)
 * widens session visibility — never artifacts, receipts or authority.
 * Daemon authority fails closed unless the operator passed
 * `--allow-unverified-daemon-authority`.
 *
 * The HTTP transport is intentionally simple: one POST of one JSON-RPC
 * message per request, one JSON-RPC reply per response. Framing, session
 * state, guidance and authority all live in the caller-scoped pipeline
 * below; this file owns the carrier and nothing else.
 */
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { createBearerVerifier } from "../../caller/index.ts"
import type { Caller } from "../../caller/index.ts"
import type { McpEndpoint, PeerAbilities } from "../../mcp/index.ts"
import { assemblePipeline } from "./assembly.ts"
import { buildMcp, receiveRpc } from "./rpc.ts"
import type { HttpOptions, HttpServerHandle } from "./types.ts"

const PEER: PeerAbilities = { supportsForms: false, supportsSubscriptions: false }

const writeJson = (response: ServerResponse, status: number, body: Schema.Json): void => {
  const text = JSON.stringify(body)

  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text, "utf8"),
    "cache-control": "no-store",
  })
  response.end(text)
}

const readBody = (request: IncomingMessage, limit: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let total = 0

    request.on("data", (chunk: Buffer) => {
      total += chunk.length

      if (total > limit) {
        reject(new Error("body too large"))
        request.destroy()

        return
      }

      chunks.push(chunk)
    })

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })

    request.on("error", (error) => {
      reject(error)
    })
  })

/**
 * Starts the HTTP server product. Requires at least one bearer key; an
 * unauthenticated listener is never a product this host serves.
 */
export const httpServer = async (options: HttpOptions): Promise<HttpServerHandle> => {
  const verifier = createBearerVerifier(options.authTokens)

  if (verifier.size === 0) {
    throw new Error("httpServer requires at least one bearer key")
  }

  const assembly = await assemblePipeline(options)

  try {
    const mcpService = await buildMcp(assembly, options)
    const endpoints = new Map<Caller["id"], McpEndpoint>()
    const mcpPath = options.path ?? "/mcp"
    let origin = ""
    let closing: Promise<void> | undefined

    const endpointFor = (caller: Caller): McpEndpoint => {
      const existing = endpoints.get(caller.id)

      if (existing !== undefined) return existing

      const endpoint = Effect.runSync(
        Effect.flatMap(assembly.callers.conversation(caller), (conversation) =>
          mcpService.bind(assembly.view, caller, conversation, PEER),
        ),
      )

      endpoints.set(caller.id, endpoint)

      return endpoint
    }

    const handleRequest = async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      const url = request.url ?? "/"
      const path = url.split("?", 1)[0] ?? "/"

      if (path !== mcpPath) {
        writeJson(response, 404, { error: "not_found" })

        return
      }

      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" })
        response.end()

        return
      }

      if (request.headers.origin !== undefined && request.headers.origin !== origin) {
        writeJson(response, 403, { error: "origin_refused" })

        return
      }

      // Bearer admission: verified evidence only; raw keys and digests
      // never appear in logs, replies or public ids.
      const header = request.headers.authorization
      const evidence = verifier.verify(header)

      if (Option.isNone(evidence)) {
        response.writeHead(401, {
          "www-authenticate": "Bearer",
          "cache-control": "no-store",
        })
        response.end()

        return
      }

      const admitted = await Effect.runPromise(
        Effect.result(assembly.callers.admit(evidence.value)),
      )

      if (Result.isFailure(admitted)) {
        writeJson(response, 403, { error: "admission_refused" })

        return
      }

      let bodyText: string

      try {
        bodyText = await readBody(request, 4 * 1024 * 1024)
      } catch {
        writeJson(response, 413, { error: "body_too_large" })

        return
      }

      if (closing !== undefined) return

      const encoded = await receiveRpc(endpointFor(admitted.success), bodyText)

      if (encoded === undefined) {
        response.writeHead(202)
        response.end()

        return
      }

      writeJson(response, 200, encoded)
    }

    const server: Server = createServer((request, response) => {
      handleRequest(request, response).catch(() => {
        if (!response.headersSent) {
          writeJson(response, 500, { error: "internal_error" })
        } else {
          response.end()
        }
      })
    })

    const host = options.host ?? "127.0.0.1"
    const requestedPort = options.port ?? 0

    const addressHost = host.includes(":") ? "[" + host + "]" : host

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(requestedPort, host, () => {
        server.off("error", reject)
        resolve()
      })
    })

    const address = server.address()

    if (address === null || Schema.is(Schema.String)(address)) {
      throw new Error("listener did not bind a TCP port")
    }

    const port = address.port
    const url = "http://" + addressHost + ":" + String(port)

    origin = new URL(url).origin

    const shutdown = async (): Promise<void> => {
      const stopped = new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })

      try {
        await Promise.all([
          stopped,
          ...Array.from(endpoints.values(), (endpoint) =>
            Effect.runPromise(endpoint.close()).catch(() => undefined),
          ),
        ])
      } finally {
        endpoints.clear()
        await assembly.close()
      }
    }

    return { port, host, path: mcpPath, url, close: () => (closing ??= shutdown()) }
  } catch (failure) {
    await assembly.close().catch(() => undefined)

    throw failure
  }
}
