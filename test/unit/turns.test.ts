import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect"
import type { Done } from "effect/Cause"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Authority, authorityLayer, Denied, Evidence } from "../../src/authority/index.ts"
import type { AutonomyLevel, Grant } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { Caller } from "../../src/caller/index.ts"
import { Custody, custodyLayer } from "../../src/custody/index.ts"
import {
  Decisions,
  decisionsLayer,
  HumanChoice,
  InvalidChoice,
  PERMISSION_OUTCOMES,
  ReplyUncertain,
  StaleDecision,
} from "../../src/decisions/index.ts"
import { Disclosure, disclosureLayer, REDACTED, releasedJson } from "../../src/disclosure/index.ts"
import type { Released } from "../../src/disclosure/index.ts"
import { dialectLayer } from "../../src/factory-dialect/index.ts"
import { localExecLayer } from "../../src/local-exec/index.ts"
import { InvalidPosition, Observations, observationsLayer } from "../../src/observations/index.ts"
import {
  Placement,
  PlacementNotice,
  PlacementPeerLost,
  PlacementRejected,
  placementLayer,
  PlacementSubmissionUncertain,
  RunIntent,
} from "../../src/placement/index.ts"
import type {
  Facet,
  PlacementProviderAdapter,
  PlacementWorkRef,
  ProviderHandle,
  RunningLease,
} from "../../src/placement/index.ts"
import {
  Busy,
  InterruptUncertain,
  SubmitRejected,
  turnId,
  Turns,
  turnsLayer,
  TurnSubmissionUncertain,
  TurnUnavailable,
} from "../../src/turns/index.ts"
import type { TurnsOptions } from "../../src/turns/index.ts"
import { workspacesLayer } from "../../src/workspace/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAKE = join(import.meta.dirname, "../support/fake-droid-exec.mjs")

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "turns-test-")))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

interface Services {
  readonly turns: Turns["Service"]
  readonly placement: Placement["Service"]
  readonly callers: Callers["Service"]
  readonly authority: Authority["Service"]
  readonly decisions: Decisions["Service"]
  readonly observations: Observations["Service"]
  readonly disclosure: Disclosure["Service"]
  readonly custody: Custody["Service"]
  readonly close: () => Promise<void>
}

interface HarnessOptions {
  readonly maxAutonomy?: AutonomyLevel
  readonly protectedValues?: ReadonlyArray<string>
  readonly turnsOptions?: TurnsOptions
  readonly providers?: ReadonlyArray<PlacementProviderAdapter>
}

const makeServices = (options?: HarnessOptions): Services => {
  const scope = Effect.runSync(Scope.make())

  const disclosureLive = disclosureLayer({
    protectedValues: options?.protectedValues,
  })

  const authorityLive = authorityLayer({
    maxAutonomy: options?.maxAutonomy ?? "high",
  })

  const workspacesLive = Layer.provideMerge(
    workspacesLayer({ allowedRoots: [sandbox] }),
    custodyLayer,
  )

  const baseDeps = Layer.mergeAll(
    custodyLayer,
    workspacesLive,
    authorityLive,
    callersLayer(),
    disclosureLive,
    dialectLayer,
  )

  const decisionsLive = Layer.provideMerge(decisionsLayer, baseDeps)
  const observationsLive = Layer.provideMerge(observationsLayer, baseDeps)

  const localLive = Layer.provideMerge(
    localExecLayer({
      droidPath: process.execPath,
      args: [FAKE],
    }),
    baseDeps,
  )

  const placementLive = Layer.provideMerge(
    placementLayer({ providers: options?.providers }),
    Layer.mergeAll(localLive, baseDeps),
  )

  const turnsLive = Layer.provideMerge(
    turnsLayer(options?.turnsOptions),
    Layer.mergeAll(decisionsLive, observationsLive, baseDeps),
  )

  const merged = Layer.mergeAll(
    turnsLive,
    placementLive,
    decisionsLive,
    observationsLive,
    localLive,
    baseDeps,
  )

  const context = Effect.runSync(Layer.buildWithScope(merged, scope))

  const built = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const turns = yield* Turns
        const placement = yield* Placement
        const callers = yield* Callers
        const authority = yield* Authority
        const decisions = yield* Decisions
        const observations = yield* Observations
        const disclosure = yield* Disclosure
        const custody = yield* Custody

        return {
          turns,
          placement,
          callers,
          authority,
          decisions,
          observations,
          disclosure,
          custody,
        }
      }),
      context,
    ),
  )

  return {
    ...built,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
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

const openLocalLease = (
  services: Services,
  caller: Caller,
  grant: Grant,
  scope: Scope.Scope,
  autonomyLevel: AutonomyLevel = "high",
): Promise<RunningLease> =>
  Effect.runPromise(
    services.placement
      .open(
        caller,
        RunIntent.Local({
          workspace: { kind: "borrowed", path: sandbox },
          settings: { autonomyLevel },
        }),
        grant,
        ["submit", "observe", "interrupt", "answer"],
      )
      .pipe(Scope.provide(scope)),
  )

// ---------------------------------------------------------------------------
// Synthetic provider harness (for deterministic races & edge cases)
// ---------------------------------------------------------------------------

const ALL_FACETS: ReadonlyArray<Facet> = [
  "submit",
  "observe",
  "interrupt",
  "answer",
  "update_settings",
  "list_models",
  "fork",
  "close",
]

interface SyntheticLeaseRig {
  readonly lease: RunningLease
  readonly emit: (notice: PlacementNotice) => void
  readonly failStream: (message: string) => void
  readonly endStream: () => void
  readonly workRef: (generation: number) => PlacementWorkRef
  readonly submitCount: () => number
  readonly interruptCount: () => number
}

interface SyntheticOptions {
  readonly facets?: ReadonlyArray<Facet>
  readonly onSubmit?: (
    text: string,
    generation: number,
    emit: (notice: PlacementNotice) => void,
    workRef: (generation: number) => PlacementWorkRef,
  ) => Effect.Effect<PlacementWorkRef, PlacementRejected | PlacementSubmissionUncertain>
  readonly onInterrupt?: (
    work: PlacementWorkRef,
  ) => Effect.Effect<void, PlacementRejected | PlacementSubmissionUncertain>
}

const openSyntheticLease = async (
  services: Services,
  caller: Caller,
  scope: Scope.Scope,
  options?: SyntheticOptions,
): Promise<{ readonly rig: SyntheticLeaseRig; readonly grant: Grant }> => {
  const queue = Effect.runSync(Queue.unbounded<PlacementNotice, Done>())
  const streamLost = Effect.runSync(Deferred.make<PlacementPeerLost | undefined>())

  let submits = 0
  let interrupts = 0
  let generation = 0
  let assignedLeaseId = ""

  const mintRef = (gen: number): PlacementWorkRef =>
    // SAFETY: test-only synthetic ref; placement rebinds leaseId on return
    // and tests construct matching notices with this helper.
    ({ leaseId: assignedLeaseId, generation: gen }) as PlacementWorkRef

  const emit = (notice: PlacementNotice): void => {
    Queue.offerUnsafe(queue, notice)
  }

  const failStream = (message: string): void => {
    Deferred.doneUnsafe(streamLost, Effect.succeed(new PlacementPeerLost({ message })))
    Queue.endUnsafe(queue)
  }

  const endStream = (): void => {
    Deferred.doneUnsafe(streamLost, Effect.succeed(undefined))
    Queue.endUnsafe(queue)
  }

  const handle: ProviderHandle = {
    providerSessionId: "synthetic-session",
    facets: options?.facets ?? ALL_FACETS,
    submit: (text) => {
      submits += 1
      generation += 1
      const currentGen = generation

      if (options?.onSubmit !== undefined) {
        return options.onSubmit(text, currentGen, emit, mintRef)
      }

      return Effect.succeed(mintRef(currentGen))
    },
    notices: () =>
      Stream.concat(
        Stream.fromQueue(queue),
        Stream.unwrap(
          Effect.map(Deferred.await(streamLost), (lost) =>
            lost === undefined ? Stream.empty : Stream.fail(lost),
          ),
        ),
      ),
    interrupt: (work) => {
      interrupts += 1

      if (options?.onInterrupt !== undefined) {
        return options.onInterrupt(work)
      }

      return Effect.void
    },
    updateSettings: () => Effect.succeed({ autonomyLevel: "high" as const }),
    listModels: () => Effect.succeed([]),
    fork: () => Effect.succeed({ kind: "external" as const, externalSessionId: "fork-1" }),
    adopt: () => Effect.void,
    release: () =>
      Effect.sync(() => {
        endStream()
      }),
  }

  const adapter: PlacementProviderAdapter = {
    provider: "synthetic",
    open: () => Effect.succeed(handle),
  }

  const grant = grantFor(services, caller, "high", { kind: "hosted", id: "synthetic-1" })

  const lease = await Effect.runPromise(
    services.placement
      .open(caller, RunIntent.Remote({ provider: "synthetic", adapter }), grant, [])
      .pipe(Scope.provide(scope)),
  )

  assignedLeaseId = lease.leaseId

  return {
    grant,
    rig: {
      lease,
      emit,
      failStream,
      endStream,
      workRef: mintRef,
      submitCount: () => submits,
      interruptCount: () => interrupts,
    },
  }
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))

