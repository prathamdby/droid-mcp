import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { outcomeWithinCap } from "../../src/droid/prompts.ts"
import type { TurnResult } from "../../src/droid/turns.ts"
import { settle, withPrompts } from "../support/prompts.ts"

const pending = (turn: TurnResult) => {
  const event = turn.events.find((candidate) => candidate.kind === "pending_permission")

  if (event?.requestId === undefined) throw new Error("missing pending permission")

  return event
}

describe("permission autonomy cap", () => {
  it("allows ordinary outcomes at every cap and levels only up to the cap", () => {
    expect(outcomeWithinCap("high", "proceed_auto_run")).toBe(true)
    expect(outcomeWithinCap("high", "proceed_auto_run_high")).toBe(true)
    expect(outcomeWithinCap("high", "proceed_new_session")).toBe(true)
    expect(outcomeWithinCap("medium", "proceed_auto_run")).toBe(false)
    expect(outcomeWithinCap("medium", "proceed_new_session")).toBe(false)
    expect(outcomeWithinCap("medium", "proceed_auto_run_high")).toBe(false)
    expect(outcomeWithinCap("medium", "proceed_auto_run_medium")).toBe(true)
    expect(outcomeWithinCap("off", "proceed_once")).toBe(true)
    expect(outcomeWithinCap("off", "cancel")).toBe(true)
    expect(outcomeWithinCap("off", "proceed_edit")).toBe(true)
    expect(outcomeWithinCap("off", "proceed_always")).toBe(true)
    expect(outcomeWithinCap("low", "proceed_new_session_low")).toBe(true)
    expect(outcomeWithinCap("low", "proceed_auto_run_high")).toBe(false)
  })

  it("advertises and accepts only choices inside the session cap", async () => {
    const outcome = await Effect.runPromise(
      withPrompts(
        (harness) =>
          Effect.gen(function* () {
            const turn = yield* harness.hub.api.stream({
              sessionId: harness.sessionId,
              prompt: "permission:levels",
              waitMs: 1_000,
            })

            const event = pending(turn)

            const denied = yield* harness
              .respondPermission({
                sessionId: harness.sessionId,
                requestId: event.requestId ?? "",
                outcome: "proceed_auto_run_high",
              })
              .pipe(Effect.flip)

            yield* harness.respondPermission({
              sessionId: harness.sessionId,
              requestId: event.requestId ?? "",
              outcome: "proceed_once",
            })

            const settled = yield* settle(harness.hub, harness.sessionId, event.seq + 1)

            return { event, denied, settled }
          }),
        5_000,
        "low",
      ),
    )

    expect(outcome.event.options).toEqual([
      "proceed_once",
      "proceed_new_session_low",
      "proceed_edit",
      "cancel",
    ])
    expect(outcome.denied.code).toBe("autonomy_exceeds_cap")
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
  })
})
