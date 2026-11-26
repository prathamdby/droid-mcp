import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"

import {
  Authority,
  type AuthorityApi,
  AuthorityUnverifiable,
  authorityLayer,
  type AuthorityOptions,
  autonomyRank,
  autonomyWithinCap,
  AUTONOMY_LEVELS,
  type Demand,
  Denied,
  Evidence,
  type Grant,
} from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { AdmissionRefused, Caller, TargetRef } from "../../src/caller/index.ts"

const target: TargetRef = { kind: "daemon", id: "target-1" }

const run = <A, E>(
  program: Effect.Effect<A, E, Authority | Callers>,
  options: AuthorityOptions,
): Exit.Exit<A, E> =>
  Effect.runSyncExit(Effect.provide(program, Layer.merge(callersLayer(), authorityLayer(options))))

const expectSuccess = <A, E>(exit: Exit.Exit<A, E>): A => {
  expect(Exit.isSuccess(exit)).toBe(true)

  if (!Exit.isSuccess(exit)) throw new Error("expected success")

  return exit.value
}

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true)

  if (!Exit.isFailure(exit)) throw new Error("expected failure")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

const admitAndUse = <A, E>(
  use: (api: AuthorityApi, caller: Caller) => Effect.Effect<A, E>,
): Effect.Effect<A, E | AdmissionRefused, Authority | Callers> =>
  Effect.gen(function* () {
    const authority = yield* Authority
    const callers = yield* Callers
    const evidence = Option.getOrThrow(trustedEvidence("operator"))
    const caller = yield* callers.admit(evidence)

    return yield* use(authority, caller)
  })

const decide = (
  api: AuthorityApi,
  caller: Caller,
  demand: Demand,
  evidence: Evidence,
): Effect.Effect<Grant, Denied | AuthorityUnverifiable> =>
  api.decide(caller, target, demand, evidence)

const explicitCeiling = (ceiling: "off" | "low" | "medium" | "high") =>
  Evidence.Explicit({ ceiling })

describe("autonomy ordering", () => {
  it("exposes all four levels in order", () => {
    expect(AUTONOMY_LEVELS).toEqual(["off", "low", "medium", "high"])
  })

  it("ranks off < low < medium < high", () => {
    expect(autonomyRank("off")).toBe(0)
    expect(autonomyRank("low")).toBe(1)
    expect(autonomyRank("medium")).toBe(2)
    expect(autonomyRank("high")).toBe(3)
  })

  it("compares within cap", () => {
    expect(autonomyWithinCap("low", "medium")).toBe(true)
    expect(autonomyWithinCap("medium", "medium")).toBe(true)
    expect(autonomyWithinCap("high", "medium")).toBe(false)
    expect(autonomyWithinCap("off", "off")).toBe(true)
  })
})

