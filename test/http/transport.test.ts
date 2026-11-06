import * as Schema from "effect/Schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { expectBody, initialize, readBody, startServer } from "../support/mcp-http.ts"
import type { TestServer } from "../support/mcp-http.ts"

const KEY = "transport-test-key"

const InitializeSchema = Schema.Struct({
  result: Schema.Struct({
    serverInfo: Schema.Struct({ name: Schema.String }),
  }),
})

const DiscoverSchema = Schema.Struct({
  result: Schema.Struct({ supportedVersions: Schema.Array(Schema.String) }),
})

const ToolsListSchema = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
})

const ServerInfoCallSchema = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      version: Schema.String,
      protocols: Schema.Array(Schema.String),
    }),
  }),
})

const ErrorSchema = Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) })

let server: TestServer

beforeAll(async () => {
  server = await startServer({ config: testConfig(), keys: [KEY] })
})

afterAll(async () => {
  await server.dispose()
})

const authorized = { authorization: "Bearer " + KEY }

/** Streamable HTTP from a 2026-07-28 client: sessionless, `_meta`-negotiated. */
const STATELESS_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
}

const stateless = (id: number, method: string, params: Record<string, Schema.Json> = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: { ...params, _meta: STATELESS_META },
})

const statelessHeaders = (method: string, extra: Record<string, string> = {}) => ({
  ...authorized,
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": method,
  ...extra,
})

describe("auth over HTTP", () => {
  it("answers 401 without a key and advertises Bearer", async () => {
    const response = await server.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect((await response.text()).length).toBe(0)
  })

  it("answers 401 for a wrong key", async () => {
    const response = await server.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      },
      { authorization: "Bearer not-the-key" },
    )

    expect(response.status).toBe(401)
  })

  it("accepts the valid key", async () => {
    const { response } = await initialize(server, "2025-11-25", authorized)
    expect(response.status).toBe(200)
  })
})

describe("protocol negotiation", () => {
  it("initializes on 2025-11-25", async () => {
    const { body, response } = await initialize(server, "2025-11-25", authorized)
    expect(response.status).toBe(200)
    expect(response.headers.get("mcp-protocol-version")).toBe("2025-11-25")
    expect(expectBody(InitializeSchema, body).result.serverInfo.name).toBe("droid-mcp")
  })

  it("initializes on 2026-07-28 as a sessionless client", async () => {
    const discovered = await server.post(
      stateless(1, "server/discover"),
      statelessHeaders("server/discover"),
    )

    expect(discovered.status).toBe(200)
    expect(discovered.headers.get("mcp-session-id")).toBeNull()

    const body = expectBody(DiscoverSchema, await readBody(discovered))

    expect(body.result.supportedVersions).toContain("2026-07-28")

    const listed = await server.post(stateless(2, "tools/list"), statelessHeaders("tools/list"))

    expect(listed.status).toBe(200)

    const tools = expectBody(ToolsListSchema, await readBody(listed))

    expect(tools.result.tools.map((tool) => tool.name)).toContain("server_info")

    const called = await server.post(
      stateless(3, "tools/call", { name: "server_info", arguments: {} }),
      statelessHeaders("tools/call", { "mcp-name": "server_info" }),
    )

    expect(called.status).toBe(200)
  })

  it("rejects an unsupported revision on a later request", async () => {
    const { sessionId } = await initialize(server, "2025-11-25", authorized)

    const response = await server.post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        ...authorized,
        "mcp-session-id": sessionId ?? "",
        "mcp-protocol-version": "1999-01-01",
      },
    )

    expect(response.status).toBe(400)
    const body = expectBody(ErrorSchema, await readBody(response))

    expect(body.error.code).toBe(-32022)
  })

  it("rejects a header that disagrees with the negotiated version", async () => {
    const { sessionId } = await initialize(server, "2025-11-25", authorized)

    const response = await server.post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        ...authorized,
        "mcp-session-id": sessionId ?? "",
        "mcp-protocol-version": "2025-06-18",
      },
    )

    expect(response.status).toBe(400)
  })

  it("tolerates a missing version header on a later request", async () => {
    const { sessionId } = await initialize(server, "2025-11-25", authorized)

    const response = await server.post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { ...authorized, "mcp-session-id": sessionId ?? "" },
    )

    expect(response.status).toBe(200)
  })

  it("serves tools/list and server_info on a session", async () => {
    const { sessionId } = await initialize(server, "2025-11-25", authorized)

    const headers = {
      ...authorized,
      "mcp-session-id": sessionId ?? "",
      "mcp-protocol-version": "2025-11-25",
    }

    const names = expectBody(
      ToolsListSchema,
      await readBody(
        await server.post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers),
      ),
    ).result.tools.map((tool) => tool.name)

    expect(names).toContain("server_info")

    const called = expectBody(
      ServerInfoCallSchema,
      await readBody(
        await server.post(
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "server_info", arguments: {} },
          },
          headers,
        ),
      ),
    )

    const result = called.result

    expect(result.structuredContent.version).toBe("0.1.0")
    expect(result.structuredContent.protocols).toEqual([
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2026-07-28",
    ])
  })

  it("terminates a session with DELETE", async () => {
    const { sessionId } = await initialize(server, "2025-11-25", authorized)

    const response = await server.request("DELETE", {
      ...authorized,
      "mcp-session-id": sessionId ?? "",
      "mcp-protocol-version": "2025-11-25",
    })

    expect(response.status).toBe(204)
  })
})

describe("origin policy", () => {
  it("rejects a disallowed origin and accepts an originless request", async () => {
    const limited = await startServer({
      config: testConfig(),
      keys: [KEY],
      allowedOrigins: ["https://allowed.example"],
    })

    try {
      const rejected = await limited.post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "t", version: "1" },
          },
        },
        { ...authorized, origin: "https://evil.example" },
      )

      expect(rejected.status).toBe(403)

      const allowed = await initialize(limited, "2025-11-25", {
        ...authorized,
        origin: "https://allowed.example",
      })

      expect(allowed.response.status).toBe(200)
    } finally {
      await limited.dispose()
    }
  })
})
