/**
 * Level 5 `turns` module: turn lifecycle, racing completion reconciliation,
 * atomic observation/decision snapshots, wait semantics and honest interrupts.
 *
 * A `TurnRef` names one submission on a live `RunningLease`. At most one turn
 * may be active on a lease at a time, and every turn makes at most one
 * terminal transition (`completed`, `interrupted`, or `failed`). Once settled,
 * a turn's terminal state is permanent: late notices carrying an older work
 * ref or arriving after settlement never mutate or settle newer work.
 *
 * Invariants:
 * - Reserve the active turn slot and start the single per-lease notice pump
 *   (supervised through `custody`) BEFORE sending `lease.submit(...)`, so
 *   fast racing notices and completions are captured and reconciled without
 *   resubmission.
 * - Map `PlacementSubmissionUncertain` to `TurnSubmissionUncertain` (owned by
 *   this module) and NEVER retry or resubmit.
 * - Update turn state, `observations` and `decisions` atomically under the
 *   per-lease lock so `inspect` and `wait` never observe an inconsistent view.
 * - Track outstanding decisions strictly in `decisions`, never by scanning
 *   retained `observations` history: eviction of a prompt event never loses
 *   the live decision.
 * - Retire live decisions atomically on turn termination, peer loss or lease
 *   retirement.
 * - `wait` expiry returns the current `TurnView` without cancelling work.
 * - `interrupt` forwards the request honestly and never fabricates
 *   `"interrupted"` status; only a peer `TurnInterrupted` notice transitions
 *   a turn to `"interrupted"`.
 * - Every observation event crosses `disclosure` for `"event"` audience, and
 *   every turn summary, assistant text and failure reason crosses `disclosure`
 *   for `"client"` audience.
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

import { Denied } from "../authority/index.ts"
import type { Grant } from "../authority/index.ts"
import { Custody } from "../custody/index.ts"
import type { Lease } from "../custody/index.ts"
import { decisionRefLabel, Decisions, StaleDecision } from "../decisions/index.ts"
import type {
  ChallengeInput,
  DecisionRef,
  DecisionScope,
  DecisionView,
  HumanChoice,
  InvalidChoice,
  ReplyUncertain,
} from "../decisions/index.ts"
import { Disclosure, releasedJson, ReleasePayload } from "../disclosure/index.ts"
import type { Audience, Released, TextScrubStream } from "../disclosure/index.ts"
import { Observations } from "../observations/index.ts"
import type { History, InvalidPosition, ObservationPage, Position } from "../observations/index.ts"
import { PlacementNotice } from "../placement/index.ts"
import type { PlacementPeerLost, PlacementWorkRef, RunningLease } from "../placement/index.ts"
import {
  buildOptionsChallenge,
  buildPermissionChallenge,
  buildQuestionChallenge,
} from "./private/challenges.ts"
import { extractDeltaText, serializeDecisionViewData } from "./private/events.ts"

// ---------------------------------------------------------------------------
// Opaque handles
// ---------------------------------------------------------------------------

const turnRefBrand: unique symbol = Symbol("droid-mcp-v2/turns/TurnRef")

/**
 * An opaque handle to one turn on a live lease. Minted only by this module;
 * never exposes raw peer ids, URIs or internal epoch counters.
 */
export interface TurnRef {
  readonly [turnRefBrand]: true
}

interface TurnRefBody {
  readonly [turnRefBrand]: true
  readonly id: string
}

const readTurnRef = (ref: TurnRef): TurnRefBody =>
  // SAFETY: the brand symbol is module-private, so every `TurnRef` in
  // existence was constructed inside this module with this exact body.
  ref as TurnRefBody

/** Safe public identity of a turn, suitable for logging and discovery. */
export const turnId = (ref: TurnRef): string => readTurnRef(ref).id

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TurnInput {
  readonly text: string
}

export type TurnStatus = "running" | "completed" | "interrupted" | "failed"

export interface TurnView {
  readonly turn: TurnRef
  readonly status: TurnStatus
  readonly summary: Released<"client"> | undefined
  readonly lastText: string | undefined
  readonly failureReason: string | undefined
  readonly outstandingDecisions: ReadonlyArray<DecisionView>
  readonly startedAtMs: number
  readonly finishedAtMs: number | undefined
}

export type WaitCondition = "terminal" | "decision_or_terminal" | "activity"

export interface TurnsOptions {
  readonly maxEvents?: number | undefined
  readonly maxBytes?: number | undefined
  readonly decisionTimeoutMs?: number | undefined
}

// ---------------------------------------------------------------------------
// Tagged errors (owned by this module)
// ---------------------------------------------------------------------------

export class Busy extends Schema.TaggedError<Busy>()("Busy", {
  message: Schema.String,
}) {}

