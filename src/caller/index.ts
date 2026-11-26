/**
 * `caller` owns admission, principal identity, conversation binding, resource
 * ownership and delegation.
 *
 * Admission never parses request fields: it consumes `VerifiedEvidence` issued
 * by a trusted verifier. Bearer evidence proves possession of a configured key
 * through the full 64-hex SHA-256 digest compared with `timingSafeEqual`, and
 * the full digest — never its first eight hex characters — becomes principal
 * identity. Trusted evidence admits an explicit named local principal (stdio or
 * embedded hosts). Neither the raw key nor the digest ever appears in a public
 * session id, diagnostic label or continuation.
 *
 * Ownership is strictly per-caller by default for every resource kind. With
 * `sharedSessions`, only `kind: "session"` resources become visible across
 * admitted callers; artifacts, workspaces, operations and targets remain
 * strictly per-caller. Foreign resources are indistinguishable from absent
 * ones: both surface as `NotVisible` with an identical shape.
 */
import { createHash, timingSafeEqual } from "node:crypto"

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/*
 * Private brand symbols. They are declared with `unique symbol` and never
 * exported, so the opaque types below are unforgeable outside this module.
 */
declare const callerIdBrand: unique symbol
declare const callerBrand: unique symbol
declare const conversationIdBrand: unique symbol
declare const conversationBrand: unique symbol
declare const ownershipBrand: unique symbol
declare const delegationBrand: unique symbol
declare const evidenceBrand: unique symbol

/** The verified principal identity: a full 64-hex digest or `"trusted:<name>"`. */
export type CallerId = string & { readonly [callerIdBrand]: true }

/** An admitted caller handle. `id` is never a session id, label or continuation. */
export interface Caller {
  readonly [callerBrand]: true
  readonly id: CallerId
  readonly kind: "bearer" | "trusted"
  /** Safe non-digest label, never the raw key or digest hex. */
  readonly displayLabel: string
}

/** Constant-time equality over the full caller identity. */
export const sameCaller = (a: Caller, b: Caller): boolean => {
  const left = Buffer.from(String(a.id), "utf8")
  const right = Buffer.from(String(b.id), "utf8")

  if (left.length !== right.length) return false

  return timingSafeEqual(left, right)
}

/** Opaque conversation scope identity. */
export type ConversationId = string & { readonly [conversationIdBrand]: true }

/** A conversation binds a caller to a verified binding or its sessionless scope. */
export interface Conversation {
  readonly [conversationBrand]: true
  readonly caller: Caller
  readonly id: ConversationId
  readonly sessionless: boolean
}

export type ResourceKind = "session" | "artifact" | "workspace" | "operation" | "target"

export interface ResourceRef {
  readonly kind: ResourceKind
  readonly id: string
}

export type AccessRight = "read" | "write" | "answer" | "admin" | "invoke"

/** Proof that `caller` holds `rights` on `resource`, issued only by this module. */
export interface Ownership {
  readonly [ownershipBrand]: true
  readonly caller: Caller
  readonly resource: ResourceRef
  readonly rights: ReadonlySet<AccessRight>
}

export type TargetKind = "local" | "daemon" | "hosted" | "context" | "session" | "system"

export interface TargetRef {
  readonly kind: TargetKind
  readonly id: string
  readonly scope?: string
}

/** Scoped rights a caller holds over a target, issued only by this module. */
export interface Delegation {
  readonly [delegationBrand]: true
  readonly caller: Caller
  readonly target: TargetRef
  readonly rights: ReadonlySet<AccessRight>
}

/** Evidence of admission, constructible only through the trusted verifiers here. */
export interface VerifiedEvidence {
  readonly [evidenceBrand]: true
}

/** An externally supplied conversation binding token. */
export interface ConversationBinding {
  readonly bindingId: string
}