const eventKindsOf = (items: ReadonlyArray<Released<"event">>): ReadonlyArray<string> => {
  const kinds: Array<string> = []

  for (const item of items) {
    const json = releasedJson(item)

    if (Option.isSome(json) && isRecord(json.value)) {
      const kind = json.value["kind"]

      if (Schema.is(Schema.String)(kind)) kinds.push(kind)
    }
  }

  return kinds
}

// ---------------------------------------------------------------------------
// 1. Basic turn lifecycle (real fake-droid-exec)
// ---------------------------------------------------------------------------

describe("basic turn lifecycle", () => {
  it("runs a turn to completion, records observations, summary and lastText", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "turn-basic")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      // Lease observations can be read cleanly before any turn starts.
      const beforePage = await Effect.runPromise(services.turns.observeLease(lease, null, 0))
      expect(beforePage.items).toEqual([])
      expect(beforePage.gap).toBe(false)
      expect(await Effect.runPromise(services.turns.latestTurn(lease))).toBeUndefined()

      const turn = await Effect.runPromise(services.turns.start(lease, { text: "hello" }, grant))

      expect(turnId(turn)).toMatch(/^turn-\d+$/)

      const finalView = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))

      expect(finalView.status).toBe("completed")
      expect(finalView.lastText).toBe("hi")
      expect(finalView.failureReason).toBeUndefined()
      expect(finalView.outstandingDecisions).toEqual([])
      expect(finalView.startedAtMs).toBeGreaterThan(0)
      expect(finalView.finishedAtMs).toBeGreaterThanOrEqual(finalView.startedAtMs)
      expect(finalView.summary).toBeDefined()
      expect(finalView.summary?.sink).toBe("client")

      const latest = await Effect.runPromise(services.turns.latestTurn(lease))
      expect(latest?.status).toBe("completed")
      expect(latest?.lastText).toBe("hi")

      const page = await Effect.runPromise(services.turns.observe(turn, null, 0))
      const kinds = eventKindsOf(page.items)

      expect(kinds).toContain("delta")
      expect(kinds).toContain("turn_completed")

      const leasePage = await Effect.runPromise(services.turns.observeLease(lease, null, 0))
      expect(leasePage.items.length).toBe(page.items.length)

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("scrubs protected values in turn summary and observations via disclosure", async () => {
    const secret = "top-secret-token-xyz"
    const services = makeServices({ protectedValues: [secret] })
    const caller = admitCaller(services, "turn-disclosure")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "echo:" + secret }, grant),
      )

      const view = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))

      expect(view.status).toBe("completed")
      expect(view.summary).toBeDefined()

      if (view.summary !== undefined) {
        const serialized = JSON.stringify(Option.getOrNull(releasedJson(view.summary)))

        expect(serialized).not.toContain(secret)
        expect(serialized).toContain(REDACTED)
      }

      const page = await Effect.runPromise(services.turns.observe(turn, null, 0))

      const allEvents = JSON.stringify(
        page.items.map((item) => Option.getOrNull(releasedJson(item))),
      )

      expect(allEvents).not.toContain(secret)

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Racing fast completion reconciled without resubmission
// ---------------------------------------------------------------------------

