/**
 * Level 2 `decisions` module: outstanding offers, validation against the
 * original choices, and one-winner reply rights.
 *
 * A `DecisionScope` is a revocable per-turn capability minted by `openScope`;
 * `retire` withdraws it atomically together with every offer still
 * outstanding in it. A `Challenge` pairs normalized choices with the
 * single-use reply endpoint the provider handed in; `offer` releases its
 * display data through `disclosure` for the client audience, registers it, and
 * returns a `DecisionView` carrying only that released data plus an opaque
 * ref minted per offer — never derived from a peer request id, so a peer
 * reusing one can never receive a stale answer.
 *
 * Answer, timeout and retirement contend for the same single-winner right.
 * Validation runs before the right is claimed, so a malformed or unauthorized
 * answer neither consumes the offer nor invokes the endpoint. Once a winner
 * claims the right the offer is consumed permanently: a definite
 * non-delivery cannot be re-issued because the endpoint contract is
 * exactly-once, and an uncertain post-handoff failure surfaces as
 * `ReplyUncertain` and is never replayed. No CLI reply JSON, lock, counter,
 * cursor or preflight fetch appears anywhere in this module.
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { Authority, Denied } from "../authority/index.ts"
import type { AuthorityApi, AutonomyLevel, Grant } from "../authority/index.ts"
import { Disclosure, ReleasePayload } from "../disclosure/index.ts"
import type { DisclosureApi, DisclosureRefused, ProtectedBytes } from "../disclosure/index.ts"
import {
  type ChallengeInput,
  type ChallengeOptionRow,
  type ChallengeReply,
  outcomeRequirement,
  PERMISSION_OUTCOMES,
  type PermissionOutcome,
} from "./private/model.ts"

export { PERMISSION_OUTCOMES }

export type {
  ChallengeInput,
  ChallengeOptionRow,
  ChallengeQuestion,
  ChallengeReply,
  OptionsChallenge,
  OptionsReply,
  PermissionChallenge,
  PermissionOutcome,
  PermissionReply,
  QuestionChallenge,
  QuestionReply,
  ReplyDeliveryFailure,
  ReplyEndpoint,
  ReplyNotDelivered,
  ReplyUncertainDelivery,
} from "./private/model.ts"

// `Denied` (owned by `authority`) and `DisclosureRefused` (owned by
// `disclosure`) propagate out of this module unchanged; consumers import
// those classes from their owning modules. Boundary rules forbid re-exporting
// them here, because a re-export would launder the dependency edge.

// ---------------------------------------------------------------------------
// Opaque handles
// ---------------------------------------------------------------------------

/**
 * Brand keys for the opaque handles. The symbols are module-private, so the
 * fields cannot be forged outside this module.
 */
const scopeBrand: unique symbol = Symbol("droid-mcp-v2/decisions/DecisionScope")
const refBrand: unique symbol = Symbol("droid-mcp-v2/decisions/DecisionRef")

/**
 * A revocable per-turn capability. Only `openScope` mints one; possession of
 * the handle is required for every `offer`, `outstanding` and `answer` call
 * in that scope, and `retire` withdraws it atomically with its offers.
 */
export interface DecisionScope {
  readonly [scopeBrand]: true
}

/**
 * An unforgeable handle on one registered offer. Each `offer` mints a fresh
 * one bound to its own endpoint, so a peer reusing a request id never
 * receives an answer meant for an earlier or later offer.
 */
export interface DecisionRef {
  readonly [refBrand]: true
}

interface RefBody {
  readonly [refBrand]: true
  readonly id: string
}

/**
 * Human-presentable identity of a decision, safe to render in events and
 * discovery. It exposes nothing about the peer request id or the endpoint.
 */
export const decisionRefLabel = (ref: DecisionRef): string => readRef(ref).id

const readRef = (ref: DecisionRef): RefBody =>
  // SAFETY: the brand is module-private, so every `DecisionRef` in existence
  // was minted by `offer` below with exactly this body.
  ref as RefBody

