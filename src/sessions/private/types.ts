/**
 * Domain types, opaque references, scoped session capabilities and tagged
 * errors owned by the Level 6 `sessions` module.
 */
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"

import type { AutonomyLevel, Grant } from "../../authority/index.ts"
import type { AdmissionRefused, Caller } from "../../caller/index.ts"
import type { BoundOperation, Invocation } from "../../capabilities/index.ts"
import type { DecisionRef, DecisionView, HumanChoice } from "../../decisions/index.ts"
import type { Released } from "../../disclosure/index.ts"
import type { InvalidPosition, ObservationPage, Position } from "../../observations/index.ts"
import type {
  Facet,
  OpenFailed,
  PlacementForkOutcome,
  PlacementForkRequest,
  PlacementModelInfo,
  PlacementProviderAdapter,
  PlacementSettingsPatch,
  PlacementSettingsView,
} from "../../placement/index.ts"
import type { TurnInput, TurnRef, TurnStatus, TurnView, WaitCondition } from "../../turns/index.ts"

// ---------------------------------------------------------------------------
// Opaque SessionRef
// ---------------------------------------------------------------------------

const sessionRefBrand: unique symbol = Symbol("droid-mcp-v2/sessions/SessionRef")

/**
 * An opaque public reference to one live session, minted only by `sessions`.
 * Its id is fresh and module-minted — never a provider session id and never a
 * caller digest. Possession of a `SessionRef` confers zero access without
 * resolving it through `Sessions.resolve(caller, ref, right)`.
 */
export interface SessionRef {
  readonly [sessionRefBrand]: true
}

interface SessionRefBody {
  readonly [sessionRefBrand]: true
  readonly id: string
}

export const buildSessionRef = (id: string): SessionRef => {
  const body: SessionRefBody = {
    [sessionRefBrand]: true,
    id,
  }

  return body
}

const readSessionRef = (ref: SessionRef): SessionRefBody =>
  // SAFETY: the brand symbol is module-private, so every `SessionRef` in
  // existence was created by `buildSessionRef` with this exact body.
  ref as SessionRefBody

/** Safe public identifier of a session ref (never a backend id or digest). */
export const sessionRefId = (ref: SessionRef): string => readSessionRef(ref).id

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SessionsOptions {
  /**
   * Legacy `--shared-sessions` operator opt-in. Defaults to `false`: strict
   * per-caller isolation where only the owning caller can see, resolve,
   * mutate, close or watch a session. Never shares artifacts, guidance
   * receipts or grants across callers.
   */
  readonly sharedSessions?: boolean | undefined
  /**
   * Require a valid guidance receipt in the caller's conversation before
   * session operations execute. Defaults to `true`.
   */
  readonly guidanceRequired?: boolean | undefined
  /**
   * Default wait duration (ms) for `session_stream`, `session_events` and
   * `runOnce` when the caller omits `waitMs`. Defaults to 20_000.
   */
  readonly defaultWaitMs?: number | undefined
}

// ---------------------------------------------------------------------------
// Intents (structurally compatible with Placement without importing lower
// workspace or local-exec modules)
// ---------------------------------------------------------------------------

export type SessionReasoningEffort =
  | "none"
  | "dynamic"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type SessionInteractionMode = "auto" | "spec" | "agi" | "mission"

export type SessionWorkspaceIntent =
  | { readonly kind: "borrowed"; readonly path: string }
  | {
      readonly kind: "ephemeral"
      readonly repoPath: string
      readonly worktreeDir?: string | undefined
      readonly branchMode?: "copy" | "existing" | undefined
      readonly baseBranch?: string | undefined
      readonly baseBranchFromOrigin?: boolean | undefined
      readonly newBranch?: string | undefined
    }
  | {
      readonly kind: "persistent"
      readonly repoPath: string
      readonly worktreeDir?: string | undefined
      readonly branchMode?: "copy" | "existing" | undefined
      readonly baseBranch?: string | undefined
      readonly baseBranchFromOrigin?: boolean | undefined
      readonly newBranch?: string | undefined
    }

export interface SessionSettings {
  readonly autonomyLevel: AutonomyLevel
  readonly interactionMode?: SessionInteractionMode | undefined
  readonly modelId?: string | undefined
  readonly reasoningEffort?: SessionReasoningEffort | undefined
  readonly specModeModelId?: string | undefined
  readonly specModeReasoningEffort?: SessionReasoningEffort | undefined
  readonly disabledToolIds?: ReadonlyArray<string> | undefined
}

