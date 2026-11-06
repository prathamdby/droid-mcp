import { spawn } from "node:child_process"
import { createServer } from "node:net"

import { Option, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { expectBody, readBody, waitForPort } from "../support/mcp-http.ts"

const KEY = "process-test-key"
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
    const port = await freePort()

    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/main.ts", "serve", "--port", String(port)],
      {
        cwd: root,
        env: { ...process.env, DROID_MCP_KEYS: "", DROID_MCP_LOG_LEVEL: "error" },
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

    expect(code).toBe(2)
    expect(stderr).toContain("serve.keys_missing")
  })
})