// ---------------------------------------------------------------------------
// Human choices
// ---------------------------------------------------------------------------

export type HumanChoice = Data.TaggedEnum<{
  readonly Permission: {
    readonly outcome: PermissionOutcome
    readonly comment?: string
    readonly editedSpecContent?: string
  }
  readonly Question: {
    readonly answers: ReadonlyArray<{ readonly index: number; readonly answer: string }>
  }
  readonly Options: {
    readonly selectedIds: ReadonlyArray<string>
    readonly refresh?: boolean
  }
}>

export const HumanChoice = Data.taggedEnum<HumanChoice>()

// ---------------------------------------------------------------------------
// Decision views
// ---------------------------------------------------------------------------

/** Scrubbed permission display data released for the client audience. */
export interface PermissionDecisionViewData {
  readonly kind: "permission"
  readonly outcomes: ReadonlyArray<PermissionOutcome>
  readonly summary?: string
  readonly details?: Schema.Json
}

/** Scrubbed question display data released for the client audience. */
export interface QuestionDecisionViewData {
  readonly kind: "question"
  readonly questions: ReadonlyArray<{
    readonly index: number
    readonly topic?: string
    readonly text: string
    readonly options?: ReadonlyArray<Schema.Json>
    readonly multiSelect: boolean
  }>
}

/** Scrubbed options display data released for the client audience. */
export interface OptionsDecisionViewData {
  readonly kind: "options"
  readonly rows: ReadonlyArray<ChallengeOptionRow>
  readonly multiSelect: boolean
  readonly refreshable: boolean
  readonly title?: string
  readonly hint?: string
}

export type DecisionViewData =
  | PermissionDecisionViewData
  | QuestionDecisionViewData
  | OptionsDecisionViewData

/**
 * What an observer of a scope may see: the opaque ref plus display data that
 * has already crossed the client disclosure boundary. A view carries no reply
 * endpoint and no unscrubbed field.
 */
