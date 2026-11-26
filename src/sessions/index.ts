/**
 * Level 6 `sessions` module: public session references, per-caller directory
 * visibility, caller-filtered change subscriptions, one-shot turn retention
 * and typed bound session operations.
 *
 * Invariants:
 * - Default per-caller isolation (`sharedSessions = false`): ONLY the owning
 *   caller can list, resolve, read, submit, answer, modify, close or watch a
 *   session. Foreign references produce the exact same `NotVisible` failure as
 *   missing ones, never leaking session existence.
 * - Explicit `--shared-sessions` opt-in (`sharedSessions = true`) shares only
 *   session directory visibility across admitted callers; guidance receipts,
 *   artifacts and authority grants remain strictly caller/conversation-scoped.
 * - Every public `SessionRef` carries a fresh module-minted identifier, never
 *   a provider session id and never a caller digest. Possession of a ref or id
 *   confers zero access without `resolve` / `resolveId`.
 * - `ScopedSession` narrows each resolved handle to the exact requested right
 *   (`read`, `submit`, `answer` or `admin`) and re-checks visibility on every
 *   method call.
 * - Direct methods (`create`, `runOnce`) enforce the exact same caller,
 *   guidance, delegation and authority ceiling gates as the bound operations.
 * - Ownership and `Custody` lifetime are bound BEFORE directory publication;
 *   any open or adoption failure cleans up all acquired resources without
 *   leaking directory entries.
 * - `close` atomically revokes lookup first, emits the caller-filtered
 *   `Closed` change event, retires turns and drains the session's custody
 *   lifetime cleanly.
 * - `runOnce` closes on terminal completion or external interruption and keeps
 *   the session alive and addressable by its owner when still running.
 */
import { randomUUID } from "node:crypto"

import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as PubSub from "effect/PubSub"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

import { Authority, autonomyWithinCap, Evidence } from "../authority/index.ts"
import type { AutonomyLevel, Demand, Grant } from "../authority/index.ts"
import { AdmissionRefused, Callers, sameCaller } from "../caller/index.ts"
import type { AccessRight, Caller, TargetRef } from "../caller/index.ts"
import { Capabilities } from "../capabilities/index.ts"
import type { BoundOperation } from "../capabilities/index.ts"
import { Custody } from "../custody/index.ts"
import type { Lifetime } from "../custody/index.ts"
import { decisionRefLabel } from "../decisions/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance } from "../guidance/index.ts"
import { positionOffset } from "../observations/index.ts"
import type { Position } from "../observations/index.ts"
import { OpenFailed, Placement, RunIntent } from "../placement/index.ts"
import type { Facet, PlacementSettingsView, RunningLease } from "../placement/index.ts"
import { Turns } from "../turns/index.ts"
import type { TurnRef } from "../turns/index.ts"
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "./private/codecs.ts"
import { buildSessionOperations } from "./private/operations.ts"
import {
  buildSessionRef,
  CloseFailed,
  NotVisible,
  RunFailed,
  ScopedSession,
  SessionChange,
  SessionIntent,
  SessionOperationFailed,
  SessionRefused,
  sessionRefId,
} from "./private/types.ts"
import type {
  AdminScopedSession,
  AnswerScopedSession,
  OffsetObservationPage,
  OneShotDelivery,
  OneShotIntent,
  ReadScopedSession,
  RunView,
  ScopedSessionFor,
  SessionInteractionMode,
  SessionOperationErrorCode,
  SessionReasoningEffort,
  SessionRef,
  SessionRight,
  SessionSettings,
  SessionsApi,
  SessionsOptions,
  SessionStatus,
  SessionSummary,
  SessionWorkspaceIntent,
  SessionWorktreeView,
  SubmitScopedSession,
} from "./private/types.ts"

export {
  CloseFailed,
  NotVisible,
  RunFailed,
  ScopedSession,
  SessionChange,
  SessionIntent,
  SessionOperationFailed,
  SessionRefused,
  sessionRefId,
}

export type {
  AdminScopedSession,
  AnswerScopedSession,
  OffsetObservationPage,
  OneShotDelivery,
  OneShotIntent,
  ReadScopedSession,
  RunView,
  ScopedSessionFor,
  SessionInteractionMode,
  SessionOperationErrorCode,
  SessionReasoningEffort,
  SessionRef,
  SessionRight,
  SessionSettings,
  SessionsApi,
  SessionsOptions,
  SessionStatus,
  SessionSummary,
  SessionWorkspaceIntent,
  SessionWorktreeView,
  SubmitScopedSession,
}

export class Sessions extends Context.Service<Sessions, SessionsApi>()("droid-mcp/sessions") {}

// ---------------------------------------------------------------------------
// Internal state & helpers
// ---------------------------------------------------------------------------

const MAX_CACHED_POSITIONS = 256
const DEFAULT_REQUIRED_FACETS: ReadonlyArray<Facet> = ["submit", "observe"]

interface SessionRecord {
  readonly id: string
  readonly ref: SessionRef
  readonly owner: Caller
  readonly lease: RunningLease
  readonly lifetime: Lifetime
  readonly createdAtMs: number
  readonly positions: Map<number, Position>
  settings: PlacementSettingsView | undefined
  latestTurnRef: TurnRef | undefined
  lastCursor: number
  closeDone: Deferred.Deferred<void> | undefined
}

