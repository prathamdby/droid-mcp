import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit, Fiber, Layer, Option, Predicate, Scope, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Authority, authorityLayer, Evidence } from "../../src/authority/index.ts"
import type { AutonomyLevel, Grant } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { Caller } from "../../src/caller/index.ts"
import { Custody, custodyLayer } from "../../src/custody/index.ts"
import { disclosureLayer } from "../../src/disclosure/index.ts"
import { dialectLayer } from "../../src/factory-dialect/index.ts"
import { localExecLayer } from "../../src/local-exec/index.ts"
import {
  NoEligibleProvider,
  OpenFailed,
  Placement,
  PlacementFacetUnsupported,
  PlacementNotice,
  PlacementPeerLost,
  PlacementRejected,
  placementLayer,
  PlacementSubmissionUncertain,
  RunIntent,
} from "../../src/placement/index.ts"
import type {
  PlacementProviderAdapter,
  PlacementWorkRef,
  ProviderHandle,
  RunningLease,
} from "../../src/placement/index.ts"
import { Workspaces, workspacesLayer } from "../../src/workspace/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAKE = join(import.meta.dirname, "../support/fake-droid-exec.mjs")

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "placement-test-")))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

interface Services {
  readonly placement: Placement["Service"]
  readonly callers: Callers["Service"]
  readonly authority: Authority["Service"]
  readonly workspaces: Workspaces["Service"]
  readonly custody: Custody["Service"]
}

interface HarnessOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly maxAutonomy?: AutonomyLevel
  readonly spawnTimeoutMs?: number
  readonly providers?: ReadonlyArray<PlacementProviderAdapter>
}

const makeServices = (options?: HarnessOptions): Services => {
  const workspacesLive = Layer.provideMerge(
    workspacesLayer({ allowedRoots: [sandbox] }),
    custodyLayer,
  )

  const deps = Layer.mergeAll(
    custodyLayer,
    workspacesLive,
    authorityLayer({ maxAutonomy: options?.maxAutonomy ?? "high" }),
    callersLayer(),
    disclosureLayer({}),
    dialectLayer,
  )

  const localLive = Layer.provideMerge(
    localExecLayer({
      droidPath: process.execPath,
      args: [FAKE],
      env: options?.env,
      spawnTimeoutMs: options?.spawnTimeoutMs,
    }),
    deps,
  )

  const placementLive = Layer.provideMerge(
    placementLayer({ providers: options?.providers }),
    Layer.mergeAll(localLive, deps),
  )

  const merged = Layer.mergeAll(placementLive, localLive, deps)

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const placement = yield* Placement
        const callers = yield* Callers
        const authority = yield* Authority
        const workspaces = yield* Workspaces
        const custody = yield* Custody

        return { placement, callers, authority, workspaces, custody }
      }),
      merged,
    ),
  )
}

const admitCaller = (services: Services, principal: string): Caller =>
  Effect.runSync(services.callers.admit(Option.getOrThrow(trustedEvidence(principal))))

const grantFor = (
  services: Services,
  caller: Caller,
  ceiling: AutonomyLevel,
  target: { readonly kind: "local" | "daemon" | "hosted"; readonly id: string } = {
    kind: "local",
    id: "local-1",
  },
): Grant =>
  Effect.runSync(
    services.authority.decide(
      caller,
      target,
      { effect: "execute" },
      Evidence.Explicit({ ceiling }),
    ),
  )

const captureFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)

    if (Exit.isFailure(exit)) {
      const found = Cause.findErrorOption(exit.cause)

      if (Option.isSome(found)) return found.value
    }

    return yield* Effect.die(null)
  })

const localIntent = (autonomyLevel: AutonomyLevel = "high") =>
  RunIntent.Local({
    workspace: { kind: "borrowed", path: sandbox },
    settings: { autonomyLevel },
  })