describe("racing fast completion", () => {
  it("reconciles completion emitted before submit resolves without resubmitting", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "race-fast")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope, {
        onSubmit: (_text, gen, emit) =>
          Effect.gen(function* () {
            // Peer emits delta and completion BEFORE submit returns workRef.
            emit(
              PlacementNotice.SessionDelta({
                leaseId: rig.lease.leaseId,
                workRef: undefined,
                kind: "assistant_text_delta",
                payload: { textDelta: "fast-answer" },
              }),
            )

            emit(
              PlacementNotice.TurnCompleted({
                leaseId: rig.lease.leaseId,
                workRef: undefined,
                summary: { reason: "completed", fast: true },
              }),
            )

            // Let the pump process both notices while submit is still in flight.
            yield* Effect.sleep("40 millis")

            return rig.workRef(gen)
          }),
      })

      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "go" }, grant))

      expect(rig.submitCount()).toBe(1)

      const view = await Effect.runPromise(services.turns.inspect(turn))

      expect(view.status).toBe("completed")
      expect(view.lastText).toBe("fast-answer")
      expect(view.finishedAtMs).toBeDefined()

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Busy rejection & SubmitRejected slot release
// ---------------------------------------------------------------------------

describe("busy and submission rejection", () => {
  it("rejects a second turn with Busy while one is running", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "turn-busy")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const first = await Effect.runPromise(services.turns.start(lease, { text: "hang" }, grant))

      const secondFailure = await Effect.runPromise(
        captureFailure(services.turns.start(lease, { text: "hello" }, grant)),
      )

      expect(secondFailure).toBeInstanceOf(Busy)

      const view = await Effect.runPromise(services.turns.inspect(first))
      expect(view.status).toBe("running")

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("reserves active slot before sending so concurrent start fails Busy", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "turn-reserve")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const gate = Effect.runSync(Deferred.make<void>())

      const { rig, grant } = await openSyntheticLease(services, caller, scope, {
        onSubmit: (_text, gen) =>
          Effect.gen(function* () {
            yield* Deferred.await(gate)

            return rig.workRef(gen)
          }),
      })

      const firstFiber = await Effect.runPromise(
        Effect.forkDetach(services.turns.start(rig.lease, { text: "first" }, grant)),
      )

      await Effect.runPromise(Effect.sleep("30 millis"))

      // First submit is still in flight; a second start must immediately fail Busy.
      const secondFailure = await Effect.runPromise(
        captureFailure(services.turns.start(rig.lease, { text: "second" }, grant)),
      )

      expect(secondFailure).toBeInstanceOf(Busy)
      expect(rig.submitCount()).toBe(1)

      Deferred.doneUnsafe(gate, Effect.void)

      const firstRef = await Effect.runPromise(Fiber.join(firstFiber))
      expect(turnId(firstRef)).toMatch(/^turn-\d+$/)

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("releases the reserved slot cleanly on SubmitRejected so later turns succeed", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "turn-reject")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const rejected = await Effect.runPromise(
        captureFailure(services.turns.start(lease, { text: "reject" }, grant)),
      )

      expect(rejected).toBeInstanceOf(SubmitRejected)
      expect(await Effect.runPromise(services.turns.latestTurn(lease))).toBeUndefined()

      // Slot was released: a subsequent valid turn succeeds cleanly.
      const next = await Effect.runPromise(services.turns.start(lease, { text: "hello" }, grant))
      const view = await Effect.runPromise(services.turns.wait(next, "terminal", 5000))

      expect(view.status).toBe("completed")

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Wait semantics and timeout without cancelling work
// ---------------------------------------------------------------------------

describe("wait semantics", () => {
  it("wait timeout returns running view without cancelling work; work finishes afterward", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "wait-timeout")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)

      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "slow" }, grant))

      const timedOutView = await Effect.runPromise(services.turns.wait(turn, "terminal", 60))

      expect(timedOutView.status).toBe("running")
      expect(rig.interruptCount()).toBe(0)

      // Work is still alive and completes afterward.
      rig.emit(
        PlacementNotice.SessionDelta({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          kind: "assistant_text_delta",
          payload: { textDelta: "finished" },
        }),
      )

      rig.emit(
        PlacementNotice.TurnCompleted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          summary: { ok: true },
        }),
      )

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 2000))

      expect(completed.status).toBe("completed")
      expect(completed.lastText).toBe("finished")

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("wait with activity returns as soon as a new delta arrives while still running", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "wait-activity")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)

      const turn = await Effect.runPromise(
        services.turns.start(rig.lease, { text: "stream" }, grant),
      )

      const waitFiber = await Effect.runPromise(
        Effect.forkDetach(services.turns.wait(turn, "activity", 3000)),
      )

      await Effect.runPromise(Effect.sleep("30 millis"))

      rig.emit(
        PlacementNotice.SessionDelta({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          kind: "assistant_text_delta",
          payload: { textDelta: "chunk-1" },
        }),
      )

      const view = await Effect.runPromise(Fiber.join(waitFiber))

      expect(view.status).toBe("running")
      expect(view.lastText).toBe("chunk-1")

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("never releases a protected value split across text deltas", async () => {
    const secret = "split-secret-99"
    const services = makeServices({ protectedValues: [secret] })
    const caller = admitCaller(services, "split-delta")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)

      const turn = await Effect.runPromise(
        services.turns.start(rig.lease, { text: "stream" }, grant),
      )

      const cut = Math.floor(secret.length / 2)

      rig.emit(
        PlacementNotice.SessionDelta({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          kind: "assistant_text_delta",
          payload: { textDelta: "echo " + secret.slice(0, cut) },
        }),
      )

      rig.emit(
        PlacementNotice.SessionDelta({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          kind: "assistant_text_delta",
          payload: { textDelta: secret.slice(cut) + " done" },
        }),
      )

      rig.emit(
        PlacementNotice.TurnCompleted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          summary: { ok: true },
        }),
      )

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 2000))

      expect(completed.status).toBe("completed")
      expect(completed.lastText).toBe("echo [REDACTED] done")

      const page = await Effect.runPromise(services.turns.observeLease(rig.lease, null, 0))

      const released = page.items
        .map((item) => {
          const json = releasedJson(item)

          if (Option.isNone(json) || !isRecord(json.value)) return ""

          if (json.value["kind"] !== "delta") return ""

          const payload = json.value["payload"]

          if (!isRecord(payload)) return ""

          const textDelta = payload["textDelta"]

          return Schema.is(Schema.String)(textDelta) ? textDelta : ""
        })
        .join("")

      // Reassembling the released stream in order never yields the secret.
      expect(released).not.toContain(secret)
      expect(released).toContain("echo [REDACTED] done")
      expect(JSON.stringify(page.items)).not.toContain(secret)

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Honest interrupts
// ---------------------------------------------------------------------------