interface ChangeEnvelope {
  readonly owner: Caller
  readonly change: SessionChange
}

const notVisible = (sessionId: string): NotVisible =>
  new NotVisible({
    message: "session is not visible to this caller",
    sessionId,
  })

const accessRightFor = (right: SessionRight): AccessRight =>
  Match.value(right).pipe(
    Match.when("read", () => "read" as const),
    Match.when("submit", () => "write" as const),
    Match.when("answer", () => "answer" as const),
    Match.when("admin", () => "admin" as const),
    Match.exhaustive,
  )

const minAutonomy = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel =>
  autonomyWithinCap(a, b) ? a : b

const workspacePathOf = (workspace: SessionWorkspaceIntent): string =>
  workspace.kind === "borrowed" ? workspace.path : workspace.repoPath

const worktreeViewOf = (lease: RunningLease): SessionWorktreeView | undefined => {
  const ws = lease.workspace

  if (ws === undefined || !ws.isolated || ws.ownership === "borrowed") return undefined

  const lifecycle: "ephemeral" | "persistent" = ws.ownership

  return {
    path: ws.location,
    acquiredPath: ws.acquiredPath,
    lifecycle,
    branch: ws.branch,
  }
}

const rememberPosition = (record: SessionRecord, position: Position): number => {
  const offset = positionOffset(position)

  record.positions.delete(offset)
  record.positions.set(offset, position)

  if (offset > record.lastCursor) record.lastCursor = offset

  while (record.positions.size > MAX_CACHED_POSITIONS) {
    const oldest = record.positions.keys().next()

    if (oldest.done) break

    record.positions.delete(oldest.value)
  }

  return offset
}

const validateCaller = (caller: Caller): Effect.Effect<void, AdmissionRefused> =>
  String(caller.id).trim().length > 0
    ? Effect.void
    : Effect.fail(
        new AdmissionRefused({
          message: "caller identity is invalid",
          reason: "invalid_caller",
        }),
      )

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const sessionsLayer = (
  options?: SessionsOptions,
): Layer.Layer<
  Sessions,
  never,
  Turns | Placement | Callers | Authority | Custody | Capabilities | Guidance
