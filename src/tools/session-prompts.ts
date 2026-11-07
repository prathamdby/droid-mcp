import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../config.ts"
import {
  PermissionOutcomeSchema,
  answersResult,
  isPromptProblem,
  optionsResult,
  permissionResult,
} from "../droid/prompts.ts"
import { toJsonValue } from "../droid/protocol.ts"
import { SessionHubService } from "../droid/turns.ts"
import { ToolFailure } from "./failure.ts"
import { toolFailure } from "./guards.ts"

const RespondPermission = Tool.make("session_respond_permission", {
  description:
    "Answer a pending_permission event. The outcome must be one the event offered. " +
    "Outcomes that would raise autonomy above the server cap are rejected. " +
    "proceed_edit also needs editedSpecContent.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    requestId: Schema.String,
    outcome: PermissionOutcomeSchema,
    comment: Schema.optional(Schema.String),
    editedSpecContent: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ resolved: Schema.Boolean }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const AnswerQuestion = Tool.make("session_answer_question", {
  description:
    "Answer a pending_question event. Each answer names a question index from the event; " +
    "the server fills in the question text.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    requestId: Schema.String,
    answers: Schema.Array(
      Schema.Struct({
        index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        answer: Schema.String,
      }),
    ),
  }),
  success: Schema.Struct({ resolved: Schema.Boolean }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const PickOptions = Tool.make("session_pick_options", {
  description:
    "Answer a pending_options event with row ids from the event. Single-select prompts " +
    "accept one id; set refresh to ask Droid for fresh rows.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    requestId: Schema.String,
    selectedIds: Schema.Array(Schema.String),
    refresh: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ resolved: Schema.Boolean, refresh: Schema.Boolean }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const missingPrompt: ToolFailure = {
  code: "prompt_not_found",
  message: "that prompt is no longer pending; read session_events for the current state",
}

export const sessionPromptTools = (config?: { readonly maxAutonomy: AutonomyLevel }) => {
  const tools: Array<Tool.Any> = [RespondPermission, AnswerQuestion, PickOptions]
  const PromptTools = Toolkit.make(RespondPermission, AnswerQuestion, PickOptions)

  const handlers = PromptTools.of({
    session_respond_permission: (params) =>
      Effect.gen(function* () {
        const hub = yield* SessionHubService

        const view = yield* hub
          .pendingPrompt(params.sessionId, params.requestId)
          .pipe(Effect.mapError(toolFailure))

        if (view === undefined || view.kind !== "permission") {
          return yield* Effect.fail(
            view === undefined
              ? missingPrompt
              : { code: "prompt_mismatch", message: "that prompt is not a permission prompt" },
          )
        }

        const result = permissionResult(
          view,
          {
            outcome: params.outcome,
            comment: params.comment,
            editedSpecContent: params.editedSpecContent,
          },
          config?.maxAutonomy,
        )

        if (isPromptProblem(result)) {
          return yield* Effect.fail({ code: result.code, message: result.message })
        }

        return yield* hub
          .answer({
            sessionId: params.sessionId,
            requestId: params.requestId,
            result: toJsonValue(result),
          })
          .pipe(Effect.mapError(toolFailure))
      }),
    session_answer_question: (params) =>
      Effect.gen(function* () {
        const hub = yield* SessionHubService

        const view = yield* hub
          .pendingPrompt(params.sessionId, params.requestId)
          .pipe(Effect.mapError(toolFailure))

        if (view === undefined || view.kind !== "question") {
          return yield* Effect.fail(
            view === undefined
              ? missingPrompt
              : { code: "prompt_mismatch", message: "that prompt is not a question prompt" },
          )
        }

        const result = answersResult(view, params.answers)

        if (isPromptProblem(result)) {
          return yield* Effect.fail({ code: result.code, message: result.message })
        }

        return yield* hub
          .answer({
            sessionId: params.sessionId,
            requestId: params.requestId,
            result: toJsonValue(result),
          })
          .pipe(Effect.mapError(toolFailure))
      }),
    session_pick_options: (params) =>
      Effect.gen(function* () {
        const hub = yield* SessionHubService

        const view = yield* hub
          .pendingPrompt(params.sessionId, params.requestId)
          .pipe(Effect.mapError(toolFailure))

        if (view === undefined || view.kind !== "options") {
          return yield* Effect.fail(
            view === undefined
              ? missingPrompt
              : { code: "prompt_mismatch", message: "that prompt is not an option picker" },
          )
        }

        const result = optionsResult(view, params.selectedIds, params.refresh === true)

        if (isPromptProblem(result)) {
          return yield* Effect.fail({ code: result.code, message: result.message })
        }

        const answered = yield* hub
          .answer({
            sessionId: params.sessionId,
            requestId: params.requestId,
            result: toJsonValue(result),
          })
          .pipe(Effect.mapError(toolFailure))

        return { resolved: answered.resolved, refresh: result.refresh }
      }),
  })

  return { tools, handlers }
}