describe("honest interrupts", () => {
  it("does not fabricate interrupted status when interrupt request returns", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "interrupt-honest")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)
      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "work" }, grant))

      await Effect.runPromise(services.turns.interrupt(turn, grant))
      expect(rig.interruptCount()).toBe(1)

      // Status MUST stay running until the peer reports TurnInterrupted.
      const stillRunning = await Effect.runPromise(services.turns.inspect(turn))
      expect(stillRunning.status).toBe("running")

      rig.emit(
        PlacementNotice.TurnInterrupted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          reason: "cancelled",
        }),
      )

      const interrupted = await Effect.runPromise(services.turns.wait(turn, "terminal", 2000))
      expect(interrupted.status).toBe("interrupted")

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("settles as interrupted on real fake-droid-exec interrupt scenario", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "interrupt-real")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "interrupt" }, grant),
      )

      await Effect.runPromise(services.turns.interrupt(turn, grant))

      const view = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))

      expect(view.status).toBe("interrupted")

      // Interrupting an already-settled turn fails with TurnUnavailable.
      const again = await Effect.runPromise(captureFailure(services.turns.interrupt(turn, grant)))

      expect(again).toBeInstanceOf(TurnUnavailable)

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("maps PlacementSubmissionUncertain during interrupt to InterruptUncertain", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "interrupt-uncertain")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope, {
        onInterrupt: () =>
          Effect.fail(
            new PlacementSubmissionUncertain({
              message: "interrupt reply lost",
              operation: "interrupt",
            }),
          ),
      })

      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "work" }, grant))
      const failure = await Effect.runPromise(captureFailure(services.turns.interrupt(turn, grant)))

      expect(failure).toBeInstanceOf(InterruptUncertain)

      const view = await Effect.runPromise(services.turns.inspect(turn))
      expect(view.status).toBe("running")

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Submission uncertainty (zero retries)
// ---------------------------------------------------------------------------

