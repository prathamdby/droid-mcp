import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { SessionHub, TurnResult } from "../../src/droid/turns.ts"
import { createSession, fakeHub } from "../support/hub.ts"

const scoped = <A, E>(run: (hub: SessionHub) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(Effect.flatMap((hub) => run(hub))),
  )

const permissionEvent = (turn: TurnResult) => {
  const event = turn.events.find((candidate) => candidate.kind === "pending_permission")

  if (event?.requestId === undefined) throw new Error("missing pending permission")

  return event
}

const untilSettled = (hub: SessionHub, sessionId: string, cursor: number) =>
  Effect.gen(function* () {
    let current = yield* hub.api.events({ sessionId, cursor, waitMs: 1_000 })

    for (let attempt = 0; current.status === "running" && attempt < 5; attempt += 1) {
      current = yield* hub.api.events({ sessionId, cursor: current.cursor, waitMs: 1_000 })
    }

    return current
  })

describe("prompt lifetime", () => {
  it("drops a permission prompt when the turn is interrupted", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission",
            waitMs: 200,
          })

          const event = permissionEvent(running)

          yield* hub.api.interrupt(sessionId)
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const pending = yield* hub.api.pendingPrompt(sessionId, event.requestId ?? "")

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId: event.requestId ?? "",
              result: { selectedOption: "proceed_once" },
            })
            .pipe(Effect.flip)

          return { settled, pending, stale }
        }),
      ),
    )

    expect(outcome.settled.status).toBe("interrupted")
    expect(outcome.settled.result?.reason).toBe("cancelled")
    expect(outcome.pending).toBeUndefined()
    expect(outcome.stale.code).toBe("prompt_not_found")
  })

  it("rejects a stale public id when the CLI reuses a request id", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const first = yield* hub.api.stream({
            sessionId,
            prompt: "permission:reuse",
            waitMs: 200,
          })

          const firstId = permissionEvent(first).requestId ?? ""

          yield* hub.api.interrupt(sessionId)
          yield* untilSettled(hub, sessionId, first.cursor)

          const second = yield* hub.api.stream({
            sessionId,
            prompt: "permission:reuse",
            waitMs: 200,
          })

          const secondId = permissionEvent(second).requestId ?? ""

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId: firstId,
              result: { selectedOption: "cancel" },
            })
            .pipe(Effect.flip)

          yield* hub.api.answer({
            sessionId,
            requestId: secondId,
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, second.cursor)

          return { firstId, secondId, stale, settled }
        }),
      ),
    )

    expect(outcome.firstId).not.toBe(outcome.secondId)
    expect(outcome.stale.code).toBe("prompt_not_found")
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
  })

  it("keeps only the newest prompt when one CLI id is sent twice", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:dup",
            waitMs: 300,
          })

          const first = yield* hub.api.pendingPrompt(sessionId, "hub-1")
          const second = yield* hub.api.pendingPrompt(sessionId, "hub-2")

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId: "hub-1",
              result: { selectedOption: "proceed_once" },
            })
            .pipe(Effect.flip)

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-2",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)

          return { first, second, stale, settled }
        }),
      ),
    )

    expect(outcome.first).toBeUndefined()
    expect(outcome.second?.kind).toBe("permission")

    if (outcome.second?.kind === "permission") {
      expect(outcome.second.toolUses[0]?.toolUse?.name).toBe("Second")
    }

    expect(outcome.stale.code).toBe("prompt_not_found")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
  })

  it("keeps a huge permission prompt answerable after the ring bounds the event", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:huge",
            waitMs: 300,
          })

          const event = permissionEvent(running)
          const pending = yield* hub.api.pendingPrompt(sessionId, event.requestId ?? "")

          yield* hub.api.answer({
            sessionId,
            requestId: event.requestId ?? "",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)

          return { running, event, pending, settled }
        }),
      ),
    )

    expect(outcome.running.truncated).toBe(false)
    expect(outcome.running.events.length).toBeGreaterThan(0)
    expect(outcome.event.options).toEqual(["proceed_once", "cancel"])
    expect(outcome.event.requestId?.startsWith("hub-")).toBe(true)
    expect(JSON.stringify(outcome.running.events).includes("x".repeat(10_000))).toBe(false)
    expect(outcome.pending?.kind).toBe("permission")

    if (outcome.pending?.kind === "permission") {
      expect(JSON.stringify(outcome.pending.toolUses[0]?.toolUse?.input)).toContain(
        "x".repeat(300_000),
      )
    }

    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
  })

  it("survives answering and closing the same prompt together", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission",
            waitMs: 200,
          })

          const event = permissionEvent(running)

          const answered = hub.api
            .answer({
              sessionId,
              requestId: event.requestId ?? "",
              result: { selectedOption: "proceed_once" },
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error.code,
                onSuccess: () => "resolved",
              }),
            )

          const closed = hub.api.close(sessionId).pipe(
            Effect.match({
              onFailure: (error) => error.code,
              onSuccess: () => "closed",
            }),
          )

          const both = yield* Effect.all([answered, closed], { concurrency: 2 })
          const sessions = yield* hub.api.sessions

          return { both, sessions }
        }),
      ),
    )

    expect(outcome.sessions).toHaveLength(0)
    expect(["resolved", "prompt_not_found", "session_not_found", "exec_failed"]).toContain(
      outcome.both[0],
    )
    expect(outcome.both[1]).toBe("closed")
  })
})
