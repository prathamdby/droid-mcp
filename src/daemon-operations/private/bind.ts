/**
 * Assembly of daemon operation entries: decode through the reviewed codec,
 * enforce the authority invariants before any dispatch, materialize the
 * inherited initialize authority from one authorized defaults read, and
 * translate link failures into the capabilities failure vocabulary with
 * delivery certainty intact.
 *
 * Nothing here ever writes persistent defaults to serve a single request,
 * and no read reply is ever treated as proof that a peer enforced authority.
 */
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { Evidence } from "../../authority/index.ts"
import type { AutonomyLevel, Demand, Grant } from "../../authority/index.ts"
import type { TargetRef } from "../../caller/index.ts"
import {
  DeliveryUncertain,
  InvalidInput,
  MalformedPeerReply,
  OperationUnverifiable,
  PeerFailure,
  TargetUnavailable,
} from "../../capabilities/index.ts"
import type {
  BoundOperation,
  CapabilitiesApi,
  Definition,
  JsonSchemaObject,
  OperationFacts,
  OperationFailure,
} from "../../capabilities/index.ts"
import type {
  BadReply,
  DaemonLinkService,
  IncompatibleVersion,
  NotDelivered,
  PeerRejected,
  PossiblyDelivered,
  ReplayPermission,
} from "../../daemon-link/index.ts"
import { ReleasePayload } from "../../disclosure/index.ts"
import type { Binding } from "../../factory-dialect/index.ts"
import {
  capModeOf,
  decodeJsonRecord,
  explicitLevelsOf,
  familyOf,
  levelWithinCap,
  modeLevelOf,
  operationIdOf,
  readLevelField,
  readModeField,
  semanticsOf,
} from "./entries.ts"
import type { MethodSemantics } from "./entries.ts"

// ---------------------------------------------------------------------------
// Peer view
// ---------------------------------------------------------------------------

/**
 * The verified daemon peer an entry set is bound against. `peerId` is an
 * opaque installation identifier; it is evidence of which installation the
 * entries were reviewed for, never proof of access on its own.
 */
export interface DaemonPeer {
  readonly peerId: string
  readonly allowUnverifiedDaemonAuthority: boolean
  readonly guidanceRequired: boolean
  readonly servedMethods: ReadonlySet<string> | undefined
}

// ---------------------------------------------------------------------------
// Failure translation: link failures become operation failures, preserving
// delivery certainty, refusal reason and version facts
// ---------------------------------------------------------------------------

type LinkFailure = NotDelivered | PossiblyDelivered | PeerRejected | BadReply | IncompatibleVersion

