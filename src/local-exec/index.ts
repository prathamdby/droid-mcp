/**
 * Level 2 `local-exec` module: starting and speaking to the local executable.
 *
 * A `LocalLease` exposes only verified facilities, typed settings/model/fork
 * operations and a correlated notice stream. It never exposes the child
 * handle, pipes, raw peer method strings or the launch environment.
 *
 * Invariants:
 * - The child is acquired through `custody` before the lease escapes, so a
 *   scope closed immediately after `open` still terminates the process.
 * - Line capture starts before any outbound frame is written, so notices
 *   racing a send reply are already routed when the reply arrives.
 * - Work refs are fresh, monotonic and module-minted; a late or ambiguous
 *   notice is never attributed to newer work.
 * - Peer challenges carry single-use reply closures validated by internal
 *   correlation epochs; a reused peer request id never receives a stale reply.
 * - Peer exit is a fact notice, not a final public turn status; the notice
 *   stream then ends with `PeerLost` and the turn owner decides.
 * - Initialization never assumes a model catalog arrives with the reply.
 * - A fork not known to be runnable returns an external reference.
 * - Display payloads, stderr summaries and failure messages crossing the
 *   module boundary are scrubbed through `disclosure`.
 * - Operations never pass autonomy or settings exceeding the grant ceiling.
 */
import * as Cause from "effect/Cause"
import type { Done } from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

import { Authority, autonomyWithinCap } from "../authority/index.ts"
import type { AutonomyLevel, Grant } from "../authority/index.ts"
import { Custody } from "../custody/index.ts"
import type { Lease, Lifetime } from "../custody/index.ts"
import { Disclosure, ReleasePayload, releasedJson } from "../disclosure/index.ts"
import {
  Dialect,
  EXEC_ARGS,
  EXEC_METHOD,
  PeerNotice,
  LEGACY_FACTORY_API_VERSION,
  SDK_PROTOCOL_VERSION,
} from "../factory-dialect/index.ts"
import { Workspaces } from "../workspace/index.ts"
import type { WorkspaceLease, WorkspaceView } from "../workspace/index.ts"
import { spawnTransport } from "./private/process.ts"
import type { ExecTransport } from "./private/process.ts"
import { openSessionCore, nextCorrelationId } from "./private/session-core.ts"
import type { SessionCore } from "./private/session-core.ts"

// ---------------------------------------------------------------------------
// Errors (owned by this module)
// ---------------------------------------------------------------------------