describe("submission uncertainty", () => {
  it("maps PlacementSubmissionUncertain to TurnSubmissionUncertain with zero retries", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "submit-uncertain")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope, {
        onSubmit: () =>
          Effect.fail(
            new PlacementSubmissionUncertain({
              message: "transport dropped after handoff",
              operation: "submit",
            }),
          ),
      })

      const failure = await Effect.runPromise(
        captureFailure(services.turns.start(rig.lease, { text: "mutate" }, grant)),
      )

      expect(failure).toBeInstanceOf(TurnSubmissionUncertain)
      expect(rig.submitCount()).toBe(1)

      const latest = await Effect.runPromise(services.turns.latestTurn(rig.lease))
      expect(latest?.status).toBe("failed")
      expect(latest?.failureReason).toContain("transport dropped after handoff")

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("surfaces TurnSubmissionUncertain when real peer crashes on submit", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "submit-crash")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const failure = await Effect.runPromise(
        captureFailure(services.turns.start(lease, { text: "crash" }, grant)),
      )

      expect(failure).toBeInstanceOf(TurnSubmissionUncertain)

      const latest = await Effect.runPromise(services.turns.latestTurn(lease))
      expect(latest?.status).toBe("failed")

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Interactive challenges -> Decisions -> decide()
// ---------------------------------------------------------------------------

describe("interactive challenges and decisions", () => {
  it("handles real permission challenge end-to-end", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "challenge-permission")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "permission" }, grant),
      )

      const waiting = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 5000),
      )

      expect(waiting.status).toBe("running")
      expect(waiting.outstandingDecisions.length).toBe(1)

      const decision = waiting.outstandingDecisions[0]

      expect(decision).toBeDefined()
      expect(decision?.data.kind).toBe("permission")

      if (decision !== undefined && decision.data.kind === "permission") {
        expect(decision.data.outcomes).toContain("proceed_once")
        expect(decision.data.outcomes).toContain("cancel")

        // An invalid choice leaves the offer still pending and answerable.
        const invalid = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_edit" }),
              grant,
            ),
          ),
        )

        expect(invalid).toBeInstanceOf(InvalidChoice)

        await Effect.runPromise(
          services.turns.decide(
            turn,
            decision.ref,
            HumanChoice.Permission({ outcome: "proceed_once", comment: "looks good" }),
            grant,
          ),
        )

        // Second answer on the same ref fails with StaleDecision.
        const duplicate = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "cancel" }),
              grant,
            ),
          ),
        )

        expect(duplicate).toBeInstanceOf(StaleDecision)
      }

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))

      expect(completed.status).toBe("completed")
      expect(completed.outstandingDecisions).toEqual([])

      if (completed.summary !== undefined) {
        const summaryText = JSON.stringify(Option.getOrNull(releasedJson(completed.summary)))

        expect(summaryText).toContain("proceed_once")
        expect(summaryText).toContain("looks good")
      }

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("enforces caller grant ownership and autonomy cap on decide()", async () => {
    const services = makeServices({ maxAutonomy: "low" })
    const caller = admitCaller(services, "decide-owner")
    const foreign = admitCaller(services, "decide-foreign")
    const lowGrant = grantFor(services, caller, "low")
    const foreignGrant = grantFor(services, foreign, "low")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, lowGrant, scope, "low")

      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "permission:levels" }, lowGrant),
      )

      const waiting = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 5000),
      )

      const decision = waiting.outstandingDecisions[0]
      expect(decision).toBeDefined()

      if (decision !== undefined) {
        // Foreign caller's grant is denied.
        const foreignDenied = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              foreignGrant,
            ),
          ),
        )

        expect(foreignDenied).toBeInstanceOf(Denied)

        // Outcome exceeding autonomy ceiling is denied and leaves offer answerable.
        const capDenied = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_auto_run_high" }),
              lowGrant,
            ),
          ),
        )

        expect(capDenied).toBeInstanceOf(Denied)

        // Valid within-cap outcome succeeds afterward.
        await Effect.runPromise(
          services.turns.decide(
            turn,
            decision.ref,
            HumanChoice.Permission({ outcome: "proceed_once" }),
            lowGrant,
          ),
        )
      }

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))
      expect(completed.status).toBe("completed")

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("handles real question challenge end-to-end", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "challenge-question")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)
      const turn = await Effect.runPromise(services.turns.start(lease, { text: "ask" }, grant))

      const waiting = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 5000),
      )

      expect(waiting.outstandingDecisions.length).toBe(1)

      const decision = waiting.outstandingDecisions[0]
      expect(decision?.data.kind).toBe("question")

      if (decision !== undefined && decision.data.kind === "question") {
        expect(decision.data.questions.length).toBe(2)
        expect(decision.data.questions[0]?.text).toBe("Which runner?")

        await Effect.runPromise(
          services.turns.decide(
            turn,
            decision.ref,
            HumanChoice.Question({
              answers: [
                { index: 0, answer: "vitest" },
                { index: 1, answer: "lint,types" },
              ],
            }),
            grant,
          ),
        )
      }

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))
      expect(completed.status).toBe("completed")

      if (completed.summary !== undefined) {
        const summaryText = JSON.stringify(Option.getOrNull(releasedJson(completed.summary)))

        expect(summaryText).toContain("vitest")
        expect(summaryText).toContain("lint,types")
      }

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("handles real options challenge end-to-end", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "challenge-options")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)
      const turn = await Effect.runPromise(services.turns.start(lease, { text: "pick" }, grant))

      const waiting = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 5000),
      )

      expect(waiting.outstandingDecisions.length).toBe(1)

      const decision = waiting.outstandingDecisions[0]
      expect(decision?.data.kind).toBe("options")

      if (decision !== undefined && decision.data.kind === "options") {
        expect(decision.data.title).toBe("Pick a repo")
        expect(decision.data.rows.map((row) => row.id)).toEqual(["repo-a", "repo-b", "repo-c"])

        await Effect.runPromise(
          services.turns.decide(
            turn,
            decision.ref,
            HumanChoice.Options({ selectedIds: ["repo-b"] }),
            grant,
          ),
        )
      }

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))
      expect(completed.status).toBe("completed")

      if (completed.summary !== undefined) {
        const summaryText = JSON.stringify(Option.getOrNull(releasedJson(completed.summary)))

        expect(summaryText).toContain("repo-b")
      }

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("surfaces ReplyUncertain when a challenge reply fails delivery and consumes the offer", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "challenge-uncertain")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)
      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "ask" }, grant))

      let replyCalls = 0

      rig.emit(
        PlacementNotice.PermissionChallenge({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          peerRequestId: "peer-1",
          toolUses: [],
          options: ["proceed_once", "cancel"],
          reply: () => {
            replyCalls += 1

            return Effect.fail(
              new PlacementRejected({
                message: "connection lost after handoff (uncertain)",
                operation: "answer",
              }),
            )
          },
        }),
      )

      const waiting = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 2000),
      )

      const decision = waiting.outstandingDecisions[0]
      expect(decision).toBeDefined()

      if (decision !== undefined) {
        const failure = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              grant,
            ),
          ),
        )

        expect(failure).toBeInstanceOf(ReplyUncertain)

        if (failure instanceof ReplyUncertain) {
          expect(failure.delivery).toBe("uncertain")
        }

        expect(replyCalls).toBe(1)

        // Decision was consumed and cannot be replayed.
        const retry = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              grant,
            ),
          ),
        )

        expect(retry).toBeInstanceOf(StaleDecision)
        expect(replyCalls).toBe(1)
      }

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Evicted prompt event (Structural Proof 1 property)
// ---------------------------------------------------------------------------

