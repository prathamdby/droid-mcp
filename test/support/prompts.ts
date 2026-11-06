import * as Effect from "effect/Effect"

import { SessionHubService } from "../../src/droid/turns.ts"
import type { SessionProblem, TurnResult } from "../../src/droid/turns.ts"
import type { SessionHub } from "../../src/droid/turns.ts"
import type { ToolFailure } from "../../src/tools/failure.ts"
import { sessionPromptTools } from "../../src/tools/session-prompts.ts"
import { createSession, fakeHub } from "./hub.ts"

export interface PromptHarness {
  readonly hub: SessionHub
  readonly sessionId: string
  readonly respondPermission: (params: {
    sessionId: string
    requestId: string
    outcome:
      | "proceed_once"
      | "proceed_always"
      | "proceed_always_file"
      | "proceed_auto_run"
      | "proceed_auto_run_low"
      | "proceed_auto_run_medium"
      | "proceed_auto_run_high"
      | "proceed_new_session"
      | "proceed_new_session_low"
      | "proceed_new_session_medium"
      | "proceed_new_session_high"
      | "proceed_edit"
      | "proceed_always_tools"
      | "proceed_always_server"
      | "proceed_report_false_positive"
      | "cancel"
    comment?: string
    editedSpecContent?: string
  }) => Effect.Effect<{ readonly resolved: boolean }, ToolFailure>
  readonly answerQuestion: (params: {
    sessionId: string
    requestId: string
    answers: ReadonlyArray<{ index: number; answer: string }>
  }) => Effect.Effect<{ readonly resolved: boolean }, ToolFailure>
  readonly pickOptions: (params: {
    sessionId: string
    requestId: string
    selectedIds: ReadonlyArray<string>
    refresh?: boolean
  }) => Effect.Effect<{ readonly resolved: boolean; readonly refresh: boolean }, ToolFailure>
}

/**
 * Polls until the turn leaves `running`. `session_events` waits on the session's
 * signal when nothing new has arrived, so this is a few round trips, not a spin.
 */
export const settle = (
  hub: SessionHub,
  sessionId: string,
  cursor: number,
): Effect.Effect<TurnResult, SessionProblem> =>
  Effect.gen(function* () {
    let current = yield* hub.api.events({ sessionId, cursor, waitMs: 3_000 })
    let attempts = 0

    while (current.status === "running" && attempts < 5) {
      attempts += 1
      current = yield* hub.api.events({ sessionId, cursor: current.cursor, waitMs: 3_000 })
    }

    return current
  })

/** A hub plus the prompt tools, wired the way the server wires them. */
export const withPrompts = <A, E>(
  run: (harness: PromptHarness) => Effect.Effect<A, E, never>,
  promptTimeoutMs = 5_000,
): Effect.Effect<A, E | SessionProblem, never> =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub({ promptTimeoutMs }), (hub) => hub.closeAll).pipe(
      Effect.flatMap((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const prompts = sessionPromptTools()

          const provide = <A, E>(
            effect: Effect.Effect<A, E, SessionHubService>,
          ): Effect.Effect<A, E> => Effect.provideService(effect, SessionHubService, hub.api)

          const harness: PromptHarness = {
            hub,
            sessionId,
            respondPermission: (params) =>
              provide(prompts.handlers.session_respond_permission(params)),
            answerQuestion: (params) => provide(prompts.handlers.session_answer_question(params)),
            pickOptions: (params) => provide(prompts.handlers.session_pick_options(params)),
          }

          return yield* run(harness)
        }),
      ),
    ),
  )
