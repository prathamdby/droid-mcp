import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { SessionHub } from "../../src/droid/turns.ts"
import { createSession, fakeHub } from "../support/hub.ts"

const scoped = <A, E>(run: (hub: SessionHub) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(Effect.flatMap((hub) => run(hub))),
  )

describe("turn submission", () => {
  it("records a rejected message without replaying the previous turn", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const first = yield* hub.api.stream({ sessionId, prompt: "structured" })
          const second = yield* hub.api.stream({ sessionId, prompt: "reject", waitMs: 1_000 })
          const polled = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })
          const third = yield* hub.api.stream({ sessionId, prompt: "hello" })
          const completed = polled.events.filter((event) => event.kind === "turn_completed")

          return { first, second, polled, third, completed }
        }),
      ),
    )

    expect(outcome.first.status).toBe("completed")
    expect(outcome.first.result?.structuredOutput).toEqual({ old: true })
    expect(outcome.first.result?.turnId).toBe("turn-a")
    expect(outcome.second.status).toBe("failed")
    expect(outcome.second.result?.reason).toBe("exec_failed")
    expect(outcome.second.result?.turnId).toBeUndefined()
    expect(outcome.second.result?.structuredOutput).toBeUndefined()
    expect(outcome.polled.status).toBe("failed")
    expect(outcome.polled.result?.reason).toBe("exec_failed")
    expect(outcome.polled.result?.turnId).toBeUndefined()
    expect(outcome.polled.result?.structuredOutput).toBeUndefined()
    expect(outcome.completed[outcome.completed.length - 1]?.reason).toBe("exec_failed")
    expect(outcome.third.status).toBe("completed")
    expect(outcome.third.result?.structuredOutput).toBeUndefined()
  })
})
