/**
 * Level 4 `placement` module: selecting a runnable provider and binding a
 * live lease to the caller, grant, workspace and provider credential.
 *
 * A `RunIntent` expresses the caller's placement requirement: a local
 * intent carries a workspace specification and typed local settings; a
 * remote intent carries a typed provider adapter describing verified remote
 * behavior. The module never fakes a local path for remote work, never
 * exposes a transcript provider, and consumers never switch on backend type.
 *
 * Invariants:
 * - Every `required` facet is verified before a lease escapes; an unmet
 *   requirement fails with `NoEligibleProvider` and no work ever starts.
 *   Nothing silently downgrades.
 * - Grant consistency is checked before opening: the requested autonomy
 *   must sit within the grant ceiling and the target kinds must agree.
 * - The local provider acquires the workspace inside the acquisition scope;
 *   when the exec session cannot open or a verified facility is missing,
 *   the workspace is released before the failure surfaces.
 * - `adopt` transfers the exec lease and the workspace lease together so
 *   cleanup stays bound; `release` joins both into one cleanup.
 * - The `daemon-operations` and `hosted-factory` edges are `import type`
 *   only, so a local-only assembly loads zero runtime code for omitted
 *   providers.
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

import { Authority, autonomyWithinCap } from "../authority/index.ts"
import type { Grant } from "../authority/index.ts"
import type { Caller } from "../caller/index.ts"
import type { Lifetime } from "../custody/index.ts"
import type { DaemonFacet } from "../daemon-operations/index.ts"
import type { RemoteFacet } from "../hosted-factory/index.ts"
import { LocalExec, LocalNotice } from "../local-exec/index.ts"
import type {
  ExecFacetUnsupported,
  ExecRejected,
  ExecSubmissionUncertain,
  InitFailed,
  LocalLease,
  LocalModelInfo,
  LocalSettings,
  LocalSettingsPatch,
  LocalSettingsView,
  LocalWorkRef,
  PeerLost,
} from "../local-exec/index.ts"
import { Workspaces } from "../workspace/index.ts"
import type { WorkspaceIntent, WorkspaceView } from "../workspace/index.ts"

// ---------------------------------------------------------------------------
// Errors (owned by this module)
// ---------------------------------------------------------------------------

/** No installed provider can satisfy the intent plus the required facets. */
export class NoEligibleProvider extends Schema.TaggedError<NoEligibleProvider>()(
  "NoEligibleProvider",
  {
    message: Schema.String,
    reason: Schema.String,
    missingFacets: Schema.optional(Schema.Array(Schema.String)),
  },
) {}

/** The selected provider failed to open a runnable session. */
export class OpenFailed extends Schema.TaggedError<OpenFailed>()("OpenFailed", {
  message: Schema.String,
  reason: Schema.String,
}) {}

/** The provider refused an operation; the refusal reason is preserved. */
export class PlacementRejected extends Schema.TaggedError<PlacementRejected>()(
  "PlacementRejected",
  {
    message: Schema.String,
    operation: Schema.optional(Schema.String),
  },
) {}

/** A mutation's delivery or outcome cannot be established; it is never retried. */
export class PlacementSubmissionUncertain extends Schema.TaggedError<PlacementSubmissionUncertain>()(
  "PlacementSubmissionUncertain",
  {
    message: Schema.String,
    operation: Schema.optional(Schema.String),
  },
) {}

/** The lease does not support the requested facet; nothing is downgraded. */
export class PlacementFacetUnsupported extends Schema.TaggedError<PlacementFacetUnsupported>()(
  "PlacementFacetUnsupported",
  {
    message: Schema.String,
    facet: Schema.String,
  },
) {}