const translateLinkFailure = (failure: LinkFailure): OperationFailure =>
  Match.value(failure).pipe(
    Match.when(
      { _tag: "NotDelivered" },
      (variant) =>
        new TargetUnavailable({
          message:
            "the daemon did not receive the " + variant.method + " request: " + variant.message,
        }),
    ),
    Match.when(
      { _tag: "PossiblyDelivered" },
      (variant) =>
        new DeliveryUncertain({
          message:
            "the " +
            variant.method +
            " outcome is uncertain; the request may have executed on the daemon",
        }),
    ),
    Match.when(
      { _tag: "PeerRejected" },
      (variant) =>
        new PeerFailure({
          code:
            variant.code === -32601
              ? "daemon_method_unsupported"
              : "daemon_rejected_" + String(variant.code),
          message: "the daemon rejected the request: " + variant.message,
        }),
    ),
    Match.when(
      { _tag: "BadReply" },
      (variant) =>
        new MalformedPeerReply({
          message:
            "the daemon reply to " +
            variant.method +
            " was malformed; this does not prove the request failed to execute",
        }),
    ),
    Match.when(
      { _tag: "IncompatibleVersion" },
      (variant) =>
        new TargetUnavailable({
          message:
            "the daemon speaks protocol " +
            variant.peerVersion +
            ", which this link cannot serve (supports " +
            variant.supportedVersion +
            ")",
        }),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Input decoding: exactly the reviewed params schema; absent input decodes
// as the empty object when the schema admits it
// ---------------------------------------------------------------------------

const decodeParams =
  (method: string, binding: Binding<Schema.Json, Schema.Json>) =>
  (input: Schema.Json): Effect.Effect<Readonly<Record<string, Schema.Json>>, InvalidInput> => {
    // An absent argument object — undefined at the boundary or JSON null —
    // means "no fields"; anything else is validated strictly, so malformed
    // input never silently becomes an empty request.
    const effective = input === undefined || input === null ? {} : input

    const decoded = Option.getOrUndefined(binding.decodeParams(effective))

    if (decoded === undefined) {
      return Effect.fail(
        new InvalidInput({
          message: "arguments do not match the reviewed schema for " + method,
        }),
      )
    }

    const record = Option.getOrUndefined(decodeJsonRecord(decoded))

    if (record === undefined) {
      return Effect.fail(
        new InvalidInput({ message: "arguments for " + method + " must form an object" }),
      )
    }

    return Effect.succeed(record)
  }

// ---------------------------------------------------------------------------
// Authority demand extraction
// ---------------------------------------------------------------------------

/**
 * The explicit excess the parameters state, as structured demand facts.
 * Both the level field and any auto mode above it are reported; the demand
 * carries the highest one so a single decision covers every spelled field.
 */
const requestedLevelOf = (
  record: Readonly<Record<string, Schema.Json>>,
): AutonomyLevel | undefined => {
  let highest: AutonomyLevel | undefined

  for (const level of explicitLevelsOf(record)) {
    if (highest === undefined || !levelWithinCap(level, highest)) highest = level
  }

  return highest
}

/**
 * The explicit authority facts an initialize or settings request states at
 * the boundary: the highest explicit level and an explicit unsafe-skip.
 * Explicit evidence is what the owner claims was checked — for
 * session-configuring operations the narrowed wire fields themselves are
 * exactly what the daemon receives, so the evidence matches the dispatch.
 */
const explicitEvidenceOf = (
  ceiling: AutonomyLevel,
  input: Readonly<Record<string, Schema.Json>>,
): Evidence => {
  const level = readLevelField(input["autonomyLevel"])
  const mode = readModeField(input["autonomyMode"])
  const granted = mode === undefined ? undefined : modeLevelOf(mode)

  const requestedLevel =
    level !== undefined && granted !== undefined
      ? levelWithinCap(level, granted)
        ? granted
        : level
      : (level ?? granted)

  const skip = input["skipPermissionsUnsafe"] === true ? true : undefined

  const inner = requestedLevel === undefined ? { ceiling } : { ceiling, requestedLevel }

  const complete = skip === undefined ? inner : { ...inner, skipPermissionsUnsafe: skip }

  return Evidence.Explicit(complete)
}

// ---------------------------------------------------------------------------
// Initialize narrowing: one authorized defaults read, explicit effective
// fields on the wire, never a persistent-defaults write
// ---------------------------------------------------------------------------

/**
 * The one-narrowing-per-invocation cache. `evidence` and `perform` both need
 * the narrowed fields — evidence so the decision judges exactly what the
 * wire will carry, perform so the wire carries exactly what was decided —
 * and the capabilities pipeline hands both the identical decoded object, so
 * a WeakMap keyed on that object shares one snapshot read between them
 * without ever widening the input type. Entries are garbage-collected with
 * the invocation's decoded input; nothing persists across invocations.
 */
type Narrowed = {
  readonly effect: Effect.Effect<Readonly<Record<string, Schema.Json>>, OperationFailure>
}

const narrowingCache = new WeakMap<Readonly<Record<string, Schema.Json>>, Narrowed>()

/**
 * Narrows an omitted initialize authority field onto the request using one
 * read of the peer's settings snapshot. A within-cap observed value is kept,
 * an above-cap one is clamped, and an absent one falls back to no auto
 * authority. The snapshot read itself is a reviewed pure read; its reply is
 * never treated as proof of enforcement — it only bounds what this request
 * explicitly asks for.
 */
const narrowInitialize = (
  link: DaemonLinkService,
  defaultsBinding: Binding<Schema.Json, Schema.Json> | undefined,
  cap: AutonomyLevel,
  record: Readonly<Record<string, Schema.Json>>,
): Effect.Effect<Readonly<Record<string, Schema.Json>>, OperationFailure> => {
  const levelOmitted = readLevelField(record["autonomyLevel"]) === undefined
  const modeOmitted = readModeField(record["autonomyMode"]) === undefined

  const pinSkip = (wire: Readonly<Record<string, Schema.Json>>): typeof wire =>
    wire["skipPermissionsUnsafe"] === undefined && cap !== "high"
      ? { ...wire, skipPermissionsUnsafe: false }
      : wire

  if (!levelOmitted && !modeOmitted) {
    return Effect.succeed(pinSkip(record))
  }

  if (defaultsBinding === undefined) {
    return Effect.fail(
      new OperationUnverifiable({
        message: "the peer does not serve the settings snapshot read initialize narrowing requires",
        reason: "defaults_read_unavailable",
      }),
    )
  }

  const cwd = record["cwd"]

  const snapshotParams: Schema.Json =
    cwd !== undefined && Schema.is(Schema.String)(cwd) ? { cwd } : {}

  return Effect.gen(function* () {
    const snapshot = yield* link
      .exchange(defaultsBinding, snapshotParams, "before_handoff")
      .pipe(Effect.mapError(translateLinkFailure))

    const fields = Option.getOrUndefined(decodeJsonRecord(snapshot))

    if (fields === undefined) {
      return yield* Effect.fail(
        new MalformedPeerReply({
          message: "daemon.get_default_settings returned no settings object",
        }),
      )
    }

    const withLevel: Readonly<Record<string, Schema.Json>> = levelOmitted
      ? { ...record, autonomyLevel: boundedLevel(fields["autonomyLevel"], cap) }
      : { ...record }

    const withMode: Readonly<Record<string, Schema.Json>> = modeOmitted
      ? { ...withLevel, autonomyMode: boundedMode(fields["autonomyMode"], cap) }
      : withLevel

    return pinSkip(withMode)
  })
}

/**
 * The initialize level written when the field is omitted: a within-cap
 * observed default is kept, an above-cap one is clamped to the ceiling, and
 * an absent one becomes `off`, which grants no auto authority.
 */
const boundedLevel = (value: Schema.Json | undefined, cap: AutonomyLevel): AutonomyLevel => {
  const observed = readLevelField(value)

  if (observed === undefined) return "off"

  return levelWithinCap(observed, cap) ? observed : cap
}

/**
 * The initialize mode written when the field is omitted: `normal` and
 * `spec` carry through as read, an auto mode above the ceiling becomes the
 * ceiling's own mode spelling, and an absent one becomes `normal`.
 */
const boundedMode = (
  value: Schema.Json | undefined,
  cap: AutonomyLevel,
): "normal" | "spec" | "auto-low" | "auto-medium" | "auto-high" => {
  const observed = readModeField(value)

  if (observed === undefined) return "normal"

  const observedLevel = modeLevelOf(observed)

  if (observedLevel !== undefined && !levelWithinCap(observedLevel, cap)) return capModeOf(cap)

  return observed
}

/**
 * Memoizes `narrowInitialize` on the decoded input object so one invocation
 * reads at most one snapshot even though evidence construction and perform
 * both narrow. `Effect.cached` computes the narrowing once per input object
 * and shares the result — including a shared failure — between the two
 * pipeline stages, so evidence and perform can never disagree about the
 * same invocation.
 */
const narrowedWire = (
  link: DaemonLinkService,
  defaultsBinding: Binding<Schema.Json, Schema.Json> | undefined,
  cap: AutonomyLevel,
  record: Readonly<Record<string, Schema.Json>>,
): Effect.Effect<Readonly<Record<string, Schema.Json>>, OperationFailure> => {
  const cached = narrowingCache.get(record)

  if (cached !== undefined) return cached.effect

  // SAFETY: `Effect.cached` never fails to construct the caching wrapper
  // itself — it only defers evaluation — so building it synchronously here
  // cannot throw or defect.
  const memoized = Effect.runSync(
    Effect.cached(narrowInitialize(link, defaultsBinding, cap, record)),
  )

  narrowingCache.set(record, { effect: memoized })

  return memoized
}

// ---------------------------------------------------------------------------
// Definition assembly
// ---------------------------------------------------------------------------

interface BindContext {
  readonly link: DaemonLinkService
  readonly peer: DaemonPeer
  readonly ceiling: AutonomyLevel
  readonly defaultsBinding: Binding<Schema.Json, Schema.Json> | undefined
}

/**
 * The catalog replay fact for one effect kind. Pure reads are safe to
 * discover as retriable; everything else is a write the catalog records as
 * non-retryable.
 */
const replayPolicyOf = (effect: MethodSemantics["effect"]): "safe_read" | "no_retry" =>
  effect === "read" ? "safe_read" : "no_retry"

const buildDefinition = (
  ctx: BindContext,
  binding: Binding<Schema.Json, Schema.Json>,
  semantics: MethodSemantics,
): Definition<Readonly<Record<string, Schema.Json>>, Schema.Json> => {
  const method = binding.method
  const id = operationIdOf(method)
  const family = familyOf(method)
  const peer = ctx.peer
  const targetRef: TargetRef = { kind: "daemon", id: peer.peerId }

  const baseFacts = {
    id,
    family,
    description: semantics.description,
    // SAFETY: the binding's params schema is the reviewed JSON Schema object
    // the build-time extractor emitted; `JsonSchemaObject` is structurally
    // identical and the assertion only crosses the module boundary.
    inputSchema: binding.paramsSchema as JsonSchemaObject,
    effect: semantics.effect,
    replay: replayPolicyOf(semantics.effect),
    annotations: {
      readOnlyHint: semantics.effect === "read",
      destructiveHint: semantics.destructive,
      idempotentHint: semantics.effect === "read",
      openWorldHint: true,
    },
  }

  const facts: OperationFacts = peer.guidanceRequired
    ? { ...baseFacts, prerequisite: { edition: "droid-v1" } }
    : baseFacts

  const decode = decodeParams(method, binding)

  const demand = (input: Readonly<Record<string, Schema.Json>>): Demand => {
    const base: Demand = { effect: semantics.effect, operation: method }

    if (semantics.effect === "read") return base

    const requestedLevel = requestedLevelOf(input)
    const skip = input["skipPermissionsUnsafe"] === true ? true : undefined

    const withLevel = requestedLevel === undefined ? base : { ...base, requestedLevel }

    return skip === undefined ? withLevel : { ...withLevel, skipPermissionsUnsafe: skip }
  }

  const unprovableReason =
    semantics.effect === "session_load"
      ? "a saved session restores authority no request field can narrow"
      : "queued work runs under the session's own authority, which no read reply proves"

  const operationKind =
    semantics.effect === "session_load" ? ("load_session" as const) : ("queued_work" as const)

  const evidence = (
    input: Readonly<Record<string, Schema.Json>>,
  ): Effect.Effect<Evidence, OperationFailure> => {
    if (semantics.effect === "session_load" || semantics.effect === "queued_work") {
      return Effect.succeed(
        Evidence.Unprovable({
          ceiling: ctx.ceiling,
          reason: unprovableReason,
          operationKind,
        }),
      )
    }

    /*
     * Initialize requests that omit authority fields inherit them: the
     * evidence must describe the effective authority the wire will carry,
     * not the omission. Narrowing runs before the decision — reading one
     * defaults snapshot through the separately reviewed read binding — so a
     * later settings change cannot fill the gap, and the decision judges
     * the exact level and skip the dispatch will ask for.
     *
     * Explicit excess is the exception: the demand already states it, the
     * decision is a known denial regardless of what the snapshot holds, and
     * a denied request must never dispatch anything — not even the
     * narrowing read. In that case evidence is constructed from the raw
     * input and no RPC runs.
     */
    if (semantics.initialize) {
      const explicitLevel = requestedLevelOf(input)
      const excessLevel = explicitLevel !== undefined && !levelWithinCap(explicitLevel, ctx.ceiling)
      const excessSkip = input["skipPermissionsUnsafe"] === true && ctx.ceiling !== "high"

      if (excessLevel || excessSkip) {
        return Effect.succeed(explicitEvidenceOf(ctx.ceiling, input))
      }

      return Effect.map(narrowedWire(ctx.link, ctx.defaultsBinding, ctx.ceiling, input), (wire) =>
        explicitEvidenceOf(ctx.ceiling, wire),
      )
    }

    return Effect.succeed(explicitEvidenceOf(ctx.ceiling, input))
  }

  const perform = (
    _grant: Grant,
    input: Readonly<Record<string, Schema.Json>>,
  ): Effect.Effect<Schema.Json, OperationFailure> => {
    const send = (
      wire: Readonly<Record<string, Schema.Json>>,
    ): Effect.Effect<Schema.Json, OperationFailure> => {
      const replay: ReplayPermission =
        semantics.effect === "read" ? "idempotent_after_handoff" : "never"

      return ctx.link.exchange(binding, wire, replay).pipe(Effect.mapError(translateLinkFailure))
    }

    /*
     * The narrowed wire is the same memoized computation evidence used, so
     * exactly one snapshot read serves the whole invocation and the dispatch
     * sends precisely what the decision judged.
     */
    if (semantics.initialize) {
      return Effect.flatMap(narrowedWire(ctx.link, ctx.defaultsBinding, ctx.ceiling, input), send)
    }

    return send(input)
  }

  const sensitiveKeys = semantics.sensitive
    ? ["token", "clientSecret", "apiKey", "headers"]
    : undefined

  const definition: Definition<Readonly<Record<string, Schema.Json>>, Schema.Json> = {
    facts,
    decode,
    target: () => targetRef,
    demand,
    evidence: (_who, input) => evidence(input),
    perform,
    classify: (_input, output) => {
      const payload = { payload: ReleasePayload.JsonValue({ value: output }) }

      return sensitiveKeys === undefined ? payload : { ...payload, sensitiveKeys }
    },
  }

  return definition
}

/**
 * Binds every operation entry the installation serves. The iteration is
 * typed uniformly because every definition shares one input/output pair —
 * the reviewed JSON parameter record and the reviewed JSON reply — so no
 * heterogeneous collection ever widens or re-asserts a type.
 */
export const bindEntries = (
  capabilities: CapabilitiesApi,
  link: DaemonLinkService,
  peer: DaemonPeer,
  ceiling: AutonomyLevel,
  bindings: ReadonlyArray<Binding<Schema.Json, Schema.Json>>,
  defaultsBinding: Binding<Schema.Json, Schema.Json> | undefined,
): ReadonlyArray<BoundOperation> => {
  const ctx: BindContext = { link, peer, ceiling, defaultsBinding }

  return bindings.map((binding) =>
    capabilities.bind(buildDefinition(ctx, binding, semanticsOf(binding.method))),
  )
}
