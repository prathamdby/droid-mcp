import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { TurnResult } from "../../src/droid/turns.ts"
import { withPrompts } from "../support/prompts.ts"

const pending = (turn: TurnResult, kind: string) => {
  const event = turn.events.find((candidate) => candidate.kind === kind)

  if (event?.requestId === undefined)
    throw new Error("no " + kind + " event in " + String(turn.cursor))

  return event
}

describe("permission prompts", () => {
  it("sends the selected option and completes the turn", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "permission",
            waitMs: 2_000,
          })

          const event = pending(turn, "pending_permission")
          yield* harness.respondPermission({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            outcome: "proceed_once",
          })

          const afterAnswer = yield* harness.hub.api.events({
            sessionId: harness.sessionId,
            cursor: event.seq + 1,
            waitMs: 2_000,
          })

          const settled = yield* harness.hub.api.events({
            sessionId: harness.sessionId,
            cursor: afterAnswer.cursor,
            waitMs: 2_000,
          })

          return { event, settled }
        }),
      ),
    )

    expect(outcome.event.options).toEqual(["proceed_once", "proceed_always", "cancel"])
    expect(outcome.event.toolUses).toHaveLength(1)
    expect(outcome.event.deadline).toBeGreaterThan(0)
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
  })

  it("reports a denied prompt as an interrupted turn", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "deny",
            waitMs: 2_000,
          })

          const event = pending(turn, "pending_permission")
          yield* harness.respondPermission({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            outcome: "cancel",
          })

          yield* harness.hub.api.events({
            sessionId: harness.sessionId,
            cursor: event.seq + 1,
            waitMs: 2_000,
          })

          return yield* harness.hub.api.events({
            sessionId: harness.sessionId,
            cursor: event.seq + 1,
            waitMs: 2_000,
          })
        }),
      ),
    )

    expect(outcome.status).toBe("interrupted")
    expect(outcome.result?.reason).toBe("permission_rejected")
  })

  it("rejects an outcome the prompt did not offer", async () => {
    const failure = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "permission",
            waitMs: 2_000,
          })

          const event = pending(turn, "pending_permission")

          return yield* harness
            .respondPermission({
              sessionId: harness.sessionId,
              requestId: event.requestId ?? "",
              outcome: "proceed_new_session_high",
            })
            .pipe(Effect.flip)
        }),
      ),
    )

    expect(failure.code).toBe("invalid_outcome")
  })

  it("rejects an unknown request id", async () => {
    const failure = await Effect.runPromise(
      withPrompts((harness) =>
        harness
          .respondPermission({
            sessionId: harness.sessionId,
            requestId: "no-such-prompt",
            outcome: "proceed_once",
          })
          .pipe(Effect.flip),
      ),
    )

    expect(failure.code).toBe("prompt_not_found")
  })

  it("rejects a second answer for the same prompt", async () => {
    const second = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "permission",
            waitMs: 2_000,
          })

          const event = pending(turn, "pending_permission")
          yield* harness.respondPermission({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            outcome: "proceed_once",
          })

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

    expect(second.code).toBe("prompt_not_found")
  })

  it("carries every tool use of a batched request", async () => {
    const event = await Effect.runPromise(
      withPrompts((harness) =>
        harness.hub.api
          .stream({ sessionId: harness.sessionId, prompt: "batch", waitMs: 2_000 })
          .pipe(Effect.map((turn) => pending(turn, "pending_permission"))),
      ),
    )

    expect(event.toolUses).toHaveLength(2)
  })
})