export type SessionIntent = Data.TaggedEnum<{
  readonly Local: {
    readonly workspace: SessionWorkspaceIntent
    readonly settings: SessionSettings
    readonly requiredFacets?: ReadonlyArray<Facet> | undefined
  }
  readonly Remote: {
    readonly provider: string
    readonly adapter: PlacementProviderAdapter
    readonly autonomyLevel?: AutonomyLevel | undefined
    readonly targetKind?: "daemon" | "hosted" | undefined
    readonly requiredFacets?: ReadonlyArray<Facet> | undefined
  }
}>

export const SessionIntent = Data.taggedEnum<SessionIntent>()

export type OneShotDelivery = "wait" | "detach" | "block"

export interface OneShotIntent {
  readonly session: SessionIntent
  readonly prompt: TurnInput
  readonly waitMs?: number | undefined
  readonly waitUntil?: WaitCondition | undefined
  readonly delivery?: OneShotDelivery | undefined
}

// ---------------------------------------------------------------------------
// Views & change feed
// ---------------------------------------------------------------------------

export interface SessionWorktreeView {
  readonly path: string
  readonly acquiredPath: string
  readonly lifecycle: "ephemeral" | "persistent"
  readonly branch?: string | undefined
}

export type SessionStatus = TurnStatus | "idle"

export interface SessionSummary {
  readonly ref: SessionRef
  readonly sessionId: string
  readonly cwd: string | undefined
  readonly status: SessionStatus
  readonly cursor: number
  readonly settings: PlacementSettingsView | undefined
  readonly facets: ReadonlyArray<Facet>
  readonly worktree?: SessionWorktreeView | undefined
  readonly createdAtMs: number
}

export type SessionChange = Data.TaggedEnum<{
  readonly Created: { readonly summary: SessionSummary }
  readonly Updated: { readonly summary: SessionSummary }
  readonly Closed: { readonly ref: SessionRef; readonly sessionId: string }
}>

export const SessionChange = Data.taggedEnum<SessionChange>()

export interface OffsetObservationPage {
  readonly items: ReadonlyArray<Released<"event">>
  readonly cursor: number
  readonly resume: Position
  readonly gap: boolean
  readonly omittedCount: number
}

export interface RunView {
  readonly sessionRef: SessionRef
  readonly sessionId: string
  readonly closed: boolean
  readonly status: TurnStatus
  readonly summary: Released<"client"> | undefined
  readonly lastText: string | undefined
  readonly failureReason: string | undefined
  readonly outstandingDecisions: ReadonlyArray<DecisionView>
  readonly cursor: number
  readonly events: ReadonlyArray<Released<"event">>
  readonly truncated: boolean
  readonly resume: Position | undefined
}

// ---------------------------------------------------------------------------
// Tagged errors (owned by this module)
// ---------------------------------------------------------------------------

export class SessionRefused extends Schema.TaggedError<SessionRefused>()("SessionRefused", {
  message: Schema.String,
  reason: Schema.String,
  edition: Schema.optional(Schema.String),
  ceiling: Schema.optional(Schema.String),
  requestedLevel: Schema.optional(Schema.String),
}) {}

/**
 * Identical refusal for absent and foreign sessions: an observer cannot tell
 * whether an id does not exist or belongs to another caller.
 */
export class NotVisible extends Schema.TaggedError<NotVisible>()("NotVisible", {
  message: Schema.String,
  sessionId: Schema.String,
}) {}

export class CloseFailed extends Schema.TaggedError<CloseFailed>()("CloseFailed", {
  message: Schema.String,
  sessionId: Schema.String,
  reason: Schema.String,
}) {}

export class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", {
  message: Schema.String,
  code: Schema.String,
  sessionId: Schema.optional(Schema.String),
  uncertain: Schema.optional(Schema.Boolean),
}) {}

export type SessionOperationErrorCode =
  | "busy"
  | "submit_rejected"
  | "submission_uncertain"
  | "turn_unavailable"
  | "interrupt_uncertain"
  | "invalid_choice"
  | "denied"
  | "stale_decision"
  | "reply_uncertain"
  | "invalid_cursor"
  | "rejected"
  | "facet_unsupported"

export class SessionOperationFailed extends Schema.TaggedError<SessionOperationFailed>()(
  "SessionOperationFailed",
  {
    code: Schema.Literals([
      "busy",
      "submit_rejected",
      "submission_uncertain",
      "turn_unavailable",
      "interrupt_uncertain",
      "invalid_choice",
      "denied",
      "stale_decision",
      "reply_uncertain",
      "invalid_cursor",
      "rejected",
      "facet_unsupported",
    ]),
    message: Schema.String,
    reason: Schema.optional(Schema.String),
    uncertain: Schema.optional(Schema.Boolean),
  },
) {}

// ---------------------------------------------------------------------------
// ScopedSession capabilities
// ---------------------------------------------------------------------------

export type SessionRight = "read" | "submit" | "answer" | "admin"