describe("decide with explicit evidence", () => {
  it("succeeds within the cap with verified: true", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(api, caller, { effect: "read", requestedLevel: "medium" }, explicitCeiling("high")),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.verified).toBe(true)
    expect(grant.effectiveLevel).toBe("medium")
    expect(grant.ceiling).toBe("high")
    expect(grant.target).toBe(target)
    expect(grant.effect).toBe("read")
    expect(grant.skipPermissionsUnsafe).toBe(false)
  })

  it("defaults the effective level to the narrowed ceiling when nothing is requested", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(api, caller, { effect: "write" }, explicitCeiling("high")),
      ),
      { maxAutonomy: "medium" },
    )

    const grant = expectSuccess(exit)

    expect(grant.effectiveLevel).toBe("medium")
    expect(grant.ceiling).toBe("medium")
  })

  it("fails with Denied when the requested level exceeds the ceiling", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "execute", requestedLevel: "high" },
          explicitCeiling("medium"),
        ),
      ),
      { maxAutonomy: "high" },
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(Denied)
    expect(error._tag).toBe("Denied")

    if (error instanceof Denied) {
      expect(error.requestedLevel).toBe("high")
      expect(error.ceiling).toBe("medium")
    }
  })

  it("fails with Denied when maxAutonomy narrows the ceiling below the request", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(api, caller, { effect: "execute", requestedLevel: "high" }, explicitCeiling("high")),
      ),
      { maxAutonomy: "medium" },
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(Denied)

    if (error instanceof Denied) {
      expect(error.ceiling).toBe("medium")
    }
  })

  it("denies skipPermissionsUnsafe below high even when evidence and demand omit a level", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "execute", skipPermissionsUnsafe: true },
          explicitCeiling("medium"),
        ),
      ),
      { maxAutonomy: "high" },
    )

    expectFailure(exit)
  })

  it("denies skipPermissionsUnsafe when maxAutonomy itself is below high", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "execute", skipPermissionsUnsafe: true },
          explicitCeiling("high"),
        ),
      ),
      { maxAutonomy: "low" },
    )

    expectFailure(exit)
  })

  it("permits skipPermissionsUnsafe only at high", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "execute", skipPermissionsUnsafe: true },
          explicitCeiling("high"),
        ),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.skipPermissionsUnsafe).toBe(true)
  })

  it("pins an omitted skipPermissionsUnsafe to false below high", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(api, caller, { effect: "execute" }, explicitCeiling("medium")),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.skipPermissionsUnsafe).toBe(false)
  })

  it("pins an omitted skipPermissionsUnsafe to false at high as well", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(api, caller, { effect: "execute" }, explicitCeiling("high")),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.skipPermissionsUnsafe).toBe(false)
  })
})

describe("decide with inherited evidence", () => {
  it("uses the inherited default narrowed to the ceiling", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "write" },
          Evidence.Inherited({ ceiling: "high", defaultLevel: "medium" }),
        ),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.effectiveLevel).toBe("medium")
    expect(grant.verified).toBe(true)
  })

  it("narrows an inherited default above the ceiling without widening", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "write" },
          Evidence.Inherited({ ceiling: "low", defaultLevel: "high" }),
        ),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.effectiveLevel).toBe("low")
  })

  it("narrows the inherited default to maxAutonomy", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "write" },
          Evidence.Inherited({ ceiling: "high", defaultLevel: "high" }),
        ),
      ),
      { maxAutonomy: "medium" },
    )

    const grant = expectSuccess(exit)

    expect(grant.effectiveLevel).toBe("medium")
    expect(grant.ceiling).toBe("medium")
  })

  it("honors a narrower requested level instead of the inherited default", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "write", requestedLevel: "low" },
          Evidence.Inherited({ ceiling: "high", defaultLevel: "medium" }),
        ),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.effectiveLevel).toBe("low")
  })

  it("pins an omitted skipPermissionsUnsafe to false below high for inherited evidence", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "write" },
          Evidence.Inherited({
            ceiling: "medium",
            defaultLevel: "medium",
            skipPermissionsUnsafe: true,
          }),
        ),
      ),
      { maxAutonomy: "high" },
    )

    const grant = expectSuccess(exit)

    expect(grant.skipPermissionsUnsafe).toBe(false)
  })
})