> =>
  Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const turns = yield* Turns
      const placement = yield* Placement
      const callers = yield* Callers
      const authority = yield* Authority
      const custody = yield* Custody
      const capabilities = yield* Capabilities
      const guidance = yield* Guidance

      const sharedSessions = options?.sharedSessions ?? false
      const guidanceRequired = options?.guidanceRequired ?? true
      const defaultWaitMs = options?.defaultWaitMs ?? DEFAULT_WAIT_MS

      const sessionsById = new Map<string, SessionRecord>()
      const changeBus = yield* PubSub.unbounded<ChangeEnvelope>()
      let finalizing = false

      const isOpen = (record: SessionRecord): boolean =>
        !finalizing && record.closeDone === undefined

      const isVisibleTo = (record: SessionRecord, caller: Caller): boolean =>
        isOpen(record) && (sharedSessions || sameCaller(record.owner, caller))

      const emitChange = (owner: Caller, change: SessionChange): void => {
        PubSub.publishUnsafe(changeBus, { owner, change })
      }

      const buildSummary = (record: SessionRecord): Effect.Effect<SessionSummary> =>
        Effect.map(turns.latestTurn(record.lease), (turnView): SessionSummary => {
          const status: SessionStatus = turnView === undefined ? "idle" : turnView.status
          const worktree = worktreeViewOf(record.lease)

          const base: SessionSummary = {
            ref: record.ref,
            sessionId: record.id,
            cwd: record.lease.workspace?.location,
            status,
            cursor: record.lastCursor,
            settings: record.settings,
            facets: placement.facets(record.lease),
            createdAtMs: record.createdAtMs,
          }

          return worktree !== undefined ? { ...base, worktree } : base
        })

      const emitUpdated = (record: SessionRecord): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!isOpen(record)) return

          const summary = yield* buildSummary(record)

          if (isOpen(record)) {
            emitChange(record.owner, SessionChange.Updated({ summary }))
          }
        })

      const checkVisible = (
        caller: Caller,
        sessionId: string,
        right: SessionRight,
      ): Effect.Effect<SessionRecord, NotVisible> =>
        Effect.gen(function* () {
          const record = sessionsById.get(sessionId)

          if (record === undefined || !isVisibleTo(record, caller)) {
            return yield* Effect.fail(notVisible(sessionId))
          }

          if (!sharedSessions) {
            yield* callers
              .access(caller, { kind: "session", id: record.id }, accessRightFor(right))
              .pipe(Effect.mapError(() => notVisible(sessionId)))
          }

          return record
        })

      /**
       * Validates that `grant` belongs to `caller` and produces a grant
       * accepted by `record.lease` without ever widening authority. Under
       * default per-caller isolation (`sharedSessions = false`), `caller` is
       * always `record.owner` and `grant` is returned unchanged. Under
       * `--shared-sessions`, another caller's own grant is narrowed against
       * the lease's ceiling and bound to `record.owner` for lower layers.
       */
      const resolveLeaseGrant = (
        caller: Caller,
        record: SessionRecord,
        grant: Grant,
      ): Effect.Effect<Grant, SessionOperationFailed> => {
        if (!sameCaller(grant.caller, caller)) {
          return Effect.fail(
            new SessionOperationFailed({
              code: "denied",
              reason: "foreign_grant",
              message: "the grant does not belong to this caller",
            }),
          )
        }

        if (sameCaller(record.owner, caller)) {
          return Effect.succeed(grant)
        }

        const boundedCeiling = minAutonomy(grant.ceiling, record.lease.grant.ceiling)
        const boundedLevel = minAutonomy(grant.effectiveLevel, boundedCeiling)
        const boundedSkip = grant.skipPermissionsUnsafe && record.lease.grant.skipPermissionsUnsafe

        return authority
          .decide(
            record.owner,
            record.lease.grant.target,
            {
              effect: grant.effect,
              requestedLevel: boundedLevel,
              skipPermissionsUnsafe: boundedSkip,
            },
            Evidence.Explicit({
              ceiling: boundedCeiling,
              requestedLevel: boundedLevel,
              skipPermissionsUnsafe: boundedSkip,
            }),
          )
          .pipe(
            Effect.mapError(
              (failure) =>
                new SessionOperationFailed({
                  code: "denied",
                  reason: failure.reason,
                  message: failure.message,
                }),
            ),
          )
      }

      // -------------------------------------------------------------------
      // Close
      // -------------------------------------------------------------------

      const teardownRecord = (record: SessionRecord): Effect.Effect<void, CloseFailed> =>
        Effect.gen(function* () {
          yield* Effect.ignore(callers.revoke(record.owner, { kind: "session", id: record.id }))
          yield* turns.retireLease(record.lease)

          yield* custody.drain(record.lifetime).pipe(
            Effect.mapError(
              (err) =>
                new CloseFailed({
                  message: err.message,
                  sessionId: record.id,
                  reason: err.reason,
                }),
            ),
            Effect.ensuring(Effect.ignore(record.lease.release())),
          )
        })

      const closeRecord = (record: SessionRecord): Effect.Effect<void, CloseFailed> =>
        Effect.suspend(() => {
          // Keep the record invisible but tracked so layer shutdown can join teardown.
          if (record.closeDone !== undefined) return Deferred.await(record.closeDone)

          const done = Deferred.makeUnsafe<void>()

          record.closeDone = done
          emitChange(record.owner, SessionChange.Closed({ ref: record.ref, sessionId: record.id }))

          return teardownRecord(record).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                sessionsById.delete(record.id)
              }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
            ),
          )
        }).pipe(Effect.uninterruptible)

      const closeById = (
        caller: Caller,
        sessionId: string,
      ): Effect.Effect<void, NotVisible | CloseFailed> =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const record = yield* checkVisible(caller, sessionId, "admin")

            if (!isOpen(record)) {
              return yield* Effect.fail(notVisible(sessionId))
            }

            return yield* closeRecord(record)
          }),
        )

      const close: SessionsApi["close"] = (caller, ref) => closeById(caller, sessionRefId(ref))

      // -------------------------------------------------------------------
      // Scoped session builders
      // -------------------------------------------------------------------

      const observePosition = (
        caller: Caller,
        record: SessionRecord,
        right: "read" | "submit",
        after: Position | null,
        waitMs: number,
      ) =>
        Effect.gen(function* () {
          yield* checkVisible(caller, record.id, right)

          const page = yield* turns.observeLease(record.lease, after, waitMs).pipe(
            Effect.catchTag("TurnUnavailable", (err) =>
              Effect.fail(
                new SessionOperationFailed({
                  code: "turn_unavailable",
                  message: err.message,
                }),
              ),
            ),
          )

          rememberPosition(record, page.resume)

          return page
        })

      const observeAtOffset = (
        caller: Caller,
        record: SessionRecord,
        offset: number,
        waitMs: number,
      ): Effect.Effect<OffsetObservationPage, NotVisible | SessionOperationFailed> =>
        Effect.gen(function* () {
          yield* checkVisible(caller, record.id, "read")

          if (!Number.isInteger(offset) || offset < 0) {
            return yield* Effect.fail(
              new SessionOperationFailed({
                code: "invalid_cursor",
                message: "cursor must be a non-negative integer",
              }),
            )
          }

          const mapObserveError = <A>(
            effect: Effect.Effect<
              A,
              | { readonly _tag: "TurnUnavailable"; readonly message: string }
              | { readonly _tag: "InvalidPosition"; readonly message: string }
            >,
          ): Effect.Effect<A, SessionOperationFailed> =>
            Effect.mapError(effect, (err) =>
              Match.value(err).pipe(
                Match.when(
                  { _tag: "TurnUnavailable" },
                  (variant) =>
                    new SessionOperationFailed({
                      code: "turn_unavailable",
                      message: variant.message,
                    }),
                ),
                Match.when(
                  { _tag: "InvalidPosition" },
                  (variant) =>
                    new SessionOperationFailed({
                      code: "invalid_cursor",
                      message: variant.message,
                    }),
                ),
                Match.exhaustive,
              ),
            )

          if (offset === 0) {
            const page = yield* mapObserveError(turns.observeLease(record.lease, null, waitMs))
            const cursor = rememberPosition(record, page.resume)

            return {
              items: page.items,
              cursor,
              resume: page.resume,
              gap: page.gap,
              omittedCount: page.omittedCount,
            }
          }

          const saved = record.positions.get(offset)

          if (saved !== undefined) {
            const page = yield* mapObserveError(turns.observeLease(record.lease, saved, waitMs))
            const cursor = rememberPosition(record, page.resume)

            return {
              items: page.items,
              cursor,
              resume: page.resume,
              gap: page.gap,
              omittedCount: page.omittedCount,
            }
          }

          // Uncached positive offset: inspect current retained window.
          const full = yield* mapObserveError(turns.observeLease(record.lease, null, 0))
          const head = rememberPosition(record, full.resume)
          const firstRetained = head - full.items.length

          if (offset > head) {
            return yield* Effect.fail(
              new SessionOperationFailed({
                code: "invalid_cursor",
                message: "cursor offset is beyond the current session history",
              }),
            )
          }

          if (offset < firstRetained) {
            return {
              items: full.items,
              cursor: head,
              resume: full.resume,
              gap: true,
              omittedCount: firstRetained - offset,
            }
          }

          if (offset === head) {
            if (waitMs > 0) {
              const waited = yield* mapObserveError(
                turns.observeLease(record.lease, full.resume, waitMs),
              )

              const nextCursor = rememberPosition(record, waited.resume)

              return {
                items: waited.items,
                cursor: nextCursor,
                resume: waited.resume,
                gap: waited.gap,
                omittedCount: waited.omittedCount,
              }
            }

            return {
              items: [],
              cursor: head,
              resume: full.resume,
              gap: false,
              omittedCount: 0,
            }
          }

          const sliceStart = offset - firstRetained

          return {
            items: full.items.slice(sliceStart),
            cursor: head,
            resume: full.resume,
            gap: false,
            omittedCount: 0,
          }
        })

      const waitOnSession = (
        caller: Caller,
        record: SessionRecord,
        right: "read" | "submit",
        until: "terminal" | "decision_or_terminal" | "activity",
        waitMs: number,
      ) =>
        Effect.gen(function* () {
          yield* checkVisible(caller, record.id, right)

          const turnRef = record.latestTurnRef

          if (turnRef === undefined) return undefined

          return yield* turns.wait(turnRef, until, waitMs).pipe(
            Effect.mapError(
              (err) =>
                new SessionOperationFailed({
                  code: "turn_unavailable",
                  message: err.message,
                }),
            ),
          )
        })

      const buildReadScoped = (caller: Caller, record: SessionRecord): ReadScopedSession =>
        ScopedSession.Read({
          right: "read",
          ref: record.ref,
          sessionId: record.id,
          summary: () =>
            Effect.flatMap(checkVisible(caller, record.id, "read"), () => buildSummary(record)),
          inspect: () =>
            Effect.flatMap(checkVisible(caller, record.id, "read"), () =>
              turns.latestTurn(record.lease),
            ),
          observe: (after, waitMs) => observePosition(caller, record, "read", after, waitMs),
          observeAtOffset: (offset, waitMs) => observeAtOffset(caller, record, offset, waitMs),
          wait: (until, waitMs) => waitOnSession(caller, record, "read", until, waitMs),
          listModels: () =>
            Effect.gen(function* () {
              yield* checkVisible(caller, record.id, "read")

              return yield* record.lease.listModels().pipe(
                Effect.mapError((err) =>
                  Match.value(err).pipe(
                    Match.when(
                      { _tag: "PlacementFacetUnsupported" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "facet_unsupported",
                          message: variant.message,
                        }),
                    ),
                    Match.when(
                      { _tag: "PlacementRejected" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "rejected",
                          message: variant.message,
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              )
            }),
          facets: () => placement.facets(record.lease),
        })

      const buildSubmitScoped = (caller: Caller, record: SessionRecord): SubmitScopedSession =>
        ScopedSession.Submit({
          right: "submit",
          ref: record.ref,
          sessionId: record.id,
          submit: (input, grant) =>
            Effect.gen(function* () {
              yield* checkVisible(caller, record.id, "submit")

              const leaseGrant = yield* resolveLeaseGrant(caller, record, grant)

              const turnRef = yield* turns.start(record.lease, input, leaseGrant).pipe(
                Effect.mapError((err) =>
                  Match.value(err).pipe(
                    Match.when(
                      { _tag: "Busy" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "busy",
                          message: variant.message,
                        }),
                    ),
                    Match.when(
                      { _tag: "SubmitRejected" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "submit_rejected",
                          message: variant.message,
                          reason: variant.reason,
                        }),
                    ),
                    Match.when(
                      { _tag: "TurnSubmissionUncertain" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "submission_uncertain",
                          message: variant.message,
                          uncertain: true,
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              )

              record.latestTurnRef = turnRef
              yield* emitUpdated(record)

              return turnRef
            }),
          interrupt: (grant) =>
            Effect.gen(function* () {
              yield* checkVisible(caller, record.id, "submit")

              const leaseGrant = yield* resolveLeaseGrant(caller, record, grant)
              const turnRef = record.latestTurnRef

              if (turnRef === undefined) {
                return yield* Effect.fail(
                  new SessionOperationFailed({
                    code: "turn_unavailable",
                    message: "there is no active turn to interrupt",
                  }),
                )
              }

              yield* turns.interrupt(turnRef, leaseGrant).pipe(
                Effect.mapError((err) =>
                  Match.value(err).pipe(
                    Match.when(
                      { _tag: "TurnUnavailable" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "turn_unavailable",
                          message: variant.message,
                        }),
                    ),
                    Match.when(
                      { _tag: "InterruptUncertain" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "interrupt_uncertain",
                          message: variant.message,
                          uncertain: true,
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              )

              yield* emitUpdated(record)
            }),
          summary: () =>
            Effect.flatMap(checkVisible(caller, record.id, "submit"), () => buildSummary(record)),
          inspect: () =>
            Effect.flatMap(checkVisible(caller, record.id, "submit"), () =>
              turns.latestTurn(record.lease),
            ),
          observe: (after, waitMs) => observePosition(caller, record, "submit", after, waitMs),
          wait: (until, waitMs) => waitOnSession(caller, record, "submit", until, waitMs),
        })

      const buildAnswerScoped = (caller: Caller, record: SessionRecord): AnswerScopedSession => {
        const decide: AnswerScopedSession["decide"] = (decisionRef, choice, grant) =>
          Effect.gen(function* () {
            yield* checkVisible(caller, record.id, "answer")

            const leaseGrant = yield* resolveLeaseGrant(caller, record, grant)
            const turnRef = record.latestTurnRef

            if (turnRef === undefined) {
              return yield* Effect.fail(
                new SessionOperationFailed({
                  code: "stale_decision",
                  message: "no active turn is accepting decisions on this session",
                }),
              )
            }

            yield* turns.decide(turnRef, decisionRef, choice, leaseGrant).pipe(
              Effect.mapError((err) =>
                Match.value(err).pipe(
                  Match.when(
                    { _tag: "InvalidChoice" },
                    (variant) =>
                      new SessionOperationFailed({
                        code: "invalid_choice",
                        reason: variant.reason,
                        message: variant.message,
                      }),
                  ),
                  Match.when(
                    { _tag: "Denied" },
                    (variant) =>
                      new SessionOperationFailed({
                        code: "denied",
                        reason: variant.reason,
                        message: variant.message,
                      }),
                  ),
                  Match.when(
                    { _tag: "StaleDecision" },
                    (variant) =>
                      new SessionOperationFailed({
                        code: "stale_decision",
                        message: variant.message,
                      }),
                  ),
                  Match.when(
                    { _tag: "ReplyUncertain" },
                    (variant) =>
                      new SessionOperationFailed({
                        code: "reply_uncertain",
                        reason: variant.delivery,
                        uncertain: variant.delivery === "uncertain",
                        message: variant.message,
                      }),
                  ),
                  Match.exhaustive,
                ),
              ),
            )

            yield* emitUpdated(record)
          })

        const outstandingDecisions: AnswerScopedSession["outstandingDecisions"] = () =>
          Effect.flatMap(checkVisible(caller, record.id, "answer"), () =>
            Effect.map(turns.latestTurn(record.lease), (turnView) =>
              turnView === undefined ? [] : turnView.outstandingDecisions,
            ),
          )

        const decideByLabel: AnswerScopedSession["decideByLabel"] = (decisionId, choice, grant) =>
          Effect.gen(function* () {
            const pending = yield* outstandingDecisions()
            const matched = pending.find((view) => decisionRefLabel(view.ref) === decisionId)

            if (matched === undefined) {
              return yield* Effect.fail(
                new SessionOperationFailed({
                  code: "stale_decision",
                  message:
                    "that decision is no longer outstanding; read session_events for the current state",
                }),
              )
            }

            return yield* decide(matched.ref, choice, grant)
          })

        return ScopedSession.Answer({
          right: "answer",
          ref: record.ref,
          sessionId: record.id,
          decide,
          decideByLabel,
          outstandingDecisions,
        })
      }

      const buildAdminScoped = (caller: Caller, record: SessionRecord): AdminScopedSession =>
        ScopedSession.Admin({
          right: "admin",
          ref: record.ref,
          sessionId: record.id,
          updateSettings: (patch, grant) =>
            Effect.gen(function* () {
              yield* checkVisible(caller, record.id, "admin")

              if (
                patch.autonomyLevel !== undefined &&
                !authority.allows(grant, { level: patch.autonomyLevel })
              ) {
                return yield* Effect.fail(
                  new SessionOperationFailed({
                    code: "denied",
                    reason: "requested_level_exceeds_grant",
                    message: "requested autonomy exceeds the grant",
                  }),
                )
              }

              const leaseGrant = yield* resolveLeaseGrant(caller, record, grant)

              const updated = yield* record.lease.updateSettings(patch, leaseGrant).pipe(
                Effect.mapError((err) =>
                  Match.value(err).pipe(
                    Match.when(
                      { _tag: "PlacementFacetUnsupported" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "facet_unsupported",
                          message: variant.message,
                        }),
                    ),
                    Match.when(
                      { _tag: "PlacementSubmissionUncertain" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "submission_uncertain",
                          uncertain: true,
                          message: variant.message,
                        }),
                    ),
                    Match.when(
                      { _tag: "PlacementRejected" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "rejected",
                          message: variant.message,
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              )

              record.settings = updated
              yield* emitUpdated(record)

              return updated
            }),
          fork: (request, grant) =>
            Effect.gen(function* () {
              yield* checkVisible(caller, record.id, "admin")

              const leaseGrant = yield* resolveLeaseGrant(caller, record, grant)

              return yield* record.lease.fork(request, leaseGrant).pipe(
                Effect.mapError((err) =>
                  Match.value(err).pipe(
                    Match.when(
                      { _tag: "PlacementFacetUnsupported" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "facet_unsupported",
                          message: variant.message,
                        }),
                    ),
                    Match.when(
                      { _tag: "PlacementSubmissionUncertain" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "submission_uncertain",
                          uncertain: true,
                          message: variant.message,
                        }),
                    ),
                    Match.when(
                      { _tag: "PlacementRejected" },
                      (variant) =>
                        new SessionOperationFailed({
                          code: "rejected",
                          message: variant.message,
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              )
            }),
          close: () => closeById(caller, record.id),
        })

      const buildScopedFor = (
        caller: Caller,
        record: SessionRecord,
        right: SessionRight,
      ): ScopedSession =>
        Match.value(right).pipe(
          Match.when("read", () => buildReadScoped(caller, record)),
          Match.when("submit", () => buildSubmitScoped(caller, record)),
          Match.when("answer", () => buildAnswerScoped(caller, record)),
          Match.when("admin", () => buildAdminScoped(caller, record)),
          Match.exhaustive,
        )

      // -------------------------------------------------------------------
      // Public API methods
      // -------------------------------------------------------------------

      const resolveId: SessionsApi["resolveId"] = <R extends SessionRight>(
        caller: Caller,
        id: string,
        right: R,
      ): Effect.Effect<ScopedSessionFor<R>, NotVisible> =>
        Effect.map(checkVisible(caller, id, right), (record) => {
          const scoped = buildScopedFor(caller, record, right)

          // SAFETY: `buildScopedFor` constructs the exact `ScopedSession`
          // variant whose `right` field equals `right`, matching `ScopedSessionFor<R>`.
          return scoped as ScopedSessionFor<R>
        })

      const resolve: SessionsApi["resolve"] = (caller, ref, right) =>
        resolveId(caller, sessionRefId(ref), right)

      const listVisible: SessionsApi["listVisible"] = (caller) =>
        Effect.gen(function* () {
          yield* validateCaller(caller)

          const visible: Array<SessionRecord> = []

          for (const record of sessionsById.values()) {
            if (isVisibleTo(record, caller)) visible.push(record)
          }

          const summaries: Array<SessionSummary> = []

          for (const record of visible) {
            if (isOpen(record)) summaries.push(yield* buildSummary(record))
          }

          return summaries
        })

      const watchVisible: SessionsApi["watchVisible"] = (caller) =>
        Stream.unwrap(
          Effect.map(validateCaller(caller), () =>
            Stream.fromPubSub(changeBus).pipe(
              Stream.filter((envelope) => sharedSessions || sameCaller(envelope.owner, caller)),
              Stream.map((envelope) => envelope.change),
            ),
          ),
        )

      const create: SessionsApi["create"] = (who, intent) =>
        Effect.gen(function* () {
          // 1. Validate caller & conversation binding
          if (
            String(who.caller.id).trim().length === 0 ||
            !sameCaller(who.caller, who.conversation.caller)
          ) {
            return yield* Effect.fail(
              new SessionRefused({
                message: "invocation caller does not match conversation owner",
                reason: "caller_mismatch",
              }),
            )
          }

          // 2. Enforce guidance prerequisite (identical to bound entries)
          if (guidanceRequired) {
            yield* guidance.check(who.conversation, { edition: CURRENT_GUIDE_EDITION }).pipe(
              Effect.mapError(
                (err) =>
                  new SessionRefused({
                    message: err.message,
                    reason: "guidance_required",
                    edition: err.edition,
                  }),
              ),
            )
          }

          // 3. Determine target, demand, required facets and placement RunIntent
          const plan = SessionIntent.$match(intent, {
            Local: (variant) => {
              const target: TargetRef = { kind: "local", id: workspacePathOf(variant.workspace) }

              const demand: Demand = {
                effect: "execute",
                requestedLevel: variant.settings.autonomyLevel,
                operation: "session_create",
              }

              const evidence = Evidence.Explicit({
                ceiling: authority.ceiling(),
                requestedLevel: variant.settings.autonomyLevel,
              })

              const runIntent = RunIntent.Local({
                workspace: variant.workspace,
                settings: variant.settings,
              })

              const requiredFacets = variant.requiredFacets ?? DEFAULT_REQUIRED_FACETS

              return { target, demand, evidence, runIntent, requiredFacets }
            },
            Remote: (variant) => {
              const kind: "daemon" | "hosted" =
                variant.targetKind ?? (variant.provider === "daemon" ? "daemon" : "hosted")

              const target: TargetRef = { kind, id: variant.provider }

              const demand: Demand =
                variant.autonomyLevel !== undefined
                  ? {
                      effect: "execute",
                      requestedLevel: variant.autonomyLevel,
                      operation: "session_create",
                    }
                  : {
                      effect: "execute",
                      operation: "session_create",
                    }

              const evidence = Evidence.Explicit(
                variant.autonomyLevel !== undefined
                  ? {
                      ceiling: authority.ceiling(),
                      requestedLevel: variant.autonomyLevel,
                    }
                  : {
                      ceiling: authority.ceiling(),
                    },
              )

              const runIntent = RunIntent.Remote({
                provider: variant.provider,
                adapter: variant.adapter,
              })

              const requiredFacets = variant.requiredFacets ?? DEFAULT_REQUIRED_FACETS

              return { target, demand, evidence, runIntent, requiredFacets }
            },
          })

          // 4. Enforce target delegation
          yield* callers.delegate(who.caller, plan.target).pipe(
            Effect.mapError(
              (err) =>
                new SessionRefused({
                  message: err.message,
                  reason: "delegation_unavailable",
                }),
            ),
          )

          // 5. Enforce authority ceiling BEFORE calling placement.open
          const grant = yield* authority
            .decide(who.caller, plan.target, plan.demand, plan.evidence)
            .pipe(
              Effect.mapError((err) =>
                Match.value(err).pipe(
                  Match.when({ _tag: "Denied" }, (variant) =>
                    variant.requestedLevel !== undefined
                      ? new SessionRefused({
                          message: variant.message,
                          reason: variant.reason,
                          ceiling: variant.ceiling,
                          requestedLevel: variant.requestedLevel,
                        })
                      : new SessionRefused({
                          message: variant.message,
                          reason: variant.reason,
                          ceiling: variant.ceiling,
                        }),
                  ),
                  Match.when(
                    { _tag: "authority_unverifiable" },
                    (variant) =>
                      new SessionRefused({
                        message: variant.message,
                        reason: "authority_unverifiable",
                      }),
                  ),
                  Match.exhaustive,
                ),
              ),
            )

          // 6. Bind ownership and custody lifetime BEFORE publication.
          //    Any failure before publication drains all acquired resources.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const id = "sess-" + randomUUID()
              const ref = buildSessionRef(id)
              const lifetime = yield* custody.createLifetime("session:" + id)

              yield* callers.own(who.caller, { kind: "session", id }).pipe(
                Effect.mapError(
                  (err) =>
                    new SessionRefused({
                      message: err.message,
                      reason: "ownership_conflict",
                    }),
                ),
              )

              const provisionalScope = yield* Scope.make()
              let adopted = false
              let openedLease: RunningLease | undefined

              const rollback = Effect.gen(function* () {
                if (openedLease !== undefined) {
                  yield* Effect.ignore(turns.retireLease(openedLease))
                  yield* Effect.ignore(openedLease.release())
                }

                yield* Effect.ignore(custody.drain(lifetime))
                yield* Effect.ignore(Scope.close(provisionalScope, Exit.void))
                yield* Effect.ignore(callers.revoke(who.caller, { kind: "session", id }))
              })

              const opened = yield* restore(
                Scope.provide(provisionalScope)(
                  placement.open(who.caller, plan.runIntent, grant, plan.requiredFacets),
                ),
              ).pipe(
                Effect.mapError((err) =>
                  Match.value(err).pipe(
                    Match.when(
                      { _tag: "NoEligibleProvider" },
                      (variant) =>
                        new SessionRefused({
                          message: variant.message,
                          reason: "no_eligible_provider",
                        }),
                    ),
                    Match.when({ _tag: "OpenFailed" }, (variant) => variant),
                    Match.exhaustive,
                  ),
                ),
                Effect.onError(() => rollback),
              )

              openedLease = opened

              yield* opened.adopt(lifetime).pipe(
                Effect.mapError(
                  (err) =>
                    new OpenFailed({
                      message: err.message,
                      reason: "adopt_failed",
                    }),
                ),
                Effect.onError(() => rollback),
              )

              adopted = true

              // Provisional scope can close now that the lease is adopted into
              // the session's dedicated custody lifetime.
              yield* Scope.close(provisionalScope, Exit.void)

              if (!adopted) {
                yield* rollback

                return yield* Effect.fail(
                  new OpenFailed({
                    message: "session lease was not adopted",
                    reason: "adopt_failed",
                  }),
                )
              }

              const record: SessionRecord = {
                id,
                ref,
                owner: who.caller,
                lease: opened,
                lifetime,
                createdAtMs: Date.now(),
                positions: new Map(),
                settings: opened.settingsSnapshot,
                latestTurnRef: undefined,
                lastCursor: 0,
                closeDone: undefined,
              }

              sessionsById.set(id, record)

              const summary = yield* buildSummary(record)

              emitChange(who.caller, SessionChange.Created({ summary }))

              return ref
            }),
          )
        })

      const runOnce: SessionsApi["runOnce"] = (who, intent) =>
        Effect.acquireUseRelease(
          create(who, intent.session).pipe(
            Effect.catchTag("OpenFailed", (failure) =>
              Effect.fail(
                new RunFailed({
                  code: "open_failed",
                  message: failure.message,
                }),
              ),
            ),
          ),
          (ref) =>
            Effect.gen(function* () {
              const id = sessionRefId(ref)

              const submitter = yield* resolveId(who.caller, id, "submit").pipe(
                Effect.mapError(
                  (err) =>
                    new RunFailed({
                      code: "not_visible",
                      message: err.message,
                      sessionId: id,
                    }),
                ),
              )

              const runGrant = yield* authority
                .decide(
                  who.caller,
                  { kind: "session", id },
                  { effect: "execute", operation: "session_run" },
                  Evidence.Explicit({ ceiling: authority.ceiling() }),
                )
                .pipe(
                  Effect.mapError((failure) =>
                    Match.value(failure).pipe(
                      Match.when(
                        { _tag: "Denied" },
                        (variant) =>
                          new SessionRefused({
                            message: variant.message,
                            reason: variant.reason,
                            ceiling: variant.ceiling,
                          }),
                      ),
                      Match.when(
                        { _tag: "authority_unverifiable" },
                        (variant) =>
                          new SessionRefused({
                            message: variant.message,
                            reason: "authority_unverifiable",
                          }),
                      ),
                      Match.exhaustive,
                    ),
                  ),
                )

              yield* submitter.submit(intent.prompt, runGrant).pipe(
                Effect.mapError((err) =>
                  Match.value(err).pipe(
                    Match.when(
                      { _tag: "NotVisible" },
                      (variant) =>
                        new RunFailed({
                          code: "not_visible",
                          message: variant.message,
                          sessionId: id,
                        }),
                    ),
                    Match.when(
                      { _tag: "SessionOperationFailed" },
                      (variant) =>
                        new RunFailed({
                          code: variant.code,
                          message: variant.message,
                          sessionId: id,
                          uncertain: variant.uncertain,
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              )

              const delivery: OneShotDelivery = intent.delivery ?? "wait"
              const waitUntil = intent.waitUntil ?? "decision_or_terminal"

              const waitDuration =
                intent.waitMs ?? (delivery === "block" ? MAX_WAIT_MS : defaultWaitMs)

              const turnView =
                delivery === "detach"
                  ? yield* submitter.inspect().pipe(
                      Effect.mapError(
                        (err) =>
                          new RunFailed({
                            code: "not_visible",
                            message: err.message,
                            sessionId: id,
                          }),
                      ),
                    )
                  : yield* submitter.wait(waitUntil, waitDuration).pipe(
                      Effect.mapError((err) =>
                        Match.value(err).pipe(
                          Match.when(
                            { _tag: "NotVisible" },
                            (variant) =>
                              new RunFailed({
                                code: "not_visible",
                                message: variant.message,
                                sessionId: id,
                              }),
                          ),
                          Match.when(
                            { _tag: "SessionOperationFailed" },
                            (variant) =>
                              new RunFailed({
                                code: variant.code,
                                message: variant.message,
                                sessionId: id,
                                uncertain: variant.uncertain,
                              }),
                          ),
                          Match.exhaustive,
                        ),
                      ),
                    )

              const page = yield* submitter.observe(null, 0).pipe(
                Effect.mapError(
                  (err) =>
                    new RunFailed({
                      code: "observe_failed",
                      message: err.message,
                      sessionId: id,
                    }),
                ),
              )

              const status = turnView === undefined ? "running" : turnView.status

              if (status === "running") {
                return {
                  sessionRef: ref,
                  sessionId: id,
                  closed: false,
                  status,
                  summary: turnView?.summary,
                  lastText: turnView?.lastText,
                  failureReason: turnView?.failureReason,
                  outstandingDecisions: turnView?.outstandingDecisions ?? [],
                  cursor: delivery === "detach" ? 0 : positionOffset(page.resume),
                  events: delivery === "detach" ? [] : page.items,
                  truncated: delivery === "detach" ? false : page.gap,
                  resume: page.resume,
                }
              }

              return {
                sessionRef: ref,
                sessionId: id,
                closed: true,
                status,
                summary: turnView?.summary,
                lastText: turnView?.lastText,
                failureReason: turnView?.failureReason,
                outstandingDecisions: [],
                cursor: positionOffset(page.resume),
                events: page.items,
                truncated: page.gap,
                resume: undefined,
              }
            }),
          (ref, exit) => {
            if (Exit.isSuccess(exit) && !exit.value.closed) {
              return Effect.void
            }

            return Effect.ignore(closeById(who.caller, sessionRefId(ref)))
          },
        )

      // -------------------------------------------------------------------
      // Layer finalizer: drain any remaining live sessions cleanly
      // -------------------------------------------------------------------

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          finalizing = true

          const remaining = Array.from(sessionsById.values())

          for (const record of remaining) {
            yield* Effect.ignore(closeRecord(record))
          }

          yield* PubSub.shutdown(changeBus)
        }),
      )

      // -------------------------------------------------------------------
      // Assemble service API + bound operations
      // -------------------------------------------------------------------

      let boundEntries: ReadonlyArray<BoundOperation> = []

      const api: SessionsApi = {
        create,
        resolve,
        resolveId,
        listVisible,
        watchVisible,
        close,
        runOnce,
        entries: () => boundEntries,
      }

      boundEntries = buildSessionOperations({
        capabilities,
        sessions: api,
        guidanceRequired,
        defaultWaitMs,
      })

      return api
    }),
  )
