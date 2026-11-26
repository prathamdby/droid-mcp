/**
 * `authority` owns authority comparison and narrowing. `Demand` describes
 * required effects; `Evidence` distinguishes explicit settings, inherited
 * values and unprovable effective settings; `Grant` binds principal, target,
 * effects and level. The decision consumes only structured inputs — never a
 * wire field name, CLI mode spelling, description text or presentation hint.
 *
 * Known excess always fails with `Denied`, even under the operator passthrough.
 * When effective authority cannot be proven (for example daemon `load_session`
 * or queued work), the decision fails closed with the `authority_unverifiable`
 * tag unless the operator opts into `--allow-unverified-daemon-authority`; a
 * passthrough grant is never reported as verified.
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { Caller, TargetRef } from "../caller/index.ts"

// ---------------------------------------------------------------------------
// Autonomy levels
// ---------------------------------------------------------------------------

export type AutonomyLevel = "off" | "low" | "medium" | "high"

export const AUTONOMY_LEVELS = ["off", "low", "medium", "high"] as const

/** Ranks an autonomy level on the 0..3 scale. */
export const autonomyRank = (level: AutonomyLevel): number => AUTONOMY_LEVELS.indexOf(level)

/** True when `requested` does not exceed `cap`. */
export const autonomyWithinCap = (requested: AutonomyLevel, cap: AutonomyLevel): boolean =>
  autonomyRank(requested) <= autonomyRank(cap)

const minLevel = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel =>
  autonomyWithinCap(a, b) ? a : b

// ---------------------------------------------------------------------------
// Demand, evidence, choice
// ---------------------------------------------------------------------------

export type EffectKind = "read" | "write" | "execute" | "configure" | "session_load" | "queued_work"

// Read is the common floor. Execute can narrow to write, but the dedicated
// effects do not imply one another or grant general write/execute authority.
const NARROWER_EFFECTS: Record<EffectKind, ReadonlyArray<EffectKind>> = {
  read: ["read"],
  write: ["read", "write"],
  execute: ["read", "write", "execute"],
  configure: ["read", "configure"],
  session_load: ["read", "session_load"],
  queued_work: ["read", "queued_work"],
}

/** A structured statement of required effects. Never parsed from text. */
export type Demand = {
  readonly effect: EffectKind
  readonly requestedLevel?: AutonomyLevel
  readonly skipPermissionsUnsafe?: boolean
  readonly operation?: string
}

export type Evidence = Data.TaggedEnum<{
  /** Settings were explicitly supplied and checked at the boundary. */
  readonly Explicit: {
    readonly ceiling: AutonomyLevel
    readonly requestedLevel?: AutonomyLevel
    readonly skipPermissionsUnsafe?: boolean
  }
  /** Settings were inherited from stored defaults. */
  readonly Inherited: {
    readonly ceiling: AutonomyLevel
    readonly defaultLevel: AutonomyLevel
    readonly requestedLevel?: AutonomyLevel
    readonly skipPermissionsUnsafe?: boolean
  }
  /** Effective settings cannot be proven (for example daemon load_session or queued work). */
  readonly Unprovable: {
    readonly ceiling: AutonomyLevel
    readonly reason: string
    readonly operationKind: "load_session" | "queued_work" | "other"
  }
}>

export const Evidence = Data.taggedEnum<Evidence>()

/** The effects a consumer wants to exercise under a grant. */
export type ChoiceEffect = {
  readonly level: AutonomyLevel
  readonly skipPermissionsUnsafe?: boolean
}

// ---------------------------------------------------------------------------
// Grant
// ---------------------------------------------------------------------------

/**
 * Brand key for the opaque `Grant` handle. The runtime symbol is
 * module-private, so a grant cannot be forged outside `authority/`.
 */
const grantBrand: unique symbol = Symbol("droid-mcp-v2/authority/Grant")

/**
 * Proof that `caller` may exercise `effectiveLevel` against `target`. Only
 * this module issues one; possession of a string is never proof of access.
 */
