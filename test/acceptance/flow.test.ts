import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { expectBody, readBody, waitForPort } from "../support/mcp-http.ts"

/**
 * One end-to-end pass through the shipped server: a real process on a real
 * port, driven over Streamable HTTP, with `droid` replaced by the fake so no
 * model is involved. Everything below happens the way a client would do it.
 */

const KEY = "acceptance-key"
const root = process.cwd()
const fake = join(root, "test", "support", "fake-droid-exec.mjs")

const AddressSchema = Schema.Struct({ port: Schema.Number })

const InitializeSchema = Schema.Struct({
  result: Schema.Struct({ instructions: Schema.optional(Schema.String) }),
})

const ReadSchema = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
  }),
})

const CreatedSchema = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({ sessionId: Schema.String, cwd: Schema.String }),
  }),
})

const TurnSchema = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.String,
      cursor: Schema.Number,
      events: Schema.Array(
        Schema.Struct({
          seq: Schema.Number,
          kind: Schema.String,
          requestId: Schema.optional(Schema.String),
          options: Schema.optional(Schema.Array(Schema.String)),
          text: Schema.optional(Schema.String),
        }),
      ),
      result: Schema.optional(Schema.Struct({ reason: Schema.String })),
    }),
  }),
})

const ResolvedSchema = Schema.Struct({
  result: Schema.Struct({ structuredContent: Schema.Struct({ resolved: Schema.Boolean }) }),
})

const ClosedSchema = Schema.Struct({
  result: Schema.Struct({ structuredContent: Schema.Struct({ closed: Schema.Boolean }) }),
})

interface RunningServer {
  readonly port: number
  readonly stop: () => Promise<void>
}

/** A `droid` that ignores the CLI arguments and runs the fake instead. */
const shim = (directory: string): string => {
  const path = join(directory, "droid")

  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`)
  chmodSync(path, 0o755)

  return path
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

const start = async (droidPath: string): Promise<RunningServer> => {
  const port = await freePort()

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/main.ts", "serve", "--port", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        DROID_MCP_KEYS: KEY,
        DROID_MCP_DROID_PATH: droidPath,
        DROID_MCP_LOG_LEVEL: "error",
        DROID_MCP_RUNTIME_DIR: droidPath + "-runtime",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  await waitForPort(port)

  return {
    port,
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

describe("acceptance", () => {
  let server: RunningServer
  let directory: string
  let sessionId = ""
  let instructions = ""

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "droid-mcp-acceptance-"))

    try {
      server = await start(shim(directory))
    } catch (cause) {
      rmSync(directory, { recursive: true, force: true })
      throw cause
    }

    const initialized = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + KEY,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "acceptance", version: "1.0.0" },
        },
      }),
    })

    sessionId = initialized.headers.get("mcp-session-id") ?? ""
    instructions =
      expectBody(InitializeSchema, await readBody(initialized)).result.instructions ?? ""
  }, 60_000)

  afterAll(async () => {
    await server?.stop()

    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  })

  const post = (body: Schema.Json) =>
    fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + KEY,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify(body),
    })

  const read = async (uri: string) => {
    const entity = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + KEY,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri } }),
    })

    return expectBody(ReadSchema, await readBody(entity))
  }

  const tool = async (name: string, args: Schema.Json): Promise<Schema.Json | undefined> => {
    const response = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    })

    return readBody(response)
  }

  it("sends instructions on initialize", () => {
    expect(instructions).toContain("session_create")
    expect(instructions).toContain("skill://droid/SKILL.md")
  })

  it("reads the droid skill", async () => {
    const body = await read("skill://droid/SKILL.md")

    expect(body.result.contents[0]?.text).toContain("session_create")
  })

  it("runs a turn, answers a permission prompt, and closes the session", async () => {
    const created = expectBody(
      CreatedSchema,
      await tool("session_create", { cwd: root, autonomyLevel: "low" }),
    )

    const sessionId = created.result.structuredContent.sessionId

    expect(created.result.structuredContent.cwd).toBe(root)

    const first = expectBody(
      TurnSchema,
      await tool("session_stream", { sessionId, prompt: "hello", waitMs: 5_000 }),
    )

    expect(first.result.structuredContent.status).toBe("completed")
    expect(first.result.structuredContent.events.map((event) => event.kind)).toContain(
      "assistant_text",
    )

    const prompting = expectBody(
      TurnSchema,
      await tool("session_stream", { sessionId, prompt: "permission", waitMs: 5_000 }),
    )

    const pending = prompting.result.structuredContent.events.find(
      (event) => event.kind === "pending_permission",
    )

    const requestId = pending?.requestId

    expect(prompting.result.structuredContent.status).toBe("running")
    expect(pending?.options).toEqual(["proceed_once", "proceed_always", "cancel"])

    if (requestId === undefined) throw new Error("no pending permission")

    const answered = expectBody(
      ResolvedSchema,
      await tool("session_respond_permission", {
        sessionId,
        requestId,
        outcome: "proceed_once",
      }),
    )

    expect(answered.result.structuredContent.resolved).toBe(true)

    const polled = expectBody(
      TurnSchema,
      await tool("session_events", {
        sessionId,
        cursor: prompting.result.structuredContent.cursor,
        waitMs: 5_000,
      }),
    )

    expect(polled.result.structuredContent.status).toBe("completed")

    const closed = expectBody(ClosedSchema, await tool("session_close", { sessionId }))

    expect(closed.result.structuredContent.closed).toBe(true)
  }, 60_000)

  it("reports the autonomy cap", async () => {
    const body = await tool("session_create", { cwd: root, autonomyLevel: "high" })

    const error = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
      }),
    )(body)

    expect(error.result.content[0]?.text).toContain("autonomy_exceeds_cap")
  })
})
