import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import {
  SEED_SESSION,
  SESSION_GATING_DETAIL,
  startFakeFactoryApi,
} from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const SESSION_TOOLS = [
  "rest_list_remote_sessions",
  "rest_create_remote_session",
  "rest_get_remote_session",
  "rest_update_remote_session",
  "rest_delete_remote_session",
  "rest_interrupt_remote_session",
  "rest_list_remote_session_messages",
  "rest_post_remote_session_message",
  "rest_get_remote_session_message",
  "rest_list_remote_session_children",
]

const MessagePage = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
  pagination: Schema.Struct({ hasMore: Schema.Boolean, nextCursor: Schema.NullOr(Schema.String) }),
})

describe("rest hosted session tools over MCP", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: "factory-session-key", factoryBaseUrl: api.baseUrl }),
    })
  })

  beforeEach(() => {
    api.reset()
  })

  afterAll(async () => {
    await client.dispose()
    await api.close()
  })

  const bodyOf = (): Json =>
    Schema.decodeUnknownSync(Schema.Json)(JSON.parse(api.last()?.body ?? "null"))

  it("lists all ten tools and separates them from local session_* handles", async () => {
    const byName = new Map((await client.list()).map((tool) => [tool.name, tool]))

    for (const name of SESSION_TOOLS) {
      const description = byName.get(name)?.description ?? ""

      expect(description).toContain("enabled for selected organizations")
      expect(description).toContain("not local session_* handles")
    }

    expect(byName.get("rest_delete_remote_session")?.description).toContain(
      "Destructive; confirm before calling.",
    )
  })

  it("lists sessions with a reserved-character cursor", async () => {
    await client.ok("rest_list_remote_sessions", { limit: 20, cursor: "a/b?c&d=e#f" })

    expect(api.last()?.query).toBe("limit=20&cursor=a%2Fb%3Fc%26d%3De%23f")
  })

  it("creates a session on an existing computer and forwards sessionSettings", async () => {
    const body = {
      computerId: "c-1",
      cwd: "/work/app",
      sessionSettings: { model: "auto", reasoningEffort: "high" },
    }

    const created = await client.ok("rest_create_remote_session", { body })

    expect(created).toMatchObject({
      sessionId: "s-2",
      computerId: "c-1",
      status: "idle",
      sessionSettings: { model: "auto", reasoningEffort: "high" },
    })
    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe("/api/v0/sessions")
    expect(bodyOf()).toEqual(body)
  })

  it("requires computerId before I/O and reports an unknown computer", async () => {
    const missing = await client.call("rest_create_remote_session", {
      body: { sessionSettings: { model: "auto" } },
    })

    expect(missing.rpcError ?? missing.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)

    expect(
      await client.fail("rest_create_remote_session", { body: { computerId: "c-x" } }),
    ).toEqual({
      code: "rest_rejected",
      message: "createSession was rejected (HTTP 404): computer not found",
    })
  })

  it("reads, updates, interrupts, and deletes a session", async () => {
    expect(
      await client.ok("rest_get_remote_session", { sessionId: "s-1", computerId: "c-1" }),
    ).toEqual(SEED_SESSION)
    expect(api.last()?.path).toBe("/api/v0/sessions/s-1")
    expect(api.last()?.query).toBe("computerId=c-1")

    const updated = await client.ok("rest_update_remote_session", {
      sessionId: "s-1",
      body: { sessionSettings: { model: "auto" } },
    })

    expect(updated).toMatchObject({ sessionId: "s-1", sessionSettings: { model: "auto" } })
    expect(api.last()?.method).toBe("PATCH")
    expect(bodyOf()).toEqual({ sessionSettings: { model: "auto" } })

    expect(await client.ok("rest_interrupt_remote_session", { sessionId: "s-1" })).toEqual({
      status: "idle",
    })
    expect(api.last()?.path).toBe("/api/v0/sessions/s-1/interrupt")
    expect(api.last()?.body).toBe("")

    expect(
      await client.ok("rest_delete_remote_session", { sessionId: "s-1", computerId: "c-1" }),
    ).toEqual({ ok: true })
    expect(api.last()?.method).toBe("DELETE")
    expect(api.last()?.query).toBe("computerId=c-1")
    expect(api.state.sessions.has("s-1")).toBe(false)

    expect((await client.fail("rest_delete_remote_session", { sessionId: "s-1" })).code).toBe(
      "rest_rejected",
    )
  })

  it("pages role-filtered messages across two pages", async () => {
    const first = Schema.decodeUnknownSync(MessagePage)(
      await client.ok("rest_list_remote_session_messages", {
        sessionId: "s-1",
        limit: 1,
        role: "assistant",
      }),
    )

    expect(api.last()?.path).toBe("/api/v0/sessions/s-1/messages")
    expect(api.last()?.query).toBe("limit=1&role=assistant")
    expect(first.messages.map((message) => message.id)).toEqual(["msg-2"])
    expect(first.pagination.hasMore).toBe(true)

    const cursor = first.pagination.nextCursor ?? ""

    expect(cursor).toMatch(/[/?&=#]/)

    const second = Schema.decodeUnknownSync(MessagePage)(
      await client.ok("rest_list_remote_session_messages", {
        sessionId: "s-1",
        limit: 1,
        cursor,
        role: "assistant",
      }),
    )

    expect(api.last()?.query).toBe(
      "limit=1&cursor=" + encodeURIComponent(cursor) + "&role=assistant",
    )
    expect(second.messages.map((message) => message.id)).toEqual(["msg-4"])
    expect(second.pagination).toEqual({ hasMore: false, nextCursor: null })
  })

  it("rejects page limits 0, 101, and 1.5 before I/O", async () => {
    for (const limit of [0, 101, 1.5]) {
      const sessions = await client.call("rest_list_remote_sessions", { limit })

      const messages = await client.call("rest_list_remote_session_messages", {
        sessionId: "s-1",
        limit,
      })

      expect(sessions.rpcError ?? sessions.isError).toBeTruthy()
      expect(messages.rpcError ?? messages.isError).toBeTruthy()
    }

    const role = await client.call("rest_list_remote_session_messages", {
      sessionId: "s-1",
      role: "system",
    })

    expect(role.rpcError ?? role.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)
  })

  it("posts a message, keeps extra members, and reads it back", async () => {
    const body = { text: "run the tests", images: [], computerId: "c-1" }

    const posted = Schema.decodeUnknownSync(
      Schema.Struct({ messageId: Schema.String, status: Schema.String }),
    )(await client.ok("rest_post_remote_session_message", { sessionId: "s-1", body }))

    expect(posted.status).toBe("running")
    expect(api.last()?.path).toBe("/api/v0/sessions/s-1/messages")
    expect(bodyOf()).toEqual(body)

    const message = await client.ok("rest_get_remote_session_message", {
      sessionId: "s-1",
      messageId: posted.messageId,
      computerId: "c-1",
    })

    expect(message).toMatchObject({
      id: posted.messageId,
      role: "user",
      content: [{ type: "text", text: "run the tests" }],
    })
    expect(api.last()?.path).toBe("/api/v0/sessions/s-1/messages/" + posted.messageId)
    expect(api.last()?.query).toBe("computerId=c-1")
  })

  it("requires message text before I/O", async () => {
    const bodies: ReadonlyArray<Json> = [{}, { text: "" }, { images: [] }]

    for (const body of bodies) {
      const outcome = await client.call("rest_post_remote_session_message", {
        sessionId: "s-1",
        body,
      })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(0)
  })

  it("reports an unknown message as rest_rejected", async () => {
    expect(
      await client.fail("rest_get_remote_session_message", { sessionId: "s-1", messageId: "m-x" }),
    ).toEqual({
      code: "rest_rejected",
      message: "getMessage was rejected (HTTP 404): message not found",
    })
  })

  it("lists child sessions with the three include flags", async () => {
    const child = { ...SEED_SESSION, sessionId: "s-child", parent_session_id: "s-1" }

    api.state.sessions.set("s-child", child)

    const listed = await client.ok("rest_list_remote_session_children", {
      sessionId: "s-1",
      includeArtifacts: true,
      includeAttention: false,
      includeUsage: true,
    })

    expect(listed).toEqual({ sessions: [child] })
    expect(api.last()?.path).toBe("/api/v0/sessions/s-1/children")
    expect(api.last()?.query).toBe("includeArtifacts=true&includeAttention=false&includeUsage=true")
  })

  it("reports a gated organization as rest_rejected with the gating detail", async () => {
    api.state.sessionGate = SESSION_GATING_DETAIL

    expect(await client.fail("rest_list_remote_sessions")).toEqual({
      code: "rest_rejected",
      message: "listSessions was rejected (HTTP 403): " + SESSION_GATING_DETAIL,
    })
    expect(api.requests).toHaveLength(1)
  })
})