export type Grant = {
  readonly [grantBrand]: true
  readonly caller: Caller
  readonly target: TargetRef
  readonly effectiveLevel: AutonomyLevel
  readonly ceiling: AutonomyLevel
  readonly skipPermissionsUnsafe: boolean
  /** False when granted only via the unverified-daemon operator passthrough. */
  readonly verified: boolean
  readonly effect: EffectKind
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class Denied extends Schema.TaggedError<Denied>()("Denied", {
  message: Schema.String,
  requestedLevel: Schema.optional(Schema.String),
  ceiling: Schema.String,
  reason: Schema.String,
}) {}

/**
 * Distinct from a known denial: the authority under which the work would run
 * cannot be established, and the operator has not enabled the passthrough.
 */
export class AuthorityUnverifiable extends Schema.TaggedError<AuthorityUnverifiable>()(
  "authority_unverifiable",
  {
    message: Schema.String,
    reason: Schema.String,
    operation: Schema.optional(Schema.String),
  },
) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AuthorityApi {
  readonly decide: (
    caller: Caller,
    target: TargetRef,
    demand: Demand,
    evidence: Evidence,
  ) => Effect.Effect<Grant, Denied | AuthorityUnverifiable>
  readonly restrict: (
    grant: Grant,
    demand: Demand,
  ) => Effect.Effect<Grant, Denied | AuthorityUnverifiable>
  readonly allows: (grant: Grant, choice: ChoiceEffect) => boolean
  readonly ceiling: () => AutonomyLevel
}

export class Authority extends Context.Service<Authority, AuthorityApi>()(
  "droid-mcp-v2/Authority",
) {}

export type AuthorityOptions = {
  /** Hard cap on autonomy for every decision this instance makes. */
  readonly maxAutonomy: AutonomyLevel
  /**
   * Operator passthrough for daemon load_session and queued work where
   * effective authority cannot be proven. Defaults to false: fail closed.
   * Never bypasses a known denial and never reports the grant as verified.
   */
  readonly allowUnverifiedDaemonAuthority?: boolean
}

/**
 * Refuses excess the demand itself states. These denials are known facts, so
 * they apply to every evidence kind and are never bypassed by the unverified
 * passthrough.
 */
const denyKnownExcess = (ceiling: AutonomyLevel, demand: Demand): Effect.Effect<void, Denied> => {
  if (demand.requestedLevel !== undefined && !autonomyWithinCap(demand.requestedLevel, ceiling)) {
    return Effect.fail(
      new Denied({
        message: "requested autonomy exceeds the effective ceiling",
        requestedLevel: demand.requestedLevel,
        ceiling,
        reason: "requested_level_exceeds_ceiling",
      }),
    )
  }

  if (demand.skipPermissionsUnsafe === true && ceiling !== "high") {
    return Effect.fail(
      new Denied({
        message: "skipping permission prompts requires the effective ceiling to be high",
        ceiling,
        reason: "skip_permissions_below_high",
      }),
    )
  }

  return Effect.void
}

const makeGrant = (
  caller: Caller,
  target: TargetRef,
  effect: EffectKind,
  effectiveLevel: AutonomyLevel,
  ceiling: AutonomyLevel,
  skipPermissionsUnsafe: boolean,
  verified: boolean,
): Grant => {
  // SAFETY: the brand is module-private and the grant is only constructed
  // here, after the denial checks have run.
  const grant = {
    caller,
    target,
    effect,
    effectiveLevel,
    ceiling,
    skipPermissionsUnsafe,
    verified,
  } as Grant

  return grant
}

const skipEffective = (ceiling: AutonomyLevel, skip: boolean | undefined): boolean =>
  ceiling === "high" && skip === true

/**
 * Builds the per-layer `Authority` service. The only state is the fixed
 * operator configuration; a grant carries everything `restrict` and `allows`
 * need, so independent layer instances never share decisions.
 */
export const authorityLayer = (options: AuthorityOptions): Layer.Layer<Authority> => {
  const maxAutonomy = options.maxAutonomy
  const allowUnverified = options.allowUnverifiedDaemonAuthority ?? false

  return Layer.sync(Authority, () => {
    const decide: AuthorityApi["decide"] = (caller, target, demand, evidence) =>
      Evidence.$match(evidence, {
        Explicit: (variant) => {
          const ceiling = minLevel(maxAutonomy, variant.ceiling)
          const skip = demand.skipPermissionsUnsafe ?? variant.skipPermissionsUnsafe

          return Effect.map(denyKnownExcess(ceiling, demand), () => {
            const effectiveLevel =
              demand.requestedLevel ?? minLevel(variant.requestedLevel ?? ceiling, ceiling)

            return makeGrant(
              caller,
              target,
              demand.effect,
              effectiveLevel,
              ceiling,
              skipEffective(ceiling, skip),
              true,
            )
          })
        },
        Inherited: (variant) => {
          const ceiling = minLevel(maxAutonomy, variant.ceiling)
          const skip = demand.skipPermissionsUnsafe ?? variant.skipPermissionsUnsafe

          return Effect.map(denyKnownExcess(ceiling, demand), () => {
            const effectiveLevel = demand.requestedLevel ?? minLevel(variant.defaultLevel, ceiling)

            return makeGrant(
              caller,
              target,
              demand.effect,
              effectiveLevel,
              ceiling,
              skipEffective(ceiling, skip),
              true,
            )
          })
        },
        Unprovable: (variant) => {
          const ceiling = minLevel(maxAutonomy, variant.ceiling)

          return Effect.flatMap(denyKnownExcess(ceiling, demand), () => {
            if (!allowUnverified) {
              return Effect.fail(
                new AuthorityUnverifiable({
                  message:
                    "effective authority cannot be proven for this operation; refusing to dispatch",
                  reason: variant.reason,
                  operation: demand.operation,
                }),
              )
            }

            return Effect.succeed(
              makeGrant(
                caller,
                target,
                demand.effect,
                ceiling,
                ceiling,
                skipEffective(ceiling, demand.skipPermissionsUnsafe),
                false,
              ),
            )
          })
        },
      })

    const restrict: AuthorityApi["restrict"] = (grant, demand) =>
      Effect.suspend(() => {
        if (
          demand.requestedLevel !== undefined &&
          (!autonomyWithinCap(demand.requestedLevel, grant.effectiveLevel) ||
            !autonomyWithinCap(demand.requestedLevel, grant.ceiling))
        ) {
          return Effect.fail(
            new Denied({
              message: "restriction cannot widen a grant beyond its effective level or ceiling",
              requestedLevel: demand.requestedLevel,
              ceiling: grant.ceiling,
              reason: "restriction_widens_level",
            }),
          )
        }

        if (demand.skipPermissionsUnsafe === true && !grant.skipPermissionsUnsafe) {
          return Effect.fail(
            new Denied({
              message: "restriction cannot add permission-skipping the grant does not hold",
              ceiling: grant.ceiling,
              reason: "restriction_widens_skip_permissions",
            }),
          )
        }

        if (!NARROWER_EFFECTS[grant.effect]?.includes(demand.effect)) {
          return Effect.fail(
            new Denied({
              message: "restriction cannot grant an effect outside the existing grant",
              ceiling: grant.ceiling,
              reason: "restriction_widens_effect",
            }),
          )
        }

        const effectiveLevel = demand.requestedLevel ?? grant.effectiveLevel
        const skip = grant.skipPermissionsUnsafe && demand.skipPermissionsUnsafe !== false

        return Effect.succeed(
          makeGrant(
            grant.caller,
            grant.target,
            demand.effect,
            effectiveLevel,
            grant.ceiling,
            skip,
            grant.verified,
          ),
        )
      })

    const allows: AuthorityApi["allows"] = (grant, choice) =>
      autonomyWithinCap(choice.level, grant.effectiveLevel) &&
      (choice.skipPermissionsUnsafe !== true || grant.skipPermissionsUnsafe === true)

    const ceiling = (): AutonomyLevel => maxAutonomy

    return { decide, restrict, allows, ceiling }
  })
}