export type ScopedSession = Data.TaggedEnum<{
  readonly Read: {
    readonly right: "read"
    readonly ref: SessionRef
    readonly sessionId: string
    readonly summary: () => Effect.Effect<SessionSummary, NotVisible>
    readonly inspect: () => Effect.Effect<TurnView | undefined, NotVisible>
    readonly observe: (
      after: Position | null,
      waitMs: number,
    ) => Effect.Effect<ObservationPage, NotVisible | InvalidPosition | SessionOperationFailed>
    readonly observeAtOffset: (
      offset: number,
      waitMs: number,
    ) => Effect.Effect<OffsetObservationPage, NotVisible | SessionOperationFailed>
    readonly wait: (
      until: WaitCondition,
      waitMs: number,
    ) => Effect.Effect<TurnView | undefined, NotVisible | SessionOperationFailed>
    readonly listModels: () => Effect.Effect<
      ReadonlyArray<PlacementModelInfo>,
      NotVisible | SessionOperationFailed
    >
    readonly facets: () => ReadonlyArray<Facet>
  }
  readonly Submit: {
    readonly right: "submit"
    readonly ref: SessionRef
    readonly sessionId: string
    readonly submit: (
      input: TurnInput,
      grant: Grant,
    ) => Effect.Effect<TurnRef, NotVisible | SessionOperationFailed>
    readonly interrupt: (grant: Grant) => Effect.Effect<void, NotVisible | SessionOperationFailed>
    readonly summary: () => Effect.Effect<SessionSummary, NotVisible>
    readonly inspect: () => Effect.Effect<TurnView | undefined, NotVisible>
    readonly observe: (
      after: Position | null,
      waitMs: number,
    ) => Effect.Effect<ObservationPage, NotVisible | InvalidPosition | SessionOperationFailed>
    readonly wait: (
      until: WaitCondition,
      waitMs: number,
    ) => Effect.Effect<TurnView | undefined, NotVisible | SessionOperationFailed>
  }
  readonly Answer: {
    readonly right: "answer"
    readonly ref: SessionRef
    readonly sessionId: string
    readonly decide: (
      ref: DecisionRef,
      choice: HumanChoice,
      grant: Grant,
    ) => Effect.Effect<void, NotVisible | SessionOperationFailed>
    readonly decideByLabel: (
      decisionId: string,
      choice: HumanChoice,
      grant: Grant,
    ) => Effect.Effect<void, NotVisible | SessionOperationFailed>
    readonly outstandingDecisions: () => Effect.Effect<ReadonlyArray<DecisionView>, NotVisible>
  }
  readonly Admin: {
    readonly right: "admin"
    readonly ref: SessionRef
    readonly sessionId: string
    readonly updateSettings: (
      patch: PlacementSettingsPatch,
      grant: Grant,
    ) => Effect.Effect<PlacementSettingsView, NotVisible | SessionOperationFailed>
    readonly fork: (
      request: PlacementForkRequest,
      grant: Grant,
    ) => Effect.Effect<PlacementForkOutcome, NotVisible | SessionOperationFailed>
    readonly close: () => Effect.Effect<void, NotVisible | CloseFailed>
  }
}>

export const ScopedSession = Data.taggedEnum<ScopedSession>()

export type ReadScopedSession = Extract<ScopedSession, { readonly right: "read" }>

export type SubmitScopedSession = Extract<ScopedSession, { readonly right: "submit" }>

export type AnswerScopedSession = Extract<ScopedSession, { readonly right: "answer" }>

export type AdminScopedSession = Extract<ScopedSession, { readonly right: "admin" }>

export type ScopedSessionFor<R extends SessionRight> = Extract<ScopedSession, { readonly right: R }>

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface SessionsApi {
  readonly create: (
    who: Invocation,
    intent: SessionIntent,
  ) => Effect.Effect<SessionRef, SessionRefused | OpenFailed>

  readonly resolve: <R extends SessionRight>(
    caller: Caller,
    ref: SessionRef,
    right: R,
  ) => Effect.Effect<ScopedSessionFor<R>, NotVisible>

  readonly resolveId: <R extends SessionRight>(
    caller: Caller,
    id: string,
    right: R,
  ) => Effect.Effect<ScopedSessionFor<R>, NotVisible>

  readonly listVisible: (
    caller: Caller,
  ) => Effect.Effect<ReadonlyArray<SessionSummary>, AdmissionRefused>

  readonly watchVisible: (caller: Caller) => Stream.Stream<SessionChange, AdmissionRefused>

  readonly close: (caller: Caller, ref: SessionRef) => Effect.Effect<void, NotVisible | CloseFailed>

  readonly runOnce: (
    who: Invocation,
    intent: OneShotIntent,
  ) => Effect.Effect<RunView, SessionRefused | RunFailed>

  readonly entries: () => ReadonlyArray<BoundOperation>
}