describe("evicted prompt event independence", () => {
  it("keeps live decision inspectable and answerable even after observations evicts its event", async () => {
    const services = makeServices({
      turnsOptions: { maxEvents: 5 },
    })

    const caller = admitCaller(services, "evict-prompt")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)
      const initialPage = await Effect.runPromise(services.turns.observeLease(lease, null, 0))

      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "permission:flood" }, grant),
      )

      // Wait for the permission decision to be registered.
      const withDecision = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 5000),
      )

      expect(withDecision.outstandingDecisions.length).toBe(1)

      // Wait for the 80 flood tool_result events (~40ms delay in fake) to evict
      // the decision_offered event out of the 5-event retention window.
      let evictedPage = await Effect.runPromise(
        services.turns.observe(turn, initialPage.resume, 500),
      )

      for (let attempt = 0; attempt < 20 && !evictedPage.gap; attempt += 1) {
        await Effect.runPromise(Effect.sleep("50 millis"))
        evictedPage = await Effect.runPromise(services.turns.observe(turn, initialPage.resume, 0))
      }

      expect(evictedPage.gap).toBe(true)
      expect(evictedPage.omittedCount).toBeGreaterThan(0)
      expect(eventKindsOf(evictedPage.items)).not.toContain("decision_offered")

      // Decisions are NEVER inferred from retained observation history: the
      // live decision is still present in inspect() AND answerable via decide().
      const afterEviction = await Effect.runPromise(services.turns.inspect(turn))

      expect(afterEviction.status).toBe("running")
      expect(afterEviction.outstandingDecisions.length).toBe(1)

      const liveDecision = afterEviction.outstandingDecisions[0]
      expect(liveDecision).toBeDefined()

      if (liveDecision !== undefined) {
        await Effect.runPromise(
          services.turns.decide(
            turn,
            liveDecision.ref,
            HumanChoice.Permission({ outcome: "proceed_once" }),
            grant,
          ),
        )
      }

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))

      expect(completed.status).toBe("completed")
      expect(completed.outstandingDecisions).toEqual([])

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  }, 15000)
})

// ---------------------------------------------------------------------------
// 9. Peer crash mid-turn vs clean exit after completion
// ---------------------------------------------------------------------------

describe("peer exit handling", () => {
  it("settles a running turn as failed with scrubbed stderr and retires live decisions on peer crash", async () => {
    const secret = "stderr-secret-42"
    const services = makeServices({ protectedValues: [secret] })
    const caller = admitCaller(services, "peer-crash-mid")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)
      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "run" }, grant))

      rig.emit(
        PlacementNotice.PermissionChallenge({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          peerRequestId: "p-1",
          toolUses: [],
          options: ["proceed_once", "cancel"],
          reply: () => Effect.void,
        }),
      )

      const withPrompt = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 2000),
      )

      const decision = withPrompt.outstandingDecisions[0]
      expect(decision).toBeDefined()

      // Peer crashes mid-turn with a secret in stderr.
      rig.emit(
        PlacementNotice.PeerExited({
          leaseId: rig.lease.leaseId,
          stderrSummary: "fatal crash: " + secret,
        }),
      )
      rig.failStream("peer process crashed")

      const failed = await Effect.runPromise(services.turns.wait(turn, "terminal", 2000))

      expect(failed.status).toBe("failed")
      expect(failed.failureReason).toContain("fatal crash:")
      expect(failed.failureReason).not.toContain(secret)
      expect(failed.failureReason).toContain(REDACTED)
      expect(failed.outstandingDecisions).toEqual([])

      // Live decision was retired atomically when the turn failed.
      if (decision !== undefined) {
        const stale = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              grant,
            ),
          ),
        )

        expect(stale).toBeInstanceOf(StaleDecision)
      }

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("preserves completed status when peer exits cleanly after completion (done-exit)", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "peer-done-exit")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "done-exit" }, grant),
      )

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))
      expect(completed.status).toBe("completed")

      // Wait for the fake peer's 40ms delayed exit and PeerExited + PlacementPeerLost.
      await Effect.runPromise(Effect.sleep("180 millis"))

      const afterExit = await Effect.runPromise(services.turns.inspect(turn))
      expect(afterExit.status).toBe("completed")
      expect(afterExit.failureReason).toBeUndefined()

      // Starting another turn after the peer died is rejected.
      const rejected = await Effect.runPromise(
        captureFailure(services.turns.start(lease, { text: "hello" }, grant)),
      )

      expect(rejected).toBeInstanceOf(SubmitRejected)

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 10. Late events from earlier turn never settle newer turn & single terminal
// ---------------------------------------------------------------------------

describe("generation isolation and single terminal transition", () => {
  it("ignores late notices from an earlier turn and allows only one terminal transition", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "late-events")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)

      // Turn 1 (generation 1) runs and completes.
      const turn1 = await Effect.runPromise(services.turns.start(rig.lease, { text: "t1" }, grant))

      rig.emit(
        PlacementNotice.TurnCompleted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          summary: { turn: 1 },
        }),
      )

      const view1 = await Effect.runPromise(services.turns.wait(turn1, "terminal", 2000))
      expect(view1.status).toBe("completed")

      // A late TurnFailed for generation 1 cannot alter Turn 1's permanent status.
      rig.emit(
        PlacementNotice.TurnFailed({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          code: "late",
          message: "late failure",
        }),
      )

      await Effect.runPromise(Effect.sleep("30 millis"))
      expect((await Effect.runPromise(services.turns.inspect(turn1))).status).toBe("completed")

      // Turn 2 (generation 2) starts.
      const turn2 = await Effect.runPromise(services.turns.start(rig.lease, { text: "t2" }, grant))

      // Late notices carrying generation 1 MUST NOT settle Turn 2 or add decisions to it.
      rig.emit(
        PlacementNotice.PermissionChallenge({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          peerRequestId: "stale-p1",
          toolUses: [],
          options: ["proceed_once"],
          reply: () => Effect.void,
        }),
      )

      rig.emit(
        PlacementNotice.TurnCompleted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          summary: { stale: true },
        }),
      )

      rig.emit(
        PlacementNotice.TurnInterrupted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          reason: "stale-interrupt",
        }),
      )

      await Effect.runPromise(Effect.sleep("40 millis"))

      const turn2Mid = await Effect.runPromise(services.turns.inspect(turn2))
      expect(turn2Mid.status).toBe("running")
      expect(turn2Mid.outstandingDecisions).toEqual([])

      // Genuine generation 2 completion settles Turn 2.
      rig.emit(
        PlacementNotice.TurnCompleted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(2),
          summary: { turn: 2 },
        }),
      )

      const turn2Done = await Effect.runPromise(services.turns.wait(turn2, "terminal", 2000))
      expect(turn2Done.status).toBe("completed")

      if (turn2Done.summary !== undefined) {
        expect(Option.getOrNull(releasedJson(turn2Done.summary))).toEqual({ turn: 2 })
      }

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("ignores a late generation-1 completion arriving while generation-2 submit is in flight", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "late-during-submit")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope, {
        onSubmit: (_text, gen, emit, workRef) =>
          Effect.gen(function* () {
            if (gen === 2) {
              // Stale completion from generation 1 arrives during turn 2 submit!
              emit(
                PlacementNotice.TurnCompleted({
                  leaseId: rig.lease.leaseId,
                  workRef: workRef(1),
                  summary: { staleFromGen1: true },
                }),
              )

              yield* Effect.sleep("30 millis")
            }

            return workRef(gen)
          }),
      })

      const turn1 = await Effect.runPromise(services.turns.start(rig.lease, { text: "t1" }, grant))

      rig.emit(
        PlacementNotice.TurnCompleted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          summary: { turn: 1 },
        }),
      )

      await Effect.runPromise(services.turns.wait(turn1, "terminal", 2000))

      const turn2 = await Effect.runPromise(services.turns.start(rig.lease, { text: "t2" }, grant))

      // Turn 2 must still be running; generation-1 notice was ignored.
      const view2 = await Effect.runPromise(services.turns.inspect(turn2))
      expect(view2.status).toBe("running")

      rig.emit(
        PlacementNotice.TurnCompleted({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(2),
          summary: { turn: 2 },
        }),
      )

      const done2 = await Effect.runPromise(services.turns.wait(turn2, "terminal", 2000))
      expect(done2.status).toBe("completed")

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 11. retireLease cleanup
// ---------------------------------------------------------------------------

