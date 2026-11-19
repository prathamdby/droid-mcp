import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Schema from "effect/Schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { expectBody, initialize, readBody, startServer } from "../support/mcp-http.ts"
import type { TestServer } from "../support/mcp-http.ts"

const KEY = "session-resource-key"
const fake = join(process.cwd(), "test", "support", "fake-droid-exec.mjs")
const directory = mkdtempSync(join(tmpdir(), "droid-mcp-resources-"))
const shim = join(directory, "droid")

writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`)

chmodSync(shim, 0o755)

const ReadSchema = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(
      Schema.Struct({
        uri: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
  }),
})

const ResourceBody = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  sessions: Schema.optional(Schema.Array(Schema.Struct({ sessionId: Schema.String }))),
})

const CreatedSchema = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      sessionId: Schema.String,
      cwd: Schema.String,
    }),
  }),
})

interface Headers {
  readonly authorization: string
  readonly "mcp-session-id": string
  readonly "mcp-protocol-version": string
}

let server: TestServer
let headers: Headers

beforeAll(async () => {
  server = await startServer({
    config: testConfig({ droidPath: shim, requireSkill: false }),
    keys: [KEY],
  })
  const started = await initialize(server, "2025-11-25", { authorization: "Bearer " + KEY })

  headers = {
    authorization: "Bearer " + KEY,
    "mcp-session-id": started.sessionId ?? "",
    "mcp-protocol-version": "2025-11-25",
  }
})

afterAll(async () => {
  await server.dispose()
  rmSync(directory, { recursive: true, force: true })
})

const read = async (uri: string) => {
  const body = expectBody(
    ReadSchema,
    await readBody(
      await server.post(
        { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } },
        headers,
      ),
    ),
  )

  return Schema.decodeUnknownSync(ResourceBody)(JSON.parse(body.result.contents[0]?.text ?? "{}"))
}

describe("session resources", () => {
  it("lists sessions, reads one, and reports unknown ids and bad cursors", async () => {
    const created = expectBody(
      CreatedSchema,
      await readBody(
        await server.post(
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "session_create",
              arguments: { cwd: directory, autonomyLevel: "low" },
            },
          },
          headers,
        ),
      ),
    )

    const sessionId = created.result.structuredContent.sessionId

    const live = await read("droid://sessions/" + sessionId)
    const missing = await read("droid://sessions/missing")
    const badNumber = await read("droid://sessions/" + sessionId + "/events/-1")
    const badText = await read("droid://sessions/" + sessionId + "/events/abc")
    const listed = await read("droid://sessions")

    expect(live.sessionId).toBe(sessionId)
    expect(live.cwd).toBe(directory)
    expect(live.cursor).toBe(1)
    expect(live.worktree).toBeUndefined()
    expect(missing.error).toBe("session_not_found")
    expect(badNumber.error).toBe("invalid_cursor")
    expect(badText.error).toBe("invalid_cursor")
    expect(listed.sessions?.some((session) => session.sessionId === sessionId)).toBe(true)
  })
})
