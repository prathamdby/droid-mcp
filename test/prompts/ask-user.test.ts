import { Effect } from "effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import type { TurnEvent, TurnResult } from "../../src/droid/turns.ts"
import { FIELD_BYTE_LIMIT } from "../../src/droid/turns.ts"
import { settle, withPrompts } from "../support/prompts.ts"

const MARK = "…[truncated]"

const ShownQuestion = Schema.Struct({
  index: Schema.optional(Schema.Number),
  topic: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
})

const ShownRow = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
})

const shownQuestion = (event: TurnEvent) => {
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Array(ShownQuestion))(event.questions ?? []),
  )

  const question = decoded?.[0]

  if (question?.question === undefined) throw new Error("missing question")

  return question
}

const shownRows = (event: TurnEvent) => {
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Array(ShownRow))(event.rows ?? []),
  )

  if (decoded === undefined || decoded.length < 2) throw new Error("missing rows")

  return decoded
}

const boundedText = (value: string): string => {
  expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(FIELD_BYTE_LIMIT)
  expect(value.endsWith(MARK)).toBe(true)
  expect(value.includes("\uFFFD")).toBe(false)

  return value.slice(0, value.length - MARK.length)
}

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

  it("bounds an oversized question on a UTF-8 boundary and answers with the original text", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "ask:huge",
            waitMs: 400,
          })

          const event = pending(turn, "pending_question")

          const view = yield* harness.hub.api.pendingPrompt(
            harness.sessionId,
            event.requestId ?? "",
          )

          yield* harness.answerQuestion({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            answers: [{ index: 0, answer: "kept" }],
          })

          const settled = yield* settle(harness.hub, harness.sessionId, event.seq + 1)

          return { event, view, settled }
        }),
      ),
    )

    const full = outcome.view?.kind === "question" ? outcome.view.questions[0]?.question : undefined
    const shown = shownQuestion(outcome.event)
    const body = boundedText(shown.question ?? "")

    expect(outcome.view?.kind).toBe("question")
    expect(full).toBeDefined()
    expect(Buffer.byteLength(full ?? "", "utf8")).toBeGreaterThan(FIELD_BYTE_LIMIT)
    expect(shown.topic).toBe("Size")
    expect(shown.index).toBe(0)
    expect(full?.startsWith(body)).toBe(true)
    expect([...(body ?? "")].every((char) => char === "😀")).toBe(true)
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({
      cancelled: false,
      answers: [{ index: 0, question: full, answer: "kept" }],
    })
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

  it("bounds oversized picker rows and still selects by the original id", async () => {
    const outcome = await Effect.runPromise(
      withPrompts((harness) =>
        Effect.gen(function* () {
          const turn = yield* harness.hub.api.stream({
            sessionId: harness.sessionId,
            prompt: "pick:huge",
            waitMs: 400,
          })

          const event = pending(turn, "pending_options")

          const view = yield* harness.hub.api.pendingPrompt(
            harness.sessionId,
            event.requestId ?? "",
          )

          yield* harness.pickOptions({
            sessionId: harness.sessionId,
            requestId: event.requestId ?? "",
            selectedIds: ["wide"],
          })

          const settled = yield* settle(harness.hub, harness.sessionId, event.seq + 1)

          return { event, view, settled }
        }),
      ),
    )

    const fullLabel = outcome.view?.kind === "options" ? outcome.view.rows[0]?.label : undefined
    const fullDetail = outcome.view?.kind === "options" ? outcome.view.rows[0]?.detail : undefined
    const rows = shownRows(outcome.event)
    const wide = rows[0]
    const narrow = rows[1]
    const labelBody = boundedText(wide?.label ?? "")
    const detailBody = boundedText(wide?.detail ?? "")

    expect(outcome.view?.kind).toBe("options")
    expect(wide?.id).toBe("wide")
    expect(narrow?.id).toBe("narrow")
    expect(narrow?.label).toBe("narrow")
    expect(narrow?.detail).toBe("small")
    expect(Buffer.byteLength(fullLabel ?? "", "utf8")).toBeGreaterThan(FIELD_BYTE_LIMIT)
    expect(Buffer.byteLength(fullDetail ?? "", "utf8")).toBeGreaterThan(FIELD_BYTE_LIMIT)
    expect(fullLabel?.startsWith(labelBody)).toBe(true)
    expect(fullDetail?.startsWith(detailBody)).toBe(true)
    expect([...(labelBody ?? "")].every((char) => char === "😀")).toBe(true)
    expect(outcome.settled.result?.structuredOutput).toEqual({
      cancelled: false,
      selectedIds: ["wide"],
      refresh: false,
    })
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
