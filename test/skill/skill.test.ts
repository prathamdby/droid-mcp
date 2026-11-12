import * as Schema from "effect/Schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { instructionsFor } from "../../src/tools/skill.ts"
import { testConfig } from "../support/config.ts"
import { expectBody, initialize, readBody, startServer } from "../support/mcp-http.ts"
import type { TestServer } from "../support/mcp-http.ts"

const KEY = "skill-test-key"
const URI = "skill://droid/SKILL.md"

const InitializeSchema = Schema.Struct({
  result: Schema.Struct({ instructions: Schema.optional(Schema.String) }),
})

const ReadSchema = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(
      Schema.Struct({ uri: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
})

const PromptsSchema = Schema.Struct({
  result: Schema.Struct({
    prompts: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
  }),
})

const PromptGetSchema = Schema.Struct({
  result: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        content: Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      }),
    ),
  }),
})

const SkillsSchema = Schema.Struct({
  result: Schema.Struct({
    skills: Schema.Array(Schema.Struct({ uri: Schema.String })),
  }),
})

let server: TestServer

beforeAll(async () => {
  server = await startServer({ config: testConfig(), keys: [KEY] })
})

afterAll(async () => {
  await server.dispose()
})

const authorized = { authorization: "Bearer " + KEY }

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

const statelessHeaders = (method: string, name?: string) =>
  name === undefined
    ? { ...authorized, "mcp-protocol-version": "2026-07-28", "mcp-method": method }
    : {
        ...authorized,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        "mcp-name": name,
      }

/** A 2025-11-25 session, initialized once per test that needs one. */
const session = async () => {
  const { sessionId } = await initialize(server, "2025-11-25", authorized)

  return { ...authorized, "mcp-protocol-version": "2025-11-25", "mcp-session-id": sessionId ?? "" }
}

describe("the droid skill", () => {
  it("is named in the instructions the server sends on initialize", async () => {
    const { body } = await initialize(server, "2025-11-25", authorized)
    const instructions = expectBody(InitializeSchema, body).result.instructions ?? ""

    expect(instructions).toBe(instructionsFor(testConfig().toolProfile))

    for (const tool of [
      "session_create",
      "session_stream",
      "session_events",
      "session_respond_permission",
      "session_answer_question",
      "session_close",
      "server_info",
    ]) {
      expect(instructions).toContain(tool)
    }

    expect(instructions).toContain(URI)
  })

  it("reads skill://droid/SKILL.md on 2025-11-25", async () => {
    const headers = await session()

    const body = expectBody(
      ReadSchema,
      await readBody(
        await server.post(
          { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: URI } },
          headers,
        ),
      ),
    )

    const content = body.result.contents[0]

    expect(content?.uri).toBe(URI)
    expect(content?.text).toContain("name: droid")
    expect(content?.text).toContain("session_create")
  })

  it("reads skill://droid/SKILL.md on 2026-07-28", async () => {
    const body = expectBody(
      ReadSchema,
      await readBody(
        await server.post(
          stateless(2, "resources/read", { uri: URI }),
          statelessHeaders("resources/read", URI),
        ),
      ),
    )

    expect(body.result.contents[0]?.text).toContain("name: droid")
  })

  it("reads a skill reference file", async () => {
    const headers = await session()

    const body = expectBody(
      ReadSchema,
      await readBody(
        await server.post(
          {
            jsonrpc: "2.0",
            id: 3,
            method: "resources/read",
            params: { uri: "skill://droid/references/prompts.md" },
          },
          headers,
        ),
      ),
    )

    expect(body.result.contents[0]?.text).toContain("proceed_edit")
  })

  it("declares the skill on skills/list", async () => {
    const listed = await server.post(stateless(4, "skills/list"), statelessHeaders("skills/list"))
    const body = expectBody(SkillsSchema, await readBody(listed))

    expect(body.result.skills.map((skill) => skill.uri)).toContain(URI)
  })

  it("serves the droid prompt", async () => {
    const headers = await session()

    const prompts = expectBody(
      PromptsSchema,
      await readBody(
        await server.post({ jsonrpc: "2.0", id: 5, method: "prompts/list", params: {} }, headers),
      ),
    )

    expect(prompts.result.prompts.map((prompt) => prompt.name)).toContain("droid")

    const got = expectBody(
      PromptGetSchema,
      await readBody(
        await server.post(
          { jsonrpc: "2.0", id: 6, method: "prompts/get", params: { name: "droid" } },
          headers,
        ),
      ),
    )

    const message = got.result.messages[0]

    expect(message?.role).toBe("user")
    expect(message?.content.type).toBe("text")
    expect(message?.content.text).toContain("# Droid")
  })
})