export class InitFailed extends Schema.TaggedError<InitFailed>()("InitFailed", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export class ExecFacetUnsupported extends Schema.TaggedError<ExecFacetUnsupported>()(
  "ExecFacetUnsupported",
  {
    message: Schema.String,
    facet: Schema.String,
  },
) {}

export class ExecRejected extends Schema.TaggedError<ExecRejected>()("ExecRejected", {
  message: Schema.String,
  code: Schema.optional(Schema.Number),
  operation: Schema.optional(Schema.String),
}) {}

export class ExecSubmissionUncertain extends Schema.TaggedError<ExecSubmissionUncertain>()(
  "ExecSubmissionUncertain",
  {
    message: Schema.String,
    operation: Schema.optional(Schema.String),
  },
) {}

export class PeerLost extends Schema.TaggedError<PeerLost>()("PeerLost", {
  message: Schema.String,
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReasoningEffort =
  | "none"
  | "dynamic"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type InteractionMode = "auto" | "spec" | "agi" | "mission"

/** Settings for opening a session. Levels are constrained by the grant ceiling. */
export interface LocalSettings {
  readonly autonomyLevel: AutonomyLevel
  readonly interactionMode?: InteractionMode | undefined
  readonly modelId?: string | undefined
  readonly reasoningEffort?: ReasoningEffort | undefined
  readonly specModeModelId?: string | undefined
  readonly specModeReasoningEffort?: ReasoningEffort | undefined
  readonly disabledToolIds?: ReadonlyArray<string> | undefined
}

/** A partial settings update; absent members stay unchanged on the peer. */
export interface LocalSettingsPatch {
  readonly autonomyLevel?: AutonomyLevel | undefined
  readonly interactionMode?: InteractionMode | undefined
  readonly modelId?: string | undefined
  readonly reasoningEffort?: ReasoningEffort | undefined
  readonly specModeModelId?: string | undefined
  readonly specModeReasoningEffort?: ReasoningEffort | undefined
  readonly disabledToolIds?: ReadonlyArray<string> | undefined
}

/** The effective settings as the session currently knows them. */
export interface LocalSettingsView {
  readonly autonomyLevel: AutonomyLevel
  readonly interactionMode?: InteractionMode | undefined
  readonly modelId?: string | undefined
  readonly reasoningEffort?: ReasoningEffort | undefined
  readonly specModeModelId?: string | undefined
  readonly specModeReasoningEffort?: ReasoningEffort | undefined
  readonly disabledToolIds?: ReadonlyArray<string> | undefined
}

/** One user-message submission. */
export interface LocalSubmission {
  readonly text: string
}

/** What the exec session verifiably supports after initialization. */
export interface VerifiedFacilities {
  readonly updateSettings: boolean
  readonly interrupt: boolean
  readonly fork: boolean
  readonly close: boolean
}

export interface LocalModelInfo {
  readonly id: string
  readonly displayName?: string | undefined
  readonly provider?: string | undefined
}

export interface LocalForkRequest {
  readonly title?: string | undefined
}

/**
 * A fork either runs inside the same live exec session (the peer continues
 * as the forked session) or names a session this lease cannot run.
 */
export type LocalForkOutcome =
  | { readonly kind: "runnable"; readonly sessionId: string }
  | { readonly kind: "external"; readonly externalSessionId: string }

declare const localLeaseBrand: unique symbol

/**
 * An opaque handle to a live exec session. Only this module mints one.
 * It exposes verified facilities and typed state — never the child handle,
 * pipes, raw method strings or launch environment.
 */
export interface LocalLease {
  readonly [localLeaseBrand]: true
  readonly id: string
  readonly sessionId: string
  readonly facilities: VerifiedFacilities
  readonly settingsSnapshot: LocalSettingsView
}

declare const localWorkRefBrand: unique symbol

/**
 * A fresh, monotonic, module-minted correlation token for one submission.
 * Only this module mints one; it cannot be forged or replayed by callers.
 */
export interface LocalWorkRef {
  readonly [localWorkRefBrand]: true
  readonly leaseId: string
  readonly generation: number
  readonly correlationId: string
}

export type LocalNotice = Data.TaggedEnum<{
  /** A session-scoped delta (assistant text, tool calls, results, misc). */
  readonly SessionDelta: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly kind: string
    readonly payload: Schema.Json
  }
  /** The peer reported a turn finished. */
  readonly TurnCompleted: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly summary: Schema.Json
  }
  /** The peer reported a turn interrupted. */
  readonly TurnInterrupted: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly reason: string
  }
  /** The peer reported a session-level failure. */
  readonly TurnFailed: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly code: string
    readonly message: string
  }
  /** The peer asks permission; `reply` resolves it at most once. */
  readonly PermissionChallenge: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly peerRequestId: string
    readonly toolUses: Schema.Json
    readonly options: Schema.Json | undefined
    readonly reply: (payload: Schema.Json) => Effect.Effect<void, ExecRejected>
  }
  /** The peer asks free-form questions. */
  readonly QuestionChallenge: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly peerRequestId: string
    readonly questions: Schema.Json
    readonly reply: (payload: Schema.Json) => Effect.Effect<void, ExecRejected>
  }
  /** The peer offers a pick-list. */
  readonly OptionsChallenge: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly peerRequestId: string
    readonly title: string
    readonly options: Schema.Json
    readonly multiSelect: boolean
    readonly reply: (payload: Schema.Json) => Effect.Effect<void, ExecRejected>
  }
  /** The peer reported a challenge resolved. */
  readonly ChallengeResolved: {
    readonly leaseId: string
    readonly workRef: LocalWorkRef | undefined
    readonly peerRequestId: string
    readonly toolUseIds: ReadonlyArray<string>
  }
  /** The peer's settings changed. */
  readonly SettingsChanged: {
    readonly leaseId: string
    readonly settings: Schema.Json
  }
  /** The peer exited. A fact for the turn owner, not a final turn status. */
  readonly PeerExited: {
    readonly leaseId: string
    readonly code: number | null
    readonly signal: string | null
    readonly stderrSummary: string | undefined
  }
  /** A notification the dialect normalized but this module does not type. */
  readonly OtherNotice: {
    readonly leaseId: string
    readonly method: string
    readonly payload: Schema.Json
  }
}>