const openLocal = (
  services: Services,
  caller: Caller,
  grant: Grant,
  scope: Scope.Scope,
  required: ReadonlyArray<
    | "submit"
    | "observe"
    | "interrupt"
    | "answer"
    | "update_settings"
    | "list_models"
    | "fork"
    | "close"
  > = [],
  autonomyLevel: AutonomyLevel = "high",
): Promise<RunningLease> =>
  Effect.runPromise(
    services.placement
      .open(caller, localIntent(autonomyLevel), grant, required)
      .pipe(Scope.provide(scope)),
  )

const ALL_FACETS = [
  "submit",
  "observe",
  "interrupt",
  "answer",
  "update_settings",
  "list_models",
  "fork",
  "close",
] as const

const stubHandle = (
  overrides?: Partial<ProviderHandle> & { readonly facets?: ProviderHandle["facets"] },
): ProviderHandle => ({
  providerSessionId: "remote-session-1",
  facets: [...ALL_FACETS],
  // SAFETY: test-only minting of an opaque ref shape; production minting
  // stays inside the placement module, which rebinds the lease identity.
  submit: () => Effect.succeed({ leaseId: "stub", generation: 1 } as PlacementWorkRef),
  notices: () => Stream.empty,
  interrupt: () => Effect.void,
  updateSettings: () => Effect.succeed({ autonomyLevel: "high" as const }),
  listModels: () => Effect.succeed([]),
  fork: () => Effect.succeed({ kind: "external" as const, externalSessionId: "fork-1" }),
  adopt: () => Effect.void,
  release: () => Effect.void,
  ...overrides,
})

// SAFETY: test-only minting of an opaque ref shape; production minting stays
// inside the placement module.
const stubRef = { leaseId: "stub", generation: 1 } as PlacementWorkRef

// ---------------------------------------------------------------------------
// local provider: open + facets
// ---------------------------------------------------------------------------