/** The provider peer is gone; the lease is no longer usable. */
export class PlacementPeerLost extends Schema.TaggedError<PlacementPeerLost>()(
  "PlacementPeerLost",
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Facet =
  | "submit"
  | "observe"
  | "interrupt"
  | "answer"
  | "update_settings"
  | "list_models"
  | "fork"
  | "close"

export interface PlacementModelInfo {
  readonly id: string
  readonly displayName?: string | undefined
  readonly provider?: string | undefined
}

export type PlacementSettingsPatch = LocalSettingsPatch

export type PlacementSettingsView = LocalSettingsView

export interface PlacementForkRequest {
  readonly title?: string | undefined
}

/**
 * A fork either runs inside the same live placement session or names a
 * session this lease cannot run. An external id is a lookup input, never
 * proof the forked session is runnable here.
 */
export type PlacementForkOutcome =
  | { readonly kind: "runnable"; readonly sessionId: string }
  | { readonly kind: "external"; readonly externalSessionId: string }

declare const placementWorkRefBrand: unique symbol

/**
 * An opaque correlation token for one submission, minted only by this
 * module. It cannot be forged or replayed by callers.
 */
export interface PlacementWorkRef {
  readonly [placementWorkRefBrand]: true
  readonly leaseId: string
  readonly generation: number
}

export type PlacementNotice = Data.TaggedEnum<{
  /** A session-scoped delta (assistant text, tool calls, results, misc). */
  readonly SessionDelta: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly kind: string
    readonly payload: Schema.Json
  }
  /** The provider reported a turn finished. */
  readonly TurnCompleted: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly summary: Schema.Json
  }
  /** The provider reported a turn interrupted. */
  readonly TurnInterrupted: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly reason: string
  }
  /** The provider reported a session-level failure. */
  readonly TurnFailed: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly code: string
    readonly message: string
  }
  /** The provider asks permission; `reply` resolves it at most once. */
  readonly PermissionChallenge: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly peerRequestId: string
    readonly toolUses: Schema.Json
    readonly options: Schema.Json | undefined
    readonly reply: (payload: Schema.Json) => Effect.Effect<void, PlacementRejected>
  }
  /** The provider asks free-form questions. */
  readonly QuestionChallenge: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly peerRequestId: string
    readonly questions: Schema.Json
    readonly reply: (payload: Schema.Json) => Effect.Effect<void, PlacementRejected>
  }
  /** The provider offers a pick-list. */
  readonly OptionsChallenge: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly peerRequestId: string
    readonly title: string
    readonly options: Schema.Json
    readonly multiSelect: boolean
    readonly reply: (payload: Schema.Json) => Effect.Effect<void, PlacementRejected>
  }
  /** The provider reported a challenge resolved. */
  readonly ChallengeResolved: {
    readonly leaseId: string
    readonly workRef: PlacementWorkRef | undefined
    readonly peerRequestId: string
    readonly toolUseIds: ReadonlyArray<string>
  }
  /** The provider's effective settings changed. */
  readonly SettingsChanged: {
    readonly leaseId: string
    readonly settings: Schema.Json
  }
  /** The provider peer exited. A fact, not a final public turn status. */
  readonly PeerExited: {
    readonly leaseId: string
    readonly stderrSummary?: string | undefined
  }
}>

export const PlacementNotice = Data.taggedEnum<PlacementNotice>()

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

/**
 * A normalized handle a provider adapter yields when it opens. The adapter
 * never returns until every facet it claims is verified; placement forwards
 * adapter failures without inventing a fallback.
 */
export interface ProviderHandle {
  readonly providerSessionId: string
  readonly facets: ReadonlyArray<Facet>
  readonly settingsSnapshot?: PlacementSettingsView | undefined
  readonly submit: (
    text: string,
    grant: Grant,
  ) => Effect.Effect<PlacementWorkRef, PlacementRejected | PlacementSubmissionUncertain>
  readonly notices: () => Stream.Stream<PlacementNotice, PlacementPeerLost>
  readonly interrupt: (
    work: PlacementWorkRef,
    grant: Grant,
  ) => Effect.Effect<void, PlacementRejected | PlacementSubmissionUncertain>
  readonly updateSettings: (
    patch: PlacementSettingsPatch,
    grant: Grant,
  ) => Effect.Effect<PlacementSettingsView, PlacementRejected | PlacementSubmissionUncertain>
  readonly listModels: () => Effect.Effect<ReadonlyArray<PlacementModelInfo>, PlacementRejected>
  readonly fork: (
    request: PlacementForkRequest,
    grant: Grant,
  ) => Effect.Effect<PlacementForkOutcome, PlacementRejected | PlacementSubmissionUncertain>
  readonly adopt: (lifetime: Lifetime) => Effect.Effect<void, PlacementPeerLost>
  readonly release: () => Effect.Effect<void>
}

