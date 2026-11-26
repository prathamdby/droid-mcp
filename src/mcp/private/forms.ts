/**
 * Form elicitation: translates the open decision of a blocking
 * `session_stream` delivery into a peer form round-trip, when — and only
 * when — the negotiated revision allows forms and the peer actually
 * implements the return channel. A declined or mismatched form answer
 * leaves the decision open and the honest pending payload is returned.
 */
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

import { readOutstandingDecision, readSessionTurnPayload, type JsonObject } from "./payloads.ts"
import {
  SESSIONLESS_PROTOCOL_REVISION,
  type FormAnswer,
  type FormRequest,
  type PeerAbilities,
} from "./types.ts"

/** Permission outcomes the form answer may carry. */
const PERMISSION_OUTCOME_WORDS: ReadonlyArray<string> = [
  "proceed_once",
  "proceed_always",
  "proceed_edit",
  "cancel",
  "proceed_auto_run_low",
  "proceed_new_session_low",
  "proceed_auto_run_medium",
  "proceed_new_session_medium",
  "proceed_auto_run",
  "proceed_auto_run_high",
  "proceed_new_session",
  "proceed_new_session_high",
]

/**
 * Whether forms can reach this peer at all on the negotiated revision. The
 * sessionless revision never carries server-initiated requests, so no
 * revision-dependent shape of form support exists there — whatever the peer
 * claims.
 */
export const formsAvailable = (peer: PeerAbilities, revision: string): boolean =>
  revision !== SESSIONLESS_PROTOCOL_REVISION &&
  peer.supportsForms &&
  Predicate.isFunction(peer.elicit)

export interface PendingDecision {
  readonly requestId: string
  readonly kind: "permission" | "question" | "options"
  readonly raw: JsonObject
}

/** Reads the outstanding decisions of an encoded session turn payload. */
export const pendingDecisionsOf = (payload: Schema.Json): ReadonlyArray<PendingDecision> => {
  const turn = readSessionTurnPayload(payload)

  if (turn === undefined) return []

  const out: Array<PendingDecision> = []

  for (const entry of turn.decisions) {
    const decision = readOutstandingDecision(entry)

    if (decision !== undefined) {
      out.push({ requestId: decision.requestId, kind: decision.kind, raw: decision.raw })
    }
  }

  return out
}

/** The status field of an encoded turn payload, when present. */
export const statusOfPayload = (payload: Schema.Json): string | undefined =>
  readSessionTurnPayload(payload)?.status

/** The cursor field of an encoded turn payload, when present. */
export const cursorOfPayload = (payload: Schema.Json): number | undefined =>
  readSessionTurnPayload(payload)?.cursor

/** The sessionId field of an encoded turn payload, when present. */
export const sessionIdOfPayload = (payload: Schema.Json): string | undefined =>
  readSessionTurnPayload(payload)?.sessionId

/** One form request derived from the encoded outstanding decision. */
const formRequestOf = (decision: PendingDecision): FormRequest => {
  const summaryValue = decision.raw.summary
  const titleValue = decision.raw.title

  const summary = Predicate.isString(summaryValue)
    ? summaryValue
    : Predicate.isString(titleValue)
      ? titleValue
      : decision.kind + " decision"

  return { kind: decision.kind, summary, details: decision.raw }
}

export interface AnswerPayload {
  readonly operation: string
  readonly wireArguments: Schema.Json
}

type PermissionAnswerWire = {
  sessionId: string
  requestId: string
  outcome: string
  comment?: string
  editedSpecContent?: string
}

type OptionsAnswerWire = {
  sessionId: string
  requestId: string
  selectedIds: ReadonlyArray<string>
  refresh?: boolean
}

/**
 * The operation name and wire arguments answering one decision through the
 * session tools, derived from the peer's form answer. A form answer whose
 * kind does not match the decision produces nothing — the decision is left
 * open rather than answered wrongly.
 */
const answerPayloadOf = (
  sessionId: string,
  decision: PendingDecision,
  answer: FormAnswer,
): AnswerPayload | undefined =>
  Match.value(answer).pipe(
    Match.when({ kind: "permission" }, (variant) => {
      if (decision.kind !== "permission") return undefined

      if (!PERMISSION_OUTCOME_WORDS.includes(variant.outcome)) return undefined

      const wireArguments: PermissionAnswerWire = {
        sessionId,
        requestId: decision.requestId,
        outcome: variant.outcome,
      }

      if (variant.comment !== undefined) wireArguments.comment = variant.comment

      if (variant.editedSpecContent !== undefined) {
        wireArguments.editedSpecContent = variant.editedSpecContent
      }

      return { operation: "session_respond_permission", wireArguments }
    }),
    Match.when({ kind: "question" }, (variant) => {
      if (decision.kind !== "question") return undefined

      const answers: Array<{ readonly index: number; readonly answer: string }> = []

      for (const entry of variant.answers) {
        answers.push({ index: entry.index, answer: entry.answer })
      }

      return {
        operation: "session_answer_question",
        wireArguments: { sessionId, requestId: decision.requestId, answers },
      }
    }),
    Match.when({ kind: "options" }, (variant) => {
      if (decision.kind !== "options") return undefined

      const wireArguments: OptionsAnswerWire = {
        sessionId,
        requestId: decision.requestId,
        selectedIds: [...variant.selectedIds],
      }

      if (variant.refresh !== undefined) wireArguments.refresh = variant.refresh

      return { operation: "session_pick_options", wireArguments }
    }),
    Match.exhaustive,
  )

/**
 * Attempts the form round-trip for one outstanding decision. Returns the
 * answer payload to dispatch through the presentation pipeline, or
 * `undefined` when the peer declined or the answer mismatched the decision.
 */
export const elicitFor = (
  peer: PeerAbilities,
  sessionId: string,
  decision: PendingDecision,
): Effect.Effect<AnswerPayload | undefined> =>
  Effect.suspend((): Effect.Effect<AnswerPayload | undefined> => {
    if (!Predicate.isFunction(peer.elicit)) return Effect.succeed(undefined)

    return Effect.match(peer.elicit(formRequestOf(decision)), {
      onFailure: () => undefined,
      onSuccess: (answer) => answerPayloadOf(sessionId, decision, answer),
    })
  })
