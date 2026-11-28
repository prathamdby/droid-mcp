/**
 * Internal data shapes for the `decisions` module.
 *
 * These types are module-internal: `index.ts` alone decides what crosses the
 * public boundary. Nothing here performs disclosure, validation or delivery;
 * this file carries the normalized challenge input and reply shapes so the
 * single-winner state machine in `index.ts` stays small.
 */
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../../authority/index.ts"
import { PERMISSION_OUTCOMES as protocolOutcomes } from "../../factory-dialect/index.ts"
import type { PermissionOutcome as ProtocolPermissionOutcome } from "../../factory-dialect/index.ts"

export type PermissionOutcome = ProtocolPermissionOutcome

export const PERMISSION_OUTCOMES: ReadonlyArray<PermissionOutcome> = protocolOutcomes

/**
 * The autonomy an outcome would establish, where the outcome itself names
 * one. One-shot outcomes establish nothing beyond the answer. Unlevelled
 * persistent outcomes state no level, so nothing below `high` can prove they
 * stay bounded.
 */
export const outcomeRequirement = (outcome: PermissionOutcome): AutonomyLevel => {
  switch (outcome) {
    case "proceed_once":
    case "proceed_always":
    case "proceed_always_file":
    case "proceed_edit":
    case "proceed_report_false_positive":
    case "cancel":
      return "off"
    case "proceed_auto_run_low":
    case "proceed_new_session_low":
      return "low"
    case "proceed_auto_run_medium":
    case "proceed_new_session_medium":
      return "medium"
    case "proceed_auto_run":
    case "proceed_auto_run_high":
    case "proceed_new_session":
    case "proceed_new_session_high":
    case "proceed_always_tools":
    case "proceed_always_server":
      return "high"
  }
}

// ---------------------------------------------------------------------------
// Reply endpoint
// ---------------------------------------------------------------------------

/**
 * Definite non-delivery: the peer was provably never handed the reply. The
 * offer is still consumed — the endpoint contract is exactly-once — but the
 * failure carries proof nothing was delivered.
 */
export type ReplyNotDelivered = {
  readonly _tag: "NotDelivered"
  readonly message: string
}

/**
 * Uncertain post-handoff failure: the reply may or may not have reached the
 * peer. The offer is consumed permanently and the failure surfaces as
 * `ReplyUncertain`; re-sending could deliver a duplicate resolution.
 */
export type ReplyUncertainDelivery = {
  readonly _tag: "Uncertain"
  readonly message: string
}

export type ReplyDeliveryFailure = ReplyNotDelivered | ReplyUncertainDelivery

/** A normalized permission reply: the outcome plus its optional free inputs. */
export type PermissionReply = {
  readonly outcome: PermissionOutcome
  readonly comment?: string
  readonly editedSpecContent?: string
}

/** A normalized question reply: answers indexed by the offered questions. */
export type QuestionReply = {
  readonly answers: ReadonlyArray<{ readonly index: number; readonly answer: string }>
}

/** A normalized options reply: selected row ids plus the refresh flag. */
export type OptionsReply = {
  readonly selectedIds: ReadonlyArray<string>
  readonly refresh: boolean
}

/**
 * One reply payload per challenge kind. Only the matching kind ever reaches
 * an endpoint, because validation rejects a mismatched choice before the
 * reply right is claimed.
 */
export type ChallengeReply =
  | { readonly kind: "permission"; readonly reply: PermissionReply }
  | { readonly kind: "question"; readonly reply: QuestionReply }
  | { readonly kind: "options"; readonly reply: OptionsReply }

/**
 * The single-use reply endpoint a challenge carries, as a cold effect
 * factory: nothing runs until a winner has been decided, and a losing
 * contender never invokes it. This module enforces exactly-once across
 * answers, timeouts and retirements, so the endpoint never needs to defend
 * itself against replay.
 */
export type ReplyEndpoint = (reply: ChallengeReply) => Effect.Effect<void, ReplyDeliveryFailure>

// ---------------------------------------------------------------------------
// Challenge input shapes
// ---------------------------------------------------------------------------

/** Display data of a permission challenge, before disclosure scrubbing. */
export type PermissionChallengeDisplay = {
  readonly summary?: string
  readonly details?: Schema.Json
}

/** One indexed question of a question challenge, before scrubbing. */
export type ChallengeQuestion = {
  readonly index: number
  readonly topic?: string
  readonly text: string
  readonly options?: ReadonlyArray<Schema.Json>
  readonly multiSelect: boolean
}

/** Display data of a question challenge, before scrubbing. */
export type QuestionChallengeDisplay = {
  readonly questions: ReadonlyArray<ChallengeQuestion>
}

/** One selectable row of an options challenge, before scrubbing. */
export type ChallengeOptionRow = {
  readonly id: string
  readonly label?: string
  readonly detail?: string
}

/** Display data of an options challenge, before scrubbing. */
export type OptionsChallengeDisplay = {
  readonly title?: string
  readonly hint?: string
  readonly rows: ReadonlyArray<ChallengeOptionRow>
  readonly multiSelect: boolean
  readonly refreshable: boolean
}

export type PermissionChallenge = {
  readonly kind: "permission"
  readonly outcomes: ReadonlyArray<PermissionOutcome>
  readonly display: PermissionChallengeDisplay
  readonly reply: ReplyEndpoint
}

export type QuestionChallenge = {
  readonly kind: "question"
  readonly display: QuestionChallengeDisplay
  readonly reply: ReplyEndpoint
}

export type OptionsChallenge = {
  readonly kind: "options"
  readonly display: OptionsChallengeDisplay
  readonly reply: ReplyEndpoint
}

/**
 * One interactive challenge. `timeoutMs`, when present, arms a timer at
 * registration whose expiry contends for the same single-winner reply right
 * as `answer` and `retire`.
 */
export type ChallengeInput =
  | (PermissionChallenge & { readonly timeoutMs?: number })
  | (QuestionChallenge & { readonly timeoutMs?: number })
  | (OptionsChallenge & { readonly timeoutMs?: number })
