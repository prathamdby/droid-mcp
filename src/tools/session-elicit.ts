import * as McpSchema from "effect/ai/McpSchema"
import * as McpServer from "effect/ai/McpServer"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../config.ts"
import {
  answersResult,
  isPromptProblem,
  optionsResult,
  permissionResult,
} from "../droid/prompts.ts"
import { toJsonValue } from "../droid/protocol.ts"
import { MAX_WAIT_MS, SessionHubService } from "../droid/turns.ts"
import type { TurnEvent, TurnResult } from "../droid/turns.ts"
import type { ToolFailure } from "./failure.ts"
import { toolFailure } from "./guards.ts"
import { presentTurn } from "./session-delivery.ts"

const Answers = Schema.Array(
  Schema.Struct({
    index: Schema.Number,
    answer: Schema.String,
  }),
)

const readAnswers = (raw: string | undefined) => {
  if (raw === undefined) return Option.none()

  try {
    return Schema.decodeUnknownOption(Answers)(JSON.parse(raw))
  } catch {
    return Option.none()
  }
}

const pendingEvent = (events: ReadonlyArray<TurnEvent>): TurnEvent | undefined => {
  for (const event of events) {
    if (event.kind.startsWith("pending_") && event.requestId !== undefined) return event
  }

  return undefined
}

const Form = Schema.Struct({
  outcome: Schema.optional(Schema.String),
  comment: Schema.optional(Schema.String),
  editedSpecContent: Schema.optional(Schema.String),
  answers: Schema.optional(Schema.String),
  selectedIds: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.Boolean),
})

const answerFromForm = (
  sessionId: string,
  requestId: string,
  maxAutonomy: AutonomyLevel | undefined,
) =>
  Effect.gen(function* () {
    const client = yield* Effect.serviceOption(McpSchema.McpServerClient)

    if (Option.isNone(client) || client.value.clientCapabilities.elicitation === undefined) {
      return false
    }

    const hub = yield* SessionHubService

    const view = yield* hub.pendingPrompt(sessionId, requestId).pipe(Effect.mapError(toolFailure))

    if (view === undefined) return false

    if (view.kind === "permission") {
      if (view.options.length === 0) return false

      const content = yield* McpServer.elicit({
        message:
          "Droid needs a permission decision. Set outcome to one of: " + view.options.join(", "),
        schema: Form,
      }).pipe(Effect.provideService(McpSchema.McpServerClient, client.value))

      if (content.outcome === undefined) return false

      const result = permissionResult(
        view,
        {
          outcome: content.outcome,
          comment: content.comment,
          editedSpecContent: content.editedSpecContent,
        },
        maxAutonomy,
      )

      if (isPromptProblem(result)) {
        return yield* Effect.fail<ToolFailure>({ code: result.code, message: result.message })
      }

      yield* hub
        .answer({ sessionId, requestId, result: toJsonValue(result) })
        .pipe(Effect.mapError(toolFailure))

      return true
    }

    if (view.kind === "question") {
      const asked = view.questions
        .map((question) => String(question.index) + ": " + question.question)
        .join("\n")

      const content = yield* McpServer.elicit({
        message:
          "Droid asked a question. Set answers to a JSON array of {index, answer}.\n" + asked,
        schema: Form,
      }).pipe(Effect.provideService(McpSchema.McpServerClient, client.value))

      const parsed = readAnswers(content.answers)

      if (Option.isNone(parsed)) return false

      const answers = parsed.value.map((answer) => ({
        index: answer.index,
        answer: answer.answer,
      }))

      const result = answersResult(view, answers)

      if (isPromptProblem(result)) {
        return yield* Effect.fail<ToolFailure>({ code: result.code, message: result.message })
      }

      yield* hub
        .answer({ sessionId, requestId, result: toJsonValue(result) })
        .pipe(Effect.mapError(toolFailure))

      return true
    }

    const content = yield* McpServer.elicit({
      message:
        "Droid needs a selection. Set selectedIds to comma-separated row ids: " +
        view.rows.map((row) => row.id).join(", "),
      schema: Form,
    }).pipe(Effect.provideService(McpSchema.McpServerClient, client.value))

    if (content.selectedIds === undefined) return false

    const selectedIds = content.selectedIds
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)

    const result = optionsResult(view, selectedIds, content.refresh === true)

    if (isPromptProblem(result)) {
      return yield* Effect.fail<ToolFailure>({ code: result.code, message: result.message })
    }

    yield* hub
      .answer({ sessionId, requestId, result: toJsonValue(result) })
      .pipe(Effect.mapError(toolFailure))

    return true
  }).pipe(Effect.catch(() => Effect.succeed(false)))

/**
 * Holds a blocking turn until it ends, a person must answer and the client
 * cannot show a form, or the wait cap is reached. Forms use elicitation on
 * protocol revisions that allow a server-initiated request. 2026-07-28 clients
 * get the pending prompt back and answer with the session tools.
 */
export const blockUntilSettled = (
  sessionId: string,
  started: TurnResult,
  maxAutonomy: AutonomyLevel | undefined,
) =>
  Effect.gen(function* () {
    const hub = yield* SessionHubService
    const deadline = Date.now() + MAX_WAIT_MS
    let current = started

    for (let round = 0; round < 32; round += 1) {
      if (current.status !== "running") return presentTurn(current)

      const prompt = pendingEvent(current.events)

      if (prompt?.requestId !== undefined) {
        const answered = yield* answerFromForm(sessionId, prompt.requestId, maxAutonomy)

        if (!answered) return presentTurn(current)
      }

      const remaining = deadline - Date.now()

      if (remaining <= 0) return presentTurn(current)

      current = yield* hub
        .events({ sessionId, cursor: current.cursor, waitMs: remaining })
        .pipe(Effect.mapError(toolFailure))
    }

    return presentTurn(current)
  })
