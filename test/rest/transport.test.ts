import { createServer } from "node:net"

import * as Predicate from "effect/Predicate"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { Config } from "../../src/config.ts"
import { testConfig } from "../support/config.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi } from "../support/fake-factory-api.ts"
import { startServer } from "../support/mcp-http.ts"
import { MCP_KEY, connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const FACTORY_KEY = "factory-transport-key"
const LIST = "GET /api/v0/computers"

/** A port nothing listens on, so a connect is refused. */
const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()

    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()

      if (address === null || Predicate.isString(address)) {
        reject(new Error("no port"))

        return
      }

      probe.close(() => resolve(address.port))
    })
  })

describe("hosted REST transport over MCP", () => {
  let api: FakeFactoryApi
  let other: FakeFactoryApi
  let client: ToolClient
  const opened: Array<ToolClient> = []

  const clientFor = async (overrides: Partial<Config>): Promise<ToolClient> => {
    const extra = await connect({
      config: testConfig({ factoryApiKey: FACTORY_KEY, factoryBaseUrl: api.baseUrl, ...overrides }),
    })

    opened.push(extra)

    return extra
  }

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    other = await startFakeFactoryApi()
    client = await clientFor({})
  })

  beforeEach(() => {
    api.reset()
    other.reset()
  })

  afterAll(async () => {
    for (const each of opened) await each.dispose()

    await api.close()
    await other.close()
  })

  it.each([200, 201, 202])("returns the JSON body of a %i", async (status) => {
    api.failNext(LIST, status, { computers: [], status })

    expect(await client.ok("rest_list_computers")).toEqual({ computers: [], status })
  })

  it("acknowledges a 204 with { ok: true }", async () => {
    api.failNext(LIST, 204)

    expect(await client.ok("rest_list_computers")).toEqual({ ok: true })
  })

  it.each([401, 403, 404, 409, 429])(
    "maps a %i to rest_rejected with the API detail",
    async (status) => {
      api.failNext(LIST, status, { detail: "nope " + String(status), status, title: "Title" })

      expect(await client.fail("rest_list_computers")).toEqual({
        code: "rest_rejected",
        message: "listComputers was rejected (HTTP " + String(status) + "): nope " + String(status),
      })
      expect(api.requests).toHaveLength(1)
    },
  )

  it.each([500, 503])("maps a %i to rest_unavailable with the API detail", async (status) => {
    api.failNext(LIST, status, { detail: "down", status, title: "Server Error" })

    expect(await client.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message: "listComputers failed upstream (HTTP " + String(status) + "): down",
    })
  })

  it("falls back to title, then a legacy error string", async () => {
    api.failNext(LIST, 400, { status: 400, title: "Bad Request" })
    api.failNext(LIST, 400, { error: "legacy message" })

    expect((await client.fail("rest_list_computers")).message).toBe(
      "listComputers was rejected (HTTP 400): Bad Request",
    )
    expect((await client.fail("rest_list_computers")).message).toBe(
      "listComputers was rejected (HTTP 400): legacy message",
    )
  })

  it("never echoes an HTML error body", async () => {
    api.failNext(LIST, 502, "<html><body><h1>502 Bad Gateway</h1></body></html>")

    const failure = await client.fail("rest_list_computers")

    expect(failure).toEqual({
      code: "rest_unavailable",
      message: "listComputers failed upstream (HTTP 502)",
    })
  })

  it("reports a malformed 2xx body as rest_unavailable", async () => {
    api.failNext(LIST, 200, "not json {")

    expect(await client.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message: "listComputers returned a malformed response (HTTP 200)",
    })
  })

  it.each([
    ["with a declared length", {}],
    ["streamed without a length", { "transfer-encoding": "chunked" }],
  ])("refuses a body over 32 MiB %s", async (_label, headers) => {
    api.failNext(LIST, 200, "x".repeat(32 * 1024 * 1024 + 1), headers)

    expect(await client.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message: "listComputers returned more than 33554432 bytes (HTTP 200)",
    })
  })

  it("reports a refused connection without a cause dump", async () => {
    const refused = await clientFor({
      factoryBaseUrl: "http://127.0.0.1:" + String(await closedPort()),
    })

    expect(await refused.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message: "listComputers could not reach the Factory API",
    })
  })

  it("times out with the configured request timeout", async () => {
    const slow = await clientFor({ requestTimeoutMs: 150 })

    api.route(LIST, () => new Promise((resolve) => setTimeout(() => resolve({ json: {} }), 1_500)))

    const failure = await slow.fail("rest_list_computers")

    expect(failure.code).toBe("rest_unavailable")
    expect(failure.message).toBe("listComputers timed out after 150 ms waiting for the Factory API")
  })

  it("refuses to follow a redirect", async () => {
    api.failNext(LIST, 302, undefined, { location: other.baseUrl + "/api/v0/computers" })

    expect(await client.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message: "listComputers was redirected (HTTP 302); redirect refused",
    })
    expect(api.requests).toHaveLength(1)
    expect(other.requests).toHaveLength(0)
  })

  it("fails before any request when FACTORY_API_KEY is missing", async () => {
    const keyless = await clientFor({ factoryApiKey: undefined })

    expect((await keyless.fail("rest_list_computers")).code).toBe("factory_api_key_missing")
    expect(api.requests).toHaveLength(0)
  })

  it("scrubs configured secrets from results and error detail", async () => {
    api.failNext(LIST, 200, {
      computers: [{ id: "c-1", note: "key " + FACTORY_KEY, authorization: "Bearer x" }],
      apiKey: { id: "k-1", value: "minted" },
    })

    expect(await client.ok("rest_list_computers")).toEqual({
      computers: [{ id: "c-1", note: "key [redacted]" }],
      apiKey: { id: "k-1" },
    })

    api.failNext(LIST, 401, {
      detail: "bad key " + FACTORY_KEY + " or " + MCP_KEY,
      status: 401,
      title: "x",
    })

    const failure = await client.fail("rest_list_computers")

    expect(failure.message).toBe(
      "listComputers was rejected (HTTP 401): bad key [redacted] or [redacted]",
    )
  })

  it("scrubs configured secrets from member names", async () => {
    api.failNext(LIST, 200, { computers: [], [FACTORY_KEY]: { ["x-" + MCP_KEY]: 1 } })

    const outcome = await client.call("rest_list_computers")

    expect(outcome.structured).toEqual({ computers: [], "[redacted]": { "x-[redacted]": 1 } })
    expect(outcome.text).not.toContain(FACTORY_KEY)
    expect(outcome.text).not.toContain(MCP_KEY)
  })

  it("scrubs a key minted in an error body from its detail", async () => {
    api.failNext(LIST, 500, {
      detail: "rotation half-done; new key fk-minted-1 is live",
      status: 500,
      title: "x",
      apiKey: { id: "k-9", value: "fk-minted-1" },
    })

    expect(await client.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message:
        "listComputers failed upstream (HTTP 500): rotation half-done; new key [redacted] is live",
    })
  })

  it("keeps a member named __proto__ as data", async () => {
    api.failNext(LIST, 200, '{"computers":[],"__proto__":{"x":1}}')

    const outcome = await client.call("rest_list_computers")

    expect(outcome.isError).toBe(false)
    expect(JSON.parse(outcome.text)).toEqual(JSON.parse('{"computers":[],"__proto__":{"x":1}}'))
  })

  it("refuses deeply nested JSON as rest_unavailable instead of overflowing", async () => {
    const deep = "[".repeat(3_000) + "]".repeat(3_000)

    api.failNext(LIST, 200, deep)
    api.failNext(LIST, 500, '{"detail":' + deep + "}")

    expect(await client.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message: "listComputers returned a malformed response (HTTP 200)",
    })
    expect(await client.fail("rest_list_computers")).toEqual({
      code: "rest_unavailable",
      message: "listComputers failed upstream (HTTP 500)",
    })
  })

  it("returns a JSON null body as null, not an acknowledgment", async () => {
    api.failNext(LIST, 200, null)

    const outcome = await client.call("rest_list_computers")

    expect(outcome.isError).toBe(false)
    expect(outcome.text).toBe("null")
  })

  it("refuses a lone surrogate in a path or query value before any request", async () => {
    const path = await client.fail("rest_get_computer", { computerId: "\ud800" })
    const named = await client.fail("rest_list_computers", { hostId: "a\udfff" })
    const extra = await client.fail("rest_list_computers", { query: { tag: ["ok", "\ud800"] } })

    expect(path).toEqual({
      code: "invalid_params",
      message:
        "rest_get_computer: computerId must be a non-empty, well-formed path segment other than . or ..",
    })
    expect(named).toEqual({
      code: "invalid_params",
      message: "rest_list_computers: query parameter hostId is not well-formed Unicode",
    })
    expect(extra).toEqual({
      code: "invalid_params",
      message: "rest_list_computers: query parameter tag is not well-formed Unicode",
    })
    expect(api.requests).toHaveLength(0)
  })

  it("answers 401 for a missing or wrong MCP bearer before any tool runs", async () => {
    const server = await startServer({
      config: testConfig({ factoryApiKey: FACTORY_KEY, factoryBaseUrl: api.baseUrl }),
      keys: [MCP_KEY],
    })

    try {
      const call = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "rest_list_computers", arguments: {} },
      }

      const missing = await server.post(call)
      const wrong = await server.post(call, { authorization: "Bearer not-the-key" })

      expect(missing.status).toBe(401)
      expect(wrong.status).toBe(401)
      expect(api.requests).toHaveLength(0)
    } finally {
      await server.dispose()
    }
  })
})
