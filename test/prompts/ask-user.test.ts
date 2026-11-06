import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { TurnResult } from "../../src/droid/turns.ts"
import { settle, withPrompts } from "../support/prompts.ts"

const pending = (turn: TurnResult, kind: string) => {
  const event = turn.events.find((candidate) => candidate.kind === kind)

  if (event?.requestId === undefined) throw new Error("no " + kind + " event")

  return event
}

describe("ask-user prompts", () => {
  it("fills each question's text from the request", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "ask",
            waitMs: 400,
          })

          const event = pending(turn, "pending_question")
          const questions = event.questions ?? []

          yield* harness.answerQuestion({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            answers: [
              { index: 0, answer: "vitest" },
              { index: 1, answer: "lint, types" },
            ],
          })

          const settled = yield* settle(harness.hub, harness.sessionId, event.seq + 1)

          return { event, questions, settled }
        }),
      ),
    )

    expect(outcome.questions).toHaveLength(2)
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({
      cancelled: false,
      answers: [
        { index: 0, question: "Which runner?", answer: "vitest" },
        { index: 1, question: "Which checks?", answer: "lint, types" },
      ],
    })
  })

  it("rejects an index the prompt never offered", async () => {
    const failure = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "ask",
            waitMs: 400,
          })

          const event = pending(turn, "pending_question")

          return yield* harness
            .answerQuestion({
              sessionId: harness.sessionId,
              requestId: event.requestId ?? "",
              answers: [{ index: 7, answer: "nope" }],
            })
            .pipe(Effect.flip)
        }),
      ),
    )

    expect(failure.code).toBe("invalid_question_index")
  })

  it("accepts a cancelled answer", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "ask",
            waitMs: 400,
          })

          const event = pending(turn, "pending_question")

          yield* harness.answerQuestion({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            answers: [],
          })

          return yield* settle(harness.hub, harness.sessionId, event.seq + 1)
        }),
      ),
    )

    expect(outcome.status).toBe("completed")
    expect(outcome.result?.structuredOutput).toEqual({ cancelled: false, answers: [] })
  })
})

describe("option pickers", () => {
  it("accepts one id for a single-select prompt", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "pick",
            waitMs: 400,
          })

          const event = pending(turn, "pending_options")

          yield* harness.pickOptions({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            selectedIds: ["repo-b"],
          })

          const settled = yield* settle(harness.hub, harness.sessionId, event.seq + 1)

          return { event, settled }
        }),
      ),
    )

    expect(outcome.event.rows).toHaveLength(3)
    expect(outcome.event.multi).toBe(false)
    expect(outcome.settled.result?.structuredOutput).toEqual({
      cancelled: false,
      selectedIds: ["repo-b"],
      refresh: false,
    })
  })

  it("rejects an id the prompt never offered", async () => {
    const failure = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "pick",
            waitMs: 400,
          })

          const event = pending(turn, "pending_options")

          return yield* harness
            .pickOptions({
              sessionId: harness.sessionId,
              requestId: event.requestId ?? "",
              selectedIds: ["repo-z"],
            })
            .pipe(Effect.flip)
        }),
      ),
    )

    expect(failure.code).toBe("invalid_selection")
  })

  it("rejects two ids when the prompt is single-select", async () => {
    const failure = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "pick",
            waitMs: 400,
          })

          const event = pending(turn, "pending_options")

          return yield* harness
            .pickOptions({
              sessionId: harness.sessionId,
              requestId: event.requestId ?? "",
              selectedIds: ["repo-a", "repo-b"],
            })
            .pipe(Effect.flip)
        }),
      ),
    )

    expect(failure.code).toBe("invalid_selection")
  })

  it("sends refresh without selections", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "pick",
            waitMs: 400,
          })

          const event = pending(turn, "pending_options")

          const answered = yield* harness.pickOptions({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            selectedIds: [],
            refresh: true,
          })

          return answered
        }),
      ),
    )

    expect(outcome.refresh).toBe(true)
  })
})

describe("spec mode", () => {
  it("requires the edited plan for proceed_edit", async () => {
    const failure = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "spec",
            waitMs: 400,
          })

          const event = pending(turn, "pending_permission")

          return yield* harness
            .respondPermission({
              sessionId: harness.sessionId,
              requestId: event.requestId ?? "",
              outcome: "proceed_edit",
            })
            .pipe(Effect.flip)
        }),
      ),
    )

    expect(failure.code).toBe("edited_spec_required")
  })

  it("sends the edited plan with proceed_edit", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "spec",
            waitMs: 400,
          })

          const event = pending(turn, "pending_permission")

          yield* harness.respondPermission({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            outcome: "proceed_edit",
            editedSpecContent: "# plan\n\n1. do it\n",
          })

          return yield* settle(harness.hub, harness.sessionId, event.seq + 1)
        }),
      ),
    )

    expect(outcome.result?.structuredOutput).toEqual({
      selectedOption: "proceed_edit",
      editedSpecContent: "# plan\n\n1. do it\n",
    })
  })
})
