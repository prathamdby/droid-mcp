import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply } from "../support/fake-daemon.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

let directory: string
let client: ToolClient | undefined
let daemon: FakeDaemon | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "droid-mcp-autonomy-"))
})

afterEach(async () => {
  await client?.dispose()
  await daemon?.close()
  client = undefined
  daemon = undefined
  rmSync(directory, { recursive: true, force: true })
})

const open = async (
  maxAutonomy: "off" | "low" | "medium" | "high" = "medium",
): Promise<ToolClient> => {
  daemon = await startFakeDaemon(join(directory, "daemon.sock"), {
    onRequest: (request): ScriptedReply => {
      if (request.method === "daemon.authenticate") {
        return { result: { userId: "user-1", orgId: "org-1" } }
      }

      return { result: { ok: true } }
    },
  })

  client = await connect({
    config: testConfig({
      socketPath: daemon.socketPath,
      runtimeDir: directory,
      factoryApiKey: "test-key",
      maxAutonomy,
    }),
  })

  return client
}

const sent = (method: string): boolean =>
  daemon?.requests.some((request) => request.method === method) ?? false

describe("generated autonomy over HTTP", () => {
  it("blocks a high settings change before the daemon sees it", async () => {
    const tools = await open()

    const failure = await tools.fail("daemon_update_session_settings", {
      sessionId: "s-1",
      autonomyLevel: "high",
    })

    expect(failure.code).toBe("autonomy_exceeds_cap")
    expect(sent("daemon.update_session_settings")).toBe(false)
  })

  it("sends a settings change within the default medium cap", async () => {
    const tools = await open()

    const result = await tools.ok("daemon_update_session_settings", {
      sessionId: "s-1",
      autonomyLevel: "low",
      modelId: "gpt-6.1-sol",
    })

    expect(result).toMatchObject({ ok: true })
    expect(
      daemon?.requests.find((request) => request.method === "daemon.update_session_settings")
        ?.params,
    ).toMatchObject({ sessionId: "s-1", autonomyLevel: "low", modelId: "gpt-6.1-sol" })
  })

  it("rejects a medium settings change when the cap is off", async () => {
    const tools = await open("off")

    const failure = await tools.fail("daemon_update_session_settings", {
      sessionId: "s-1",
      autonomyLevel: "medium",
    })

    expect(failure.code).toBe("autonomy_exceeds_cap")
    expect(sent("daemon.update_session_settings")).toBe(false)
  })

  it("rejects a medium settings change when the cap is low", async () => {
    const tools = await open("low")

    const failure = await tools.fail("daemon_update_session_settings", {
      sessionId: "s-1",
      autonomyLevel: "medium",
    })

    expect(failure.code).toBe("autonomy_exceeds_cap")
    expect(sent("daemon.update_session_settings")).toBe(false)
  })

  it("permits a high settings change when the cap is high", async () => {
    const tools = await open("high")

    const result = await tools.ok("daemon_update_session_settings", {
      sessionId: "s-1",
      autonomyLevel: "high",
    })

    expect(result).toMatchObject({ ok: true })
    expect(
      daemon?.requests.find((request) => request.method === "daemon.update_session_settings")
        ?.params,
    ).toMatchObject({ sessionId: "s-1", autonomyLevel: "high" })
  })
})