describe("decide with unprovable evidence", () => {
  const unprovable = (kind: "load_session" | "queued_work" | "other") =>
    Evidence.Unprovable({
      ceiling: "high",
      reason: "stored settings cannot be proven",
      operationKind: kind,
    })

  it("fails closed with authority_unverifiable for load_session by default", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "session_load", operation: "load_session" },
          unprovable("load_session"),
        ),
      ),
      { maxAutonomy: "high" },
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(AuthorityUnverifiable)
    expect(error._tag).toBe("authority_unverifiable")
    expect(error._tag).not.toBe("Denied")

    if (error instanceof AuthorityUnverifiable) {
      expect(error.reason).toBe("stored settings cannot be proven")
      expect(error.operation).toBe("load_session")
    }
  })

  it("fails closed with authority_unverifiable for queued work by default", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(api, caller, { effect: "queued_work" }, unprovable("queued_work")),
      ),
      { maxAutonomy: "high" },
    )

    const error = expectFailure(exit)

    expect(error._tag).toBe("authority_unverifiable")
  })

  it("grants verified: false at the ceiling when the passthrough is enabled", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(api, caller, { effect: "session_load" }, unprovable("load_session")),
      ),
      { maxAutonomy: "medium", allowUnverifiedDaemonAuthority: true },
    )

    const grant = expectSuccess(exit)

    expect(grant.verified).toBe(false)
    expect(grant.effectiveLevel).toBe("medium")
    expect(grant.ceiling).toBe("medium")
    expect(grant.skipPermissionsUnsafe).toBe(false)
  })

  it("passthrough allows skipPermissionsUnsafe only at high", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "session_load", skipPermissionsUnsafe: true },
          unprovable("load_session"),
        ),
      ),
      { maxAutonomy: "high", allowUnverifiedDaemonAuthority: true },
    )

    const grant = expectSuccess(exit)

    expect(grant.verified).toBe(false)
    expect(grant.skipPermissionsUnsafe).toBe(true)
  })

  it("passthrough never bypasses a known excess in the requested level", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "session_load", requestedLevel: "high" },
          unprovable("load_session"),
        ),
      ),
      { maxAutonomy: "medium", allowUnverifiedDaemonAuthority: true },
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(Denied)
    expect(error._tag).toBe("Denied")
  })

  it("passthrough never bypasses known skip-permissions excess", () => {
    const exit = run(
      admitAndUse((api, caller) =>
        decide(
          api,
          caller,
          { effect: "queued_work", skipPermissionsUnsafe: true },
          unprovable("queued_work"),
        ),
      ),
      { maxAutonomy: "medium", allowUnverifiedDaemonAuthority: true },
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(Denied)
  })
})

