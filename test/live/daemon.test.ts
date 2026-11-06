import { spawn } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { decodeSessionsResult, openDaemon } from "../../src/droid/daemon-client.ts"
import { METHOD } from "../../src/droid/protocol.ts"

const live = process.env["DROID_MCP_LIVE_DAEMON"] === "1"
const apiKey = process.env["FACTORY_API_KEY"]
const droidPath = process.env["DROID_MCP_DROID_PATH"] ?? "droid"

const waitForSocket = async (path: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error("daemon socket did not appear: " + path)
}

describe.skipIf(!live || apiKey === undefined)("live daemon", () => {
  it("connects, authenticates, and lists sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "droid-mcp-live-"))
    const socket = join(directory, "daemon.sock")

    const child = spawn(droidPath, ["daemon", "--unix", socket, "--listen", "websocket"], {
      stdio: "ignore",
    })

    try {
      await waitForSocket(socket, 30_000)

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* openDaemon({ socketPath: socket, version: "0.1.0" })
          const auth = yield* client.authenticate(apiKey ?? "")
          const raw = yield* client.request({ method: METHOD.listOpenedSessions, params: {} })
          const sessions = yield* decodeSessionsResult(raw)
          const version = yield* client.protocolVersion
          yield* client.close

          return { auth, count: sessions.sessions.length, version }
        }),
      )

      expect(outcome.auth.userId.length).toBeGreaterThan(0)
      expect(outcome.count).toBeGreaterThanOrEqual(0)
      expect(outcome.version.length).toBeGreaterThan(0)
    } finally {
      child.kill("SIGTERM")
    }
  })
})
