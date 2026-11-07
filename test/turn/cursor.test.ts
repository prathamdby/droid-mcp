import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { RING_EVENT_LIMIT } from "../../src/droid/turns.ts"
import { createSession, fakeHub } from "../support/hub.ts"

describe("session cursors", () => {
  it("returns the turn's events and then nothing for the same cursor", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(
          Effect.flatMap((hub) =>
            Effect.gen(function* () {
              const sessionId = yield* createSession(hub)
              const first = yield* hub.api.stream({ sessionId, prompt: "hello" })
              const second = yield* hub.api.events({ sessionId, cursor: first.cursor })

              return { first, second }
            }),
          ),
        ),
      ),
    )

    expect(outcome.first.status).toBe("completed")
    const last = outcome.first.events[outcome.first.events.length - 1]
    expect(outcome.first.cursor).toBe((last?.seq ?? 0) + 1)
    const kinds = outcome.first.events.map((event) => event.kind)
    expect(kinds).toContain("assistant_text")
    expect(kinds).toContain("tool_call")
    expect(kinds).toContain("tool_result")
    expect(kinds).toContain("turn_completed")
    expect(outcome.first.result?.reason).toBe("completed")
    expect(outcome.second.events).toHaveLength(0)
    expect(outcome.second.cursor).toBe(outcome.first.cursor)
    expect(outcome.second.status).toBe("completed")
  })

  it("returns running with a cursor when waitMs expires", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(
          Effect.flatMap((hub) =>
            Effect.gen(function* () {
              const sessionId = yield* createSession(hub)
              const running = yield* hub.api.stream({ sessionId, prompt: "hang", waitMs: 100 })

              return running
            }),
          ),
        ),
      ),
    )

    expect(outcome.status).toBe("running")
    expect(outcome.cursor).toBe(1)
  })

  it("marks a cursor older than the buffer as truncated", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(
          Effect.flatMap((hub) =>
            Effect.gen(function* () {
              const sessionId = yield* createSession(hub)
              yield* hub.api.stream({ sessionId, prompt: "burst:600" })
              const polled = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 10 })

              return polled
            }),
          ),
        ),
      ),
    )

    expect(outcome.truncated).toBe(true)
    expect(outcome.events.length).toBeLessThanOrEqual(RING_EVENT_LIMIT)
    expect(outcome.events[0]?.seq).toBeGreaterThan(1)
  })

  it("does not duplicate events between a stream and a poll", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(
          Effect.flatMap((hub) =>
            Effect.gen(function* () {
              const sessionId = yield* createSession(hub)
              const first = yield* hub.api.stream({ sessionId, prompt: "hello" })
              const second = yield* hub.api.events({ sessionId, cursor: first.cursor, waitMs: 10 })
              const third = yield* hub.api.events({ sessionId, cursor: second.cursor, waitMs: 10 })

              return { first, second, third }
            }),
          ),
        ),
      ),
    )

    expect(outcome.second.events).toHaveLength(0)
    expect(outcome.third.events).toHaveLength(0)
  })
})