describe("restrict", () => {
  const granted = (
    options: AuthorityOptions,
    demand: Demand = { effect: "execute" },
    evidence: Evidence = explicitCeiling("high"),
  ) =>
    run(
      admitAndUse((api, caller) =>
        Effect.map(decide(api, caller, demand, evidence), (grant) => ({ api, grant })),
      ),
      options,
    )

  it("narrows a grant to a lower level", () => {
    const exit = granted({ maxAutonomy: "high" })
    const { api, grant } = expectSuccess(exit)

    const narrowed = Effect.runSyncExit(
      api.restrict(grant, { effect: "write", requestedLevel: "low" }),
    )

    const value = expectSuccess(narrowed)

    expect(value.effectiveLevel).toBe("low")
    expect(value.ceiling).toBe("high")
    expect(value.verified).toBe(true)
    expect(value.effect).toBe("write")
  })

  it("keeps the effective level when nothing narrower is requested", () => {
    const exit = granted({ maxAutonomy: "high" })
    const { api, grant } = expectSuccess(exit)

    const narrowed = expectSuccess(Effect.runSyncExit(api.restrict(grant, { effect: "write" })))

    expect(narrowed.effectiveLevel).toBe(grant.effectiveLevel)
  })

  it("refuses widening beyond the effective level", () => {
    const exit = granted({ maxAutonomy: "high" }, { effect: "execute", requestedLevel: "low" })
    const { api, grant } = expectSuccess(exit)

    const failure = expectFailure(
      Effect.runSyncExit(api.restrict(grant, { effect: "execute", requestedLevel: "high" })),
    )

    expect(failure).toBeInstanceOf(Denied)
  })

  it.each([
    ["read", "write"],
    ["write", "execute"],
    ["execute", "configure"],
  ] as const)("refuses to change a %s grant to %s", (effect, requestedEffect) => {
    const { api, grant } = expectSuccess(granted({ maxAutonomy: "high" }, { effect }))

    const failure = expectFailure(
      Effect.runSyncExit(api.restrict(grant, { effect: requestedEffect })),
    )

    expect(failure._tag).toBe("Denied")
    expect(failure).toHaveProperty("reason", "restriction_widens_effect")
  })

  it("refuses widening beyond the ceiling", () => {
    const exit = granted({ maxAutonomy: "medium" })
    const { api, grant } = expectSuccess(exit)

    const failure = expectFailure(
      Effect.runSyncExit(api.restrict(grant, { effect: "execute", requestedLevel: "high" })),
    )

    expect(failure).toBeInstanceOf(Denied)
  })

  it("refuses to add permission-skipping the grant does not hold", () => {
    const exit = granted({ maxAutonomy: "high" })
    const { api, grant } = expectSuccess(exit)

    expect(grant.skipPermissionsUnsafe).toBe(false)

    const failure = expectFailure(
      Effect.runSyncExit(api.restrict(grant, { effect: "execute", skipPermissionsUnsafe: true })),
    )

    expect(failure).toBeInstanceOf(Denied)
  })

  it("preserves permission-skipping on a grant that holds it", () => {
    const exit = granted(
      { maxAutonomy: "high" },
      { effect: "execute", skipPermissionsUnsafe: true },
    )

    const { api, grant } = expectSuccess(exit)

    const narrowed = expectSuccess(Effect.runSyncExit(api.restrict(grant, { effect: "execute" })))

    expect(narrowed.skipPermissionsUnsafe).toBe(true)
  })

  it("preserves the verified bit of an unverified passthrough grant", () => {
    const exit = granted(
      { maxAutonomy: "high", allowUnverifiedDaemonAuthority: true },
      { effect: "session_load" },
      Evidence.Unprovable({
        ceiling: "high",
        reason: "stored settings cannot be proven",
        operationKind: "load_session",
      }),
    )

    const { api, grant } = expectSuccess(exit)

    const narrowed = expectSuccess(
      Effect.runSyncExit(api.restrict(grant, { effect: "read", requestedLevel: "low" })),
    )

    expect(narrowed.verified).toBe(false)
    expect(narrowed.effectiveLevel).toBe("low")
  })
})

describe("allows", () => {
  const grantAt = (
    options: AuthorityOptions,
    demand: Demand,
  ): { api: AuthorityApi; grant: Grant } => {
    const exit = run(
      admitAndUse((api, caller) =>
        Effect.map(decide(api, caller, demand, explicitCeiling("high")), (grant) => ({
          api,
          grant,
        })),
      ),
      options,
    )

    return expectSuccess(exit)
  }

  it("permits choices within the effective level", () => {
    const { api, grant } = grantAt(
      { maxAutonomy: "high" },
      { effect: "execute", requestedLevel: "medium" },
    )

    expect(api.allows(grant, { level: "low" })).toBe(true)
    expect(api.allows(grant, { level: "medium" })).toBe(true)
    expect(api.allows(grant, { level: "high" })).toBe(false)
  })

  it("enforces skipPermissionsUnsafe independently of level", () => {
    const { api, grant } = grantAt({ maxAutonomy: "high" }, { effect: "execute" })

    expect(api.allows(grant, { level: "low", skipPermissionsUnsafe: true })).toBe(false)
    expect(api.allows(grant, { level: "low" })).toBe(true)

    const skipping = grantAt(
      { maxAutonomy: "high" },
      { effect: "execute", skipPermissionsUnsafe: true },
    )

    expect(skipping.api.allows(skipping.grant, { level: "low", skipPermissionsUnsafe: true })).toBe(
      true,
    )
  })
})

describe("ceiling", () => {
  it("reports the configured maxAutonomy", () => {
    const exit = run(
      admitAndUse((api) => Effect.sync(() => api.ceiling())),
      { maxAutonomy: "low" },
    )

    expect(expectSuccess(exit)).toBe("low")
  })
})