export interface DecisionView {
  readonly ref: DecisionRef
  readonly data: DecisionViewData
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class ScopeRetired extends Schema.TaggedError<ScopeRetired>()("ScopeRetired", {
  message: Schema.String,
}) {}

export class InvalidChoice extends Schema.TaggedError<InvalidChoice>()("InvalidChoice", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export class StaleDecision extends Schema.TaggedError<StaleDecision>()("StaleDecision", {
  message: Schema.String,
}) {}

/**
 * The answer was consumed but the endpoint reported a delivery failure.
 * `delivery` cleanly distinguishes the two cases: `"uncertain"` means the
 * reply may have reached the peer (post-handoff failure) and is never
 * replayed; `"not_delivered"` means the peer provably never received it, but
 * the offer is still consumed because the endpoint contract is exactly-once.
 */
export class ReplyUncertain extends Schema.TaggedError<ReplyUncertain>()("ReplyUncertain", {
  message: Schema.String,
  delivery: Schema.Literals(["uncertain", "not_delivered"]),
}) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface DecisionsApi {
  readonly openScope: () => Effect.Effect<DecisionScope>
  readonly offer: (
    scope: DecisionScope,
    challenge: ChallengeInput,
  ) => Effect.Effect<DecisionView, ScopeRetired | DisclosureRefused | ProtectedBytes>
  readonly outstanding: (
    scope: DecisionScope,
  ) => Effect.Effect<ReadonlyArray<DecisionView>, ScopeRetired>
  readonly answer: (
    scope: DecisionScope,
    ref: DecisionRef,
    choice: HumanChoice,
    grant: Grant,
  ) => Effect.Effect<void, InvalidChoice | Denied | StaleDecision | ReplyUncertain>
  readonly retire: (scope: DecisionScope) => Effect.Effect<void>
}

export class Decisions extends Context.Service<Decisions, DecisionsApi>()("droid-mcp/decisions") {}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type OfferState = "pending" | "delivering" | "consumed"

interface OfferRecord {
  readonly challenge: ChallengeInput
  readonly refId: string
  readonly view: DecisionView
  state: OfferState
  cancelTimeout: (() => void) | undefined
}

interface ScopeRecord {
  readonly id: string
  retired: boolean
  readonly offers: Map<string, OfferRecord>
}

interface ModuleState {
  readonly scopes: WeakMap<DecisionScope, ScopeRecord>
  nextScopeOrdinal: number
  nextRefOrdinal: number
}

const invalid = (reason: string, message: string): InvalidChoice =>
  new InvalidChoice({ message, reason })

const scopeRetired = (): ScopeRetired =>
  new ScopeRetired({ message: "this decision scope has been retired" })

const stale = (): StaleDecision =>
  new StaleDecision({
    message: "that decision is no longer outstanding; it was answered, timed out or retired",
  })

// ---------------------------------------------------------------------------
// Display release through disclosure
// ---------------------------------------------------------------------------

/**
 * Releases one JSON value through `disclosure` for the client audience of
 * this scope and returns the scrubbed value. A refusal propagates out of
 * `offer` before the offer is registered; the released payload is the only
 * text allowed to cross into a view.
 */
const releaseValue = (
  disclosure: DisclosureApi,
  recipientId: string,
  value: Schema.Json,
): Effect.Effect<Schema.Json, DisclosureRefused | ProtectedBytes> =>
  Effect.gen(function* () {
    const audience = yield* disclosure.audience("client", recipientId)

    const released = yield* disclosure.release(
      { payload: ReleasePayload.JsonValue({ value }) },
      audience,
    )

    return ReleasePayload.$match(released.payload, {
      Empty: () => null,
      JsonValue: (variant) => variant.value,
      Records: () => null,
      Media: () => null,
    })
  })

/**
 * Releases a text field that may be absent. An absent field stays absent;
 * the scrubbed string replaces the original, never the other way round.
 */
const releaseText = (
  disclosure: DisclosureApi,
  recipientId: string,
  value: string,
): Effect.Effect<string, DisclosureRefused | ProtectedBytes> =>
  Effect.map(releaseValue(disclosure, recipientId, value), (scrubbed) =>
    Schema.is(Schema.String)(scrubbed) ? scrubbed : "",
  )

const releaseOptionalText = (
  disclosure: DisclosureApi,
  recipientId: string,
  value: string | undefined,
): Effect.Effect<string | undefined, DisclosureRefused | ProtectedBytes> =>
  value === undefined
    ? Effect.succeed(undefined)
    : Effect.map(releaseText(disclosure, recipientId, value), (text) => text)

/**
 * Builds the scrubbed view data for one challenge. Outcome lists, row ids,
 * indices and flags are the module's own normalized metadata and cross
 * unchanged; every free-text display field passes through the release
 * boundary, so a secret embedded in display data is scrubbed or the offer is
 * refused.
 */
const scrubView = (
  disclosure: DisclosureApi,
  recipientId: string,
  challenge: ChallengeInput,
): Effect.Effect<DecisionViewData, DisclosureRefused | ProtectedBytes> =>
  Effect.gen(function* () {
    if (challenge.kind === "permission") {
      const summary = yield* releaseOptionalText(disclosure, recipientId, challenge.display.summary)

      const details = challenge.display.details

      const releasedDetails =
        details === undefined ? undefined : yield* releaseValue(disclosure, recipientId, details)

      const base: PermissionDecisionViewData = {
        kind: "permission",
        outcomes: challenge.outcomes,
      }

      if (summary !== undefined && releasedDetails !== undefined) {
        return { ...base, summary, details: releasedDetails }
      }

      if (summary !== undefined) return { ...base, summary }

      if (releasedDetails !== undefined) return { ...base, details: releasedDetails }

      return base
    }

    if (challenge.kind === "question") {
      const questions: Array<{
        readonly index: number
        readonly topic?: string
        readonly text: string
        readonly options?: ReadonlyArray<Schema.Json>
        readonly multiSelect: boolean
      }> = []

      for (const question of challenge.display.questions) {
        const text = yield* releaseText(disclosure, recipientId, question.text)
        const topic = yield* releaseOptionalText(disclosure, recipientId, question.topic)

        const options =
          question.options === undefined
            ? undefined
            : yield* Effect.map(
                releaseValue(disclosure, recipientId, question.options),
                (scrubbed) => (Array.isArray(scrubbed) ? scrubbed : []),
              )

        const base = { index: question.index, text, multiSelect: question.multiSelect }

        if (topic !== undefined && options !== undefined) {
          questions.push({ ...base, topic, options })
        } else if (topic !== undefined) {
          questions.push({ ...base, topic })
        } else if (options !== undefined) {
          questions.push({ ...base, options })
        } else {
          questions.push(base)
        }
      }

      return { kind: "question", questions } satisfies QuestionDecisionViewData
    }

    const rows: Array<ChallengeOptionRow> = []

    for (const row of challenge.display.rows) {
      const label = yield* releaseOptionalText(disclosure, recipientId, row.label)
      const detail = yield* releaseOptionalText(disclosure, recipientId, row.detail)
      const base = { id: row.id }

      if (label !== undefined && detail !== undefined) {
        rows.push({ ...base, label, detail })
      } else if (label !== undefined) {
        rows.push({ ...base, label })
      } else if (detail !== undefined) {
        rows.push({ ...base, detail })
      } else {
        rows.push(base)
      }
    }

    const title = yield* releaseOptionalText(disclosure, recipientId, challenge.display.title)
    const hint = yield* releaseOptionalText(disclosure, recipientId, challenge.display.hint)

    const base: OptionsDecisionViewData = {
      kind: "options",
      rows,
      multiSelect: challenge.display.multiSelect,
      refreshable: challenge.display.refreshable,
    }

    if (title !== undefined && hint !== undefined) return { ...base, title, hint }

    if (title !== undefined) return { ...base, title }

    if (hint !== undefined) return { ...base, hint }

    return base
  })

// ---------------------------------------------------------------------------
// Choice validation
// ---------------------------------------------------------------------------

/**
 * Validates a human choice against the original challenge choices before the
 * reply right is claimed. Validation failure leaves the offer answerable by a
 * valid, authorized choice; nothing here consumes state or runs the endpoint.
 */
const validateChoice = (
  record: OfferRecord,
  choice: HumanChoice,
): Effect.Effect<ChallengeReply, InvalidChoice> => {
  const challenge = record.challenge

  return HumanChoice.$match(choice, {
    Permission: (variant) => {
      if (challenge.kind !== "permission") {
        return Effect.fail(
          invalid(
            "kind_mismatch",
            "a permission choice cannot answer a " + challenge.kind + " challenge",
          ),
        )
      }

      if (!challenge.outcomes.includes(variant.outcome)) {
        return Effect.fail(
          invalid("unoffered_outcome", "the challenge does not offer " + variant.outcome),
        )
      }

      if (variant.outcome === "proceed_edit" && (variant.editedSpecContent ?? "").length === 0) {
        return Effect.fail(
          invalid("edited_spec_required", "proceed_edit requires editedSpecContent"),
        )
      }

      return Effect.succeed<ChallengeReply>({
        kind: "permission",
        reply: {
          outcome: variant.outcome,
          comment: variant.comment,
          editedSpecContent: variant.editedSpecContent,
        },
      })
    },
    Question: (variant) => {
      if (challenge.kind !== "question") {
        return Effect.fail(
          invalid(
            "kind_mismatch",
            "a question choice cannot answer a " + challenge.kind + " challenge",
          ),
        )
      }

      for (const entry of variant.answers) {
        if (!challenge.display.questions.some((question) => question.index === entry.index)) {
          return Effect.fail(
            invalid(
              "unknown_question_index",
              "no question " + String(entry.index) + " in this challenge",
            ),
          )
        }
      }

      return Effect.succeed<ChallengeReply>({
        kind: "question",
        reply: { answers: variant.answers },
      })
    },
    Options: (variant) => {
      if (challenge.kind !== "options") {
        return Effect.fail(
          invalid(
            "kind_mismatch",
            "an options choice cannot answer a " + challenge.kind + " challenge",
          ),
        )
      }

      const refresh = variant.refresh === true

      if (refresh) {
        if (!challenge.display.refreshable) {
          return Effect.fail(
            invalid("refresh_not_offered", "this challenge does not offer a refresh"),
          )
        }
      } else {
        if (!challenge.display.multiSelect && variant.selectedIds.length > 1) {
          return Effect.fail(
            invalid(
              "multi_select_violation",
              "this challenge accepts one row; got " + String(variant.selectedIds.length),
            ),
          )
        }

        for (const id of variant.selectedIds) {
          if (!challenge.display.rows.some((row) => row.id === id)) {
            return Effect.fail(invalid("unknown_option_id", "no row " + id + " in this challenge"))
          }
        }
      }

      return Effect.succeed<ChallengeReply>({
        kind: "options",
        reply: { selectedIds: variant.selectedIds, refresh },
      })
    },
  })
}

/**
 * Autonomy check for a permission answer, delegated to `authority` — never
 * re-implemented here. A permission outcome whose requirement exceeds what
 * the grant allows is `Denied`; question and options answers carry no
 * autonomy escalation and pass unconditionally. Denial never consumes the
 * offer.
 */
const checkAutonomy = (
  authority: AuthorityApi,
  reply: ChallengeReply,
  grant: Grant,
): Effect.Effect<void, Denied> => {
  if (reply.kind !== "permission") return Effect.void

  const requirement: AutonomyLevel = outcomeRequirement(reply.reply.outcome)

  if (authority.allows(grant, { level: requirement })) return Effect.void

  return Effect.fail(
    new Denied({
      message: "outcome " + reply.reply.outcome + " exceeds what this grant allows",
      requestedLevel: requirement,
      ceiling: grant.ceiling,
      reason: "outcome_exceeds_grant",
    }),
  )
}

// ---------------------------------------------------------------------------
// Single-winner contention
// ---------------------------------------------------------------------------

/**
 * Atomically claims the reply right for one record. Effect executes
 * synchronous regions without yielding to other fibers, so no contender can
 * interleave between the read and the write: exactly one of answer, timeout
 * and retirement ever observes `pending` and flips it.
 */
const claimRight = (record: OfferRecord): boolean => {
  if (record.state !== "pending") return false

  record.state = "delivering"

  return true
}

const withdrawTimeout = (record: OfferRecord): void => {
  const cancel = record.cancelTimeout
  record.cancelTimeout = undefined

  if (cancel !== undefined) cancel()
}

/**
 * Consumes one offer permanently and removes it from its scope's outstanding
 * set. Eviction of an observation never lands here: only a decided answer, a
 * fired timeout or a scope retirement consumes an offer.
 */
const consume = (scope: ScopeRecord, record: OfferRecord): void => {
  record.state = "consumed"
  withdrawTimeout(record)
  scope.offers.delete(record.refId)
}

/**
 * The timeout contender: after the delay it contends for the same
 * single-winner right and, on winning, consumes the offer without invoking
 * the endpoint. The endpoint is single-use and reply-shaped; a timeout
 * resolves the offer as stale for every other contender instead of
 * fabricating a reply the human never made.
 */
const timeoutContender = (scope: ScopeRecord, record: OfferRecord): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (!claimRight(record)) return Effect.void

    consume(scope, record)

    return Effect.void
  })

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Builds the per-layer `Decisions` service. All scope and offer state is
 * local to this instance, so independent assemblies never share decisions.
 * Depends only on `Authority` and `Disclosure`.
 */