/**
 * A pluggable runnable provider. `daemonFacets` and `remoteFacets` are
 * typed views of the optional provider modules: an assembly without them
 * installs only the local provider, and no runtime code for either module
 * is ever loaded through this one. `open` is invoked only for intents whose
 * provider name matches; returning `undefined` declines eligibility without
 * an error.
 */
export interface PlacementProviderAdapter {
  readonly provider: string
  readonly daemonFacets?: ReadonlyArray<DaemonFacet> | undefined
  readonly remoteFacets?: ReadonlyArray<RemoteFacet> | undefined
  readonly open: (
    caller: Caller,
    grant: Grant,
  ) => Effect.Effect<ProviderHandle | undefined, NoEligibleProvider | OpenFailed, Scope.Scope>
}

// ---------------------------------------------------------------------------
// Run intent
// ---------------------------------------------------------------------------

/**
 * The caller's placement requirement. A local intent carries the workspace
 * specification and typed settings for the local executable. A remote intent
 * names a typed provider adapter; it never carries a fake local path.
 */
export type RunIntent = Data.TaggedEnum<{
  readonly Local: {
    readonly workspace: WorkspaceIntent
    readonly settings: LocalSettings
  }
  readonly Remote: {
    readonly provider: string
    readonly adapter: PlacementProviderAdapter
  }
}>

export const RunIntent = Data.taggedEnum<RunIntent>()

export interface PlacementOptions {
  /** Additional runnable providers beyond the built-in local provider. */
  readonly providers?: ReadonlyArray<PlacementProviderAdapter> | undefined
}

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

declare const runningLeaseBrand: unique symbol

/**
 * The typed operations a live lease exposes. A consumer asks for the facet
 * operation directly; an unsupported facet fails with
 * `PlacementFacetUnsupported` before any work is done — the operation never
 * silently downgrades to a partial behavior.
 */
export interface PlacementLeaseOperations {
  readonly submit: (
    text: string,
    grant: Grant,
  ) => Effect.Effect<
    PlacementWorkRef,
    PlacementRejected | PlacementSubmissionUncertain | PlacementFacetUnsupported
  >

  readonly notices: () => Stream.Stream<PlacementNotice, PlacementPeerLost>

  readonly interrupt: (
    work: PlacementWorkRef,
    grant: Grant,
  ) => Effect.Effect<
    void,
    PlacementRejected | PlacementSubmissionUncertain | PlacementFacetUnsupported
  >

  readonly updateSettings: (
    patch: PlacementSettingsPatch,
    grant: Grant,
  ) => Effect.Effect<
    PlacementSettingsView,
    PlacementRejected | PlacementFacetUnsupported | PlacementSubmissionUncertain
  >

  readonly listModels: () => Effect.Effect<
    ReadonlyArray<PlacementModelInfo>,
    PlacementRejected | PlacementFacetUnsupported
  >

  readonly fork: (
    request: PlacementForkRequest,
    grant: Grant,
  ) => Effect.Effect<
    PlacementForkOutcome,
    PlacementRejected | PlacementFacetUnsupported | PlacementSubmissionUncertain
  >

  readonly adopt: (lifetime: Lifetime) => Effect.Effect<void, PlacementPeerLost>

  readonly release: () => Effect.Effect<void>
}

/**
 * An opaque handle to a running provider session, minted only by this
 * module. It exposes the caller, grant, provider session identity and the
 * verified facet set — never a child handle, a route, a credential or a
 * provider-specific surface.
 */
