import { spawn } from "node:child_process"
import { createServer } from "node:net"

import { Option, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { startFakeContextApi } from "../support/fake-context-api.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"
import { expectBody, readBody, waitForPort } from "../support/mcp-http.ts"

const KEY = "process-test-key"
const FACTORY_KEY_CANARY = "fk-process-canary-7f3a"
const TENANT_HEADER = "x-factory-organization"
const TENANT_CANARY = "org-process-canary-91c2"
const root = process.cwd()

const AddressSchema = Schema.Struct({ port: Schema.Number })

const ToolsListSchema = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
})

const ServerInfoCallSchema = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({ version: Schema.String }),
  }),
})

const ToolCallSchema = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Json),
  }),
})

interface RunningServer {
  readonly port: number
  readonly stop: () => Promise<void>
  readonly stderr: () => string
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      Option.match(Schema.decodeUnknownOption(AddressSchema)(probe.address()), {
        onNone: () => reject(new Error("no port")),
        onSome: ({ port }) => probe.close(() => resolve(port)),
      })
    })
  })

const start = async (env: Record<string, string>): Promise<RunningServer> => {
  const port = await freePort()

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/main.ts", "serve", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, DROID_MCP_LOG_LEVEL: "error", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  await waitForPort(port)

  return {
    port,
    stderr: () => stderr,
    stop: async () => {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve())
        setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 5_000)
      })
    },
  }
}

const post = (server: RunningServer, body: Schema.Json, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  })

/** Runs `serve` until it exits on its own and returns its exit code and stderr. */
const exitOf = async (
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> => {
  const port = await freePort()

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/main.ts", "serve", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, DROID_MCP_LOG_LEVEL: "error", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", (exitCode) => resolve(exitCode))
    setTimeout(() => {
      child.kill("SIGKILL")
      resolve(-1)
    }, 20_000)
  })

  return { code, stderr }
}

/** Initializes a 2025-11-25 MCP session and returns the headers later calls need. */
const openSession = async (server: RunningServer): Promise<Record<string, string>> => {
  const authorized = { authorization: "Bearer " + KEY }

  const initialized = await post(
    server,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "process-test", version: "1" },
      },
    },
    authorized,
  )

  expect(initialized.status).toBe(200)
  await initialized.text()

  return {
    ...authorized,
    "mcp-session-id": initialized.headers.get("mcp-session-id") ?? "",
    "mcp-protocol-version": "2025-11-25",
  }
}

let running: RunningServer | undefined

afterEach(async () => {
  if (running !== undefined) {
    await running.stop()
    running = undefined
  }
})

describe("serve process", () => {
  it("rejects a request without a key, then lists and calls server_info", async () => {
    running = await start({ DROID_MCP_KEYS: KEY })
    const server = running
    const authorized = { authorization: "Bearer " + KEY }

    const rejected = await post(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "process-test", version: "1" },
      },
    })

    expect(rejected.status).toBe(401)
    expect(rejected.headers.get("www-authenticate")).toBe("Bearer")

    const initialized = await post(
      server,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "process-test", version: "1" },
        },
      },
      authorized,
    )

    expect(initialized.status).toBe(200)
    const sessionId = initialized.headers.get("mcp-session-id") ?? ""
    expect(sessionId.length).toBeGreaterThan(0)
    await initialized.text()

    const listed = await post(
      server,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      { ...authorized, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" },
    )

    const tools = expectBody(ToolsListSchema, await readBody(listed))

    expect(tools.result.tools.map((tool) => tool.name)).toContain("server_info")

    const called = await post(
      server,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "server_info", arguments: {} },
      },
      { ...authorized, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" },
    )

    const result = expectBody(ServerInfoCallSchema, await readBody(called))

    expect(result.result.structuredContent.version).toBe("0.1.0")
  })

  it("exits non-zero when no keys are configured", async () => {
    const { code, stderr } = await exitOf({ DROID_MCP_KEYS: "" })

    expect(code).toBe(2)
    expect(stderr).toContain("serve.keys_missing")
  })

  it("sends REST calls to FACTORY_BASE_URL and Context calls to FACTORY_CONTEXT_BASE_URL", async () => {
    const hosted = await startFakeFactoryApi()
    const context = await startFakeContextApi()

    try {
      running = await start({
        DROID_MCP_KEYS: KEY,
        DROID_MCP_LOG_LEVEL: "debug",
        FACTORY_API_KEY: FACTORY_KEY_CANARY,
        FACTORY_BASE_URL: hosted.baseUrl,
        FACTORY_CONTEXT_BASE_URL: context.baseUrl,
        FACTORY_CONTEXT_HEADERS: JSON.stringify({ [TENANT_HEADER]: TENANT_CANARY }),
      })
      const server = running
      const headers = await openSession(server)

      const callTool = async (id: number, name: string): Promise<string> => {
        const response = await post(
          server,
          {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "tool_call", arguments: { name, arguments: {} } },
          },
          headers,
        )

        const body = await readBody(response)

        expect(expectBody(ToolCallSchema, body).result.isError ?? false).toBe(false)

        return JSON.stringify(body)
      }

      const results = [
        await callTool(2, "rest_list_computers"),
        await callTool(3, "context_list_spaces"),
      ]

      expect(hosted.requests.map((request) => request.route)).toEqual(["GET /api/v0/computers"])
      expect(hosted.requests[0]?.headers.authorization).toBe("Bearer " + FACTORY_KEY_CANARY)
      expect(hosted.requests[0]?.headers[TENANT_HEADER]).toBeUndefined()
      expect(context.requests).toHaveLength(1)
      expect(context.requests[0]?.path.startsWith("/api/context/")).toBe(true)
      expect(context.requests[0]?.headers[TENANT_HEADER]).toBe(TENANT_CANARY)

      for (const canary of [FACTORY_KEY_CANARY, TENANT_CANARY]) {
        for (const result of results) expect(result).not.toContain(canary)
        expect(server.stderr()).not.toContain(canary)
      }
    } finally {
      await running?.stop()
      running = undefined
      await hosted.close()
      await context.close()
    }
  })

  it("exits 2 on an invalid FACTORY_CONTEXT_HEADERS without echoing its value", async () => {
    const { code, stderr } = await exitOf({
      DROID_MCP_KEYS: KEY,
      FACTORY_CONTEXT_HEADERS: JSON.stringify({ cookie: TENANT_CANARY }),
    })

    expect(code).toBe(2)
    expect(stderr).toContain("config_invalid")
    expect(stderr).toContain("FACTORY_CONTEXT_HEADERS")
    expect(stderr).not.toContain(TENANT_CANARY)
  })
})
