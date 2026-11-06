import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import * as Schema from "effect/Schema"

export interface ApiCall {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: string
}

export interface FakeFactoryApi {
  readonly baseUrl: string
  readonly calls: ReadonlyArray<ApiCall>
  readonly close: () => Promise<void>
}

const computer = {
  id: "c-1",
  name: "box",
  hostname: "box.local",
  providerType: "byom",
  status: "active",
  createdAt: 1,
  relayClientUrl: "wss://relay.example/c-1",
  remoteUser: "dev",
}

const template = {
  templateId: "t-1",
  repoUrl: "github.com/acme/app",
  templateName: "app",
  defaultBranch: "main",
  createdBy: "user-1",
  createdAt: 1,
  buildStatus: { status: "success" },
  lastUpdatedAt: 2,
}

const remoteSession = {
  sessionId: "s-1",
  title: "add a test",
  status: "idle",
  messageCount: 4,
  createdAt: 1,
  updatedAt: 2,
  computerId: "c-1",
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = ""

    request.on("data", (chunk) => {
      body += String(chunk)
    })
    request.on("end", () => {
      resolve(body)
    })
  })

/**
 * A stand-in for the hosted Factory API. It records every call and answers the
 * computer endpoints with the shapes the SDK validates.
 */
export const startFakeFactoryApi = async (): Promise<FakeFactoryApi> => {
  const calls: Array<ApiCall> = []

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request)
    const path = request.url ?? "/"
    const authorization = request.headers.authorization

    calls.push({ method: request.method ?? "GET", path, authorization, body })

    response.writeHead(200, { "content-type": "application/json" })

    if (path === "/api/v0/computers" && request.method === "GET") {
      response.end(JSON.stringify({ computers: [computer] }))

      return
    }

    if (path === "/api/v0/computers" && request.method === "POST") {
      response.end(JSON.stringify(computer))

      return
    }

    if (path.startsWith("/api/v0/machines/templates/")) {
      response.end(JSON.stringify(template))

      return
    }

    if (path.startsWith("/api/v0/machines/templates")) {
      response.end(
        JSON.stringify({
          templates: [template],
          pagination: { hasMore: false, nextCursor: null },
        }),
      )

      return
    }

    if (path.startsWith("/api/v0/sessions")) {
      response.end(
        JSON.stringify({
          sessions: [remoteSession],
          pagination: { hasMore: false, nextCursor: null },
        }),
      )

      return
    }

    if (path.startsWith("/api/v0/computers/") && path.endsWith("/metrics")) {
      response.end(JSON.stringify({ metrics: [] }))

      return
    }

    if (path.startsWith("/api/v0/computers/")) {
      response.end(request.method === "DELETE" ? JSON.stringify({}) : JSON.stringify(computer))

      return
    }

    response.end(JSON.stringify({}))
  }

  const server: Server = createServer((request, response) => {
    void handler(request, response)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = Schema.is(Schema.NullOr(Schema.String))(server.address())
    ? undefined
    : server.address()

  if (address === null || address === undefined || Schema.is(Schema.String)(address)) {
    throw new Error("fake API did not bind")
  }

  return {
    baseUrl: "http://127.0.0.1:" + String(address.port),
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}
