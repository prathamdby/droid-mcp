import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { SessionHub } from "../../src/droid/turns.ts"
import { createSession, fakeHub } from "../support/hub.ts"

const scoped = <A, E>(run: (hub: SessionHub) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(Effect.flatMap((hub) => run(hub))),
  )

describe("session lifecycle", () => {
  it("refuses a second stream while a turn is running", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const running = yield* hub.api.stream({ sessionId, prompt: "hang", waitMs: 50 })

          const second = yield* hub.api
            .stream({ sessionId, prompt: "hello", waitMs: 50 })
            .pipe(Effect.flip)

          return { running, second }
        }),
      ),
    )

    expect(outcome.running.status).toBe("running")
    expect(outcome.second.code).toBe("session_busy")
  })

  it("reports an interrupt as an interrupted turn", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const running = yield* hub.api.stream({ sessionId, prompt: "interrupt", waitMs: 50 })
          yield* hub.api.interrupt(sessionId)

          const polled = yield* hub.api.events({
            sessionId,
            cursor: running.cursor,
            waitMs: 2_000,
          })

          return polled
        }),
      ),
    )

    expect(outcome.status).toBe("interrupted")
    expect(outcome.result?.reason).toBe("cancelled")
  })

  it("fails the running turn when the child exits", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const turn = yield* hub.api.stream({ sessionId, prompt: "crash", waitMs: 2_000 })

          return turn
        }),
      ),
    )

    expect(outcome.status).toBe("failed")
    expect(outcome.result?.reason).toBe("process_exit")
    expect(outcome.events.some((event) => event.code === "process_exit")).toBe(true)
  })

  it("drops the session when closed", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const closed = yield* hub.api.close(sessionId)
          const after = yield* hub.api.events({ sessionId, cursor: 1 }).pipe(Effect.flip)

          return { closed, after }
        }),
      ),
    )

    expect(outcome.closed.closed).toBe(true)
    expect(outcome.after.code).toBe("session_not_found")
  })

  it("reaps an idle session", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(
          fakeHub({ idleMs: 50, reaperIntervalMs: 20 }),
          (hub) => hub.closeAll,
        ).pipe(
          Effect.flatMap((hub) =>
            Effect.gen(function* () {
              yield* createSession(hub)
              yield* Effect.sleep("200 millis")
              const sessions = yield* hub.api.sessions

              return sessions
            }),
          ),
        ),
      ),
    )

    expect(outcome).toHaveLength(0)
  })

  it("rejects a blank prompt and an interrupt with nothing to stop", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const blank = yield* hub.api.stream({ sessionId, prompt: "   \n\t " }).pipe(Effect.flip)
          const idle = yield* hub.api.interrupt(sessionId)

          return { blank, idle }
        }),
      ),
    )

    expect(outcome.blank.code).toBe("invalid_prompt")
    expect(outcome.idle.interrupted).toBe(false)
  })
})