export class AdmissionRefused extends Schema.TaggedError<AdmissionRefused>()("AdmissionRefused", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export class OwnershipConflict extends Schema.TaggedError<OwnershipConflict>()(
  "OwnershipConflict",
  {
    message: Schema.String,
    resourceKind: Schema.String,
    resourceId: Schema.String,
  },
) {}

/**
 * One refusal shape for both absent and foreign resources: an observer cannot
 * distinguish "does not exist" from "belongs to another caller".
 */
export class NotVisible extends Schema.TaggedError<NotVisible>()("NotVisible", {
  message: Schema.String,
  resourceKind: Schema.String,
  resourceId: Schema.String,
}) {}

export class DelegationUnavailable extends Schema.TaggedError<DelegationUnavailable>()(
  "DelegationUnavailable",
  {
    message: Schema.String,
    targetKind: Schema.String,
    targetId: Schema.String,
  },
) {}

/* Internal evidence bodies behind the opaque public type. */
interface BearerBody {
  readonly [evidenceBrand]: true
  readonly proof: "bearer"
  /** Verified full lowercase 64-hex digest; never a raw key. */
  readonly digest: string
}

interface TrustedBody {
  readonly [evidenceBrand]: true
  readonly proof: "trusted"
  readonly principal: string
}

const bearerEvidence = (digest: string): VerifiedEvidence => {
  // SAFETY: construction is confined to this module; the brand is unforgeable
  // outside it, and the digest is only attached after a timing-safe comparison.
  const body = { proof: "bearer", digest } as BearerBody

  return body
}

const trustedBodyEvidence = (principal: string): VerifiedEvidence => {
  // SAFETY: same confinement argument; the principal name is validated non-blank
  // by the only caller of this constructor.
  const body = { proof: "trusted", principal } as TrustedBody

  return body
}

const readEvidence = (evidence: VerifiedEvidence): BearerBody | TrustedBody =>
  // SAFETY: the module itself constructed this evidence through one of the two
  // bodies above; external code cannot supply the brand.
  evidence as BearerBody | TrustedBody

export interface BearerVerifier {
  /** Evidence for a matching bearer key, or `Option.none()` for anything else. */
  readonly verify: (authorizationHeader: string | undefined) => Option.Option<VerifiedEvidence>
  /** Number of usable keys; zero means no key can authenticate. */
  readonly size: number
}

const BEARER_PREFIX = "bearer "

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex")

const sha256Bytes = (value: string): Buffer => createHash("sha256").update(value).digest()

/**
 * Builds a bearer verifier over configured keys. Blank keys never authenticate.
 * Only digests are retained; raw keys are never stored, logged or exposed.
 */
export const createBearerVerifier = (keys: ReadonlyArray<string>): BearerVerifier => {
  const digests: Array<Buffer> = []

  for (const key of keys) {
    if (key.trim().length > 0) digests.push(sha256Bytes(key))
  }

  return {
    size: digests.length,
    verify: (authorizationHeader) => {
      if (authorizationHeader === undefined) return Option.none()

      if (authorizationHeader.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
        return Option.none()
      }

      const presented = authorizationHeader.slice(BEARER_PREFIX.length).trim()

      if (presented.length === 0) return Option.none()

      const candidate = sha256Bytes(presented)

      for (const digest of digests) {
        if (timingSafeEqual(digest, candidate)) {
          return Option.some(bearerEvidence(sha256Hex(presented)))
        }
      }

      return Option.none()
    },
  }
}

/**
 * Evidence for a trusted local principal (stdio or embedded admission). Blank
 * or whitespace-only names are refused: there is no anonymous fallback.
 */
export const trustedEvidence = (principalName: string): Option.Option<VerifiedEvidence> => {
  const principal = principalName.trim()

  if (principal.length === 0) return Option.none()

  return Option.some(trustedBodyEvidence(principal))
}

export interface CallersApi {
  readonly admit: (evidence: VerifiedEvidence) => Effect.Effect<Caller, AdmissionRefused>
  readonly conversation: (
    caller: Caller,
    binding?: ConversationBinding,
  ) => Effect.Effect<Conversation, AdmissionRefused>
  readonly own: (
    caller: Caller,
    resource: ResourceRef,
  ) => Effect.Effect<Ownership, OwnershipConflict>
  readonly access: (
    caller: Caller,
    resource: ResourceRef,
    right: AccessRight,
  ) => Effect.Effect<Ownership, NotVisible>
  readonly revoke: (caller: Caller, resource: ResourceRef) => Effect.Effect<void, NotVisible>
  readonly delegate: (
    caller: Caller,
    target: TargetRef,
  ) => Effect.Effect<Delegation, DelegationUnavailable>
}

export class Callers extends Context.Service<Callers, CallersApi>()("droid-mcp-v2/Callers") {}

export interface CallersOptions {
  /**
   * Opt-in shared session namespace. Only `kind: "session"` resources become
   * visible across callers; artifacts, workspaces, operations and targets
   * always remain strictly per-caller.
   */
  readonly sharedSessions?: boolean
  /** Target kinds this host permits delegation to; defaults to all kinds. */
  readonly allowedTargets?: ReadonlyArray<TargetKind>
}

const ALL_TARGET_KINDS: ReadonlyArray<TargetKind> = [
  "local",
  "daemon",
  "hosted",
  "context",
  "session",
  "system",
]

const ALL_RIGHTS: ReadonlySet<AccessRight> = new Set(["read", "write", "answer", "admin", "invoke"])

interface OwnershipRecord {
  readonly ownerIdentity: string
  readonly rights: ReadonlySet<AccessRight>
}

const resourceKey = (resource: ResourceRef): string => resource.kind + " " + resource.id

const identityOf = (caller: Caller): string => String(caller.id)

const lengthPrefixed = (value: string): string => `${value.length}:${value}`

const notVisible = (resource: ResourceRef): NotVisible =>
  new NotVisible({
    message: "resource is not visible to this caller",
    resourceKind: resource.kind,
    resourceId: resource.id,
  })

/**
 * Builds the per-layer `Callers` service. State (the admitted callers and the
 * ownership registry) is local to each layer instance, so independent
 * assemblies never share principals or resources.
 */
export const callersLayer = (options?: CallersOptions): Layer.Layer<Callers> => {
  const sharedSessions = options?.sharedSessions ?? false
  const allowedTargets = new Set<TargetKind>(options?.allowedTargets ?? ALL_TARGET_KINDS)

  return Layer.sync(Callers, () => {
    const admitted = new Map<string, Caller>()
    const registry = new Map<string, OwnershipRecord>()

    const admit: CallersApi["admit"] = (evidence) =>
      Effect.sync(() => {
        const body = readEvidence(evidence)
        let identity: string
        let kind: "bearer" | "trusted"
        let displayLabel: string

        if (body.proof === "bearer") {
          identity = body.digest
          kind = "bearer"
          displayLabel = "bearer-principal"
        } else {
          identity = "trusted:" + body.principal
          kind = "trusted"
          displayLabel = "trusted-principal"
        }

        const existing = admitted.get(identity)

        if (existing !== undefined) return existing

        // SAFETY: the id derives only from verified evidence inside this module,
        // and the private brands cannot be reproduced by outside code.
        const caller = { id: identity as CallerId, kind, displayLabel } as Caller

        admitted.set(identity, caller)

        return caller
      })

    const conversation: CallersApi["conversation"] = (caller, binding) =>
      Effect.sync(() => {
        const identity = identityOf(caller)
        const sessionless = binding === undefined

        const idValue = sessionless
          ? "sessionless:" + identity
          : "bound:" + lengthPrefixed(identity) + lengthPrefixed(binding.bindingId)

        // SAFETY: conversation ids are constructed solely here from an admitted
        // caller identity plus the verified binding id.
        const value = { caller, id: idValue as ConversationId, sessionless } as Conversation

        return value
      })

    const own: CallersApi["own"] = (caller, resource) =>
      Effect.suspend(() => {
        const key = resourceKey(resource)

        if (registry.has(key)) {
          return Effect.fail(
            new OwnershipConflict({
              message: "resource is already owned",
              resourceKind: resource.kind,
              resourceId: resource.id,
            }),
          )
        }

        registry.set(key, { ownerIdentity: identityOf(caller), rights: ALL_RIGHTS })

        // SAFETY: ownership is only constructed after the registry insert.
        const ownership = { caller, resource, rights: ALL_RIGHTS } as Ownership

        return Effect.succeed(ownership)
      })

    const access: CallersApi["access"] = (caller, resource, right) =>
      Effect.suspend(() => {
        const record = registry.get(resourceKey(resource))
        const identity = identityOf(caller)

        const visible =
          record !== undefined &&
          (record.ownerIdentity === identity || (sharedSessions && resource.kind === "session"))

        if (!visible || !record.rights.has(right)) {
          return Effect.fail(notVisible(resource))
        }

        // SAFETY: the ownership witness mirrors the registry entry just checked.
        const ownership = { caller, resource, rights: record.rights } as Ownership

        return Effect.succeed(ownership)
      })

    const revoke: CallersApi["revoke"] = (caller, resource) =>
      Effect.suspend(() => {
        const key = resourceKey(resource)
        const record = registry.get(key)
        const visible = record !== undefined && record.ownerIdentity === identityOf(caller)

        if (!visible) return Effect.fail(notVisible(resource))

        registry.delete(key)

        return Effect.void
      })

    const delegate: CallersApi["delegate"] = (caller, target) =>
      Effect.suspend(() => {
        if (!allowedTargets.has(target.kind)) {
          return Effect.fail(
            new DelegationUnavailable({
              message: "delegation to this target is unavailable",
              targetKind: target.kind,
              targetId: target.id,
            }),
          )
        }

        // SAFETY: delegation is only constructed for an allowed target kind.
        const delegation = { caller, target, rights: ALL_RIGHTS } as Delegation

        return Effect.succeed(delegation)
      })

    return { admit, conversation, own, access, revoke, delegate }
  })
}
