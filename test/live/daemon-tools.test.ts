import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { daemonLayer, DaemonService } from "../../src/droid/daemon-service.ts"
import { errorCode } from "../../src/droid/errors.ts"
import { SURFACE } from "../../src/generated/surface.ts"
import { testConfig } from "../support/config.ts"

/**
 * The daemon tools against a real daemon. Runs only with credentials:
 *
 *   DROID_MCP_LIVE_DAEMON=1 pnpm vitest run --project live test/live/daemon-tools.test.ts
 */

const live = process.env["DROID_MCP_LIVE_DAEMON"] === "1"
const apiKey = process.env["FACTORY_API_KEY"]
const droidPath = process.env["DROID_MCP_DROID_PATH"] ?? "droid"

describe.skipIf(!live || apiKey === undefined)("live daemon tools", () => {
  const config = testConfig({ factoryApiKey: apiKey, droidPath })

  it("lists opened sessions through the service the tools use", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const daemon = yield* DaemonService

        const sessions = yield* daemon.request({
          method: "daemon.list_opened_sessions",
          params: {},
        })

        const status = yield* daemon.status

        return { sessions, status }
      }).pipe(Effect.provide(daemonLayer(config))),
    )

    expect(result.status.endpoint.length).toBeGreaterThan(0)
    expect(result.sessions).toBeDefined()
  }, 120_000)

  it("reports a missing key instead of dialling without one", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const daemon = yield* DaemonService

        return yield* daemon.request({ method: "daemon.list_opened_sessions", params: {} })
      }).pipe(
        Effect.provide(daemonLayer(testConfig({ factoryApiKey: undefined, droidPath }))),
        Effect.flip,
      ),
    )

    expect(errorCode(error)).toBe("factory_api_key_missing")
  })

  it("covers the sessions namespace the daemon tools claim", () => {
    const tools = new Set(SURFACE.map((entry) => entry.tool))

    for (const tool of [
      "daemon_list_opened_sessions",
      "daemon_list_available_sessions",
      "daemon_search_sessions",
      "daemon_get_session_messages",
      "daemon_update_session_settings",
    ]) {
      expect(tools.has(tool)).toBe(true)
    }
  })
})
