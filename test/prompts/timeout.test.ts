import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { TurnResult } from "../../src/droid/turns.ts"
import { settle, withPrompts } from "../support/prompts.ts"

const pending = (turn: TurnResult, kind: string) => {
  const event = turn.events.find((candidate) => candidate.kind === kind)

  if (event?.requestId === undefined) throw new Error("no " + kind + " event")

  return event
}

const TIMEOUT_MS = 150

describe("prompt deadlines", () => {
  it("cancels a permission prompt and lets the turn continue", async () => {
    const outcome = await Effect.runPromise(
      withPrompts(
        (harness) =>
          Effect.gen(function* () {
            const turn = yield* harness.hub.api.stream({
              sessionId: harness.sessionId,
              prompt: "permission",
              waitMs: 300,
            })

            const event = pending(turn, "pending_permission")
            const settled = yield* settle(harness.hub, harness.sessionId, event.seq + 1)

            const late = yield* harness
              .respondPermission({
                sessionId: harness.sessionId,
                requestId: event.requestId ?? "",
                outcome: "proceed_once",
              })
              .pipe(Effect.flip)

            return { event, settled, late }
          }),
        TIMEOUT_MS,
      ),
    )

    expect((outcome.event.deadline ?? 0) - Date.now()).toBeLessThan(5_000)
    const notice = outcome.settled.events.find((candidate) => candidate.kind === "prompt_resolved")

    expect(notice?.reason).toBe("timeout")
    expect(notice?.requestId).toBe(outcome.event.requestId)
    expect(notice?.requestId?.startsWith("hub-")).toBe(true)
    expect(outcome.settled.status).toBe("interrupted")
    expect(outcome.late.code).toBe("prompt_not_found")
  })

  it("sends the ask-user cancel shape", async () => {
    const outcome = await Effect.runPromise(
      withPrompts(
        (harness) =>
          Effect.gen(function* () {
            const turn = yield* harness.hub.api.stream({
              sessionId: harness.sessionId,
              prompt: "ask",
              waitMs: 300,
            })

            const event = pending(turn, "pending_question")

            return yield* settle(harness.hub, harness.sessionId, event.seq + 1)
          }),
        TIMEOUT_MS,
      ),
    )

    expect(outcome.result?.structuredOutput).toEqual({ cancelled: true, answers: [] })
  })

  it("sends the option-picker cancel shape", async () => {
    const outcome = await Effect.runPromise(
      withPrompts(
        (harness) =>
          Effect.gen(function* () {
            const turn = yield* harness.hub.api.stream({
              sessionId: harness.sessionId,
              prompt: "pick",
              waitMs: 300,
            })

            const event = pending(turn, "pending_options")

            return yield* settle(harness.hub, harness.sessionId, event.seq + 1)
          }),
        TIMEOUT_MS,
      ),
    )

    expect(outcome.result?.structuredOutput).toEqual({ cancelled: true, selectedIds: [] })
  })

  it("cancels pending prompts when the session closes", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "permission",
            waitMs: 300,
          })

          const event = pending(turn, "pending_permission")
          yield* harness.hub.api.close(harness.sessionId)

          return yield* harness
            .respondPermission({
              sessionId: harness.sessionId,
              requestId: event.requestId ?? "",
              outcome: "proceed_once",
            })
            .pipe(Effect.flip)
        }),
      ),
    )

    expect(outcome.code).toBe("session_not_found")
  })
})