export interface RunningLease extends PlacementLeaseOperations {
  readonly [runningLeaseBrand]: true
  readonly leaseId: string
  readonly caller: Caller
  readonly grant: Grant
  readonly providerSessionId: string
  readonly facets: ReadonlyArray<Facet>
  readonly workspace?: WorkspaceView | undefined
  readonly settingsSnapshot?: PlacementSettingsView | undefined
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PlacementApi {
  readonly open: (
    caller: Caller,
    intent: RunIntent,
    grant: Grant,
    required: ReadonlyArray<Facet>,
  ) => Effect.Effect<RunningLease, NoEligibleProvider | OpenFailed, Scope.Scope>

  readonly facets: (lease: RunningLease) => ReadonlyArray<Facet>
}

export class Placement extends Context.Service<Placement, PlacementApi>()("droid-mcp/placement") {}

// ---------------------------------------------------------------------------
// Internal plumbing
// ---------------------------------------------------------------------------

interface ResolvedProvider {
  readonly handle: ProviderHandle
  readonly workspaceView: WorkspaceView | undefined
}

const facetUnsupported = (facet: Facet): PlacementFacetUnsupported =>
  new PlacementFacetUnsupported({
    message: "this lease does not support the " + facet + " facet",
    facet,
  })

const rejectionOf = (operation: string) => (failure: ExecRejected) =>
  new PlacementRejected({ message: failure.message, operation })

const uncertainOf = (operation: string) => (failure: ExecSubmissionUncertain) =>
  new PlacementSubmissionUncertain({ message: failure.message, operation })

const modelInfoOf = (info: LocalModelInfo): PlacementModelInfo => ({
  id: info.id,
  displayName: info.displayName,
  provider: info.provider,
})

const settingsViewOf = (snapshot: LocalSettingsView): PlacementSettingsView => ({
  autonomyLevel: snapshot.autonomyLevel,
  interactionMode: snapshot.interactionMode,
  modelId: snapshot.modelId,
  reasoningEffort: snapshot.reasoningEffort,
  specModeModelId: snapshot.specModeModelId,
  specModeReasoningEffort: snapshot.specModeReasoningEffort,
  disabledToolIds: snapshot.disabledToolIds,
})

/**
 * The verified facilities the local provider relies on per facet. A local
 * exec lease reports `updateSettings`, `interrupt`, `fork` and `close`;
 * `submit`, `observe`, `answer` and `list_models` are intrinsic to the
 * correlated session itself. The mapping lives here, at the selection seam —
 * consumers never switch on it.
 */
const LOCAL_FACET_FACILITIES: ReadonlyArray<readonly [Facet, keyof LocalLease["facilities"]]> = [
  ["update_settings", "updateSettings"],
  ["interrupt", "interrupt"],
  ["fork", "fork"],
  ["close", "close"],
]

const computeLocalFacets = (lease: LocalLease): ReadonlyArray<Facet> => {
  const facets: Array<Facet> = ["submit", "observe"]

  if (lease.facilities.interrupt) facets.push("interrupt")

  facets.push("answer")

  if (lease.facilities.updateSettings) facets.push("update_settings")

  facets.push("list_models")

  if (lease.facilities.fork) facets.push("fork")

  if (lease.facilities.close) facets.push("close")

  return facets
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const placementLayer = (
  options?: PlacementOptions,
): Layer.Layer<Placement, never, LocalExec | Workspaces | Authority> =>
  Layer.effect(
    Placement,
    Effect.gen(function* () {
      const localExec = yield* LocalExec
      const workspaces = yield* Workspaces
      const authority = yield* Authority

      let leaseSequence = 0

      const adapters = options?.providers ?? []

      /** Underlying local-exec refs behind each minted local placement ref. */
      const localWorkRefs = new WeakMap<PlacementWorkRef, LocalWorkRef>()

      const mintLocalWorkRef = (leaseId: string, generation: number): PlacementWorkRef =>
        // SAFETY: work refs are minted only inside this module; the brand is
        // unforgeable outside it, so callers cannot replay another lease's
        // token.
        ({ leaseId, generation }) as PlacementWorkRef

      /**
       * Normalizes one local-exec notice into the placement shape. Work
       * correlation, reuse protection and challenge reply revocation are
       * established inside `local-exec`; this stage rebinds the lease
       * identity and re-wraps the revocable, single-use reply closures so
       * `turns` and `sessions` never import `local-exec`.
       */
      const adaptLocalNotice = (leaseId: string, notice: LocalNotice): PlacementNotice => {
        const workRefOf = (ref: LocalWorkRef | undefined): PlacementWorkRef | undefined => {
          if (ref === undefined) return undefined

          const placementRef = mintLocalWorkRef(leaseId, ref.generation)

          localWorkRefs.set(placementRef, ref)

          return placementRef
        }

        const replyOf =
          (reply: (payload: Schema.Json) => Effect.Effect<void, ExecRejected>) =>
          (payload: Schema.Json): Effect.Effect<void, PlacementRejected> =>
            reply(payload).pipe(Effect.mapError(rejectionOf("answer")))

        return Match.value(notice).pipe(
          Match.when({ _tag: "SessionDelta" }, (variant) =>
            PlacementNotice.SessionDelta({
              leaseId,
              workRef: workRefOf(variant.workRef),
              kind: variant.kind,
              payload: variant.payload,
            }),
          ),
          Match.when({ _tag: "TurnCompleted" }, (variant) =>
            PlacementNotice.TurnCompleted({
              leaseId,
              workRef: workRefOf(variant.workRef),
              summary: variant.summary,
            }),
          ),
          Match.when({ _tag: "TurnInterrupted" }, (variant) =>
            PlacementNotice.TurnInterrupted({
              leaseId,
              workRef: workRefOf(variant.workRef),
              reason: variant.reason,
            }),
          ),
          Match.when({ _tag: "TurnFailed" }, (variant) =>
            PlacementNotice.TurnFailed({
              leaseId,
              workRef: workRefOf(variant.workRef),
              code: variant.code,
              message: variant.message,
            }),
          ),
          Match.when({ _tag: "PermissionChallenge" }, (variant) =>
            PlacementNotice.PermissionChallenge({
              leaseId,
              workRef: workRefOf(variant.workRef),
              peerRequestId: variant.peerRequestId,
              toolUses: variant.toolUses,
              options: variant.options,
              reply: replyOf(variant.reply),
            }),
          ),
          Match.when({ _tag: "QuestionChallenge" }, (variant) =>
            PlacementNotice.QuestionChallenge({
              leaseId,
              workRef: workRefOf(variant.workRef),
              peerRequestId: variant.peerRequestId,
              questions: variant.questions,
              reply: replyOf(variant.reply),
            }),
          ),
          Match.when({ _tag: "OptionsChallenge" }, (variant) =>
            PlacementNotice.OptionsChallenge({
              leaseId,
              workRef: workRefOf(variant.workRef),
              peerRequestId: variant.peerRequestId,
              title: variant.title,
              options: variant.options,
              multiSelect: variant.multiSelect,
              reply: replyOf(variant.reply),
            }),
          ),
          Match.when({ _tag: "ChallengeResolved" }, (variant) =>
            PlacementNotice.ChallengeResolved({
              leaseId,
              workRef: workRefOf(variant.workRef),
              peerRequestId: variant.peerRequestId,
              toolUseIds: variant.toolUseIds,
            }),
          ),
          Match.when({ _tag: "SettingsChanged" }, (variant) =>
            PlacementNotice.SettingsChanged({
              leaseId,
              settings: variant.settings,
            }),
          ),
          Match.when({ _tag: "PeerExited" }, (variant) =>
            PlacementNotice.PeerExited({
              leaseId,
              stderrSummary: variant.stderrSummary,
            }),
          ),
          Match.when({ _tag: "OtherNotice" }, (variant) =>
            PlacementNotice.SessionDelta({
              leaseId,
              workRef: undefined,
              kind: variant.method,
              payload: variant.payload,
            }),
          ),
          Match.exhaustive,
        )
      }

      /**
       * Translates a failed local-exec open into the placement error cases.
       * `InitFailed` is a genuine open failure; `ExecFacetUnsupported` means
       * the provider cannot be verified, so no eligible provider exists.
       */
      const reframeOpenCause = (
        cause: Cause.Cause<InitFailed | ExecFacetUnsupported>,
      ): Cause.Cause<NoEligibleProvider | OpenFailed> => {
        const found = Cause.findErrorOption(cause)

        if (Option.isNone(found)) {
          return Cause.fail(
            new OpenFailed({ message: "the provider open was interrupted", reason: "interrupted" }),
          )
        }

        const reframed = Match.value(found.value).pipe(
          Match.when(
            { _tag: "InitFailed" },
            (variant) => new OpenFailed({ message: variant.message, reason: variant.reason }),
          ),
          Match.when(
            { _tag: "ExecFacetUnsupported" },
            (variant) =>
              new NoEligibleProvider({
                message: variant.message,
                reason: "provider_facility_missing",
              }),
          ),
          Match.exhaustive,
        )

        return Cause.fail(reframed)
      }

      /**
       * Opens the local provider: verify grant consistency, acquire the
       * workspace in scope, open the exec session and confirm every required
       * facet is backed by a verified facility. Any failure releases the
       * exec lease and the workspace before surfacing — nothing half-open
       * escapes.
       */
      const openLocal = (
        caller: Caller,
        leaseId: string,
        workspaceIntent: WorkspaceIntent,
        settings: LocalSettings,
        grant: Grant,
        required: ReadonlyArray<Facet>,
      ): Effect.Effect<ResolvedProvider, NoEligibleProvider | OpenFailed, Scope.Scope> =>
        Effect.gen(function* () {
          if (!authority.allows(grant, { level: settings.autonomyLevel })) {
            return yield* Effect.fail(
              new NoEligibleProvider({
                message: "the requested autonomy exceeds the grant",
                reason: "grant_exceeded",
              }),
            )
          }

          const workspaceLease = yield* workspaces.acquire(caller, workspaceIntent).pipe(
            Effect.mapError(
              (failure) =>
                new OpenFailed({
                  message: failure.message,
                  reason: "workspace_unavailable",
                }),
            ),
          )

          const releaseWorkspace = Effect.orElseSucceed(
            workspaces.release(workspaceLease),
            () => undefined,
          )

          const workspaceView = yield* workspaces.describe(workspaceLease).pipe(
            Effect.mapError(
              (failure) =>
                new OpenFailed({
                  message: failure.message,
                  reason: "workspace_unavailable",
                }),
            ),
            Effect.onError(() => releaseWorkspace),
          )

          const opened = yield* Effect.exit(localExec.open(workspaceLease, grant, settings))

          if (Exit.isFailure(opened)) {
            yield* releaseWorkspace

            return yield* Effect.failCause(reframeOpenCause(opened.cause))
          }

          const localLease = opened.value

          const missing = required.filter((facet) => {
            const facility = LOCAL_FACET_FACILITIES.find(([name]) => name === facet)

            if (facility === undefined) {
              // submit / observe / answer / list_models are intrinsic to the
              // correlated session stream and typed operations.
              return false
            }

            return !localLease.facilities[facility[1]]
          })

          if (missing.length > 0) {
            yield* Effect.orElseSucceed(localExec.release(localLease), () => undefined)
            yield* releaseWorkspace

            return yield* Effect.fail(
              new NoEligibleProvider({
                message: "the local provider cannot satisfy every required facet",
                reason: "unmet_required_facets",
                missingFacets: [...missing],
              }),
            )
          }

          const handle: ProviderHandle = {
            providerSessionId: localLease.sessionId,
            facets: computeLocalFacets(localLease),
            settingsSnapshot: settingsViewOf(localLease.settingsSnapshot),
            submit: (text, operationGrant) =>
              localExec.submit(localLease, { text }, operationGrant).pipe(
                Effect.map((ref) => {
                  const placementRef = mintLocalWorkRef(leaseId, ref.generation)

                  localWorkRefs.set(placementRef, ref)

                  return placementRef
                }),
                Effect.mapError((failure) =>
                  Match.value(failure).pipe(
                    Match.when({ _tag: "ExecRejected" }, rejectionOf("submit")),
                    Match.when({ _tag: "ExecSubmissionUncertain" }, uncertainOf("submit")),
                    Match.exhaustive,
                  ),
                ),
              ),
            notices: () =>
              localExec.notices(localLease).pipe(
                Stream.map((notice) => adaptLocalNotice(leaseId, notice)),
                Stream.mapError(
                  (failure: PeerLost) => new PlacementPeerLost({ message: failure.message }),
                ),
              ),
            interrupt: (work, operationGrant) => {
              const underlying = localWorkRefs.get(work)

              if (underlying === undefined || work.leaseId !== leaseId) {
                return Effect.fail(
                  new PlacementRejected({
                    message: "the work ref does not belong to this lease",
                    operation: "interrupt",
                  }),
                )
              }

              return localExec
                .interrupt(localLease, underlying, operationGrant)
                .pipe(
                  Effect.mapError((failure) =>
                    Match.value(failure).pipe(
                      Match.when({ _tag: "ExecRejected" }, rejectionOf("interrupt")),
                      Match.when({ _tag: "ExecSubmissionUncertain" }, uncertainOf("interrupt")),
                      Match.exhaustive,
                    ),
                  ),
                )
            },
            updateSettings: (patch, operationGrant) =>
              localExec.updateSettings(localLease, patch, operationGrant).pipe(
                Effect.mapError((failure) =>
                  Match.value(failure).pipe(
                    Match.when({ _tag: "ExecRejected" }, rejectionOf("update_settings")),
                    Match.when({ _tag: "ExecSubmissionUncertain" }, uncertainOf("update_settings")),
                    Match.when(
                      { _tag: "ExecFacetUnsupported" },
                      (variant) =>
                        new PlacementRejected({
                          message: variant.message,
                          operation: "update_settings",
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              ),
            listModels: () =>
              localExec.listModels(localLease).pipe(
                Effect.map((infos) => infos.map(modelInfoOf)),
                Effect.mapError((failure) =>
                  Match.value(failure).pipe(
                    Match.when({ _tag: "ExecRejected" }, rejectionOf("list_models")),
                    Match.when(
                      { _tag: "ExecFacetUnsupported" },
                      (variant) =>
                        new PlacementRejected({
                          message: variant.message,
                          operation: "list_models",
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              ),
            fork: (request, operationGrant) =>
              localExec.fork(localLease, request, operationGrant).pipe(
                Effect.map((outcome): PlacementForkOutcome =>
                  outcome.kind === "runnable"
                    ? { kind: "runnable", sessionId: outcome.sessionId }
                    : { kind: "external", externalSessionId: outcome.externalSessionId },
                ),
                Effect.mapError((failure) =>
                  Match.value(failure).pipe(
                    Match.when({ _tag: "ExecRejected" }, rejectionOf("fork")),
                    Match.when({ _tag: "ExecSubmissionUncertain" }, uncertainOf("fork")),
                    Match.when(
                      { _tag: "ExecFacetUnsupported" },
                      (variant) =>
                        new PlacementRejected({
                          message: variant.message,
                          operation: "fork",
                        }),
                    ),
                    Match.exhaustive,
                  ),
                ),
              ),
            adopt: (lifetime) =>
              Effect.gen(function* () {
                yield* localExec
                  .adopt(localLease, lifetime)
                  .pipe(
                    Effect.mapError(
                      () => new PlacementPeerLost({ message: "the session is already closed" }),
                    ),
                  )

                // The workspace lease is adopted into the same lifetime so
                // the exec session and its checkout drain together; cleanup
                // never splits across owners.
                yield* workspaces
                  .adopt(workspaceLease, lifetime)
                  .pipe(
                    Effect.mapError(
                      () => new PlacementPeerLost({ message: "the workspace is already closed" }),
                    ),
                  )
              }),
            release: () =>
              Effect.gen(function* () {
                yield* Effect.orElseSucceed(localExec.release(localLease), () => undefined)
                yield* Effect.orElseSucceed(workspaces.release(workspaceLease), () => undefined)
              }),
          }

          return { handle, workspaceView }
        })

      const openRemote = (
        caller: Caller,
        provider: string,
        adapter: PlacementProviderAdapter,
        grant: Grant,
      ): Effect.Effect<ResolvedProvider, NoEligibleProvider | OpenFailed, Scope.Scope> =>
        Effect.gen(function* () {
          const handle = yield* adapter.open(caller, grant)

          if (handle === undefined) {
            return yield* Effect.fail(
              new NoEligibleProvider({
                message: "provider " + provider + " declined the placement",
                reason: "provider_declined",
              }),
            )
          }

          return { handle, workspaceView: undefined }
        })

      // ---------------------------------------------------------------------
      // open
      // ---------------------------------------------------------------------

      const open: PlacementApi["open"] = (caller, intent, grant, required) =>
        Effect.gen(function* () {
          const targetKind = grant.target.kind

          leaseSequence += 1
          const leaseId = "placement-lease:" + String(leaseSequence)

          const resolved = yield* Match.value(intent).pipe(
            Match.when({ _tag: "Local" }, (variant) =>
              targetKind === "local"
                ? openLocal(caller, leaseId, variant.workspace, variant.settings, grant, required)
                : Effect.fail(
                    new NoEligibleProvider({
                      message: "the grant target does not authorize local execution",
                      reason: "grant_target_mismatch",
                    }),
                  ),
            ),
            Match.when({ _tag: "Remote" }, (variant) => {
              if (targetKind !== "daemon" && targetKind !== "hosted") {
                return Effect.fail(
                  new NoEligibleProvider({
                    message: "the grant target does not authorize remote execution",
                    reason: "grant_target_mismatch",
                  }),
                )
              }

              const installed =
                adapters.find((candidate) => candidate.provider === variant.provider) ??
                variant.adapter

              return openRemote(caller, variant.provider, installed, grant)
            }),
            Match.exhaustive,
          )

          // Facet verification happens before any work starts: a provider
          // that cannot meet every requirement is released and refused, never
          // silently downgraded.
          const missing = required.filter((facet) => !resolved.handle.facets.includes(facet))

          if (missing.length > 0) {
            yield* resolved.handle.release()

            return yield* Effect.fail(
              new NoEligibleProvider({
                message: "no provider can satisfy every required facet",
                reason: "unmet_required_facets",
                missingFacets: [...missing],
              }),
            )
          }

          const handle = resolved.handle

          const requireFacet = (facet: Facet): Effect.Effect<void, PlacementFacetUnsupported> =>
            handle.facets.includes(facet) ? Effect.void : Effect.fail(facetUnsupported(facet))

          const rejectForeignGrant = (
            operation: string,
            operationGrant: Grant,
          ): Effect.Effect<void, PlacementRejected> =>
            operationGrant.caller.id === caller.id
              ? Effect.void
              : Effect.fail(
                  new PlacementRejected({
                    message: "the grant does not belong to this lease's caller",
                    operation,
                  }),
                )

          const operations: PlacementLeaseOperations = {
            submit: (text, operationGrant) =>
              Effect.gen(function* () {
                yield* requireFacet("submit")
                yield* rejectForeignGrant("submit", operationGrant)

                const ref = yield* handle.submit(text, operationGrant)

                if (ref.leaseId !== leaseId) {
                  // SAFETY: the lease-facing token always carries this
                  // lease's identity; the brand is minted only here.
                  return { leaseId, generation: ref.generation } as PlacementWorkRef
                }

                return ref
              }),
            notices: () => handle.notices(),
            interrupt: (work, operationGrant) =>
              Effect.gen(function* () {
                yield* requireFacet("interrupt")
                yield* rejectForeignGrant("interrupt", operationGrant)

                if (work.leaseId !== leaseId) {
                  return yield* Effect.fail(
                    new PlacementRejected({
                      message: "the work ref does not belong to this lease",
                      operation: "interrupt",
                    }),
                  )
                }

                return yield* handle.interrupt(work, operationGrant)
              }),
            updateSettings: (patch, operationGrant) =>
              Effect.gen(function* () {
                yield* requireFacet("update_settings")
                yield* rejectForeignGrant("update_settings", operationGrant)

                if (
                  patch.autonomyLevel !== undefined &&
                  !autonomyWithinCap(patch.autonomyLevel, operationGrant.ceiling)
                ) {
                  return yield* Effect.fail(
                    new PlacementRejected({
                      message: "the requested autonomy exceeds the grant",
                      operation: "update_settings",
                    }),
                  )
                }

                return yield* handle.updateSettings(patch, operationGrant)
              }),
            listModels: () =>
              Effect.gen(function* () {
                yield* requireFacet("list_models")

                return yield* handle.listModels()
              }),
            fork: (request, operationGrant) =>
              Effect.gen(function* () {
                yield* requireFacet("fork")
                yield* rejectForeignGrant("fork", operationGrant)

                return yield* handle.fork(request, operationGrant)
              }),
            adopt: (lifetime) => handle.adopt(lifetime),
            release: () => handle.release(),
          }

          // SAFETY: running leases are minted only here; the brand is
          // unforgeable outside this module.
          const lease = {
            leaseId,
            caller,
            grant,
            providerSessionId: handle.providerSessionId,
            facets: handle.facets,
            workspace: resolved.workspaceView,
            settingsSnapshot: handle.settingsSnapshot,
            ...operations,
          } as RunningLease

          return lease
        })

      const facets: PlacementApi["facets"] = (lease) => lease.facets

      return { open, facets }
    }),
  )