describe("retireLease", () => {
  it("retires active decisions, settles running turn, drains pump and seals history", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "retire-active")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const lease = await openLocalLease(services, caller, grant, scope)

      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "permission" }, grant),
      )

      const withPrompt = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 5000),
      )

      const decision = withPrompt.outstandingDecisions[0]
      expect(decision).toBeDefined()

      await Effect.runPromise(services.turns.retireLease(lease))

      // Calling retireLease a second time is idempotent.
      await Effect.runPromise(services.turns.retireLease(lease))

      const afterRetire = await Effect.runPromise(services.turns.inspect(turn))
      expect(afterRetire.status).toBe("failed")
      expect(afterRetire.outstandingDecisions).toEqual([])

      if (decision !== undefined) {
        const stale = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              grant,
            ),
          ),
        )

        expect(stale).toBeInstanceOf(StaleDecision)
      }

      const observeRetired = await Effect.runPromise(
        captureFailure(services.turns.observeLease(lease, null, 0)),
      )

      expect(observeRetired).toBeInstanceOf(TurnUnavailable)

      const observeTurnRetired = await Effect.runPromise(
        captureFailure(services.turns.observe(turn, null, 0)),
      )

      expect(observeTurnRetired).toBeInstanceOf(TurnUnavailable)

      const startRetired = await Effect.runPromise(
        captureFailure(services.turns.start(lease, { text: "hello" }, grant)),
      )

      expect(startRetired).toBeInstanceOf(SubmitRejected)

      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("rejects observeLease after retiring a lease that never started a turn", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "retire-unused")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig } = await openSyntheticLease(services, caller, scope)

      await Effect.runPromise(services.turns.retireLease(rig.lease))

      const failure = await Effect.runPromise(
        captureFailure(services.turns.observeLease(rig.lease, null, 0)),
      )

      expect(failure).toBeInstanceOf(TurnUnavailable)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 12. Additional contract edge cases
// ---------------------------------------------------------------------------

