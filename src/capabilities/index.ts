/**
 * `capabilities` owns typed binding, assembly and invocation — not the list
 * of concrete operations.
 *
 * An owner supplies identity, aliases, codec, effect/replay facts, guidance
 * prerequisite, target and demand extraction, a typed body and output
 * classification. `bind` closes over the matching input/output types once, so
 * a heterogeneous `Catalog` collects unlike entries with no dispatch cast and
 * no handler map: each bound handle carries its own typed pipeline behind the
 * module-private brand, and `invoke` reaches it by canonical id or unique
 * alias lookup alone.
 *
 * The invocation order is fixed and enforced by the binder, never left to the
 * supplied body:
 *
 *   1. resolve the id (canonical or unique alias) in the catalog
 *   2. decode the raw input — invalid input fails before every other gate
 *   3. guidance prerequisite check for this conversation
 *   4. target delegation check through `caller`
 *   5. evidence construction and the `authority` grant decision
 *   6. the typed `perform` body, with the grant in hand
 *   7. classification and `disclosure` release for the client audience
 *
 * Failure messages and details pass through the error audience before
 * surfacing, so a secret embedded in a peer rejection or a conflict detail
 * cannot cross the boundary inside an error string. `perform` receives a
 * fresh invocation-scoped protection sink for secrets only known once they
 * are committed to a transport, so rotating credentials cannot race the
 * release that follows. Conflict continuation values cross unchanged or not
 * at all, and a release refusal after a non-read `perform` is uncertain
 * delivery rather than a definite failure. Success output and error output
 * face the same policy.
 *
 * `annotations`, `effect`, `replay` and `prerequisite` are explicit
 * structural facts supplied by the owner. Nothing here parses a description,
 * an id prefix or a hint to derive policy: `withReplacedDescription` exists
 * precisely so the structural proof can rewrite every description while
 * grants, denials and annotations remain bit-for-bit unchanged.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { Authority, Evidence } from "../authority/index.ts"
import type { AutonomyLevel, Demand, EffectKind, Grant } from "../authority/index.ts"
import type { AuthorityUnverifiable, Denied } from "../authority/index.ts"
import { Callers, NotVisible } from "../caller/index.ts"
import type { Caller, Conversation, TargetRef } from "../caller/index.ts"
import type { DelegationUnavailable } from "../caller/index.ts"
import { Disclosure, ReleasePayload } from "../disclosure/index.ts"
import type { Audience, JsonProtection, Released } from "../disclosure/index.ts"
import type { DisclosureRefused, ProtectedBytes } from "../disclosure/index.ts"
import { Guidance } from "../guidance/index.ts"
import type { GuidanceRequired, Prerequisite } from "../guidance/index.ts"

// ---------------------------------------------------------------------------
// Structural facts
// ---------------------------------------------------------------------------

export type OperationId = string

/** The complete runtime vocabulary of operation families. */
export const OPERATION_FAMILIES = [
  "server",
  "skill",
  "session",
  "rest",
  "context",
  "daemon",
  "droid",
] as const

export type OperationFamily = (typeof OPERATION_FAMILIES)[number]

export type ReplayPolicy = "safe_read" | "no_retry"

export type JsonSchemaObject = { readonly [key: string]: Schema.Json }

/**
 * Presentation hints a client may use to render affordances. They are never
 * consulted for a policy decision here or downstream.
 */
export interface OperationAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

/**
 * The explicit facts of one operation. Every field that influences a policy
 * decision is stated structurally: `effect` and `replay` are chosen by the
 * owner at authoring time, `prerequisite` names the required guide edition,
 * and `description` carries no meaning beyond display.
 */
export interface OperationFacts {
  readonly id: OperationId
  readonly aliases?: ReadonlyArray<OperationId>
  readonly family: OperationFamily
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly effect: EffectKind
  readonly replay: ReplayPolicy
  readonly annotations: OperationAnnotations
  readonly prerequisite?: Prerequisite
}

/** The admitted caller plus the conversation scope the invocation runs in. */
export interface Invocation {
  readonly caller: Caller
  readonly conversation: Conversation
}

/** The discovery view of one visible operation. */
export interface Description {
  readonly id: OperationId
  readonly aliases: ReadonlyArray<OperationId>
  readonly family: OperationFamily
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly annotations: OperationAnnotations
  readonly requiresGuidance: boolean
}

