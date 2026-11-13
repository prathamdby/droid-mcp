import * as Schema from "effect/Schema"
import { afterEach, describe, expect, it } from "vitest"

import { SKILL_MD, SKILL_URI } from "../../src/generated/skill.ts"
import { testConfig } from "../support/config.ts"
import { expectBody, initialize, readBody, startServer } from "../support/mcp-http.ts"
import type { Json, TestServer } from "../support/mcp-http.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const KEY = "skill-gate-key"
const PROTOCOL = "2025-11-25"

const FailureBody = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Literal(true),
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
})

const failureOf = (body: Json | undefined): { code: string; message: string } => {
  const parsed = expectBody(FailureBody, body)
  const text = parsed.result.content[0]?.text ?? ""

  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String })),
  )(text)
}

const OkBody = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Literal(false)),
    structuredContent: Schema.Unknown,
  }),
})

const servers: Array<TestServer> = []
const clients: Array<ToolClient> = []

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.dispose()

  while (servers.length > 0) await servers.pop()?.dispose()
})

const openSession = async (server: TestServer) => {
  const { sessionId } = await initialize(server, PROTOCOL, { authorization: "Bearer " + KEY })

  const headers = {
    authorization: "Bearer " + KEY,
    "mcp-session-id": sessionId ?? "",
    "mcp-protocol-version": PROTOCOL,
  }

  let nextId = 1

  const rpc = async (method: string, params: Json = {}) => {
    nextId += 1

    return await readBody(
      await server.post({ jsonrpc: "2.0", id: nextId, method, params }, headers),
    )
  }

  return {
    call: (name: string, args: Json = {}) => rpc("tools/call", { name, arguments: args }),
    readResource: (uri: string) => rpc("resources/read", { uri }),
    getPrompt: (name: string) => rpc("prompts/get", { name }),
  }
}

describe("skill-read gating", () => {
  it("blocks session_* tools before skill_read and unlocks after skill_read", async () => {
    const server = await startServer({
      config: testConfig({ toolProfile: "compact" }),
      keys: [KEY],
    })

    servers.push(server)

    const session = await openSession(server)

    const gatedDirect = failureOf(await session.call("session_list"))

    expect(gatedDirect.code).toBe("skill_not_read")

    const gatedToolCall = failureOf(
      await session.call("tool_call", { name: "session_list", arguments: {} }),
    )

    expect(gatedToolCall.code).toBe("skill_not_read")

    const gatedBatch = expectBody(
      OkBody,
      await session.call("batch", { steps: [{ name: "session_list" }] }),
    )

    expect(gatedBatch.result.structuredContent).toMatchObject({
      failed: 1,
      steps: [{ name: "session_list", status: "failed", error: { code: "skill_not_read" } }],
    })

    // Ungated tools stay available before reading the skill.
    const info = expectBody(OkBody, await session.call("server_info"))

    expect(info.result.structuredContent).toMatchObject({ profile: "compact" })

    const skill = expectBody(OkBody, await session.call("skill_read"))

    expect(skill.result.structuredContent).toEqual({ uri: SKILL_URI, markdown: SKILL_MD })

    const unlocked = expectBody(OkBody, await session.call("session_list"))

    expect(unlocked.result.structuredContent).toEqual({ sessions: [] })
  })

  it("unlocks session_* tools when reading the skill resource", async () => {
    const server = await startServer({ config: testConfig(), keys: [KEY] })
    servers.push(server)

    const session = await openSession(server)

    expect(failureOf(await session.call("session_list")).code).toBe("skill_not_read")

    await session.readResource(SKILL_URI)

    expect(expectBody(OkBody, await session.call("session_list")).result.structuredContent).toEqual(
      {
        sessions: [],
      },
    )
  })

  it("unlocks session_* tools when getting the droid prompt", async () => {
    const server = await startServer({ config: testConfig(), keys: [KEY] })
    servers.push(server)

    const session = await openSession(server)

    expect(failureOf(await session.call("session_list")).code).toBe("skill_not_read")

    await session.getPrompt("droid")

    expect(expectBody(OkBody, await session.call("session_list")).result.structuredContent).toEqual(
      {
        sessions: [],
      },
    )
  })

  it("tracks skill-read state per MCP session", async () => {
    const server = await startServer({ config: testConfig(), keys: [KEY] })
    servers.push(server)

    const first = await openSession(server)
    const second = await openSession(server)

    await first.call("skill_read")

    expect(expectBody(OkBody, await first.call("session_list")).result.structuredContent).toEqual({
      sessions: [],
    })
    expect(failureOf(await second.call("session_list")).code).toBe("skill_not_read")
  })

  it("allows session_* tools immediately when requireSkill is false", async () => {
    const client = await connect({
      config: testConfig({ requireSkill: false }),
      readSkill: false,
    })

    clients.push(client)

    expect(await client.ok("session_list")).toEqual({ sessions: [] })
  })
})