export const decisionsLayer: Layer.Layer<Decisions, never, Authority | Disclosure> = Layer.effect(
  Decisions,
  Effect.gen(function* () {
    const authority = yield* Authority
    const disclosure = yield* Disclosure

    const state: ModuleState = {
      scopes: new WeakMap(),
      nextScopeOrdinal: 0,
      nextRefOrdinal: 0,
    }

    const recordOf = (scope: DecisionScope): ScopeRecord | undefined => state.scopes.get(scope)

    const liveScope = (scope: DecisionScope): Effect.Effect<ScopeRecord, ScopeRetired> =>
      Effect.suspend(() => {
        const record = recordOf(scope)

        if (record === undefined || record.retired) {
          return Effect.fail(scopeRetired())
        }

        return Effect.succeed(record)
      })

    const openScope: DecisionsApi["openScope"] = () =>
      Effect.sync(() => {
        state.nextScopeOrdinal += 1

        const id = "scope-" + String(state.nextScopeOrdinal)
        const scope: DecisionScope = { [scopeBrand]: true }
        state.scopes.set(scope, { id, retired: false, offers: new Map() })

        return scope
      })

    const offer: DecisionsApi["offer"] = (scope, challenge) =>
      Effect.gen(function* () {
        const live = yield* liveScope(scope)

        // Scrubbing happens before registration: a refused display means no
        // offer exists at all, so `outstanding` can never expose unscrubbed
        // data and no endpoint is ever armed for it.
        const data = yield* scrubView(disclosure, live.id, challenge)

        // Retirement may have run while disclosure was suspended. Recheck
        // before registering, with no yield between the check and the write.
        if (live.retired) return yield* Effect.fail(scopeRetired())

        state.nextRefOrdinal += 1

        const refId = "decision-" + String(state.nextRefOrdinal)
        const ref: RefBody = { [refBrand]: true, id: refId }

        const view: DecisionView = { ref, data }

        const record: OfferRecord = {
          challenge,
          refId,
          view,
          state: "pending",
          cancelTimeout: undefined,
        }

        live.offers.set(refId, record)

        if (challenge.timeoutMs !== undefined && challenge.timeoutMs > 0) {
          const fiber = yield* Effect.forkDetach(
            Effect.andThen(Effect.sleep(challenge.timeoutMs), timeoutContender(live, record)),
          )

          record.cancelTimeout = () => {
            fiber.interruptUnsafe()
          }
        }

        return view
      })

    const outstanding: DecisionsApi["outstanding"] = (scope) =>
      Effect.map(liveScope(scope), (live) =>
        Array.from(live.offers.values(), (record) => record.view),
      )

    const answer: DecisionsApi["answer"] = (scope, ref, choice, grant) =>
      Effect.gen(function* () {
        const live = yield* Effect.mapError(liveScope(scope), () => stale())
        const record = live.offers.get(decisionRefLabel(ref))

        if (record === undefined || record.view.ref !== ref || record.state !== "pending") {
          return yield* Effect.fail(stale())
        }

        // Validation and the authority check run before the right is
        // claimed: an invalid or denied answer leaves the offer answerable
        // and never touches the endpoint.
        const reply = yield* validateChoice(record, choice)

        yield* checkAutonomy(authority, reply, grant)

        if (!claimRight(record)) return yield* Effect.fail(stale())

        consume(live, record)

        const delivered = yield* Effect.exit(record.challenge.reply(reply))

        if (Exit.isSuccess(delivered)) return

        const failure = Cause.findErrorOption(delivered.cause)
        const uncertain = Option.isSome(failure) && Predicate.isTagged("Uncertain")(failure.value)

        return yield* Effect.fail(
          uncertain
            ? new ReplyUncertain({
                message:
                  "the reply may not have reached the peer; the decision is consumed and will not be retried",
                delivery: "uncertain",
              })
            : new ReplyUncertain({
                message:
                  "the reply was not delivered; the decision is consumed and cannot be re-issued",
                delivery: "not_delivered",
              }),
        )
      })

    const retire: DecisionsApi["retire"] = (scope) =>
      Effect.sync(() => {
        const record = recordOf(scope)

        if (record === undefined || record.retired) return

        record.retired = true

        for (const offerRecord of record.offers.values()) {
          if (offerRecord.state === "pending") {
            offerRecord.state = "consumed"
            withdrawTimeout(offerRecord)
          }
        }

        record.offers.clear()
      })

    return { openScope, offer, outstanding, answer, retire }
  }),
)