export class SubmitRejected extends Schema.TaggedError<SubmitRejected>()("SubmitRejected", {
  message: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

export class TurnSubmissionUncertain extends Schema.TaggedError<TurnSubmissionUncertain>()(
  "TurnSubmissionUncertain",
  {
    message: Schema.String,
  },
) {}

export class TurnUnavailable extends Schema.TaggedError<TurnUnavailable>()("TurnUnavailable", {
  message: Schema.String,
}) {}

export class InterruptUncertain extends Schema.TaggedError<InterruptUncertain>()(
  "InterruptUncertain",
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface TurnsApi {
  readonly start: (
    lease: RunningLease,
    prompt: TurnInput,
    grant: Grant,
  ) => Effect.Effect<TurnRef, Busy | SubmitRejected | TurnSubmissionUncertain>

  readonly inspect: (turn: TurnRef) => Effect.Effect<TurnView, TurnUnavailable>

  readonly wait: (
    turn: TurnRef,
    until: WaitCondition,
    waitMs: number,
  ) => Effect.Effect<TurnView, TurnUnavailable>

  readonly observe: (
    turn: TurnRef,
    after: Position | null,
    waitMs: number,
  ) => Effect.Effect<ObservationPage, TurnUnavailable | InvalidPosition>

  readonly decide: (
    turn: TurnRef,
    ref: DecisionRef,
    choice: HumanChoice,
    grant: Grant,
  ) => Effect.Effect<void, InvalidChoice | Denied | StaleDecision | ReplyUncertain>

  readonly interrupt: (
    turn: TurnRef,
    grant: Grant,
  ) => Effect.Effect<void, TurnUnavailable | InterruptUncertain>

  readonly observeLease: (
    lease: RunningLease,
    after: Position | null,
    waitMs: number,
  ) => Effect.Effect<ObservationPage, TurnUnavailable | InvalidPosition>

  readonly latestTurn: (lease: RunningLease) => Effect.Effect<TurnView | undefined>

  readonly retireLease: (lease: RunningLease) => Effect.Effect<void>
}

export class Turns extends Context.Service<Turns, TurnsApi>()("droid-mcp/turns") {}

// ---------------------------------------------------------------------------
// Internal state structures
// ---------------------------------------------------------------------------

interface TurnRecord {
  readonly id: string
  readonly ref: TurnRef
  readonly leaseState: LeaseState
  readonly decisionScope: DecisionScope
  readonly startedAtMs: number
  workRef: PlacementWorkRef | undefined
  submitting: boolean
  status: TurnStatus
  summary: Released<"client"> | undefined
  readonly textChunks: Array<string>
  readonly textStream: TextScrubStream
  lastText: string | undefined
  failureReason: string | undefined
  finishedAtMs: number | undefined
  activityCount: number
}

interface LeaseState {
  readonly lease: RunningLease
  readonly lock: Semaphore.Semaphore
  readonly history: History
  readonly eventAudience: Audience<"event">
  readonly clientAudience: Audience<"client">
  readonly pumpDone: Deferred.Deferred<void, never>
  readonly waiters: Set<() => void>
  pumpStarted: boolean
  pumpCustodyLease: Lease<Fiber.Fiber<void, never>> | undefined
  retired: boolean
  peerLost: boolean
  activeTurn: TurnRecord | undefined
  latestTurn: TurnRecord | undefined
  lastSettledGeneration: number | undefined
  activityVersion: number
}

const isString = Schema.is(Schema.String)

const EMPTY_DECISIONS: ReadonlyArray<DecisionView> = []

const wakeWaiters = (leaseState: LeaseState): void => {
  for (const wake of leaseState.waiters) {
    wake()
  }
}

/**
 * Replaces the fragmented text of a delta payload with the scrubbed text the
 * stream released for it. Only `assistant_text_delta` carries fragmented
 * text in this shape; other payloads pass through unchanged.
 */
const rewriteDeltaText = (kind: string, payload: Schema.Json, released: string): Schema.Json => {
  if (kind !== "assistant_text_delta") return payload

  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(payload),
  )

  if (decoded === undefined) return payload

  return { ...decoded, textDelta: released }
}

const recordSettledGeneration = (leaseState: LeaseState, workRef: PlacementWorkRef | undefined) => {
  if (workRef === undefined) return

  if (
    leaseState.lastSettledGeneration === undefined ||
    workRef.generation > leaseState.lastSettledGeneration
  ) {
    leaseState.lastSettledGeneration = workRef.generation
  }
}

const matchesActiveTurn = (
  leaseState: LeaseState,
  noticeWorkRef: PlacementWorkRef | undefined,
): TurnRecord | undefined => {
  const active = leaseState.activeTurn

  if (active === undefined || active.status !== "running") return undefined

  if (noticeWorkRef === undefined) return active

  if (noticeWorkRef.leaseId !== leaseState.lease.leaseId) return undefined

  if (active.workRef !== undefined) {
    return noticeWorkRef.generation === active.workRef.generation ? active : undefined
  }

  if (
    leaseState.lastSettledGeneration !== undefined &&
    noticeWorkRef.generation <= leaseState.lastSettledGeneration
  ) {
    return undefined
  }

  return active
}

const isConditionMet = (
  until: WaitCondition,
  turn: TurnRecord,
  view: TurnView,
  initialActivity: number,
): boolean => {
  if (turn.status !== "running") return true

  return Match.value(until).pipe(
    Match.when("terminal", () => false),
    Match.when("decision_or_terminal", () => view.outstandingDecisions.length > 0),
    Match.when("activity", () => turn.activityCount > initialActivity),
    Match.exhaustive,
  )
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const turnsLayer = (
  options?: TurnsOptions,
): Layer.Layer<Turns, never, Decisions | Observations | Disclosure | Custody> =>
  Layer.effect(
    Turns,
    Effect.gen(function* () {
      const decisions = yield* Decisions
      const observations = yield* Observations
      const disclosure = yield* Disclosure
      const custody = yield* Custody

      const activePumps = new Set<Lease<Fiber.Fiber<void, never>>>()

      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          Array.from(activePumps),
          (pumpLease) => Effect.orElseSucceed(custody.release(pumpLease), () => undefined),
          { discard: true },
        ),
      )

      const leases = new WeakMap<RunningLease, LeaseState>()
      const retiredLeases = new WeakSet<RunningLease>()
      const turnsById = new Map<string, TurnRecord>()
      const leaseInitLock = yield* Semaphore.make(1)

      let turnSequence = 0

      // ---------------------------------------------------------------------
      // Disclosure helpers
      // ---------------------------------------------------------------------

      const releaseEvent = (
        leaseState: LeaseState,
        value: Schema.Json,
      ): Effect.Effect<Released<"event"> | undefined> =>
        disclosure
          .release({ payload: ReleasePayload.JsonValue({ value }) }, leaseState.eventAudience)
          .pipe(Effect.orElseSucceed(() => undefined))

      const releaseClient = (
        leaseState: LeaseState,
        value: Schema.Json,
      ): Effect.Effect<Released<"client"> | undefined> =>
        disclosure
          .release({ payload: ReleasePayload.JsonValue({ value }) }, leaseState.clientAudience)
          .pipe(Effect.orElseSucceed(() => undefined))

      const scrubClientText = (
        leaseState: LeaseState,
        text: string,
      ): Effect.Effect<string | undefined> =>
        Effect.gen(function* () {
          const released = yield* releaseClient(leaseState, text)

          if (released === undefined) return undefined

          const json = releasedJson(released)

          if (Option.isNone(json) || !isString(json.value)) return undefined

          return json.value
        })

      const appendEvent = (leaseState: LeaseState, value: Schema.Json): Effect.Effect<void> =>
        Effect.gen(function* () {
          const released = yield* releaseEvent(leaseState, value)

          if (released === undefined) return

          yield* observations
            .append(leaseState.history, released)
            .pipe(Effect.orElseSucceed(() => undefined))
        })

      // ---------------------------------------------------------------------
      // Snapshot construction (must run under leaseState.lock)
      // ---------------------------------------------------------------------

      const buildTurnView = (turn: TurnRecord): Effect.Effect<TurnView> =>
        Effect.gen(function* () {
          const outstandingDecisions: ReadonlyArray<DecisionView> =
            turn.status === "running"
              ? yield* decisions
                  .outstanding(turn.decisionScope)
                  .pipe(Effect.orElseSucceed(() => EMPTY_DECISIONS))
              : EMPTY_DECISIONS

          return {
            turn: turn.ref,
            status: turn.status,
            summary: turn.summary,
            lastText: turn.lastText,
            failureReason: turn.failureReason,
            outstandingDecisions,
            startedAtMs: turn.startedAtMs,
            finishedAtMs: turn.finishedAtMs,
          }
        })

      const snapshotTurn = (turn: TurnRecord): Effect.Effect<TurnView> =>
        Semaphore.withPermit(turn.leaseState.lock)(buildTurnView(turn))

      // ---------------------------------------------------------------------
      // Lease state initialization
      // ---------------------------------------------------------------------

      const getOrCreateLeaseState = (lease: RunningLease): Effect.Effect<LeaseState> =>
        Semaphore.withPermit(leaseInitLock)(
          Effect.gen(function* () {
            const existing = leases.get(lease)

            if (existing !== undefined) return existing

            const recipientId = lease.leaseId
            const eventAudience = yield* disclosure.audience("event", recipientId)
            const clientAudience = yield* disclosure.audience("client", recipientId)

            const history = yield* observations.open({
              audience: eventAudience,
              maxEvents: options?.maxEvents,
              maxBytes: options?.maxBytes,
            })

            const lock = yield* Semaphore.make(1)
            const pumpDone = yield* Deferred.make<void>()

            const state: LeaseState = {
              lease,
              lock,
              history,
              eventAudience,
              clientAudience,
              pumpDone,
              waiters: new Set(),
              pumpStarted: false,
              pumpCustodyLease: undefined,
              retired: retiredLeases.has(lease),
              peerLost: false,
              activeTurn: undefined,
              latestTurn: undefined,
              lastSettledGeneration: undefined,
              activityVersion: 0,
            }

            if (state.retired) {
              yield* observations.close(history)
              Deferred.doneUnsafe(pumpDone, Effect.void)
            }

            leases.set(lease, state)

            return state
          }),
        )

      // ---------------------------------------------------------------------
      // Atomic terminal settlement (must run under leaseState.lock)
      // ---------------------------------------------------------------------

      const settleActiveTurn = (
        leaseState: LeaseState,
        turn: TurnRecord,
        status: Exclude<TurnStatus, "running">,
        summaryValue: Schema.Json | undefined,
        failureText: string | undefined,
        eventPayload: Schema.Json,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (turn.status !== "running") return

          turn.status = status
          turn.finishedAtMs = Date.now()

          if (summaryValue !== undefined) {
            turn.summary = yield* releaseClient(leaseState, summaryValue)
          }

          if (failureText !== undefined) {
            const scrubbed = yield* scrubClientText(leaseState, failureText)

            turn.failureReason = scrubbed ?? failureText
          }

          yield* decisions.retire(turn.decisionScope)

          const streamTail = turn.textStream.flush()

          if (streamTail.length > 0) {
            yield* appendEvent(leaseState, {
              kind: "delta",
              turnId: turn.id,
              deltaKind: "assistant_text_delta",
              payload: { textDelta: streamTail },
            })
          }

          yield* appendEvent(leaseState, eventPayload)

          recordSettledGeneration(leaseState, turn.workRef)

          if (leaseState.activeTurn === turn) {
            leaseState.activeTurn = undefined
          }

          turn.activityCount += 1
          leaseState.activityVersion += 1
          wakeWaiters(leaseState)
        })

      // ---------------------------------------------------------------------
      // Notice processing (serialized under leaseState.lock)
      // ---------------------------------------------------------------------

      const offerChallenge = (
        leaseState: LeaseState,
        turn: TurnRecord,
        challenge: ChallengeInput,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const offered = yield* Effect.exit(decisions.offer(turn.decisionScope, challenge))

          if (Exit.isFailure(offered)) return

          const view = offered.value

          yield* appendEvent(leaseState, {
            kind: "decision_offered",
            turnId: turn.id,
            decisionId: decisionRefLabel(view.ref),
            decisionKind: view.data.kind,
            data: serializeDecisionViewData(view.data),
          })

          turn.activityCount += 1
          leaseState.activityVersion += 1
          wakeWaiters(leaseState)
        })

      const processNotice = (
        leaseState: LeaseState,
        notice: PlacementNotice,
      ): Effect.Effect<void> =>
        PlacementNotice.$match(notice, {
          SessionDelta: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              const deltaText = extractDeltaText(variant.kind, variant.payload)

              let payload = variant.payload

              if (deltaText !== undefined) {
                turn.textChunks.push(deltaText)

                const combined = turn.textChunks.join("")
                const scrubbed = yield* scrubClientText(leaseState, combined)

                turn.lastText = scrubbed ?? combined

                // Stream scrubbing is the only correct boundary for fragmented
                // text: atomic scrubbing cannot see a protected value split
                // across deltas, so the released text here may lag the peer
                // while a possible prefix is withheld.
                payload = rewriteDeltaText(
                  variant.kind,
                  variant.payload,
                  turn.textStream.push(deltaText),
                )
              }

              yield* appendEvent(leaseState, {
                kind: "delta",
                turnId: turn.id,
                deltaKind: variant.kind,
                payload,
              })

              turn.activityCount += 1
              leaseState.activityVersion += 1
              wakeWaiters(leaseState)
            }),

          TurnCompleted: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              yield* settleActiveTurn(leaseState, turn, "completed", variant.summary, undefined, {
                kind: "turn_completed",
                turnId: turn.id,
                summary: variant.summary,
              })
            }),

          TurnInterrupted: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              yield* settleActiveTurn(
                leaseState,
                turn,
                "interrupted",
                { reason: variant.reason },
                undefined,
                {
                  kind: "turn_interrupted",
                  turnId: turn.id,
                  reason: variant.reason,
                },
              )
            }),

          TurnFailed: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              yield* settleActiveTurn(
                leaseState,
                turn,
                "failed",
                { code: variant.code, message: variant.message },
                variant.message,
                {
                  kind: "turn_failed",
                  turnId: turn.id,
                  code: variant.code,
                  message: variant.message,
                },
              )
            }),

          PermissionChallenge: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              const challenge = buildPermissionChallenge(
                variant.toolUses,
                variant.options,
                variant.reply,
                options?.decisionTimeoutMs,
              )

              yield* offerChallenge(leaseState, turn, challenge)
            }),

          QuestionChallenge: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              const challenge = buildQuestionChallenge(
                variant.questions,
                variant.reply,
                options?.decisionTimeoutMs,
              )

              yield* offerChallenge(leaseState, turn, challenge)
            }),

          OptionsChallenge: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              const challenge = buildOptionsChallenge(
                variant.title,
                variant.options,
                variant.multiSelect,
                variant.reply,
                options?.decisionTimeoutMs,
              )

              yield* offerChallenge(leaseState, turn, challenge)
            }),

          ChallengeResolved: (variant) =>
            Effect.gen(function* () {
              const turn = matchesActiveTurn(leaseState, variant.workRef)

              if (turn === undefined) return

              yield* appendEvent(leaseState, {
                kind: "challenge_resolved",
                turnId: turn.id,
                toolUseIds: [...variant.toolUseIds],
              })

              turn.activityCount += 1
              leaseState.activityVersion += 1
              wakeWaiters(leaseState)
            }),

          SettingsChanged: (variant) =>
            Effect.gen(function* () {
              yield* appendEvent(leaseState, {
                kind: "settings_changed",
                settings: variant.settings,
              })

              if (leaseState.activeTurn !== undefined) {
                leaseState.activeTurn.activityCount += 1
              }

              leaseState.activityVersion += 1
              wakeWaiters(leaseState)
            }),

          PeerExited: (variant) =>
            Effect.gen(function* () {
              leaseState.peerLost = true

              const rawStderr = variant.stderrSummary

              const scrubbedStderr =
                rawStderr === undefined || rawStderr.length === 0
                  ? undefined
                  : yield* scrubClientText(leaseState, rawStderr)

              yield* appendEvent(leaseState, {
                kind: "peer_exited",
                stderrSummary: rawStderr ?? null,
              })

              const active = leaseState.activeTurn

              if (active !== undefined && active.status === "running") {
                const reason =
                  scrubbedStderr !== undefined && scrubbedStderr.length > 0
                    ? scrubbedStderr
                    : "peer exited unexpectedly"

                yield* settleActiveTurn(
                  leaseState,
                  active,
                  "failed",
                  { reason: "peer_exited", stderrSummary: rawStderr ?? null },
                  reason,
                  {
                    kind: "turn_failed",
                    turnId: active.id,
                    code: "peer_exited",
                    message: reason,
                  },
                )
              } else {
                leaseState.activityVersion += 1
                wakeWaiters(leaseState)
              }
            }),
        })

      const handleNotice = (leaseState: LeaseState, notice: PlacementNotice): Effect.Effect<void> =>
        Semaphore.withPermit(leaseState.lock)(processNotice(leaseState, notice))

      const handlePumpEnded = (
        leaseState: LeaseState,
        exit: Exit.Exit<void, PlacementPeerLost>,
      ): Effect.Effect<void> =>
        Semaphore.withPermit(leaseState.lock)(
          Effect.gen(function* () {
            if (leaseState.retired) return

            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
              return
            }

            leaseState.peerLost = true

            const lostError = Exit.isFailure(exit)
              ? Cause.findErrorOption(exit.cause)
              : Option.none<PlacementPeerLost>()

            const active = leaseState.activeTurn

            if (active !== undefined && active.status === "running") {
              const reason = Option.isSome(lostError)
                ? lostError.value.message
                : "peer notice stream ended"

              yield* settleActiveTurn(
                leaseState,
                active,
                "failed",
                { reason: "peer_lost", message: reason },
                reason,
                {
                  kind: "turn_failed",
                  turnId: active.id,
                  code: "peer_lost",
                  message: reason,
                },
              )
            } else {
              leaseState.activityVersion += 1
              wakeWaiters(leaseState)
            }
          }),
        )

      const ensurePumpStarted = (leaseState: LeaseState): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (leaseState.pumpStarted) return false

          leaseState.pumpStarted = true

          // Obtain the notice stream BEFORE releasing the reservation lock and
          // BEFORE `lease.submit(...)` is invoked so fast racing notices are
          // captured in arrival order.
          const stream = leaseState.lease.notices()

          const pumpProgram = Effect.gen(function* () {
            const outcome = yield* Effect.exit(
              Stream.runForEach(stream, (notice) => handleNotice(leaseState, notice)),
            )

            yield* handlePumpEnded(leaseState, outcome)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (leaseState.pumpCustodyLease !== undefined) {
                  activePumps.delete(leaseState.pumpCustodyLease)
                }

                Deferred.doneUnsafe(leaseState.pumpDone, Effect.void)
              }),
            ),
          )

          const pumpLifetime = yield* custody.createLifetime(
            "turns-pump:" + leaseState.lease.leaseId,
          )

          const pumpScope = yield* Scope.make()

          const acquired = yield* custody
            .acquire({
              name: "turns-pump:" + leaseState.lease.leaseId,
              acquire: Effect.forkDetach(pumpProgram),
              dispose: (fiber) => Fiber.interrupt(fiber),
            })
            .pipe(Scope.provide(pumpScope), Effect.orDie)

          yield* custody.adopt(acquired, pumpLifetime).pipe(Effect.orDie)
          yield* Scope.close(pumpScope, Exit.void)

          activePumps.add(acquired)
          leaseState.pumpCustodyLease = acquired

          return true
        })

      // ---------------------------------------------------------------------
      // Public API
      // ---------------------------------------------------------------------

      const start: TurnsApi["start"] = (lease, prompt, grant) =>
        Effect.gen(function* () {
          if (retiredLeases.has(lease)) {
            return yield* Effect.fail(
              new SubmitRejected({
                message: "cannot start a turn on a retired lease",
                reason: "lease_retired",
              }),
            )
          }

          const leaseState = yield* getOrCreateLeaseState(lease)

          const reservation = yield* Semaphore.withPermit(leaseState.lock)(
            Effect.gen(function* () {
              if (leaseState.retired) {
                return yield* Effect.fail(
                  new SubmitRejected({
                    message: "cannot start a turn on a retired lease",
                    reason: "lease_retired",
                  }),
                )
              }

              if (leaseState.peerLost) {
                return yield* Effect.fail(
                  new SubmitRejected({
                    message: "cannot start a turn after the peer has exited",
                    reason: "peer_lost",
                  }),
                )
              }

              if (leaseState.activeTurn !== undefined) {
                return yield* Effect.fail(
                  new Busy({
                    message: "a turn is already active on this lease",
                  }),
                )
              }

              const decisionScope = yield* decisions.openScope()

              turnSequence += 1
              const id = "turn-" + String(turnSequence)
              const body: TurnRefBody = { [turnRefBrand]: true, id }

              // SAFETY: `turnRefBrand` is module-private; turn refs are minted
              // solely here.
              const ref = body as TurnRef

              const previousLatest = leaseState.latestTurn

              const turn: TurnRecord = {
                id,
                ref,
                leaseState,
                decisionScope,
                startedAtMs: Date.now(),
                workRef: undefined,
                submitting: true,
                status: "running",
                summary: undefined,
                textChunks: [],
                textStream: disclosure.scrubStream(),
                lastText: undefined,
                failureReason: undefined,
                finishedAtMs: undefined,
                activityCount: 0,
              }

              leaseState.activeTurn = turn
              leaseState.latestTurn = turn
              turnsById.set(id, turn)

              const justStartedPump = yield* ensurePumpStarted(leaseState)

              return { turn, previousLatest, justStartedPump }
            }),
          )

          if (reservation.justStartedPump) {
            yield* Effect.yieldNow
          }

          const { turn, previousLatest } = reservation
          const submitted = yield* Effect.exit(lease.submit(prompt.text, grant))

          if (Exit.isSuccess(submitted)) {
            const workRef = submitted.value

            yield* Semaphore.withPermit(leaseState.lock)(
              Effect.sync(() => {
                turn.workRef = workRef
                turn.submitting = false

                if (turn.status !== "running") {
                  recordSettledGeneration(leaseState, workRef)
                }

                leaseState.activityVersion += 1
                wakeWaiters(leaseState)
              }),
            )

            return turn.ref
          }

          const failure = Cause.findErrorOption(submitted.cause)

          if (Option.isSome(failure)) {
            const mapped = Match.value(failure.value).pipe(
              Match.when({ _tag: "PlacementRejected" }, (variant) => ({
                kind: "rejected" as const,
                error: new SubmitRejected({
                  message: variant.message,
                  reason: "rejected",
                }),
              })),
              Match.when({ _tag: "PlacementFacetUnsupported" }, (variant) => ({
                kind: "rejected" as const,
                error: new SubmitRejected({
                  message: variant.message,
                  reason: "facet_unsupported",
                }),
              })),
              Match.when({ _tag: "PlacementSubmissionUncertain" }, (variant) => ({
                kind: "uncertain" as const,
                error: new TurnSubmissionUncertain({
                  message: variant.message,
                }),
              })),
              Match.exhaustive,
            )

            if (mapped.kind === "rejected") {
              yield* Semaphore.withPermit(leaseState.lock)(
                Effect.gen(function* () {
                  turn.submitting = false
                  yield* decisions.retire(turn.decisionScope)

                  if (leaseState.activeTurn === turn) {
                    leaseState.activeTurn = undefined
                  }

                  if (leaseState.latestTurn === turn) {
                    leaseState.latestTurn = previousLatest
                  }

                  turnsById.delete(turn.id)
                  leaseState.activityVersion += 1
                  wakeWaiters(leaseState)
                }),
              )

              return yield* Effect.fail(mapped.error)
            }

            yield* Semaphore.withPermit(leaseState.lock)(
              Effect.gen(function* () {
                turn.submitting = false

                if (turn.status === "running") {
                  yield* settleActiveTurn(
                    leaseState,
                    turn,
                    "failed",
                    { reason: "submission_uncertain", message: mapped.error.message },
                    mapped.error.message,
                    {
                      kind: "turn_failed",
                      turnId: turn.id,
                      code: "submission_uncertain",
                      message: mapped.error.message,
                    },
                  )
                } else {
                  yield* decisions.retire(turn.decisionScope)

                  if (leaseState.activeTurn === turn) {
                    leaseState.activeTurn = undefined
                  }

                  leaseState.activityVersion += 1
                  wakeWaiters(leaseState)
                }
              }),
            )

            return yield* Effect.fail(mapped.error)
          }

          // Interruption or defect after attempting submission is treated as
          // uncertain: retire scope, settle if still running, never resubmit.
          yield* Semaphore.withPermit(leaseState.lock)(
            Effect.gen(function* () {
              turn.submitting = false

              if (turn.status === "running") {
                yield* settleActiveTurn(
                  leaseState,
                  turn,
                  "failed",
                  { reason: "submission_uncertain" },
                  "turn submission outcome could not be determined",
                  {
                    kind: "turn_failed",
                    turnId: turn.id,
                    code: "submission_uncertain",
                    message: "turn submission outcome could not be determined",
                  },
                )
              } else {
                yield* decisions.retire(turn.decisionScope)

                if (leaseState.activeTurn === turn) {
                  leaseState.activeTurn = undefined
                }
              }
            }),
          )

          return yield* Effect.fail(
            new TurnSubmissionUncertain({
              message: "turn submission outcome could not be determined",
            }),
          )
        })

      const lookupTurn = (turn: TurnRef): Effect.Effect<TurnRecord, TurnUnavailable> =>
        Effect.suspend(() => {
          const record = turnsById.get(readTurnRef(turn).id)

          if (record === undefined) {
            return Effect.fail(
              new TurnUnavailable({
                message: "the referenced turn is unknown",
              }),
            )
          }

          return Effect.succeed(record)
        })

      const inspect: TurnsApi["inspect"] = (turn) =>
        Effect.flatMap(lookupTurn(turn), (record) => snapshotTurn(record))

      const wait: TurnsApi["wait"] = (turn, until, waitMs) =>
        Effect.gen(function* () {
          const record = yield* lookupTurn(turn)
          const leaseState = record.leaseState

          const initial = yield* Semaphore.withPermit(leaseState.lock)(
            Effect.gen(function* () {
              const view = yield* buildTurnView(record)

              return { view, activity: record.activityCount }
            }),
          )

          if (waitMs <= 0 || isConditionMet(until, record, initial.view, initial.activity)) {
            return initial.view
          }

          const deadline = Date.now() + waitMs

          for (;;) {
            const remaining = deadline - Date.now()

            if (remaining <= 0) {
              return yield* snapshotTurn(record)
            }

            const signal = yield* Deferred.make<void>()

            const wake = (): void => {
              Deferred.doneUnsafe(signal, Effect.void)
            }

            const readyNow = yield* Semaphore.withPermit(leaseState.lock)(
              Effect.gen(function* () {
                const view = yield* buildTurnView(record)

                if (isConditionMet(until, record, view, initial.activity)) {
                  return view
                }

                leaseState.waiters.add(wake)

                return undefined
              }),
            )

            if (readyNow !== undefined) return readyNow

            yield* Effect.raceFirst(Deferred.await(signal), Effect.sleep(remaining)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  leaseState.waiters.delete(wake)
                }),
              ),
            )

            const afterWake = yield* Semaphore.withPermit(leaseState.lock)(
              Effect.gen(function* () {
                const view = yield* buildTurnView(record)

                if (isConditionMet(until, record, view, initial.activity)) {
                  return view
                }

                return undefined
              }),
            )

            if (afterWake !== undefined) return afterWake
          }
        })

      const observe: TurnsApi["observe"] = (turn, after, waitMs) =>
        Effect.gen(function* () {
          const record = yield* lookupTurn(turn)

          if (record.leaseState.retired) {
            return yield* Effect.fail(
              new TurnUnavailable({
                message: "the lease for this turn has been retired",
              }),
            )
          }

          return yield* observations.observe(record.leaseState.history, after, waitMs)
        })

      const decide: TurnsApi["decide"] = (turn, ref, choice, grant) =>
        Effect.gen(function* () {
          const record = turnsById.get(readTurnRef(turn).id)

          if (record === undefined) {
            return yield* Effect.fail(
              new StaleDecision({
                message: "the referenced turn is no longer active",
              }),
            )
          }

          if (grant.caller.id !== record.leaseState.lease.caller.id) {
            return yield* Effect.fail(
              new Denied({
                message: "the grant does not belong to this lease's caller",
                ceiling: grant.ceiling,
                reason: "foreign_grant",
              }),
            )
          }

          if (record.status !== "running" || record.leaseState.retired) {
            return yield* Effect.fail(
              new StaleDecision({
                message: "the turn is no longer accepting decisions",
              }),
            )
          }

          yield* decisions.answer(record.decisionScope, ref, choice, grant)

          yield* Semaphore.withPermit(record.leaseState.lock)(
            Effect.gen(function* () {
              yield* appendEvent(record.leaseState, {
                kind: "decision_answered",
                turnId: record.id,
                decisionId: decisionRefLabel(ref),
              })

              record.activityCount += 1
              record.leaseState.activityVersion += 1
              wakeWaiters(record.leaseState)
            }),
          )
        })

      const interrupt: TurnsApi["interrupt"] = (turn, grant) =>
        Effect.gen(function* () {
          const record = yield* lookupTurn(turn)
          const leaseState = record.leaseState

          const workRef = yield* Semaphore.withPermit(leaseState.lock)(
            Effect.gen(function* () {
              if (leaseState.retired || leaseState.peerLost) {
                return yield* Effect.fail(
                  new TurnUnavailable({
                    message: "the lease is no longer running",
                  }),
                )
              }

              if (record.status !== "running") {
                return yield* Effect.fail(
                  new TurnUnavailable({
                    message: "the turn is already settled",
                  }),
                )
              }

              if (record.workRef === undefined) {
                return yield* Effect.fail(
                  new TurnUnavailable({
                    message: "the turn submission has not yet been acknowledged",
                  }),
                )
              }

              return record.workRef
            }),
          )

          // Request interruption honestly without fabricating `"interrupted"`
          // status; status changes only when the peer reports TurnInterrupted.
          yield* leaseState.lease.interrupt(workRef, grant).pipe(
            Effect.mapError((failure) =>
              Match.value(failure).pipe(
                Match.when(
                  { _tag: "PlacementSubmissionUncertain" },
                  (variant) => new InterruptUncertain({ message: variant.message }),
                ),
                Match.when(
                  { _tag: "PlacementRejected" },
                  (variant) => new TurnUnavailable({ message: variant.message }),
                ),
                Match.when(
                  { _tag: "PlacementFacetUnsupported" },
                  (variant) => new TurnUnavailable({ message: variant.message }),
                ),
                Match.exhaustive,
              ),
            ),
          )
        })

      const observeLease: TurnsApi["observeLease"] = (lease, after, waitMs) =>
        Effect.gen(function* () {
          if (retiredLeases.has(lease)) {
            return yield* Effect.fail(
              new TurnUnavailable({
                message: "the lease has been retired",
              }),
            )
          }

          const leaseState = yield* getOrCreateLeaseState(lease)

          if (leaseState.retired) {
            return yield* Effect.fail(
              new TurnUnavailable({
                message: "the lease has been retired",
              }),
            )
          }

          return yield* observations.observe(leaseState.history, after, waitMs)
        })

      const latestTurn: TurnsApi["latestTurn"] = (lease) =>
        Effect.gen(function* () {
          const leaseState = leases.get(lease)

          if (leaseState === undefined) return undefined

          return yield* Semaphore.withPermit(leaseState.lock)(
            Effect.gen(function* () {
              const latest = leaseState.latestTurn

              if (latest === undefined) return undefined

              return yield* buildTurnView(latest)
            }),
          )
        })

      const retireLease: TurnsApi["retireLease"] = (lease) =>
        Effect.gen(function* () {
          retiredLeases.add(lease)

          const leaseState = leases.get(lease)

          if (leaseState === undefined) return

          const pumpToRelease = yield* Semaphore.withPermit(leaseState.lock)(
            Effect.gen(function* () {
              if (!leaseState.retired) {
                leaseState.retired = true

                const active = leaseState.activeTurn

                if (active !== undefined) {
                  if (active.status === "running") {
                    yield* settleActiveTurn(
                      leaseState,
                      active,
                      "failed",
                      { reason: "lease_retired" },
                      "lease retired",
                      {
                        kind: "turn_failed",
                        turnId: active.id,
                        code: "lease_retired",
                        message: "lease retired",
                      },
                    )
                  } else {
                    yield* decisions.retire(active.decisionScope)
                    leaseState.activeTurn = undefined
                  }
                }

                yield* observations.close(leaseState.history)
                leaseState.activityVersion += 1
                wakeWaiters(leaseState)
              }

              return leaseState.pumpCustodyLease
            }),
          )

          if (pumpToRelease !== undefined) {
            activePumps.delete(pumpToRelease)
            yield* Effect.orElseSucceed(custody.release(pumpToRelease), () => undefined)
            yield* Deferred.await(leaseState.pumpDone)
          }
        })

      return {
        start,
        inspect,
        wait,
        observe,
        decide,
        interrupt,
        observeLease,
        latestTurn,
        retireLease,
      }
    }),
  )