describe("additional contract edge cases", () => {
  it("handles real spec proceed_edit and deny cancel scenarios", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "spec-deny")
    const grant = grantFor(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const specLease = await openLocalLease(services, caller, grant, scope)

      const specTurn = await Effect.runPromise(
        services.turns.start(specLease, { text: "spec" }, grant),
      )

      const specWait = await Effect.runPromise(
        services.turns.wait(specTurn, "decision_or_terminal", 5000),
      )

      const specDecision = specWait.outstandingDecisions[0]
      expect(specDecision).toBeDefined()

      if (specDecision !== undefined) {
        await Effect.runPromise(
          services.turns.decide(
            specTurn,
            specDecision.ref,
            HumanChoice.Permission({
              outcome: "proceed_edit",
              editedSpecContent: "# updated plan\n",
            }),
            grant,
          ),
        )
      }

      const specDone = await Effect.runPromise(services.turns.wait(specTurn, "terminal", 5000))
      expect(specDone.status).toBe("completed")

      if (specDone.summary !== undefined) {
        const text = JSON.stringify(Option.getOrNull(releasedJson(specDone.summary)))
        expect(text).toContain("# updated plan")
      }

      await Effect.runPromise(services.turns.retireLease(specLease))
      await Effect.runPromise(specLease.release())

      const denyLease = await openLocalLease(services, caller, grant, scope)

      const denyTurn = await Effect.runPromise(
        services.turns.start(denyLease, { text: "deny" }, grant),
      )

      const denyWait = await Effect.runPromise(
        services.turns.wait(denyTurn, "decision_or_terminal", 5000),
      )

      const denyDecision = denyWait.outstandingDecisions[0]
      expect(denyDecision).toBeDefined()

      if (denyDecision !== undefined) {
        await Effect.runPromise(
          services.turns.decide(
            denyTurn,
            denyDecision.ref,
            HumanChoice.Permission({ outcome: "cancel" }),
            grant,
          ),
        )
      }

      const denyDone = await Effect.runPromise(services.turns.wait(denyTurn, "terminal", 5000))
      expect(denyDone.status).toBe("interrupted")

      await Effect.runPromise(services.turns.retireLease(denyLease))
      await Effect.runPromise(denyLease.release())
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("propagates InvalidPosition when passing a foreign feed position to observe/observeLease", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "invalid-pos")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig: rigA, grant } = await openSyntheticLease(services, caller, scope)
      const { rig: rigB } = await openSyntheticLease(services, caller, scope)

      const pageA = await Effect.runPromise(services.turns.observeLease(rigA.lease, null, 0))
      const turnB = await Effect.runPromise(services.turns.start(rigB.lease, { text: "b" }, grant))

      const leaseErr = await Effect.runPromise(
        captureFailure(services.turns.observeLease(rigB.lease, pageA.resume, 0)),
      )

      expect(leaseErr).toBeInstanceOf(InvalidPosition)

      const turnErr = await Effect.runPromise(
        captureFailure(services.turns.observe(turnB, pageA.resume, 0)),
      )

      expect(turnErr).toBeInstanceOf(InvalidPosition)

      await Effect.runPromise(services.turns.retireLease(rigA.lease))
      await Effect.runPromise(services.turns.retireLease(rigB.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it.each<{
    label: string
    options: Schema.Json | undefined
    expected: ReadonlyArray<string>
  }>([
    { label: "a non-array", options: "proceed_once", expected: [] },
    { label: "a malformed entry", options: ["cancel", { value: 1 }], expected: [] },
    { label: "only unknown outcomes", options: ["unknown"], expected: [] },
    { label: "mixed known and unknown outcomes", options: ["cancel", "unknown"], expected: [] },
    {
      label: "a reviewed file-scoped outcome",
      options: ["proceed_always_file"],
      expected: ["proceed_always_file"],
    },
    { label: "omitted options", options: undefined, expected: PERMISSION_OUTCOMES },
    { label: "an explicit empty list", options: [], expected: [] },
  ])("offers only the expected permission outcomes for $label", async ({ options, expected }) => {
    const services = makeServices()
    const caller = admitCaller(services, "malformed-permission-options")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)
      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "ask" }, grant))

      rig.emit(
        PlacementNotice.PermissionChallenge({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          peerRequestId: "p-choices",
          toolUses: [],
          options,
          reply: () => Effect.void,
        }),
      )

      const waiting = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 2000),
      )

      expect(waiting.outstandingDecisions.map(({ data }) => data)).toEqual([
        { kind: "permission", summary: "Permission requested", details: [], outcomes: expected },
      ])
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("expires live decisions after decisionTimeoutMs and reflects empty outstandingDecisions", async () => {
    const services = makeServices({
      turnsOptions: { decisionTimeoutMs: 60 },
    })

    const caller = admitCaller(services, "decision-timeout")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)
      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "ask" }, grant))

      rig.emit(
        PlacementNotice.PermissionChallenge({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          peerRequestId: "p-timeout",
          toolUses: [],
          options: ["proceed_once", "cancel"],
          reply: () => Effect.void,
        }),
      )

      const withPrompt = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 2000),
      )

      const decision = withPrompt.outstandingDecisions[0]
      expect(decision).toBeDefined()

      await Effect.runPromise(Effect.sleep("120 millis"))

      const afterTimeout = await Effect.runPromise(services.turns.inspect(turn))
      expect(afterTimeout.status).toBe("running")
      expect(afterTimeout.outstandingDecisions).toEqual([])

      if (decision !== undefined) {
        const stale = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              grant,
            ),
          ),
        )

        expect(stale).toBeInstanceOf(StaleDecision)
      }

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("handles unsupported submit and interrupt facets cleanly", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "unsupported-facets")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig: noSubmit, grant } = await openSyntheticLease(services, caller, scope, {
        facets: ["observe"],
      })

      const submitErr = await Effect.runPromise(
        captureFailure(services.turns.start(noSubmit.lease, { text: "x" }, grant)),
      )

      expect(submitErr).toBeInstanceOf(SubmitRejected)

      const { rig: noInterrupt } = await openSyntheticLease(services, caller, scope, {
        facets: ["submit", "observe"],
      })

      const turn = await Effect.runPromise(
        services.turns.start(noInterrupt.lease, { text: "x" }, grant),
      )

      const interruptErr = await Effect.runPromise(
        captureFailure(services.turns.interrupt(turn, grant)),
      )

      expect(interruptErr).toBeInstanceOf(TurnUnavailable)

      await Effect.runPromise(services.turns.retireLease(noSubmit.lease))
      await Effect.runPromise(services.turns.retireLease(noInterrupt.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })

  it("settles as failed with scrubbed reason and retires decisions on TurnFailed notice", async () => {
    const secret = "turn-fail-secret-99"
    const services = makeServices({ protectedValues: [secret] })
    const caller = admitCaller(services, "turn-failed-notice")
    const scope = await Effect.runPromise(Scope.make())

    try {
      const { rig, grant } = await openSyntheticLease(services, caller, scope)
      const turn = await Effect.runPromise(services.turns.start(rig.lease, { text: "fail" }, grant))

      rig.emit(
        PlacementNotice.PermissionChallenge({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          peerRequestId: "p-fail",
          toolUses: [],
          options: ["proceed_once", "cancel"],
          reply: () => Effect.void,
        }),
      )

      const withPrompt = await Effect.runPromise(
        services.turns.wait(turn, "decision_or_terminal", 2000),
      )

      const decision = withPrompt.outstandingDecisions[0]
      expect(decision).toBeDefined()

      rig.emit(
        PlacementNotice.TurnFailed({
          leaseId: rig.lease.leaseId,
          workRef: rig.workRef(1),
          code: "model_error",
          message: "upstream error: " + secret,
        }),
      )

      const failed = await Effect.runPromise(services.turns.wait(turn, "terminal", 2000))
      expect(failed.status).toBe("failed")
      expect(failed.failureReason).not.toContain(secret)
      expect(failed.failureReason).toContain(REDACTED)
      expect(failed.outstandingDecisions).toEqual([])

      if (decision !== undefined) {
        const stale = await Effect.runPromise(
          captureFailure(
            services.turns.decide(
              turn,
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              grant,
            ),
          ),
        )

        expect(stale).toBeInstanceOf(StaleDecision)
      }

      await Effect.runPromise(services.turns.retireLease(rig.lease))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await services.close()
    }
  })
})