// ---------------------------------------------------------------------------
// Operation failures: what a typed `perform` body may fail with
// ---------------------------------------------------------------------------

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class PeerFailure extends Schema.TaggedError<PeerFailure>()("PeerFailure", {
  code: Schema.String,
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class MalformedPeerReply extends Schema.TaggedError<MalformedPeerReply>()(
  "MalformedPeerReply",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export class DeliveryUncertain extends Schema.TaggedError<DeliveryUncertain>()(
  "DeliveryUncertain",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export class TargetUnavailable extends Schema.TaggedError<TargetUnavailable>()(
  "TargetUnavailable",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  },
) {}

export class OperationConflict extends Schema.TaggedError<OperationConflict>()(
  "OperationConflict",
  {
    message: Schema.String,
    currentVersion: Schema.optional(Schema.String),
    currentSequence: Schema.optional(Schema.String),
  },
) {}

export class OperationNotVisible extends Schema.TaggedError<OperationNotVisible>()(
  "OperationNotVisible",
  {
    message: Schema.String,
  },
) {}

export class OperationUnverifiable extends Schema.TaggedError<OperationUnverifiable>()(
  "OperationUnverifiable",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

export class OperationDenied extends Schema.TaggedError<OperationDenied>()("OperationDenied", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export type OperationFailure =
  | InvalidInput
  | PeerFailure
  | MalformedPeerReply
  | DeliveryUncertain
  | TargetUnavailable
  | OperationConflict
  | OperationNotVisible
  | OperationUnverifiable
  | OperationDenied

// ---------------------------------------------------------------------------
// Release input (mirrors the disclosure shape; restated so an operation
// owner never needs a disclosure edge of its own)
// ---------------------------------------------------------------------------

export type ReleaseInput = {
  readonly payload: ReleasePayload
  readonly sensitiveValues?: ReadonlyArray<string>
  readonly sensitiveKeys?: ReadonlyArray<string>
  readonly jsonProtection?: JsonProtection
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * Registers values that became sensitive during one invocation, such as the
 * exact credential a transport placed on the wire. The binder creates a fresh
 * collector for every execution and applies it to both outcome release and
 * failure scrubbing, so credential rotation cannot race disclosure.
 */
export type ProtectValues = (values: ReadonlyArray<string>) => Effect.Effect<void>

/**
 * The owner-supplied typed definition of one operation. `evidence` is
 * optional: when omitted, the binder constructs explicit evidence from the
 * authority ceiling plus the demand's own level and permission fields.
 * `sensitiveValues` supplies installation-scoped secrets independently of
 * input; the binder applies them to both the client release and the error
 * audience. Input-dependent secrets still belong to `classify`, while secrets
 * only known once `perform` reaches a transport belong to `protect`.
 */
export interface Definition<I, O> {
  readonly facts: OperationFacts
  readonly decode: (input: Schema.Json) => Effect.Effect<I, InvalidInput>
  readonly target: (input: I) => TargetRef
  readonly demand: (input: I) => Demand
  readonly evidence?: (who: Invocation, input: I) => Effect.Effect<Evidence, OperationFailure>
  readonly sensitiveValues?: () => Effect.Effect<ReadonlyArray<string>>
  readonly perform: (
    grant: Grant,
    input: I,
    who: Invocation,
    protect: ProtectValues,
  ) => Effect.Effect<O, OperationFailure>
  readonly classify: (input: I, output: O) => ReleaseInput
}

// ---------------------------------------------------------------------------
// Opaque bound-operation and catalog handles
// ---------------------------------------------------------------------------

const boundBrand: unique symbol = Symbol("droid-mcp-v2/capabilities/BoundOperation")
const catalogBrand: unique symbol = Symbol("droid-mcp-v2/capabilities/Catalog")

/**
 * The erased execution closure behind one `BoundOperation`. It is wired end
 * to end inside `bind`, where the input and output types are still in scope
 * and every gate service is closed over: raw JSON goes in, a released client
 * value or a typed invocation failure comes out. No step of the owner's
 * typed pipeline is reachable from outside, so there is no dispatch cast,
 * no handler map and no path to `perform` that skips a gate.
 */
type ErasedExecution = (
  who: Invocation,
  input: Schema.Json,
) => Effect.Effect<Released<"client">, InvocationFailure>

/**
 * An opaque bound operation. The only way to execute it is `invoke` on the
 * owning catalog: there is no public path to `perform` that skips the decode,
 * guidance, delegation, authority and release gates.
 */
export interface BoundOperation {
  readonly [boundBrand]: true
  readonly facts: OperationFacts
}

/** Hidden body carried behind the opaque public handle. */
interface BoundBody {
  readonly [boundBrand]: true
  readonly facts: OperationFacts
  readonly execute: ErasedExecution
}

/**
 * An opaque immutable catalog. Lookup is deterministic: a canonical id or a
 * unique alias resolves to exactly one entry, and assembly rejects any
 * collision before the catalog exists.
 */
export interface Catalog {
  readonly [catalogBrand]: true
  readonly size: number
}

interface CatalogBody {
  readonly [catalogBrand]: true
  readonly size: number
  readonly entries: ReadonlyArray<BoundBody>
  readonly byKey: ReadonlyMap<string, BoundBody>
}

const readBound = (operation: BoundOperation): BoundBody =>
  // SAFETY: the brand is module-private, so every `BoundOperation` in
  // existence was constructed by `bind` below with exactly this body.
  operation as BoundBody

const readCatalog = (catalog: Catalog): CatalogBody =>
  // SAFETY: the brand is module-private, so every `Catalog` in existence was
  // constructed by `assemble` below with exactly this body.
  catalog as CatalogBody

// ---------------------------------------------------------------------------
// Assembly and invocation failures
// ---------------------------------------------------------------------------

export class DuplicateIdentity extends Schema.TaggedError<DuplicateIdentity>()(
  "DuplicateIdentity",
  {
    message: Schema.String,
    id: Schema.String,
  },
) {}

export class InvalidEntry extends Schema.TaggedError<InvalidEntry>()("InvalidEntry", {
  message: Schema.String,
  id: Schema.String,
  reason: Schema.String,
}) {}

/** An invocation or lookup against an id the catalog does not publish. */
export class OperationNotFound extends Schema.TaggedError<OperationNotFound>()(
  "OperationNotFound",
  {
    message: Schema.String,
    id: Schema.String,
  },
) {}

/*
 * The invocation-surface translations below keep the exact wire tags of the
 * upstream failures they translate — `"GuidanceRequired"`, `"Denied"`,
 * `"authority_unverifiable"`, `"DisclosureRefused"`, `"ProtectedBytes"` — so
 * a consumer matching on `_tag` sees one vocabulary. Their class names carry
 * the `Failure` suffix inside this module only to keep the translation
 * imports unambiguous; the tags are the contract.
 */
export class GuidanceRequiredFailure extends Schema.TaggedError<GuidanceRequiredFailure>()(
  "GuidanceRequired",
  {
    message: Schema.String,
    edition: Schema.String,
  },
) {}

export class DeniedFailure extends Schema.TaggedError<DeniedFailure>()("Denied", {
  message: Schema.String,
  requestedLevel: Schema.optional(Schema.String),
  ceiling: Schema.String,
  reason: Schema.String,
}) {}

export class AuthorityUnverifiableFailure extends Schema.TaggedError<AuthorityUnverifiableFailure>()(
  "authority_unverifiable",
  {
    message: Schema.String,
    reason: Schema.String,
    operation: Schema.optional(Schema.String),
  },
) {}

export class DisclosureRefusedFailure extends Schema.TaggedError<DisclosureRefusedFailure>()(
  "DisclosureRefused",
  {
    message: Schema.String,
    sink: Schema.String,
    reason: Schema.String,
  },
) {}

export class ProtectedBytesFailure extends Schema.TaggedError<ProtectedBytesFailure>()(
  "ProtectedBytes",
  {
    message: Schema.String,
    contentType: Schema.String,
  },
) {}

/**
 * Every way one `invoke` can fail: invalid input, invisible or unsupported
 * entry, guidance required, denial, unverifiable authority, peer rejection,
 * malformed reply, uncertain delivery, conflict and release refusal. The
 * union is closed; a caller can match on it exhaustively.
 */
export type InvocationFailure =
  | InvalidInput
  | OperationNotFound
  | GuidanceRequiredFailure
  | DeniedFailure
  | AuthorityUnverifiableFailure
  | PeerFailure
  | MalformedPeerReply
  | DeliveryUncertain
  | TargetUnavailable
  | OperationConflict
  | OperationNotVisible
  | OperationUnverifiable
  | OperationDenied
  | DisclosureRefusedFailure
  | ProtectedBytesFailure

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface CapabilitiesApi {
  readonly bind: <I, O>(definition: Definition<I, O>) => BoundOperation
  readonly assemble: (
    entries: ReadonlyArray<BoundOperation>,
  ) => Effect.Effect<Catalog, DuplicateIdentity | InvalidEntry>
  readonly available: (
    catalog: Catalog,
    who: Invocation,
  ) => Effect.Effect<ReadonlyArray<Description>, NotVisible>
  readonly describe: (
    catalog: Catalog,
    who: Invocation,
    id: OperationId,
  ) => Effect.Effect<Description, NotVisible>
  readonly invoke: (
    catalog: Catalog,
    who: Invocation,
    id: OperationId,
    input: Schema.Json,
  ) => Effect.Effect<Released<"client">, InvocationFailure>
}

export class Capabilities extends Context.Service<Capabilities, CapabilitiesApi>()(
  "droid-mcp-v2/Capabilities",
) {}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const blank = (value: string): boolean => value.trim().length === 0

const descriptionOf = (body: BoundBody): Description => ({
  id: body.facts.id,
  aliases: body.facts.aliases ?? [],
  family: body.facts.family,
  description: body.facts.description,
  inputSchema: body.facts.inputSchema,
  annotations: body.facts.annotations,
  requiresGuidance: body.facts.prerequisite !== undefined,
})

/**
 * Returns a copy of `operation` whose description alone is replaced. Every
 * other fact — annotations, effect, replay, prerequisite, target, demand — is
 * preserved exactly, because none of them is ever derived from the text. This
 * is the witness Structural Proof 2 uses to replace every installed
 * description while asserting zero policy or grant differences.
 */
export const withReplacedDescription = (
  operation: BoundOperation,
  newDescription: string,
): BoundOperation => {
  const body = readBound(operation)

  const rebound: BoundBody = {
    [boundBrand]: true,
    facts: { ...body.facts, description: newDescription },
    execute: body.execute,
  }

  return rebound
}

const notVisible = (id: OperationId): NotVisible =>
  new NotVisible({
    message: "operation is not visible to this caller",
    resourceKind: "operation",
    resourceId: id,
  })

// ---------------------------------------------------------------------------
// Failure scrubbing through the error audience
// ---------------------------------------------------------------------------

/** Scrubbed copies of one failure's free-text and conflict-continuation fields. */
interface ScrubbedText {
  readonly message?: string
  readonly detail?: string
  readonly currentVersion?: string
  readonly currentSequence?: string
}

/**
 * Rebuilds one operation failure with scrubbed fields installed. The scrubbed
 * record is authoritative: an absent scrubbed detail or conflict field means
 * the original does not cross the boundary, never that the unscrubbed
 * original is restored. Each branch constructs the error through its own
 * tagged constructor, so the rebuild is total and no prototype surgery is
 * involved.
 */
const rebuildFailure = (failure: OperationFailure, text: ScrubbedText): OperationFailure =>
  Match.value(failure).pipe(
    Match.when({ _tag: "InvalidInput" }, (variant) =>
      text.detail !== undefined
        ? new InvalidInput({ message: text.message ?? variant.message, detail: text.detail })
        : new InvalidInput({ message: text.message ?? variant.message }),
    ),
    Match.when({ _tag: "PeerFailure" }, (variant) =>
      text.detail !== undefined
        ? new PeerFailure({
            code: variant.code,
            message: text.message ?? variant.message,
            detail: text.detail,
          })
        : new PeerFailure({ code: variant.code, message: text.message ?? variant.message }),
    ),
    Match.when({ _tag: "MalformedPeerReply" }, (variant) =>
      text.detail !== undefined
        ? new MalformedPeerReply({ message: text.message ?? variant.message, detail: text.detail })
        : new MalformedPeerReply({ message: text.message ?? variant.message }),
    ),
    Match.when({ _tag: "DeliveryUncertain" }, (variant) =>
      text.detail !== undefined
        ? new DeliveryUncertain({ message: text.message ?? variant.message, detail: text.detail })
        : new DeliveryUncertain({ message: text.message ?? variant.message }),
    ),
    Match.when({ _tag: "TargetUnavailable" }, (variant) =>
      variant.code !== undefined
        ? new TargetUnavailable({ message: text.message ?? variant.message, code: variant.code })
        : new TargetUnavailable({ message: text.message ?? variant.message }),
    ),
    Match.when({ _tag: "OperationConflict" }, (variant) => {
      const base = { message: text.message ?? variant.message }

      if (text.currentVersion !== undefined && text.currentSequence !== undefined) {
        return new OperationConflict({
          ...base,
          currentVersion: text.currentVersion,
          currentSequence: text.currentSequence,
        })
      }

      if (text.currentVersion !== undefined) {
        return new OperationConflict({ ...base, currentVersion: text.currentVersion })
      }

      if (text.currentSequence !== undefined) {
        return new OperationConflict({ ...base, currentSequence: text.currentSequence })
      }

      return new OperationConflict(base)
    }),
    Match.when(
      { _tag: "OperationNotVisible" },
      (variant) => new OperationNotVisible({ message: text.message ?? variant.message }),
    ),
    Match.when(
      { _tag: "OperationUnverifiable" },
      (variant) =>
        new OperationUnverifiable({
          message: text.message ?? variant.message,
          reason: variant.reason,
        }),
    ),
    Match.when(
      { _tag: "OperationDenied" },
      (variant) =>
        new OperationDenied({
          message: text.message ?? variant.message,
          reason: variant.reason,
        }),
    ),
    Match.exhaustive,
  )

interface ErrorFields {
  readonly message: string
  readonly detail?: string
  readonly currentVersion?: string
  readonly currentSequence?: string
}

/**
 * Extracts the fields of one failure that cross the error audience. Every
 * variant carries a `message`; some carry a `detail`, and a conflict carries
 * continuation values a client may reuse exactly.
 */
const errorFieldsOf = (failure: OperationFailure): ErrorFields =>
  Match.value(failure).pipe(
    Match.when({ _tag: "InvalidInput" }, (variant) =>
      variant.detail !== undefined
        ? { message: variant.message, detail: variant.detail }
        : { message: variant.message },
    ),
    Match.when({ _tag: "PeerFailure" }, (variant) =>
      variant.detail !== undefined
        ? { message: variant.message, detail: variant.detail }
        : { message: variant.message },
    ),
    Match.when({ _tag: "MalformedPeerReply" }, (variant) =>
      variant.detail !== undefined
        ? { message: variant.message, detail: variant.detail }
        : { message: variant.message },
    ),
    Match.when({ _tag: "DeliveryUncertain" }, (variant) =>
      variant.detail !== undefined
        ? { message: variant.message, detail: variant.detail }
        : { message: variant.message },
    ),
    Match.when({ _tag: "OperationConflict" }, (variant) => {
      if (variant.currentVersion !== undefined && variant.currentSequence !== undefined) {
        return {
          message: variant.message,
          currentVersion: variant.currentVersion,
          currentSequence: variant.currentSequence,
        }
      }

      if (variant.currentVersion !== undefined) {
        return { message: variant.message, currentVersion: variant.currentVersion }
      }

      if (variant.currentSequence !== undefined) {
        return { message: variant.message, currentSequence: variant.currentSequence }
      }

      return { message: variant.message }
    }),
    Match.orElse((variant) => ({ message: variant.message })),
  )

/** The scrubbed error record, decoded at the boundary of the error audience. */
const ScrubbedErrorText = Schema.Struct({
  message: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  currentVersion: Schema.optional(Schema.String),
  currentSequence: Schema.optional(Schema.String),
})

interface ErrorAudienceAccess {
  readonly audience: (sink: "error", recipientId: string) => Effect.Effect<Audience<"error">>
  readonly release: (
    input: ReleaseInput,
    to: Audience<"error">,
  ) => Effect.Effect<Released<"error">, DisclosureRefused | ProtectedBytes>
}

/**
 * The free-text fields of a failure are released to the error audience and
 * the released copies are read back through a schema, so the surfaced error
 * carries exactly what the error sink would receive. Conflict continuation
 * values cross unchanged or not at all: a refused or malformed release swaps
 * in an opaque message and strips them rather than leaking or corrupting one.
 */
const ERROR_JSON_PROTECTION: JsonProtection = {
  fixedKeys: ["message", "detail", "currentVersion", "currentSequence"],
  atomicKeys: ["currentVersion", "currentSequence"],
}

const scrubFailureText = (
  access: ErrorAudienceAccess,
  who: Invocation,
  failure: OperationFailure,
  sensitiveValues: ReadonlyArray<string>,
): Effect.Effect<OperationFailure, never> =>
  Effect.gen(function* () {
    const fields = errorFieldsOf(failure)
    const audience = yield* access.audience("error", String(who.caller.id))

    const entries: Array<readonly [string, string]> = [["message", fields.message]]

    if (fields.detail !== undefined) entries.push(["detail", fields.detail])

    if (fields.currentVersion !== undefined) entries.push(["currentVersion", fields.currentVersion])

    if (fields.currentSequence !== undefined) {
      entries.push(["currentSequence", fields.currentSequence])
    }

    const record = Object.fromEntries(entries)

    const outcome = yield* Effect.match(
      access.release(
        {
          payload: ReleasePayload.JsonValue({ value: record }),
          sensitiveValues,
          jsonProtection: ERROR_JSON_PROTECTION,
        },
        audience,
      ),
      {
        onFailure: () => ({ ok: false as const }),
        onSuccess: (released) => ({ ok: true as const, payload: released.payload }),
      },
    )

    if (!outcome.ok) {
      return rebuildFailure(failure, { message: "operation failure" })
    }

    const json = ReleasePayload.$match(outcome.payload, {
      Empty: () => null,
      JsonValue: (variant) => variant.value,
      Records: () => null,
      Media: () => null,
    })

    if (json === null) return rebuildFailure(failure, { message: "operation failure" })

    const decoded = Schema.decodeUnknownOption(ScrubbedErrorText)(json)

    return Option.match(decoded, {
      onNone: () => rebuildFailure(failure, { message: "operation failure" }),
      onSome: (scrubbed) => rebuildFailure(failure, scrubbed),
    })
  })

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Gates shared by every bound operation, closed over the layer's services. */
interface GateServices {
  readonly checkGuidance: (
    who: Invocation,
    prerequisite: Prerequisite,
  ) => Effect.Effect<void, GuidanceRequiredFailure>
  readonly delegate: (
    caller: Caller,
    id: OperationId,
    target: TargetRef,
  ) => Effect.Effect<void, OperationNotVisible>
  readonly decide: (
    caller: Caller,
    target: TargetRef,
    demand: Demand,
    evidence: Evidence,
  ) => Effect.Effect<Grant, DeniedFailure | AuthorityUnverifiableFailure>
  readonly scrub: (
    who: Invocation,
    failure: OperationFailure,
    sensitiveValues: ReadonlyArray<string>,
  ) => Effect.Effect<OperationFailure>
  readonly release: (
    who: Invocation,
    input: ReleaseInput,
  ) => Effect.Effect<Released<"client">, DisclosureRefusedFailure | ProtectedBytesFailure>
  readonly ceiling: () => AutonomyLevel
}

const translateDecision = (
  decision: Denied | AuthorityUnverifiable,
): DeniedFailure | AuthorityUnverifiableFailure =>
  Match.value(decision).pipe(
    Match.when({ _tag: "authority_unverifiable" }, (variant) =>
      variant.operation !== undefined
        ? new AuthorityUnverifiableFailure({
            message: variant.message,
            reason: variant.reason,
            operation: variant.operation,
          })
        : new AuthorityUnverifiableFailure({
            message: variant.message,
            reason: variant.reason,
          }),
    ),
    Match.when({ _tag: "Denied" }, (variant) =>
      variant.requestedLevel !== undefined
        ? new DeniedFailure({
            message: variant.message,
            requestedLevel: variant.requestedLevel,
            ceiling: variant.ceiling,
            reason: variant.reason,
          })
        : new DeniedFailure({
            message: variant.message,
            ceiling: variant.ceiling,
            reason: variant.reason,
          }),
    ),
    Match.exhaustive,
  )

const translateRefusal = (
  refusal: DisclosureRefused | ProtectedBytes,
): DisclosureRefusedFailure | ProtectedBytesFailure =>
  Match.value(refusal).pipe(
    Match.when(
      { _tag: "ProtectedBytes" },
      (variant) =>
        new ProtectedBytesFailure({
          message: variant.message,
          contentType: variant.contentType,
        }),
    ),
    Match.when(
      { _tag: "DisclosureRefused" },
      (variant) =>
        new DisclosureRefusedFailure({
          message: variant.message,
          sink: variant.sink,
          reason: variant.reason,
        }),
    ),
    Match.exhaustive,
  )

const translateDelegation = (id: OperationId, failure: DelegationUnavailable) =>
  new OperationNotVisible({
    message:
      'target "' +
      failure.targetKind +
      "/" +
      failure.targetId +
      '" for operation "' +
      id +
      '" is unavailable to this caller',
  })

/**
 * Builds the per-layer `Capabilities` service. Assembly state is pure
 * validation output; every gate lives in the supplied services, and `bind`
 * closes over them so the gates an operation passes through are fixed at
 * binding time.
 */
export const capabilitiesLayer: Layer.Layer<
  Capabilities,
  never,
  Callers | Authority | Guidance | Disclosure
> = Layer.effect(
  Capabilities,
  Effect.gen(function* () {
    const callers = yield* Callers
    const authority = yield* Authority
    const guidance = yield* Guidance
    const disclosure = yield* Disclosure

    const errorAccess: ErrorAudienceAccess = {
      audience: (sink, recipientId) => disclosure.audience(sink, recipientId),
      release: (input, to) => disclosure.release(input, to),
    }

    const gates: GateServices = {
      checkGuidance: (who, prerequisite) =>
        guidance.check(who.conversation, prerequisite).pipe(
          Effect.mapError(
            (required: GuidanceRequired) =>
              new GuidanceRequiredFailure({
                message: required.message,
                edition: required.edition,
              }),
          ),
        ),

      delegate: (caller, id, target) =>
        callers.delegate(caller, target).pipe(
          Effect.mapError((unavailable: DelegationUnavailable) =>
            translateDelegation(id, unavailable),
          ),
          Effect.asVoid,
        ),

      decide: (caller, target, demand, evidence) =>
        authority.decide(caller, target, demand, evidence).pipe(Effect.mapError(translateDecision)),

      scrub: (who, failure, sensitiveValues) =>
        scrubFailureText(errorAccess, who, failure, sensitiveValues),

      release: (who, input) =>
        Effect.flatMap(disclosure.audience("client", String(who.caller.id)), (audience) =>
          disclosure.release(input, audience).pipe(Effect.mapError(translateRefusal)),
        ),

      ceiling: () => authority.ceiling(),
    }

    const bind: CapabilitiesApi["bind"] = <I, O>(definition: Definition<I, O>): BoundOperation => {
      const evidenceFor = (
        who: Invocation,
        input: I,
        demand: Demand,
      ): Effect.Effect<Evidence, OperationFailure> => {
        if (definition.evidence !== undefined) return definition.evidence(who, input)

        const ceiling: AutonomyLevel = gates.ceiling()

        const withLevel =
          demand.requestedLevel !== undefined
            ? { ceiling, requestedLevel: demand.requestedLevel }
            : { ceiling }

        const complete =
          demand.skipPermissionsUnsafe !== undefined
            ? { ...withLevel, skipPermissionsUnsafe: demand.skipPermissionsUnsafe }
            : withLevel

        return Effect.succeed(Evidence.Explicit(complete))
      }

      /*
       * The one and only erasure point. Inside this closure the owner's `I`
       * and `O` are in scope for every step; the only values crossing the
       * boundary are raw JSON in and a released client value out. Type
       * information is never discarded and re-asserted: each step consumes
       * exactly what the previous step produced.
       */
      const installationSensitiveValues = (): Effect.Effect<ReadonlyArray<string>> =>
        definition.sensitiveValues === undefined ? Effect.succeed([]) : definition.sensitiveValues()

      const execute: ErasedExecution = (who, input) =>
        Effect.gen(function* () {
          const performedSensitiveValues = new Set<string>()

          const protectValues: ProtectValues = (values) =>
            Effect.sync(() => {
              for (const value of values) {
                if (value.length > 0) performedSensitiveValues.add(value)
              }
            })

          /*
           * Every owner-authored failure — decode, evidence and perform
           * alike — crosses the error audience before it surfaces, so a
           * secret embedded in any free-text field cannot leak through a
           * failure message.
           */
          const scrubbed = <A>(
            program: Effect.Effect<A, OperationFailure>,
          ): Effect.Effect<A, OperationFailure> =>
            Effect.matchEffect(program, {
              onFailure: (failure) =>
                Effect.flatMap(installationSensitiveValues(), (sensitiveValues) =>
                  Effect.flatMap(
                    gates.scrub(who, failure, [...sensitiveValues, ...performedSensitiveValues]),
                    (clean) => Effect.fail(clean),
                  ),
                ),
              onSuccess: (value) => Effect.succeed(value),
            })

          // Decode first: malformed input fails before every other gate.
          const decoded = yield* scrubbed(definition.decode(input))

          if (definition.facts.prerequisite !== undefined) {
            yield* gates.checkGuidance(who, definition.facts.prerequisite)
          }

          const target = definition.target(decoded)
          const demand = definition.demand(decoded)

          // Target delegation; an unavailable target is indistinguishable
          // from an invisible operation.
          yield* gates.delegate(who.caller, definition.facts.id, target)

          // Evidence and the authority decision. Denial and unverifiable
          // authority both precede any effect, so `perform` never runs for
          // a refused decision.
          const evidence = yield* scrubbed(evidenceFor(who, decoded, demand))
          const grant = yield* gates.decide(who.caller, target, demand, evidence)

          const output = yield* scrubbed(definition.perform(grant, decoded, who, protectValues))

          // Classification and release for the client audience. The output
          // crosses no boundary until disclosure approves it; an empty
          // payload stays `Empty` and a JSON null stays `null`. Once a
          // non-read perform has returned, a release refusal cannot be
          // reported as a definite failure: the effect may already have
          // reached the peer.
          const classified = definition.classify(decoded, output)
          const installationValues = yield* installationSensitiveValues()

          return yield* gates
            .release(who, {
              ...classified,
              sensitiveValues: [
                ...installationValues,
                ...performedSensitiveValues,
                ...(classified.sensitiveValues ?? []),
              ],
            })
            .pipe(
              Effect.mapError((failure) =>
                definition.facts.effect === "read"
                  ? failure
                  : new DeliveryUncertain({
                      message:
                        "the operation may have been applied, but its reply could not be disclosed safely",
                    }),
              ),
            )
        })

      const body: BoundBody = {
        [boundBrand]: true,
        facts: definition.facts,
        execute,
      }

      return body
    }

    const assemble: CapabilitiesApi["assemble"] = (entries) =>
      Effect.suspend((): Effect.Effect<Catalog, DuplicateIdentity | InvalidEntry> => {
        const bodies: Array<BoundBody> = []
        const byKey = new Map<string, BoundBody>()

        for (const entry of entries) {
          const body = readBound(entry)
          const canonical = body.facts.id

          if (blank(canonical)) {
            return Effect.fail(
              new InvalidEntry({
                message: "operation id must not be blank",
                id: canonical,
                reason: "blank-id",
              }),
            )
          }

          const keys: Array<string> = [canonical]

          for (const alias of body.facts.aliases ?? []) {
            if (blank(alias)) {
              return Effect.fail(
                new InvalidEntry({
                  message: "operation alias must not be blank",
                  id: canonical,
                  reason: "blank-alias",
                }),
              )
            }

            keys.push(alias)
          }

          for (const key of keys) {
            const existing = byKey.get(key)

            if (existing !== undefined) {
              return Effect.fail(
                new DuplicateIdentity({
                  message:
                    'identity "' +
                    key +
                    '" is claimed by both "' +
                    existing.facts.id +
                    '" and "' +
                    canonical +
                    '"',
                  id: key,
                }),
              )
            }

            byKey.set(key, body)
          }

          bodies.push(body)
        }

        // SAFETY: the brand is module-private and construction is confined
        // to this path; the frozen entry array and the copied lookup map
        // are closed over and never mutated after this point.
        const catalog: CatalogBody = {
          [catalogBrand]: true,
          size: bodies.length,
          entries: Object.freeze(bodies.slice()),
          byKey: new Map(byKey),
        }

        return Effect.succeed(catalog)
      })

    const resolveEntry = (
      catalog: Catalog,
      id: OperationId,
    ): Effect.Effect<BoundBody, OperationNotFound> =>
      Effect.suspend(() => {
        const body = readCatalog(catalog).byKey.get(id)

        if (body === undefined) {
          return Effect.fail(
            new OperationNotFound({
              message: 'no operation with id or alias "' + id + '" is visible',
              id,
            }),
          )
        }

        return Effect.succeed(body)
      })

    const available: CapabilitiesApi["available"] = (catalog, _who) =>
      Effect.succeed(readCatalog(catalog).entries.map(descriptionOf))

    const describe: CapabilitiesApi["describe"] = (catalog, _who, id) =>
      Effect.suspend(() => {
        const body = readCatalog(catalog).byKey.get(id)

        if (body === undefined) return Effect.fail(notVisible(id))

        return Effect.succeed(descriptionOf(body))
      })

    const invoke: CapabilitiesApi["invoke"] = (catalog, who, id, input) =>
      Effect.flatMap(resolveEntry(catalog, id), (body) => body.execute(who, input))

    return { bind, assemble, available, describe, invoke }
  }),
)