export const LocalNotice = Data.taggedEnum<LocalNotice>()

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LocalExecOptions {
  /** Path to the executable; tests point this at a stand-in script. */
  readonly droidPath: string
  /** Overrides the executable arguments. */
  readonly args?: ReadonlyArray<string> | undefined
  /**
   * Operator-supplied base environment the launch allowlist reads `PATH`,
   * `HOME`, `LANG` and `TERM` from. Defaults to the minimal safe values
   * (`PATH: /usr/bin:/bin`, `HOME: /`); the module never reads ambient
   * `process.env` itself — the product composition root passes the ambient
   * entries in explicitly.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>> | undefined
  /** Exact additional environment entries merged over the scrubbed base. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Cap for the initialize round-trip. */
  readonly spawnTimeoutMs?: number | undefined
  /** Cap for the bounded shutdown the drain performs. */
  readonly drainTimeoutMs?: number | undefined
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface LocalExecApi {
  readonly open: (
    workspace: WorkspaceLease,
    grant: Grant,
    settings: LocalSettings,
  ) => Effect.Effect<LocalLease, InitFailed | ExecFacetUnsupported, Scope.Scope>

  readonly submit: (
    lease: LocalLease,
    work: LocalSubmission,
    grant: Grant,
  ) => Effect.Effect<LocalWorkRef, ExecRejected | ExecSubmissionUncertain>

  readonly notices: (lease: LocalLease) => Stream.Stream<LocalNotice, PeerLost>

  readonly interrupt: (
    lease: LocalLease,
    work: LocalWorkRef,
    grant: Grant,
  ) => Effect.Effect<void, ExecRejected | ExecSubmissionUncertain>

  readonly updateSettings: (
    lease: LocalLease,
    patch: LocalSettingsPatch,
    grant: Grant,
  ) => Effect.Effect<
    LocalSettingsView,
    ExecRejected | ExecFacetUnsupported | ExecSubmissionUncertain
  >

  readonly listModels: (
    lease: LocalLease,
  ) => Effect.Effect<ReadonlyArray<LocalModelInfo>, ExecRejected | ExecFacetUnsupported>

  readonly fork: (
    lease: LocalLease,
    request: LocalForkRequest,
    grant: Grant,
  ) => Effect.Effect<
    LocalForkOutcome,
    ExecRejected | ExecFacetUnsupported | ExecSubmissionUncertain
  >

  readonly adopt: (lease: LocalLease, lifetime: Lifetime) => Effect.Effect<void, PeerLost>

  readonly release: (lease: LocalLease) => Effect.Effect<void>
}

export class LocalExec extends Context.Service<LocalExec, LocalExecApi>()("droid-mcp/local-exec") {}

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

const isRecordJson = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isStringJson = Schema.is(Schema.String)

interface SessionState {
  readonly leaseId: string
  readonly transport: ExecTransport
  readonly core: SessionCore
  readonly noticeQueue: Queue.Queue<LocalNotice, Done>
  readonly custodyLease: Lease<ExecTransport>
  readonly workspaceView: WorkspaceView
  readonly openGrant: Grant
  readonly facilities: VerifiedFacilities
  readonly lock: Semaphore.Semaphore
  generation: number
  activeWorkRef: LocalWorkRef | undefined
  initialModels: ReadonlyArray<LocalModelInfo>
  currentSettings: LocalSettingsView
  sessionId: string
  exitEmitted: boolean
}

const mintWorkRef = (state: SessionState): LocalWorkRef => {
  state.generation += 1

  // SAFETY: work refs are minted only here; the brand is unforgeable outside
  // this module, and the generation is strictly monotonic per lease.
  return {
    leaseId: state.leaseId,
    generation: state.generation,
    correlationId: nextCorrelationId(state.leaseId),
  } as LocalWorkRef
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

/** The fixed envelope keys of a client request frame. */
interface RequestFrame {
  jsonrpc: "2.0"
  factoryApiVersion: string
  factoryProtocolVersion: string
  type: "request"
  id: string
  method: string
  params?: Schema.Json
}

/** The fork request keys the peer accepts on the wire. */
type ForkWireParams = {
  title?: string
}

/** The session settings keys the peer accepts on the wire. */
type SettingsWireParams = {
  autonomyLevel?: AutonomyLevel
  interactionMode?: InteractionMode
  modelId?: string
  reasoningEffort?: ReasoningEffort
  specModeModelId?: string
  specModeReasoningEffort?: ReasoningEffort
  disabledToolIds?: ReadonlyArray<string>
}

/** A correlation pairing returned by notice attribution. */
interface NoticeCorrelation {
  readonly leaseId: string
  readonly workRef: LocalWorkRef | undefined
}

/** The scrubbed launch environment handed to the child process. */
type SpawnEnvironment = Record<string, string>

/** The mutable slot bridging session construction and the notice adapter. */
interface StateSlot {
  current: SessionState | undefined
}

const requestBytes = (
  version: { readonly protocolVersion: string; readonly legacyApiVersion: string },
  method: string,
  params: Schema.Json | undefined,
  correlationId: string,
): Uint8Array => {
  const frame: RequestFrame = {
    jsonrpc: "2.0",
    factoryApiVersion: version.legacyApiVersion,
    factoryProtocolVersion: version.protocolVersion,
    type: "request",
    id: correlationId,
    method,
  }

  if (params !== undefined) frame.params = params

  return encoder.encode(JSON.stringify(frame))
}

/** Parses the initialize reply leniently: a model catalog is never assumed. */
const InitializeReplySchema = Schema.Struct({
  sessionId: Schema.String,
  hostId: Schema.optional(Schema.String),
  settings: Schema.optional(Schema.Json),
  availableModels: Schema.optional(Schema.Array(Schema.Json)),
})

const modelInfoOf = (value: Schema.Json): LocalModelInfo | undefined => {
  if (!isRecordJson(value)) return undefined

  const id = value["id"]

  if (!isStringJson(id)) return undefined

  const displayName = value["displayName"]
  const provider = value["modelProvider"]

  return {
    id,
    displayName: isStringJson(displayName) ? displayName : undefined,
    provider: isStringJson(provider) ? provider : undefined,
  }
}

const reviewedFacets = [
  EXEC_METHOD.updateSettings,
  EXEC_METHOD.interrupt,
  "droid.fork_session",
  EXEC_METHOD.close,
  EXEC_METHOD.addUserMessage,
] as const

const TIMEOUT_GRACE = Duration.seconds(30)

type RoundTripError = ExecRejected | ExecSubmissionUncertain

/** The race shape of one exchange: a settled outcome or the timeout sentinel. */
type RoundTripRace =
  | { readonly kind: "result"; readonly result: Schema.Json }
  | { readonly kind: "rejected"; readonly code: number; readonly message: string }
  | { readonly kind: "lost" }
  | { readonly kind: "timeout" }

/** The wire-level rejection shape a challenge endpoint fails with. */
interface PeerRejectedWire {
  readonly message: string
  readonly code: number
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const localExecLayer = (
  options: LocalExecOptions,
): Layer.Layer<LocalExec, never, Custody | Workspaces | Authority | Disclosure | Dialect> =>
  Layer.effect(
    LocalExec,
    Effect.gen(function* () {
      const custody = yield* Custody
      const workspaces = yield* Workspaces
      const authority = yield* Authority
      const disclosure = yield* Disclosure
      const dialect = yield* Dialect

      const states = new WeakMap<LocalLease, SessionState>()

      let leaseSequence = 0

      const drainTimeoutMs = options.drainTimeoutMs ?? 30_000
      const spawnTimeoutMs = options.spawnTimeoutMs ?? 30_000

      const stateOf = (lease: LocalLease): SessionState => {
        const state = states.get(lease)

        // SAFETY: a lease is minted only inside `open`, which registers its
        // state before returning; the brand makes forgery impossible.
        if (state === undefined) throw new Error("local-exec lease state missing")

        return state
      }

      const buildEnvironment = (): SpawnEnvironment => {
        // The launch environment is a scrubbed allowlist plus operator-supplied
        // additions. Nothing in it ever leaves this module, and nothing is
        // read from ambient process state: the composition root passes the
        // inherited entries through `options.baseEnv`.
        const base = options.baseEnv ?? {}

        const entries: Array<readonly [string, string]> = [
          ["PATH", base["PATH"] ?? "/usr/bin:/bin"],
          ["HOME", base["HOME"] ?? "/"],
          ["FACTORY_UPSTREAM_CLIENT_TYPE", "sdk"],
          ["FACTORY_UPSTREAM_SDK", "droid-mcp/local-exec"],
        ]

        const lang = base["LANG"]

        if (lang !== undefined) entries.push(["LANG", lang])

        const term = base["TERM"]

        if (term !== undefined) entries.push(["TERM", term])

        if (options.env !== undefined) {
          for (const [key, value] of Object.entries(options.env)) {
            entries.push([key, value])
          }
        }

        return Object.fromEntries(entries)
      }

      const clampAutonomy = (requested: AutonomyLevel, grant: Grant): AutonomyLevel =>
        autonomyWithinCap(requested, grant.ceiling) ? requested : grant.ceiling

      const settingsParamsOf = (
        source: LocalSettings | LocalSettingsPatch,
        grant: Grant,
      ): SettingsWireParams => {
        const params: SettingsWireParams = {}

        if (source.autonomyLevel !== undefined) {
          params.autonomyLevel = clampAutonomy(source.autonomyLevel, grant)
        }

        if (source.interactionMode !== undefined) {
          params.interactionMode = source.interactionMode
        }

        if (source.modelId !== undefined) params.modelId = source.modelId

        if (source.reasoningEffort !== undefined) {
          params.reasoningEffort = source.reasoningEffort
        }

        if (source.specModeModelId !== undefined) {
          params.specModeModelId = source.specModeModelId
        }

        if (source.specModeReasoningEffort !== undefined) {
          params.specModeReasoningEffort = source.specModeReasoningEffort
        }

        if (source.disabledToolIds !== undefined) {
          params.disabledToolIds = [...source.disabledToolIds]
        }

        return params
      }

      const settingsViewOf = (
        source: LocalSettings | LocalSettingsPatch,
        fallback: LocalSettingsView,
        grant: Grant,
      ): LocalSettingsView => ({
        autonomyLevel:
          source.autonomyLevel === undefined
            ? fallback.autonomyLevel
            : clampAutonomy(source.autonomyLevel, grant),
        interactionMode: source.interactionMode ?? fallback.interactionMode,
        modelId: source.modelId ?? fallback.modelId,
        reasoningEffort: source.reasoningEffort ?? fallback.reasoningEffort,
        specModeModelId: source.specModeModelId ?? fallback.specModeModelId,
        specModeReasoningEffort: source.specModeReasoningEffort ?? fallback.specModeReasoningEffort,
        disabledToolIds: source.disabledToolIds ?? fallback.disabledToolIds,
      })

      // ---------------------------------------------------------------------
      // Disclosure helpers (scrub through disclosure before crossing the boundary)
      // ---------------------------------------------------------------------

      const scrubJson = (recipientId: string, value: Schema.Json): Effect.Effect<Schema.Json> =>
        Effect.gen(function* () {
          const audience = yield* disclosure.audience("log", recipientId)

          const released = yield* disclosure
            .release({ payload: ReleasePayload.JsonValue({ value }) }, audience)
            .pipe(Effect.orElseSucceed(() => undefined))

          if (released === undefined) return null

          const json = releasedJson(released)

          return Option.getOrElse(json, () => null)
        })

      const scrubTextOf = (recipientId: string, text: string): Effect.Effect<string> =>
        Effect.gen(function* () {
          if (text.length === 0) return ""

          const audience = yield* disclosure.audience("log", recipientId)

          const released = yield* disclosure
            .release({ payload: ReleasePayload.JsonValue({ value: text }) }, audience)
            .pipe(Effect.orElseSucceed(() => undefined))

          if (released === undefined) return ""

          const json = releasedJson(released)

          if (Option.isNone(json)) return ""

          return isStringJson(json.value) ? json.value : ""
        })

      // ---------------------------------------------------------------------
      // Notice adaptation
      // ---------------------------------------------------------------------

      const correlationOf = (state: SessionState, noticeSessionId: string): NoticeCorrelation => {
        // Correlation is only forward-looking: a notice names at most the
        // newest active work, and only when it belongs to this session. The
        // peer supplies no per-turn correlation on its notices, so a notice
        // racing an earlier generation is indistinguishable — it attaches to
        // the active ref or to none, never backwards.
        if (noticeSessionId.length === 0 || noticeSessionId !== state.sessionId) {
          return { leaseId: state.leaseId, workRef: undefined }
        }

        return { leaseId: state.leaseId, workRef: state.activeWorkRef }
      }

      const adaptNotice = (state: SessionState) => {
        const scrubbed = (payload: Schema.Json): Effect.Effect<Schema.Json> =>
          scrubJson(state.leaseId, payload).pipe(Effect.orElseSucceed(() => null))

        const wrapReply =
          (endpointReply: (payload: Schema.Json) => Effect.Effect<void, PeerRejectedWire>) =>
          (payload: Schema.Json): Effect.Effect<void, ExecRejected> =>
            endpointReply(payload).pipe(
              Effect.mapError(
                (rejected) =>
                  new ExecRejected({
                    message: rejected.message,
                    code: rejected.code,
                  }),
              ),
            )

        return (notice: PeerNotice): Effect.Effect<LocalNotice> =>
          PeerNotice.$match(notice, {
            SessionDelta: (variant) =>
              Effect.gen(function* () {
                const correlation = correlationOf(state, variant.sessionId)
                const payload = yield* scrubbed(variant.payload)

                return LocalNotice.SessionDelta({
                  leaseId: correlation.leaseId,
                  workRef: correlation.workRef,
                  kind: variant.kind,
                  payload,
                })
              }),
            TurnCompleted: (variant) =>
              Effect.gen(function* () {
                const correlation = correlationOf(state, variant.sessionId)
                const summary = yield* scrubbed(variant.summary)

                return LocalNotice.TurnCompleted({
                  leaseId: correlation.leaseId,
                  workRef: correlation.workRef,
                  summary,
                })
              }),
            TurnInterrupted: (variant) =>
              Effect.sync(() => {
                const correlation = correlationOf(state, variant.sessionId)

                return LocalNotice.TurnInterrupted({
                  leaseId: correlation.leaseId,
                  workRef: correlation.workRef,
                  reason: variant.reason,
                })
              }),
            TurnFailed: (variant) =>
              Effect.gen(function* () {
                const correlation = correlationOf(state, variant.sessionId)
                const message = yield* scrubTextOf(state.leaseId, variant.message)

                return LocalNotice.TurnFailed({
                  leaseId: correlation.leaseId,
                  workRef: correlation.workRef,
                  code: variant.code,
                  message,
                })
              }),
            PermissionChallenge: (variant) =>
              Effect.gen(function* () {
                const toolUses = yield* scrubbed(variant.toolUses)

                const challengeOptions =
                  variant.options === undefined ? undefined : yield* scrubbed(variant.options)

                return LocalNotice.PermissionChallenge({
                  leaseId: state.leaseId,
                  workRef: state.activeWorkRef,
                  peerRequestId: variant.peerRequestId,
                  toolUses,
                  options: challengeOptions,
                  reply: wrapReply((payload) => variant.endpoint.reply(payload)),
                })
              }),
            QuestionChallenge: (variant) =>
              Effect.gen(function* () {
                const questions = yield* scrubbed(variant.questions)

                return LocalNotice.QuestionChallenge({
                  leaseId: state.leaseId,
                  workRef: state.activeWorkRef,
                  peerRequestId: variant.peerRequestId,
                  questions,
                  reply: wrapReply((payload) => variant.endpoint.reply(payload)),
                })
              }),
            OptionsChallenge: (variant) =>
              Effect.gen(function* () {
                const challengeOptions = yield* scrubbed(variant.options)

                return LocalNotice.OptionsChallenge({
                  leaseId: state.leaseId,
                  workRef: state.activeWorkRef,
                  peerRequestId: variant.peerRequestId,
                  title: variant.title,
                  options: challengeOptions,
                  multiSelect: variant.multiSelect,
                  reply: wrapReply((payload) => variant.endpoint.reply(payload)),
                })
              }),
            ChallengeResolved: (variant) =>
              Effect.succeed(
                LocalNotice.ChallengeResolved({
                  leaseId: state.leaseId,
                  workRef: state.activeWorkRef,
                  peerRequestId: variant.peerRequestId,
                  toolUseIds: variant.toolUseIds,
                }),
              ),
            ModelCatalog: () =>
              Effect.succeed(
                LocalNotice.OtherNotice({
                  leaseId: state.leaseId,
                  method: "model_catalog",
                  payload: null,
                }),
              ),
            SettingsChanged: (variant) =>
              Effect.gen(function* () {
                const settings = yield* scrubbed(variant.settings)

                return LocalNotice.SettingsChanged({
                  leaseId: state.leaseId,
                  settings,
                })
              }),
            OtherNotice: (variant) =>
              Effect.gen(function* () {
                const payload = yield* scrubbed(variant.payload)

                return LocalNotice.OtherNotice({
                  leaseId: state.leaseId,
                  method: variant.method,
                  payload,
                })
              }),
          })
      }

      // ---------------------------------------------------------------------
      // Round trips
      // ---------------------------------------------------------------------

      const roundTrip = <A>(
        state: SessionState,
        method: string,
        params: Schema.Json | undefined,
        correlationId: string,
        onResult: (result: Schema.Json) => Effect.Effect<A, RoundTripError>,
      ): Effect.Effect<A, RoundTripError> =>
        Semaphore.withPermit(state.lock)(
          Effect.gen(function* () {
            const outcome = state.core.expectReply(correlationId)
            const bytes = requestBytes(state.core.currentVersion(), method, params, correlationId)

            const written = yield* Effect.exit(state.transport.write(bytes))

            if (Exit.isFailure(written)) {
              // The frame never reached the peer, so delivery certainty is
              // preserved: this is a rejection, never uncertainty.
              state.core.unexpect(correlationId)

              return yield* Effect.fail(
                new ExecRejected({
                  message: "cannot write to the local executable",
                  operation: method,
                }),
              )
            }

            const timedOut = Effect.as(Effect.sleep(TIMEOUT_GRACE), {
              kind: "timeout" as const,
            })

            const race: Effect.Effect<RoundTripRace> = Effect.raceFirst(outcome, timedOut).pipe(
              // The correlation id never survives its exchange: a late reply
              // after timeout is unowned and dropped, so nothing can be
              // mis-correlated onto a reused id.
              Effect.ensuring(Effect.sync(() => state.core.unexpect(correlationId))),
            )

            // The frame was written. A missing reply is genuinely uncertain:
            // the peer may already be executing.
            const result = yield* race

            if (result.kind === "timeout") {
              return yield* Effect.fail(
                new ExecSubmissionUncertain({
                  message: "the peer did not answer in time",
                  operation: method,
                }),
              )
            }

            if (result.kind === "lost") {
              return yield* Effect.fail(
                new ExecSubmissionUncertain({
                  message: "the peer exited before answering",
                  operation: method,
                }),
              )
            }

            if (result.kind === "rejected") {
              const scrubbed = yield* scrubTextOf(state.leaseId, result.message)

              return yield* Effect.fail(
                new ExecRejected({
                  message: scrubbed.length === 0 ? "the peer rejected the request" : scrubbed,
                  code: result.code,
                  operation: method,
                }),
              )
            }

            return yield* onResult(result.result)
          }),
        )

      const initializeSession = (
        state: SessionState,
        workspaceView: WorkspaceView,
      ): Effect.Effect<void, InitFailed> =>
        Effect.gen(function* () {
          const correlationId = nextCorrelationId(state.leaseId)

          const initParams = {
            machineId: "local",
            cwd: workspaceView.location,
          }

          const outcome = state.core.expectReply(correlationId)

          const bytes = requestBytes(
            state.core.currentVersion(),
            EXEC_METHOD.initialize,
            initParams,
            correlationId,
          )

          const written = yield* Effect.exit(state.transport.write(bytes))

          if (Exit.isFailure(written)) {
            state.core.unexpect(correlationId)

            return yield* Effect.fail(
              new InitFailed({
                message: "the local executable could not be written to",
                reason: "write_failed",
              }),
            )
          }

          const timedOut = Effect.as(Effect.sleep(Duration.millis(spawnTimeoutMs)), {
            kind: "timeout" as const,
          })

          const race: Effect.Effect<RoundTripRace> = Effect.raceFirst(outcome, timedOut).pipe(
            Effect.ensuring(Effect.sync(() => state.core.unexpect(correlationId))),
          )

          const settled = yield* race

          if (settled.kind === "timeout") {
            return yield* Effect.fail(
              new InitFailed({
                message: "the local executable did not initialize in time",
                reason: "spawn_timeout",
              }),
            )
          }

          if (settled.kind === "lost") {
            return yield* Effect.fail(
              new InitFailed({
                message: "the local executable exited during initialization",
                reason: "peer_exited",
              }),
            )
          }

          if (settled.kind === "rejected") {
            const scrubbed = yield* scrubTextOf(state.leaseId, settled.message)

            return yield* Effect.fail(
              new InitFailed({
                message: scrubbed.length === 0 ? "the peer rejected initialization" : scrubbed,
                reason: "peer_rejected",
              }),
            )
          }

          const decoded = Option.getOrUndefined(
            Schema.decodeUnknownOption(InitializeReplySchema)(settled.result),
          )

          if (decoded === undefined) {
            return yield* Effect.fail(
              new InitFailed({
                message: "the local executable returned a malformed initialization reply",
                reason: "bad_reply",
              }),
            )
          }

          state.sessionId = decoded.sessionId

          // A model catalog is never assumed: it is recorded only when the
          // peer actually supplies one.
          if (decoded.availableModels !== undefined) {
            const models: Array<LocalModelInfo> = []

            for (const entry of decoded.availableModels) {
              const info = modelInfoOf(entry)

              if (info !== undefined) models.push(info)
            }

            state.initialModels = models
          }
        })

      // ---------------------------------------------------------------------
      // open
      // ---------------------------------------------------------------------

      const open: LocalExecApi["open"] = (workspace, grant, settings) =>
        Effect.gen(function* () {
          if (!authority.allows(grant, { level: settings.autonomyLevel })) {
            return yield* Effect.fail(
              new InitFailed({
                message: "the requested autonomy exceeds the grant",
                reason: "denied",
              }),
            )
          }

          // Every facility this module uses must have a reviewed binding.
          for (const method of reviewedFacets) {
            const bound = yield* Effect.exit(dialect.reviewedBinding(method))

            if (Exit.isFailure(bound)) {
              return yield* Effect.fail(
                new ExecFacetUnsupported({
                  message: "the dialect has no reviewed binding for a required method",
                  facet: method,
                }),
              )
            }
          }

          const workspaceView = yield* workspaces.describe(workspace).pipe(
            Effect.mapError(
              () =>
                new InitFailed({
                  message: "the workspace is not available",
                  reason: "workspace_unavailable",
                }),
            ),
          )

          leaseSequence += 1
          const leaseId = "local-exec-lease:" + String(leaseSequence)

          const noticeQueue = yield* Queue.unbounded<LocalNotice, Done>()
          const stateSlot: StateSlot = { current: undefined }

          const transport = yield* spawnTransport({
            executable: options.droidPath,
            args: options.args ?? EXEC_ARGS,
            cwd: workspaceView.location,
            env: buildEnvironment(),
            lineLimitBytes: 1024 * 1024,
            stderrLimitBytes: 8 * 1024,
          }).pipe(
            Effect.mapError(
              (failure) => new InitFailed({ message: failure.message, reason: "spawn_failed" }),
            ),
          )

          const core = openSessionCore({
            transport,
            version: {
              protocolVersion: SDK_PROTOCOL_VERSION,
              legacyApiVersion: LEGACY_FACTORY_API_VERSION,
            },
            dialect,
            emit: (notice) => {
              const state = stateSlot.current

              if (state === undefined) return

              // Adaptation is synchronous by construction: disclosure release
              // is a pure scrub. A defect here must never kill the reader, so
              // a failure to adapt drops the one notice rather than the stream.
              try {
                const adapted = Effect.runSync(Effect.exit(adaptNotice(state)(notice)))

                if (Exit.isFailure(adapted)) return

                Queue.offerUnsafe(noticeQueue, adapted.value)
              } catch {
                // A notice that cannot be adapted is dropped; the peer
                // stream itself stays healthy.
              }
            },
          })

          const lock = yield* Semaphore.make(1)

          // The child is registered with custody BEFORE the lease escapes,
          // so scope close always terminates it — even mid-initialization.
          const custodyLease = yield* custody
            .acquire({
              name: "local-exec:" + leaseId,
              acquire: Effect.succeed(transport),
              dispose: (value) => value.close,
              drainTimeoutMs,
            })
            .pipe(
              Effect.mapError(
                (failure) =>
                  new InitFailed({
                    message: failure.message,
                    reason: "custody_failed",
                  }),
              ),
            )

          const cleanup = (failure: InitFailed | ExecFacetUnsupported) =>
            Effect.andThen(
              Effect.orElseSucceed(custody.release(custodyLease), () => undefined),
              Effect.fail(failure),
            )

          const state: SessionState = {
            leaseId,
            transport,
            core,
            noticeQueue,
            custodyLease,
            workspaceView,
            openGrant: grant,
            facilities: {
              updateSettings: true,
              interrupt: true,
              fork: true,
              close: true,
            },
            lock,
            generation: 0,
            activeWorkRef: undefined,
            initialModels: [],
            currentSettings: {
              autonomyLevel: clampAutonomy(settings.autonomyLevel, grant),
              interactionMode: settings.interactionMode,
              modelId: settings.modelId,
              reasoningEffort: settings.reasoningEffort,
              specModeModelId: settings.specModeModelId,
              specModeReasoningEffort: settings.specModeReasoningEffort,
              disabledToolIds: settings.disabledToolIds,
            },
            sessionId: "",
            exitEmitted: false,
          }

          stateSlot.current = state

          // Start the line reader before initialization writes anything, so
          // capture precedes every outbound frame by construction. When
          // stdout ends and the exit fact lands, pending exchanges settle as
          // lost, the PeerExited fact is emitted exactly once and the notice
          // queue ends — terminating every consumer with the fact in hand.
          const watcher = Effect.gen(function* () {
            yield* Effect.exit(
              Stream.runForEach(Stream.fromQueue(transport.lines), (line) =>
                Effect.sync(() => {
                  core.route(line)
                }),
              ),
            )

            const fact = yield* Deferred.await(transport.exit)
            core.failPending()

            if (!state.exitEmitted) {
              state.exitEmitted = true

              const rawTail = transport.stderrTail()
              const scrubbedTail = yield* scrubTextOf(leaseId, rawTail)

              Queue.offerUnsafe(
                noticeQueue,
                LocalNotice.PeerExited({
                  leaseId,
                  code: fact.code,
                  signal: fact.signal,
                  stderrSummary: scrubbedTail.length === 0 ? undefined : scrubbedTail.slice(0, 512),
                }),
              )
            }

            Queue.endUnsafe(noticeQueue)
          })

          yield* Effect.forkDetach(watcher)

          // Initialization. Failure cleans up through custody.
          const initialized = yield* Effect.exit(initializeSession(state, workspaceView))

          if (Exit.isFailure(initialized)) {
            const failure = Cause.findErrorOption(initialized.cause)

            return yield* cleanup(
              Option.isSome(failure)
                ? failure.value
                : new InitFailed({
                    message: "initialization was interrupted",
                    reason: "interrupted",
                  }),
            )
          }

          // Apply the caller's settings. Autonomy is already clamped to the
          // grant ceiling; the peer never receives a level above it.
          const settingsParams = settingsParamsOf(settings, grant)
          const settingsCorrelation = nextCorrelationId(leaseId)

          const settingsResult = yield* Effect.exit(
            roundTrip(
              state,
              EXEC_METHOD.updateSettings,
              settingsParams,
              settingsCorrelation,
              () => Effect.void,
            ),
          )

          if (Exit.isFailure(settingsResult)) {
            const failure = Cause.findErrorOption(settingsResult.cause)
            const message = Option.isSome(failure) ? failure.value.message : "settings failed"

            return yield* cleanup(new InitFailed({ message, reason: "settings_rejected" }))
          }

          // SAFETY: leases are minted only here; the brand is unforgeable
          // outside this module.
          const lease = {
            id: leaseId,
            sessionId: state.sessionId,
            facilities: state.facilities,
            settingsSnapshot: state.currentSettings,
          } as LocalLease

          states.set(lease, state)

          return lease
        })

      // ---------------------------------------------------------------------
      // submit
      // ---------------------------------------------------------------------

      const submit: LocalExecApi["submit"] = (lease, work, grant) =>
        Effect.gen(function* () {
          const state = stateOf(lease)

          if (grant.caller.id !== state.openGrant.caller.id) {
            return yield* Effect.fail(
              new ExecRejected({ message: "the grant does not belong to this session's caller" }),
            )
          }

          if (state.transport.hasExited()) {
            return yield* Effect.fail(
              new ExecRejected({ message: "the local executable is not running" }),
            )
          }

          const workRef = mintWorkRef(state)

          yield* roundTrip(
            state,
            EXEC_METHOD.addUserMessage,
            { text: work.text },
            workRef.correlationId,
            () => Effect.void,
          )

          // The submission was accepted: this generation becomes the newest
          // active work. Notices are only ever attributed forward, never
          // back to an older ref.
          state.activeWorkRef = workRef

          return workRef
        })

      // ---------------------------------------------------------------------
      // notices
      // ---------------------------------------------------------------------

      const notices: LocalExecApi["notices"] = (lease) => {
        const state = stateOf(lease)

        // The queue ends when the peer exit fact has been emitted as the
        // final notice. Stream termination then surfaces as PeerLost, so the
        // turn owner observes both the fact and the loss of the peer.
        const termination = Stream.unwrap(
          Effect.gen(function* () {
            const fact = yield* Deferred.await(state.core.exit)

            return Stream.fail(
              new PeerLost({
                message: "the local executable exited",
                code: fact.code,
                signal: fact.signal,
              }),
            )
          }),
        )

        return Stream.concat(Stream.fromQueue(state.noticeQueue), termination)
      }

      // ---------------------------------------------------------------------
      // interrupt
      // ---------------------------------------------------------------------

      const interrupt: LocalExecApi["interrupt"] = (lease, work, grant) =>
        Effect.gen(function* () {
          const state = stateOf(lease)

          if (grant.caller.id !== state.openGrant.caller.id) {
            return yield* Effect.fail(
              new ExecRejected({ message: "the grant does not belong to this session's caller" }),
            )
          }

          if (work.leaseId !== lease.id) {
            return yield* Effect.fail(
              new ExecRejected({ message: "the work ref does not belong to this lease" }),
            )
          }

          yield* roundTrip(
            state,
            EXEC_METHOD.interrupt,
            {},
            nextCorrelationId(state.leaseId),
            () => Effect.void,
          )
        })

      // ---------------------------------------------------------------------
      // updateSettings
      // ---------------------------------------------------------------------

      const updateSettings: LocalExecApi["updateSettings"] = (lease, patch, grant) =>
        Effect.gen(function* () {
          const state = stateOf(lease)

          if (!lease.facilities.updateSettings) {
            return yield* Effect.fail(
              new ExecFacetUnsupported({
                message: "this session does not support settings updates",
                facet: "updateSettings",
              }),
            )
          }

          if (grant.caller.id !== state.openGrant.caller.id) {
            return yield* Effect.fail(
              new ExecRejected({ message: "the grant does not belong to this session's caller" }),
            )
          }

          // The patch never carries autonomy above the grant ceiling.
          const params = settingsParamsOf(patch, grant)

          yield* roundTrip(
            state,
            EXEC_METHOD.updateSettings,
            params,
            nextCorrelationId(state.leaseId),
            () => Effect.void,
          )

          state.currentSettings = settingsViewOf(patch, state.currentSettings, grant)

          return state.currentSettings
        })

      // ---------------------------------------------------------------------
      // listModels
      // ---------------------------------------------------------------------

      const listModels: LocalExecApi["listModels"] = (lease) =>
        Effect.sync(() => stateOf(lease).initialModels)

      // ---------------------------------------------------------------------
      // fork
      // ---------------------------------------------------------------------

      const fork: LocalExecApi["fork"] = (lease, request, grant) =>
        Effect.gen(function* () {
          const state = stateOf(lease)

          if (!lease.facilities.fork) {
            return yield* Effect.fail(
              new ExecFacetUnsupported({
                message: "this session does not support forking",
                facet: "fork",
              }),
            )
          }

          if (grant.caller.id !== state.openGrant.caller.id) {
            return yield* Effect.fail(
              new ExecRejected({ message: "the grant does not belong to this session's caller" }),
            )
          }

          const params: ForkWireParams = {}

          if (request.title !== undefined) params.title = request.title

          const bound = yield* dialect.reviewedBinding("droid.fork_session").pipe(
            Effect.mapError(
              () =>
                new ExecFacetUnsupported({
                  message: "the dialect has no reviewed binding for a required method",
                  facet: "fork",
                }),
            ),
          )

          return yield* roundTrip(
            state,
            "droid.fork_session",
            params,
            nextCorrelationId(state.leaseId),
            (result) => {
              const decoded = Option.getOrUndefined(bound.decodeResult(result))

              const newSessionId =
                decoded !== undefined && isRecordJson(decoded) ? decoded["newSessionId"] : undefined

              if (!isStringJson(newSessionId)) {
                return Effect.fail(
                  new ExecRejected({
                    message: "the fork reply does not match the reviewed result schema",
                    operation: "droid.fork_session",
                  }),
                )
              }

              // The fork creates a distinct session. This lease is bound to
              // the original session id and never becomes the fork, so the
              // forked session is never claimed runnable: it is external.
              return Effect.succeed({
                kind: "external" as const,
                externalSessionId: newSessionId,
              })
            },
          )
        })

      // ---------------------------------------------------------------------
      // adopt / release
      // ---------------------------------------------------------------------

      const adopt: LocalExecApi["adopt"] = (lease, lifetime) =>
        Effect.gen(function* () {
          const state = stateOf(lease)

          yield* custody.adopt(state.custodyLease, lifetime).pipe(
            Effect.mapError(
              () =>
                new PeerLost({
                  message: "the session is already closed",
                  code: null,
                  signal: null,
                }),
            ),
          )
        })

      const release: LocalExecApi["release"] = (lease) =>
        Effect.gen(function* () {
          const state = stateOf(lease)

          yield* Effect.orElseSucceed(custody.release(state.custodyLease), () => undefined)
        })

      return {
        open,
        submit,
        notices,
        interrupt,
        updateSettings,
        listModels,
        fork,
        adopt,
        release,
      }
    }),
  )