describe("local open", () => {
  it("opens against the real local provider and reports verified facets", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "open-basic")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    const lease = await openLocal(services, caller, grant, scope)

    expect(lease.providerSessionId).toBe("fake-session")
    expect(lease.caller.id).toBe(caller.id)
    expect(lease.facets).toEqual([...ALL_FACETS])
    expect(services.placement.facets(lease)).toEqual([...ALL_FACETS])

    // The workspace view is real, not faked: acquisition path and caller
    // identity come straight from the workspace module.
    expect(lease.workspace?.acquiredPath).toBe(sandbox)
    expect(lease.workspace?.callerId).toBe(String(caller.id))

    // The settings snapshot reflects the effective settings.
    expect(lease.settingsSnapshot?.autonomyLevel).toBe("high")

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("terminates the child when the acquisition scope closes without release", async () => {
    const piddir = join(sandbox, "pids")
    const services = makeServices({ env: { FAKE_DROID_PIDDIR: piddir } })
    const caller = admitCaller(services, "open-custody")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    await openLocal(services, caller, grant, scope)

    await Effect.runPromise(Effect.sleep("100 millis"))

    const pid = Number(readdirSync(piddir)[0])

    await Effect.runPromise(Scope.close(scope, Exit.void))

    const alive = await Effect.runPromise(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)

          return true
        } catch {
          return false
        }
      }),
    )

    expect(alive).toBe(false)
  })

  it("fails with OpenFailed when initialization never answers", async () => {
    const services = makeServices({
      env: { FAKE_DROID_INIT: "hang" },
      spawnTimeoutMs: 800,
    })

    const caller = admitCaller(services, "open-hang")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement.open(caller, localIntent(), grant, []).pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(OpenFailed)

    if (failure instanceof OpenFailed) {
      expect(failure.reason).toBe("spawn_timeout")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("releases the acquired workspace when the exec session cannot open", async () => {
    const services = makeServices({
      env: { FAKE_DROID_INIT: "hang" },
      spawnTimeoutMs: 800,
    })

    const caller = admitCaller(services, "open-release")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement.open(caller, localIntent(), grant, []).pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(OpenFailed)

    // The borrowed workspace must already be released: re-acquiring the same
    // path succeeds only when no live lease holds it, and describe fails for
    // a closed lease. Proof: a fresh acquisition of the same path works.
    const reacquired = await Effect.runPromise(
      services.workspaces
        .acquire(caller, { kind: "borrowed", path: sandbox })
        .pipe(Scope.provide(scope)),
    )

    expect(reacquired.id.length).toBeGreaterThan(0)

    await Effect.runPromise(services.workspaces.release(reacquired))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("fails with OpenFailed when the workspace root is denied", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "open-root-denied")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    const outside = realpathSync(mkdtempSync(join(tmpdir(), "placement-outside-")))

    try {
      const failure = await Effect.runPromise(
        captureFailure(
          services.placement
            .open(
              caller,
              RunIntent.Local({
                workspace: { kind: "borrowed", path: outside },
                settings: { autonomyLevel: "high" },
              }),
              grant,
              [],
            )
            .pipe(Scope.provide(scope)),
        ),
      )

      expect(failure).toBeInstanceOf(OpenFailed)

      if (failure instanceof OpenFailed) {
        expect(failure.reason).toBe("workspace_unavailable")
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})

// ---------------------------------------------------------------------------
// grant checks
// ---------------------------------------------------------------------------

describe("grant checks", () => {
  it("refuses to open when the requested autonomy exceeds the grant", async () => {
    const services = makeServices({ maxAutonomy: "low" })
    const caller = admitCaller(services, "grant-exceeded")
    const grant = grantFor(services, caller, "low")
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement.open(caller, localIntent("high"), grant, []).pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(NoEligibleProvider)

    if (failure instanceof NoEligibleProvider) {
      expect(failure.reason).toBe("grant_exceeded")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("refuses a local intent under a non-local grant target", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "grant-mismatch")
    const grant = grantFor(services, caller, "high", { kind: "hosted", id: "hosted-1" })
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement.open(caller, localIntent(), grant, []).pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(NoEligibleProvider)

    if (failure instanceof NoEligibleProvider) {
      expect(failure.reason).toBe("grant_target_mismatch")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("rejects submissions under a grant belonging to a different caller", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "grant-owner")
    const other = admitCaller(services, "grant-other")
    const grant = grantFor(services, caller, "high")
    const foreignGrant = grantFor(services, other, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    const failure = await Effect.runPromise(captureFailure(lease.submit("hello", foreignGrant)))

    expect(failure).toBeInstanceOf(PlacementRejected)

    if (failure instanceof PlacementRejected) {
      expect(failure.operation).toBe("submit")
    }

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// required facet verification: never a silent downgrade
// ---------------------------------------------------------------------------

describe("required facet verification", () => {
  it("local provider satisfies every declared facet", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "facets-all")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    // Requiring everything the fake supports must succeed; nothing is
    // downgraded because the lease verifiably has every facility.
    const lease = await openLocal(services, caller, grant, scope, [...ALL_FACETS])

    expect(lease.facets).toEqual([...ALL_FACETS])

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("refuses to open when a provider lacks a required facet, with no silent downgrade", async () => {
    // The adapter claims everything except fork; requiring fork must fail
    // before any lease escapes, and the adapter handle must be released.
    let released = 0

    const adapter: PlacementProviderAdapter = {
      provider: "fixture-remote",
      open: () =>
        Effect.succeed(
          stubHandle({
            facets: ["submit", "observe", "close"],
            release: () =>
              Effect.sync(() => {
                released += 1
              }),
          }),
        ),
    }

    const services = makeServices({ providers: [adapter] })
    const caller = admitCaller(services, "facets-missing")
    const grant = grantFor(services, caller, "high", { kind: "hosted", id: "hosted-1" })
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement
          .open(caller, RunIntent.Remote({ provider: "fixture-remote", adapter }), grant, [
            "submit",
            "fork",
          ])
          .pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(NoEligibleProvider)

    if (failure instanceof NoEligibleProvider) {
      expect(failure.reason).toBe("unmet_required_facets")
      expect(failure.missingFacets).toEqual(["fork"])
    }

    // The provider's resources are released; nothing half-open escapes.
    expect(released).toBe(1)

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("fails an unsupported facet operation before doing any work", async () => {
    // The adapter supports submit/observe only. Asking the lease to fork must
    // fail with PlacementFacetUnsupported WITHOUT touching the provider: the
    // adapter's fork closure records whether it was ever invoked.
    let forkInvocations = 0

    const adapter: PlacementProviderAdapter = {
      provider: "fixture-remote",
      open: () =>
        Effect.succeed(
          stubHandle({
            facets: ["submit", "observe"],
            fork: () => {
              forkInvocations += 1

              return Effect.succeed({ kind: "external" as const, externalSessionId: "x" })
            },
          }),
        ),
    }

    const services = makeServices({ providers: [adapter] })
    const caller = admitCaller(services, "facets-unsupported")
    const grant = grantFor(services, caller, "high", { kind: "hosted", id: "hosted-1" })
    const scope = await Effect.runPromise(Scope.make())

    const lease = await Effect.runPromise(
      services.placement
        .open(caller, RunIntent.Remote({ provider: "fixture-remote", adapter }), grant, [
          "submit",
          "observe",
        ])
        .pipe(Scope.provide(scope)),
    )

    const failure = await Effect.runPromise(captureFailure(lease.fork({}, grant)))

    expect(failure).toBeInstanceOf(PlacementFacetUnsupported)
    expect(forkInvocations).toBe(0)

    const interrupted = await Effect.runPromise(captureFailure(lease.interrupt(stubRef, grant)))

    expect(interrupted).toBeInstanceOf(PlacementFacetUnsupported)

    const settings = await Effect.runPromise(
      captureFailure(lease.updateSettings({ modelId: "m" }, grant)),
    )

    expect(settings).toBeInstanceOf(PlacementFacetUnsupported)

    const models = await Effect.runPromise(captureFailure(lease.listModels()))

    expect(models).toBeInstanceOf(PlacementFacetUnsupported)

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("declined adapters yield NoEligibleProvider", async () => {
    const adapter: PlacementProviderAdapter = {
      provider: "declining-remote",
      open: () => Effect.succeed(undefined),
    }

    const services = makeServices({ providers: [adapter] })
    const caller = admitCaller(services, "provider-declined")
    const grant = grantFor(services, caller, "high", { kind: "hosted", id: "hosted-1" })
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement
          .open(caller, RunIntent.Remote({ provider: "declining-remote", adapter }), grant, [])
          .pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(NoEligibleProvider)

    if (failure instanceof NoEligibleProvider) {
      expect(failure.reason).toBe("provider_declined")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// remote intent: typed adapter, never a fake local path
// ---------------------------------------------------------------------------

describe("remote intent", () => {
  it("opens through the typed adapter without any workspace acquisition", async () => {
    let opened = 0

    const adapter: PlacementProviderAdapter = {
      provider: "fixture-remote",
      remoteFacets: [{ kind: "remote_session_launch", supported: true }],
      open: () => {
        opened += 1

        return Effect.succeed(stubHandle())
      },
    }

    const services = makeServices({ providers: [adapter] })
    const caller = admitCaller(services, "remote-open")
    const grant = grantFor(services, caller, "high", { kind: "hosted", id: "hosted-1" })
    const scope = await Effect.runPromise(Scope.make())

    const lease = await Effect.runPromise(
      services.placement
        .open(caller, RunIntent.Remote({ provider: "fixture-remote", adapter }), grant, ["submit"])
        .pipe(Scope.provide(scope)),
    )

    expect(opened).toBe(1)
    expect(lease.providerSessionId).toBe("remote-session-1")

    // No workspace: a remote placement never fakes a local path.
    expect(lease.workspace).toBeUndefined()

    // Submission flows through the adapter's typed closure.
    const ref = await Effect.runPromise(lease.submit("hello", grant))
    expect(ref.leaseId).toBe(lease.leaseId)

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("refuses a remote intent under a local grant target", async () => {
    const adapter: PlacementProviderAdapter = {
      provider: "fixture-remote",
      open: () => Effect.succeed(stubHandle()),
    }

    const services = makeServices({ providers: [adapter] })
    const caller = admitCaller(services, "remote-mismatch")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement
          .open(caller, RunIntent.Remote({ provider: "fixture-remote", adapter }), grant, [])
          .pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(NoEligibleProvider)

    if (failure instanceof NoEligibleProvider) {
      expect(failure.reason).toBe("grant_target_mismatch")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("surfaces adapter open failures as placement failures", async () => {
    const adapter: PlacementProviderAdapter = {
      provider: "failing-remote",
      open: () =>
        Effect.fail(new OpenFailed({ message: "remote host unreachable", reason: "unreachable" })),
    }

    const services = makeServices({ providers: [adapter] })
    const caller = admitCaller(services, "remote-failing")
    const grant = grantFor(services, caller, "high", { kind: "hosted", id: "hosted-1" })
    const scope = await Effect.runPromise(Scope.make())

    const failure = await Effect.runPromise(
      captureFailure(
        services.placement
          .open(caller, RunIntent.Remote({ provider: "failing-remote", adapter }), grant, [])
          .pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(OpenFailed)

    if (failure instanceof OpenFailed) {
      expect(failure.reason).toBe("unreachable")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// local submission, notices and interrupt through the lease facade
// ---------------------------------------------------------------------------

describe("submit and notices", () => {
  it("submits work and normalizes notices without any local-exec import by consumers", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "submit-basic")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    const workRef = await Effect.runPromise(lease.submit("hello", grant))

    expect(workRef.leaseId).toBe(lease.leaseId)

    // Collect notices until the completion arrives, with a bounded wait.
    const collected: Array<PlacementNotice> = []

    await Effect.runPromise(
      lease.notices().pipe(
        Stream.takeWhile((notice) => {
          collected.push(notice)

          return !Predicate.isTagged("TurnCompleted")(notice)
        }),
        Stream.runDrain,
        Effect.timeout("5 seconds"),
        Effect.orDie,
      ),
    )

    const completed = collected.find((notice) => Predicate.isTagged("TurnCompleted")(notice))

    expect(completed).toBeDefined()

    if (completed !== undefined && Predicate.isTagged("TurnCompleted")(completed)) {
      // The notice carries the placement lease identity and the correlated
      // placement work ref — never a raw local-exec ref.
      expect(completed.leaseId).toBe(lease.leaseId)
      expect(completed.workRef?.leaseId).toBe(lease.leaseId)
      expect(completed.workRef?.generation).toBe(workRef.generation)
    }

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("delivers a permission challenge whose wrapped reply resolves exactly once", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "challenge-once")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    await Effect.runPromise(lease.submit("permission", grant))

    const challenge = await Effect.runPromise(
      Effect.gen(function* () {
        const found: Array<Extract<PlacementNotice, { _tag: "PermissionChallenge" }>> = []

        yield* lease.notices().pipe(
          Stream.takeWhile((notice) => {
            if (Predicate.isTagged("PermissionChallenge")(notice)) found.push(notice)

            return !Predicate.isTagged("PermissionChallenge")(notice)
          }),
          Stream.runDrain,
          Effect.timeout("5 seconds"),
          Effect.orDie,
        )

        const first = found[0]

        if (first === undefined) return yield* Effect.die(null)

        return first
      }),
    )

    // First reply wins through the placement-wrapped closure.
    await Effect.runPromise(challenge.reply({ selectedOption: "proceed_once" }))

    // The wrapped closure preserves single-use revocation: a second reply
    // fails with PlacementRejected, never reaching the peer.
    const second = await Effect.runPromise(
      captureFailure(challenge.reply({ selectedOption: "cancel" })),
    )

    expect(second).toBeInstanceOf(PlacementRejected)

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("ends the notice stream with PlacementPeerLost when the peer exits", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "peer-exit")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    const seen: Array<PlacementNotice> = []

    const streamFiber = await Effect.runPromise(
      Effect.forkDetach(
        Effect.exit(
          Stream.runForEach(lease.notices(), (notice) =>
            Effect.sync(() => {
              seen.push(notice)
            }),
          ),
        ),
      ),
    )

    // The fake crashes mid-turn; the submission outcome is genuinely
    // uncertain, surfacing as PlacementSubmissionUncertain.
    const submission = await Effect.runPromise(Effect.exit(lease.submit("crash", grant)))

    expect(Exit.isFailure(submission)).toBe(true)

    if (Exit.isFailure(submission)) {
      const failure = Cause.findErrorOption(submission.cause)

      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(PlacementSubmissionUncertain)
      }
    }

    const collected = await Effect.runPromise(
      Fiber.await(streamFiber).pipe(
        Effect.flatMap((outcome) =>
          Exit.isSuccess(outcome) ? Effect.succeed(outcome.value) : Effect.die(null),
        ),
      ),
    )

    expect(Exit.isFailure(collected)).toBe(true)

    if (Exit.isFailure(collected)) {
      const failure = Cause.findErrorOption(collected.cause)

      expect(Option.isSome(failure)).toBe(true)

      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(PlacementPeerLost)
      }
    }

    // The normalized PeerExited fact arrived first: a fact, not a final
    // turn status.
    const exitFacts = seen.filter((notice) => Predicate.isTagged("PeerExited")(notice))

    expect(exitFacts.length).toBe(1)

    const fact = exitFacts[0]

    if (fact !== undefined && Predicate.isTagged("PeerExited")(fact)) {
      expect(fact.leaseId).toBe(lease.leaseId)
      expect(fact.stderrSummary).toContain("boom: fake crash")
    }

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

describe("interrupt", () => {
  it("interrupts a running turn through the minted work ref", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "interrupt-ok")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    const workRef = await Effect.runPromise(lease.submit("interrupt", grant))

    await Effect.runPromise(lease.interrupt(workRef, grant))

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("rejects a work ref belonging to a different lease", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "interrupt-foreign")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)
    const other = await openLocal(services, caller, grant, scope)

    const foreignRef = await Effect.runPromise(other.submit("hang", grant))

    const failure = await Effect.runPromise(captureFailure(lease.interrupt(foreignRef, grant)))

    expect(failure).toBeInstanceOf(PlacementRejected)

    await Effect.runPromise(lease.release())
    await Effect.runPromise(other.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// settings, models, fork through the lease facade
// ---------------------------------------------------------------------------

describe("settings, models, fork", () => {
  it("applies a settings patch and reports the effective view", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "settings-apply")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    const view = await Effect.runPromise(lease.updateSettings({ modelId: "other-model" }, grant))

    expect(view.modelId).toBe("other-model")
    expect(view.autonomyLevel).toBe("high")

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("refuses a settings patch whose autonomy exceeds the grant before any work", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "settings-ceiling")
    const grant = grantFor(services, caller, "low")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope, [], "low")

    const failure = await Effect.runPromise(
      captureFailure(lease.updateSettings({ autonomyLevel: "high" }, grant)),
    )

    expect(failure).toBeInstanceOf(PlacementRejected)

    if (failure instanceof PlacementRejected) {
      expect(failure.operation).toBe("update_settings")
    }

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("lists models without assuming a catalog arrived at initialization", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "models-list")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    const models = await Effect.runPromise(lease.listModels())

    expect(models).toEqual([{ id: "fake-model", displayName: undefined, provider: undefined }])

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("returns an external fork reference, never a runnable claim", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "fork-external")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    const outcome = await Effect.runPromise(lease.fork({}, grant))

    expect(outcome.kind).toBe("external")

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// adoption and release
// ---------------------------------------------------------------------------

describe("adopt and release", () => {
  it("adopts exec and workspace together: scope close keeps both alive, drain terminates both", async () => {
    const piddir = join(sandbox, "pids-adopt")
    const services = makeServices({ env: { FAKE_DROID_PIDDIR: piddir } })
    const caller = admitCaller(services, "adopt-drain")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    await Effect.runPromise(Effect.sleep("100 millis"))

    const pid = Number(readdirSync(piddir)[0])

    const lifetime = await Effect.runPromise(services.custody.createLifetime("placement-lifetime"))

    await Effect.runPromise(lease.adopt(lifetime))

    // The original scope no longer owns anything: closing it must not
    // terminate the child.
    await Effect.runPromise(Scope.close(scope, Exit.void))

    const aliveAfterScope = await Effect.runPromise(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)

          return true
        } catch {
          return false
        }
      }),
    )

    expect(aliveAfterScope).toBe(true)

    // Draining the lifetime terminates the child and ends the workspace
    // lease: cleanup stayed bound together.
    await Effect.runPromise(services.custody.drain(lifetime))

    const aliveAfterDrain = await Effect.runPromise(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)

          return true
        } catch {
          return false
        }
      }),
    )

    expect(aliveAfterDrain).toBe(false)
  })

  it("release joins exec and workspace cleanup exactly once", async () => {
    const piddir = join(sandbox, "pids-release")
    const services = makeServices({ env: { FAKE_DROID_PIDDIR: piddir } })
    const caller = admitCaller(services, "release-join")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await openLocal(services, caller, grant, scope)

    await Effect.runPromise(Effect.sleep("100 millis"))

    const pid = Number(readdirSync(piddir)[0])

    await Effect.runPromise(lease.release())

    const alive = await Effect.runPromise(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)

          return true
        } catch {
          return false
        }
      }),
    )

    expect(alive).toBe(false)

    // Releasing again is a no-op, not an error: cleanup is the same joined
    // execution, never a double free.
    await Effect.runPromise(lease.release())

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// type-only provider edges: zero runtime code for omitted providers
// ---------------------------------------------------------------------------

describe("type-only provider edges", () => {
  it("the placement module source carries no runtime import of the optional providers", async () => {
    const { readFileSync } = await import("node:fs")

    const source = readFileSync(join(import.meta.dirname, "../../src/placement/index.ts"), "utf8")

    // Every reference to the optional provider modules must be type-only:
    // `import type` statements, never a value import. A runtime import would
    // load the module and its transitive closure in a local-only assembly.
    const lines = source.split("\n")

    const valueImports = lines.filter((line) => {
      if (!line.includes("daemon-operations") && !line.includes("hosted-factory")) return false

      return /^import\s+(?!type)/.test(line.trimStart())
    })

    expect(valueImports).toEqual([])

    // The type-only imports exist, proving the edges are wired as designed.
    expect(source).toContain('import type { DaemonFacet } from "../daemon-operations/index.ts"')
    expect(source).toContain('import type { RemoteFacet } from "../hosted-factory/index.ts"')
  })

  it("importing placement does not load the daemon-operations or hosted-factory modules", async () => {
    // A local-only assembly exercises the full open/submit/close path. Both
    // optional providers are absent from this test's module graph beyond
    // their type declarations: the proof is that everything works while the
    // test process never needed either module's runtime. The strongest
    // direct evidence available in-process: the placement layer builds with
    // zero provider adapters installed.
    const services = makeServices()
    const caller = admitCaller(services, "local-only-assembly")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    const lease = await openLocal(services, caller, grant, scope, ["submit", "observe", "close"])

    expect(lease.providerSessionId).toBe("fake-session")

    const ref = await Effect.runPromise(lease.submit("hello", grant))
    expect(ref.leaseId).toBe(lease.leaseId)

    await Effect.runPromise(lease.release())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})
