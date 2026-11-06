import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import {
  PR_AGENT_ID,
  SESSION_GATING_DETAIL,
  startFakeFactoryApi,
} from "../support/fake-factory-api.ts"
import type { FakeFactoryApi } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

/**
 * The Environment-to-session flow, as separate MCP calls against the fake hosted API:
 * find the `pr-agent` Environment, provision a computer from it, wait until it
 * is active, open a hosted session with model `auto`, send one prompt, and read
 * the messages back.
 */

const PROMPT = "Review the open pull request and summarize the risky changes."
const MAX_POLLS = 5

const Environments = Schema.Struct({
  environments: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
})

const Computer = Schema.Struct({ id: Schema.String, status: Schema.String })
const Session = Schema.Struct({ sessionId: Schema.String, computerId: Schema.String })
const Posted = Schema.Struct({ messageId: Schema.String, status: Schema.String })

const Messages = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
})

describe("hosted Environment-to-session flow over MCP", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: "factory-flow-key", factoryBaseUrl: api.baseUrl }),
    })
  })

  beforeEach(() => {
    api.reset()
  })

  afterAll(async () => {
    await client.dispose()
    await api.close()
  })

  const routesHit = (route: string): number =>
    api.requests.filter((request) => request.route === route).length

  /** Finds `pr-agent`, provisions a computer from it, and waits until the computer is active. */
  const provision = async (): Promise<string> => {
    const listed = Schema.decodeUnknownSync(Environments)(await client.ok("rest_list_environments"))

    const environmentId = listed.environments.find((each) => each.name === "pr-agent")?.id

    expect(environmentId).toBe(PR_AGENT_ID)

    expect(
      await client.ok("rest_get_environment", { environmentId: environmentId ?? "" }),
    ).toMatchObject({ id: PR_AGENT_ID, name: "pr-agent" })

    const created = Schema.decodeUnknownSync(Computer)(
      await client.ok("rest_create_computer", {
        name: "pr-agent-box",
        source: { kind: "environment", environmentId: environmentId ?? "", isListed: false },
      }),
    )

    expect(created.status).toBe("provisioning")

    let status = created.status
    let polls = 0

    while (status !== "active" && polls < MAX_POLLS) {
      polls += 1
      status = Schema.decodeUnknownSync(Computer)(
        await client.ok("rest_get_computer", { computerId: created.id }),
      ).status
    }

    expect(status).toBe("active")

    return created.id
  }

  it("provisions from pr-agent, opens a session with model auto, and posts one prompt", async () => {
    const computerId = await provision()

    const session = Schema.decodeUnknownSync(Session)(
      await client.ok("rest_create_remote_session", {
        body: { computerId, sessionSettings: { model: "auto" } },
      }),
    )

    expect(session.computerId).toBe(computerId)

    const posted = Schema.decodeUnknownSync(Posted)(
      await client.ok("rest_post_remote_session_message", {
        sessionId: session.sessionId,
        body: { text: PROMPT },
      }),
    )

    expect(posted.status).toBe("running")

    const listed = Schema.decodeUnknownSync(Messages)(
      await client.ok("rest_list_remote_session_messages", { sessionId: session.sessionId }),
    )

    expect(listed.messages).toEqual([
      expect.objectContaining({ id: posted.messageId, role: "user" }),
    ])

    expect(routesHit("POST /api/v0/computers")).toBe(1)
    expect(routesHit("POST /api/v0/sessions")).toBe(1)
    expect(routesHit("POST /api/v0/sessions/{sessionId}/messages")).toBe(1)

    const createdComputer = api.requests.find(
      (request) => request.route === "POST /api/v0/computers",
    )

    expect(JSON.parse(createdComputer?.body ?? "{}")).toEqual({
      name: "pr-agent-box",
      source: { kind: "environment", environmentId: PR_AGENT_ID, isListed: false },
    })
    expect(api.state.computers.get(computerId)).toMatchObject({ status: "active", isListed: false })
    expect(api.state.sessions.get(session.sessionId)).toMatchObject({
      computerId,
      sessionSettings: { model: "auto" },
    })
    expect(api.state.messages.get(session.sessionId)).toEqual([
      expect.objectContaining({
        id: posted.messageId,
        content: [{ type: "text", text: PROMPT }],
      }),
    ])
  })

  it("stops at a gated organization without a retry, a second computer, or a message", async () => {
    api.state.sessionGate = SESSION_GATING_DETAIL

    const computerId = await provision()

    const denied = await client.fail("rest_create_remote_session", {
      body: { computerId, sessionSettings: { model: "auto" } },
    })

    expect(denied).toEqual({
      code: "rest_rejected",
      message: "createSession was rejected (HTTP 403): " + SESSION_GATING_DETAIL,
    })
    expect(routesHit("POST /api/v0/computers")).toBe(1)
    expect(routesHit("POST /api/v0/sessions")).toBe(1)
    expect(routesHit("POST /api/v0/sessions/{sessionId}/messages")).toBe(0)
    expect([...api.state.sessions.values()].some((each) => each.computerId === computerId)).toBe(
      false,
    )
  })
})
