import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Config } from "../../src/config.ts"
import { MAX_WAIT_MS } from "../../src/droid/turns.ts"
import { testConfig } from "../support/config.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply } from "../support/fake-daemon.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

let directory: string
let client: ToolClient | undefined
let daemon: FakeDaemon | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "droid-mcp-failures-"))
})

afterEach(async () => {
  await client?.dispose()
  await daemon?.close()
  client = undefined
  daemon = undefined
  rmSync(directory, { recursive: true, force: true })
})

const open = async (overrides: Partial<Config>): Promise<ToolClient> => {
  client = await connect({
    config: testConfig({
      socketPath: join(directory, "daemon.sock"),
      runtimeDir: directory,
      factoryApiKey: "test-key",
      ...overrides,
    }),
  })

  return client
}

/** A `droid` path that cannot be executed: missing, or present without the execute bit. */
const unusableDroids = (): ReadonlyArray<readonly [string, string]> => {
  const plain = join(directory, "not-executable")

  writeFileSync(plain, "#!/bin/sh\nexit 0\n")
  chmodSync(plain, 0o644)

  return [
    ["missing", join(directory, "missing", "droid")],
    ["not executable", plain],
  ]
}

describe("tool failures over MCP", () => {
  it("reports a droid binary that cannot run as a failure and keeps serving", async () => {
    for (const [label, droidPath] of unusableDroids()) {
      const tools = await open({ droidPath })

      const daemonFailure = await tools.fail("daemon_list_models")

      expect(daemonFailure.code, label).toBe("daemon_unavailable")

      const sessionFailure = await tools.fail("session_create", {
        cwd: directory,
        autonomyLevel: "low",
      })

      expect(sessionFailure.code, label).toBe("exec_failed")
      expect(await tools.ok("server_info")).toBeDefined()

      await tools.dispose()
      client = undefined
    }
  })

  it("reports a daemon reply that breaks the SDK result schema as a protocol error", async () => {
    const replies = new Map<string, ScriptedReply>([
      ["daemon.authenticate", { result: { userId: "user-1", orgId: "org-1" } }],
      ["daemon.list_models", { result: "not an object" }],
      ["daemon.list_crons", { result: { crons: "none" } }],
    ])

    daemon = await startFakeDaemon(join(directory, "daemon.sock"), {
      onRequest: (request) => replies.get(request.method) ?? { result: {} },
    })

    const tools = await open({})

    expect(await tools.fail("daemon_list_models")).toEqual({
      code: "daemon_protocol_error",
      message: "daemon.list_models returned a result that does not match its schema",
    })
    expect(await tools.fail("daemon_list_crons", { sessionId: "s-1" })).toEqual({
      code: "daemon_protocol_error",
      message: "daemon.list_crons returned a result that does not match its schema",
    })

    replies.set("daemon.list_crons", { result: { crons: [], added: true } })

    expect(await tools.ok("daemon_list_crons", { sessionId: "s-1" })).toEqual({ crons: [] })
  })

  it("bounds waitMs and advertises the bound", async () => {
    const tools = await open({})
    const listed = await tools.list()

    for (const name of ["session_stream", "session_events", "session_run"]) {
      const schema = JSON.stringify(listed.find((tool) => tool.name === name)?.inputSchema)

      expect(schema, name).toContain('"maximum":' + String(MAX_WAIT_MS))
      expect(schema, name).not.toContain("Infinity")
    }

    const outcome = await tools.call("session_stream", {
      sessionId: "s-1",
      prompt: "hello",
      waitMs: MAX_WAIT_MS + 1,
    })

    expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
  })

  it("rejects null for non-nullable optional inputs before running handlers", async () => {
    const tools = await open({ droidPath: join(directory, "missing", "droid") })

    const calls = [
      ["session_create", { cwd: directory, autonomyLevel: "low", modelId: null }],
      ["session_run", { cwd: directory, prompt: "hello", autonomyLevel: "low", waitMs: null }],
      ["session_update_settings", { sessionId: "nope", modelId: null }],
      ["session_rewind", { sessionId: "nope", messageId: "m-1", filesToDelete: null }],
      ["session_list_skills", { sessionId: "nope", includeContent: null }],
      [
        "session_add_mcp_server",
        { sessionId: "nope", name: "docs", command: "docs", oauth: { scopes: null } },
      ],
      [
        "session_respond_permission",
        { sessionId: "nope", requestId: "p", outcome: "cancel", comment: null },
      ],
      ["rest_list_environments", { serviceAccountId: null }],
      ["rest_create_environment", { body: { name: "x", repositories: [], setupScript: null } }],
      ["context_list_spaces", { limit: null }],
    ] as const

    for (const [name, args] of calls) {
      const outcome = await tools.call(name, args)

      if (outcome.rpcError !== undefined) {
        expect(outcome.rpcError.code, name).toBe(-32602)
      } else {
        expect(outcome.isError, name).toBe(true)
        expect(outcome.text, name).toMatch(/Invalid parameters for tool|invalid_arguments/)
      }
    }
  })

  it("reports an unknown session to the prompt tools as session_not_found", async () => {
    const tools = await open({})

    const calls = [
      ["session_respond_permission", { outcome: "cancel" }],
      ["session_answer_question", { answers: [{ index: 0, answer: "a" }] }],
      ["session_pick_options", { selectedIds: ["x"] }],
    ] as const

    for (const [name, args] of calls) {
      expect(await tools.fail(name, { sessionId: "nope", requestId: "p", ...args })).toEqual({
        code: "session_not_found",
        message: "no session nope; call session_create first",
      })
    }
  })
})
