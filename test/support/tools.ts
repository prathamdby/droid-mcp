import * as Effect from "effect/Effect"

import type { Config } from "../../src/config.ts"
import type { JsonValue } from "../../src/droid/protocol.ts"
import { SessionHubService } from "../../src/droid/turns.ts"
import type { SessionHub } from "../../src/droid/turns.ts"
import type { ToolFailure } from "../../src/tools/failure.ts"
import { sessionAdminTools } from "../../src/tools/session-admin.ts"
import { sessionDiscoverTools } from "../../src/tools/session-discover.ts"
import { sessionHistoryTools } from "../../src/tools/session-history.ts"
import { sessionMcpTools } from "../../src/tools/session-mcp.ts"
import { sessionPromptTools } from "../../src/tools/session-prompts.ts"
import { sessionTools } from "../../src/tools/session.ts"
import { testConfig } from "./config.ts"
import { createSession, fakeHub } from "./hub.ts"

/** Every session tool handler, keyed by tool name. */
export type ToolHandler = (params: never) => Effect.Effect<unknown, ToolFailure, SessionHubService>

export interface ToolHarness {
  readonly hub: SessionHub
  readonly sessionId: string
  readonly config: Config
  readonly call: (
    name: string,
    params: Readonly<Record<string, JsonValue>>,
  ) => Effect.Effect<unknown, ToolFailure>
}

/**
 * Runs the real handlers with a fake `droid exec`, the same way the server
 * wires them: one hub service, one handler per tool.
 */
export const withTools = <A, E>(
  run: (harness: ToolHarness) => Effect.Effect<A, E>,
  overrides: Partial<Config> = {},
): Effect.Effect<A, E | ToolFailure, never> =>
  Effect.scoped(
    Effect.acquireRelease(
      fakeHub({ promptTimeoutMs: overrides.promptTimeoutMs ?? 5_000 }),
      (hub) => hub.closeAll,
    ).pipe(
      Effect.flatMap((hub) => {
        const config = testConfig(overrides)

        const registry = new Map<string, ToolHandler>()

        const collect = (record: Readonly<Record<string, ToolHandler>>): void => {
          for (const [name, handler] of Object.entries(record)) registry.set(name, handler)
        }

        collect(sessionTools(config).handlers)
        collect(sessionPromptTools().handlers)
        collect(sessionAdminTools(config).handlers)
        collect(sessionMcpTools().handlers)
        collect(sessionHistoryTools().handlers)
        collect(sessionDiscoverTools(config).handlers)

        return Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const harness: ToolHarness = {
            hub,
            sessionId,
            config,
            call: (name, params) =>
              Effect.gen(function* () {
                const handler = registry.get(name)

                if (handler === undefined) {
                  return yield* Effect.fail({
                    code: "missing_tool",
                    message: "no handler named " + name,
                  })
                }

                // SAFETY: the registry is keyed by tool name and each handler was
                // declared with that tool's own parameter schema; this table erases
                // the per-key types because the test looks handlers up by string.
                return yield* Effect.provideService(
                  handler(params as never),
                  SessionHubService,
                  hub.api,
                )
              }),
          }

          return yield* run(harness)
        })
      }),
    ),
  )

export const withDroidPath = (droidPath: string, overrides: Partial<Config> = {}): Config =>
  testConfig({ droidPath, ...overrides })
