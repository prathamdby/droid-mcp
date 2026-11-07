import { Effect } from "effect"
import * as Fiber from "effect/Fiber"
import { describe, expect, it } from "vitest"

import { SessionHubService } from "../../src/droid/turns.ts"
import type { SessionHub } from "../../src/droid/turns.ts"
import { EVENT_TEXT_LIMIT, RING_BYTE_LIMIT, RING_EVENT_LIMIT } from "../../src/droid/turns.ts"
import { sessionDiscoverTools } from "../../src/tools/session-discover.ts"
import { testConfig } from "../support/config.ts"
import { createSession, fakeHub, tempCwd } from "../support/hub.ts"

const scoped = <A, E>(run: (hub: SessionHub) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(Effect.flatMap((hub) => run(hub))),
  )

const runTool = (hub: SessionHub) => {
  const tools = sessionDiscoverTools(testConfig())

  return (params: {
    readonly cwd: string
    readonly prompt: string
    readonly autonomyLevel: "low"
    readonly waitMs?: number
  }) => tools.handlers.session_run(params).pipe(Effect.provideService(SessionHubService, hub.api))
}

describe("running sessions and bounded history", () => {
  it("keeps a session_run that is still running", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const turn = yield* runTool(hub)({
            cwd: tempCwd(),
            prompt: "hang",
            autonomyLevel: "low",
            waitMs: 20,
          })

          const polled = yield* hub.api.events({
            sessionId: turn.sessionId,
            cursor: turn.cursor,
            waitMs: 30,
          })

          return { turn, polled }
        }),
      ),
    )

    expect(outcome.turn.status).toBe("running")
    expect(outcome.polled.status).toBe("running")
  })

  it("closes a session_run that finishes or fails", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const run = runTool(hub)

          const done = yield* run({
            cwd: tempCwd(),
            prompt: "echo:one",
            autonomyLevel: "low",
          })

          const afterDone = yield* hub.api
            .events({ sessionId: done.sessionId, cursor: done.cursor })
            .pipe(Effect.flip)

          const failed = yield* run({
            cwd: tempCwd(),
            prompt: "reject",
            autonomyLevel: "low",
            waitMs: 1_000,
          })

          const afterFailed = yield* hub.api
            .events({ sessionId: failed.sessionId, cursor: 1 })
            .pipe(Effect.flip)

          return { done, afterDone, failed, afterFailed }
        }),
      ),
    )

    expect(outcome.done.status).toBe("completed")
    expect(outcome.done.result?.structuredOutput).toEqual({ echo: "one" })
    expect(outcome.afterDone.code).toBe("session_not_found")
    expect(outcome.failed.status).toBe("failed")
    expect(outcome.failed.result?.reason).toBe("exec_failed")
    expect(outcome.afterFailed.code).toBe("session_not_found")
  })

  it("closes a session_run interrupted before it returns running", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkDetach(
            runTool(hub)({
              cwd: tempCwd(),
              prompt: "hang",
              autonomyLevel: "low",
              waitMs: 10_000,
            }),
          )

          let opened = false

          for (let attempt = 0; attempt < 40 && !opened; attempt += 1) {
            const sessions = yield* hub.api.sessions

            opened = sessions.length === 1

            if (!opened) yield* Effect.sleep("25 millis")
          }

          yield* Fiber.interrupt(fiber)
          yield* Fiber.await(fiber)
          yield* Effect.sleep("50 millis")
          const sessions = yield* hub.api.sessions

          return { opened, sessions }
        }),
      ),
    )

    expect(outcome.opened).toBe(true)
    expect(outcome.sessions).toHaveLength(0)
  })

  it("caps assistant text by UTF-8 bytes without splitting a code point", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const burst = yield* hub.api.stream({ sessionId, prompt: "deltas:2000" })
          const next = yield* hub.api.stream({ sessionId, prompt: "hello" })

          return { burst, next }
        }),
      ),
    )

    const text = outcome.burst.events.find((event) => event.kind === "assistant_text")?.text ?? ""
    const mark = "…[truncated]"
    const body = text.endsWith(mark) ? text.slice(0, text.length - mark.length) : text

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(EVENT_TEXT_LIMIT)
    expect(text.endsWith(mark)).toBe(true)
    expect(text.includes("\uFFFD")).toBe(false)
    expect([...body].every((char) => char === "😀")).toBe(true)
    expect(outcome.next.events.some((event) => event.text === "hi")).toBe(true)
  })

  it("evicts the ring by UTF-8 bytes while a pending prompt stays readable", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const turn = yield* hub.api.stream({ sessionId, prompt: "bulk:70" })

          return turn
        }),
      ),
    )

    expect(RING_BYTE_LIMIT).toBe(256 * 1024)
    expect(outcome.truncated).toBe(true)
    expect(outcome.events.length).toBeLessThan(71)
    expect(outcome.events.length).toBeLessThanOrEqual(RING_EVENT_LIMIT)
    expect(outcome.events[0]?.seq).toBeGreaterThan(1)
    expect(outcome.status).toBe("completed")
  })

  it("marks an idle exit failed and refuses another turn", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          yield* hub.api.stream({ sessionId, prompt: "done-exit", waitMs: 1_000 })
          let failed = false

          for (let attempt = 0; attempt < 40 && !failed; attempt += 1) {
            const sessions = yield* hub.api.sessions

            failed = sessions[0]?.status === "failed"

            if (!failed) yield* Effect.sleep("25 millis")
          }

          const blocked = yield* hub.api.stream({ sessionId, prompt: "hello" }).pipe(Effect.flip)
          const events = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 20 })

          return { failed, blocked, events }
        }),
      ),
    )

    expect(outcome.failed).toBe(true)
    expect(outcome.blocked.code).toBe("session_closed")
    expect(outcome.events.status).toBe("failed")
    expect(outcome.events.result?.reason).toBe("process_exit")
  })

  it("patches the hub snapshot after settings and directory commands", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          yield* hub.api.command({
            sessionId,
            method: "droid.update_session_settings",
            params: { sessionId, autonomyLevel: "medium", interactionMode: "spec" },
          })
          const updated = yield* hub.api.sessions

          yield* hub.api.command({
            sessionId,
            method: "droid.change_working_directory",
            params: { workingDirectory: "/tmp" },
          })
          const moved = yield* hub.api.sessions

          return { updated: updated[0], moved: moved[0] }
        }),
      ),
    )

    expect(outcome.updated?.settings.autonomyLevel).toBe("medium")
    expect(outcome.updated?.settings.interactionMode).toBe("spec")
    expect(outcome.moved?.cwd).toBe("/tmp")
  })
})
