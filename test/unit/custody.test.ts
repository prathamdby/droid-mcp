import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { describe, expect, it } from "vitest"

import {
  AcquireFailed,
  Custody,
  custodyLayer,
  DrainFailed,
  LeaseClosed,
} from "../../src/custody/index.ts"
import type { Lease } from "../../src/custody/index.ts"

interface Probe {
  readonly value: string
}

const makeProbe = (value: string): Probe => ({ value })

interface Tracker {
  disposed: Array<string>
  disconnected: Array<string>
}

const makeTracker = (): Tracker => ({ disposed: [], disconnected: [] })

const acquisition = (
  tracker: Tracker,
  name: string,
  options?: {
    readonly idleTimeoutMs?: number
    readonly drainTimeoutMs?: number
    readonly dispose?: (probe: Probe) => Effect.Effect<void, DrainFailed>
    readonly acquire?: Effect.Effect<Probe, AcquireFailed>
  },
) => ({
  name,
  acquire: options?.acquire ?? Effect.succeed(makeProbe(name)),
  dispose:
    options?.dispose ??
    ((probe: Probe) =>
      Effect.sync(() => {
        tracker.disposed.push(probe.value)
      })),
  idleTimeoutMs: options?.idleTimeoutMs,
  drainTimeoutMs: options?.drainTimeoutMs,
})

const borrowing = (
  tracker: Tracker,
  name: string,
  options?: {
    readonly drainTimeoutMs?: number
    readonly disconnect?: (probe: Probe) => Effect.Effect<void, DrainFailed>
  },
) => ({
  name,
  connect: Effect.succeed(makeProbe(name)),
  disconnect:
    options?.disconnect ??
    ((probe: Probe) =>
      Effect.sync(() => {
        tracker.disconnected.push(probe.value)
      })),
  drainTimeoutMs: options?.drainTimeoutMs,
})

const run = <A, E>(effect: Effect.Effect<A, E, Custody>) =>
  Effect.runPromise(Effect.provide(effect, custodyLayer))

const joinSuccess = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Fiber.await(fiber).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.die(null),
    ),
  )

/**
 * Captures the typed failure of an effect. `Effect.flip` cannot serve here
 * because it re-fails `undefined` for effects that legitimately succeed
 * with no value.
 */
const captureFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)

    if (Exit.isFailure(exit)) {
      const found = Cause.findErrorOption(exit.cause)

      if (Option.isSome(found)) return found.value
    }

    return yield* Effect.die(null)
  })

/** Forks an effect and resolves to a fiber of its captured typed failure. */
const forkFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.forkDetach(captureFailure(effect))

describe("provisional acquisition", () => {
  it("closing the scope right after acquire still disposes exactly once", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const scope = yield* Scope.make()
      const lease = yield* custody.acquire(acquisition(tracker, "alpha")).pipe(Scope.provide(scope))

      expect(yield* custody.isActive(lease)).toBe(true)

      yield* Scope.close(scope, Exit.void)

      expect(yield* custody.isActive(lease)).toBe(false)

      return lease
    })

    await run(program)

    expect(tracker.disposed).toEqual(["alpha"])
  })

  it("acquire failure propagates as AcquireFailed and installs no cleanup", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody

      return yield* Effect.flip(
        custody.acquire(
          acquisition(tracker, "broken", {
            acquire: Effect.fail(
              new AcquireFailed({ message: "nope", name: "broken", cause: "boom" }),
            ),
          }),
        ),
      )
    })

    const failure = await run(program.pipe(Effect.scoped))

    expect(failure).toBeInstanceOf(AcquireFailed)
    expect(failure.name).toBe("broken")
    expect(tracker.disposed).toEqual([])
  })

  it("lease exposes id, name and kind but no disposal rights", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const owned = yield* custody.acquire(acquisition(tracker, "owned-one"))
      const borrowed = yield* custody.borrow(borrowing(tracker, "borrowed-one"))

      return { owned, borrowed }
    })

    const { owned, borrowed } = await run(program.pipe(Effect.scoped))

    expect(owned.kind).toBe("owned")
    expect(owned.name).toBe("owned-one")
    expect(owned.id.startsWith("lease:")).toBe(true)
    expect(borrowed.kind).toBe("borrowed")
    expect(Object.keys(owned).sort()).toEqual(["id", "kind", "name"])
    expect(Object.keys(borrowed).sort()).toEqual(["id", "kind", "name"])
  })
})

describe("use", () => {
  it("passes the acquired value to the body and returns its result", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lease = yield* custody.acquire(acquisition(tracker, "usable"))

      return yield* custody.use(lease, (probe) => Effect.succeed("got:" + probe.value))
    })

    const result = await run(program.pipe(Effect.scoped))

    expect(result).toBe("got:usable")
  })

  it("fails with LeaseClosed once closing has begun", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lease = yield* custody.acquire(acquisition(tracker, "closing-fast"))

      yield* custody.release(lease)

      return yield* captureFailure(custody.use(lease, () => Effect.void))
    })

    const failure = await run(program.pipe(Effect.scoped))

    expect(failure).toBeInstanceOf(LeaseClosed)
  })

  it("a use blocked inside the body keeps the lease undisposed until it finishes", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lease = yield* custody.acquire(acquisition(tracker, "slow-body"))
      const entered = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()

      const useFiber = yield* Effect.forkDetach(
        custody.use(lease, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(proceed)
          }),
        ),
      )

      yield* Deferred.await(entered)

      const releaseFiber = yield* Effect.forkDetach(custody.release(lease))

      yield* Effect.sleep(40)

      expect(tracker.disposed).toEqual([])

      yield* Deferred.succeed(proceed, undefined)
      yield* joinSuccess(releaseFiber)
      yield* joinSuccess(useFiber)

      return lease
    })

    await run(program.pipe(Effect.scoped))

    expect(tracker.disposed).toEqual(["slow-body"])
  })
})

describe("release and drain join one cleanup execution", () => {
  it("concurrent release and drain dispose at most once", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("owners")
      const scope = yield* Scope.make()

      const lease = yield* custody
        .acquire(
          acquisition(tracker, "raced", {
            dispose: () =>
              Effect.sleep(30).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    tracker.disposed.push("raced")
                  }),
                ),
              ),
          }),
        )
        .pipe(Scope.provide(scope))

      yield* custody.adopt(lease, lifetime)

      const releaseFiber = yield* Effect.forkDetach(custody.release(lease))
      const drainFiber = yield* Effect.forkDetach(custody.drain(lifetime))

      yield* joinSuccess(releaseFiber)
      yield* joinSuccess(drainFiber)
      yield* Scope.close(scope, Exit.void)

      return lease
    })

    await run(program)

    expect(tracker.disposed).toEqual(["raced"])
  })

  it("double release disposes exactly once", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lease = yield* custody.acquire(acquisition(tracker, "twice"))

      yield* custody.release(lease)
      yield* custody.release(lease)
    })

    await run(program.pipe(Effect.scoped))

    expect(tracker.disposed).toEqual(["twice"])
  })

  it("concurrent joiners share the same failure outcome", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody

      const lease = yield* custody.acquire(
        acquisition(tracker, "failing-dispose", {
          dispose: () =>
            Effect.fail(
              new DrainFailed({ message: "inner", name: "failing-dispose", reason: "x" }),
            ),
        }),
      )

      const firstFiber = yield* forkFailure(custody.release(lease))
      const secondFiber = yield* forkFailure(custody.release(lease))

      return { first: yield* joinSuccess(firstFiber), second: yield* joinSuccess(secondFiber) }
    })

    const { first, second } = await run(program.pipe(Effect.scoped))

    expect(first).toBeInstanceOf(DrainFailed)
    expect(second).toBeInstanceOf(DrainFailed)
    expect(first.message).toBe(second.message)
  })
})

describe("adopt", () => {
  it("closing the original scope after adopt does not dispose; drain does, once", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("main")
      const scope = yield* Scope.make()

      const lease = yield* custody
        .acquire(acquisition(tracker, "adopted"))
        .pipe(Scope.provide(scope))

      yield* custody.adopt(lease, lifetime)
      yield* Scope.close(scope, Exit.void)

      expect(yield* custody.isActive(lease)).toBe(true)
      expect(tracker.disposed).toEqual([])

      yield* custody.drain(lifetime)

      expect(tracker.disposed).toEqual(["adopted"])
    })

    await run(program)
  })

  it("adopt fails with LeaseClosed for a closed lease", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("main")
      const lease = yield* custody.acquire(acquisition(tracker, "gone"))

      yield* custody.release(lease)

      return yield* captureFailure(custody.adopt(lease, lifetime))
    })

    const failure = await run(program.pipe(Effect.scoped))

    expect(failure).toBeInstanceOf(LeaseClosed)
  })

  it("adopt fails with LeaseClosed when the lifetime already drained", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("spent")
      const lease = yield* custody.acquire(acquisition(tracker, "late"))

      yield* custody.drain(lifetime)

      return yield* captureFailure(custody.adopt(lease, lifetime))
    })

    const failure = await run(program.pipe(Effect.scoped))

    expect(failure).toBeInstanceOf(LeaseClosed)
  })

  it("without adopt the lease is disposed when its own scope closes", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const scope = yield* Scope.make()

      const lease = yield* custody
        .acquire(acquisition(tracker, "scoped"))
        .pipe(Scope.provide(scope))

      yield* Scope.close(scope, Exit.void)

      return lease
    })

    await run(program)

    expect(tracker.disposed).toEqual(["scoped"])
  })
})

describe("idle timeout", () => {
  it("disposes an idle adopted lease after idleTimeoutMs", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("idle")

      const lease = yield* custody.acquire(
        acquisition(tracker, "idles-away", { idleTimeoutMs: 40 }),
      )

      yield* custody.adopt(lease, lifetime)
      yield* Effect.sleep(90)

      return yield* custody.isActive(lease)
    })

    const active = await run(program.pipe(Effect.scoped))

    expect(active).toBe(false)
    expect(tracker.disposed).toEqual(["idles-away"])
  })

  it("active use inhibits idle expiry; expiry fires after the body finishes", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("idle")

      const lease = yield* custody.acquire(
        acquisition(tracker, "busy-then-idle", { idleTimeoutMs: 40 }),
      )

      yield* custody.adopt(lease, lifetime)

      const useFiber = yield* Effect.forkDetach(custody.use(lease, () => Effect.sleep(80)))

      yield* Effect.sleep(60)

      expect(tracker.disposed).toEqual([])
      expect(yield* custody.isActive(lease)).toBe(true)

      yield* joinSuccess(useFiber)
      yield* Effect.sleep(70)

      return yield* custody.isActive(lease)
    })

    const active = await run(program.pipe(Effect.scoped))

    expect(active).toBe(false)
    expect(tracker.disposed).toEqual(["busy-then-idle"])
  })

  it("once closing begins, new use fails with LeaseClosed even before disposal finishes", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("idle")

      const lease = yield* custody.acquire(
        acquisition(tracker, "closing-window", {
          idleTimeoutMs: 40,
          dispose: () =>
            Effect.sleep(60).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  tracker.disposed.push("closing-window")
                }),
              ),
            ),
        }),
      )

      yield* custody.adopt(lease, lifetime)
      yield* Effect.sleep(70)

      const failure = yield* captureFailure(custody.use(lease, () => Effect.void))

      yield* Effect.sleep(100)

      return failure
    })

    const failure = await run(program.pipe(Effect.scoped))

    expect(failure).toBeInstanceOf(LeaseClosed)
    expect(tracker.disposed).toEqual(["closing-window"])
  })
})

describe("borrowed leases", () => {
  it("release calls disconnect and never destroys the host", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lease = yield* custody.borrow(borrowing(tracker, "host"))

      yield* custody.use(lease, (probe) => Effect.succeed(probe.value))
      yield* custody.release(lease)
    })

    await run(program.pipe(Effect.scoped))

    expect(tracker.disconnected).toEqual(["host"])
    expect(tracker.disposed).toEqual([])
  })

  it("scope close ends the borrowing through disconnect exactly once", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const scope = yield* Scope.make()

      const lease = yield* custody
        .borrow(borrowing(tracker, "scoped-host"))
        .pipe(Scope.provide(scope))

      yield* Scope.close(scope, Exit.void)

      return lease
    })

    await run(program)

    expect(tracker.disconnected).toEqual(["scoped-host"])
  })
})

describe("bounded drain timeout", () => {
  it("a hanging disposal fails with DrainFailed after drainTimeoutMs", async () => {
    const tracker = makeTracker()
    const startedAt = Date.now()

    const program = Effect.gen(function* () {
      const custody = yield* Custody

      const lease = yield* custody.acquire(
        acquisition(tracker, "hangs", {
          drainTimeoutMs: 60,
          dispose: () => Effect.never.pipe(Effect.asVoid),
        }),
      )

      return yield* captureFailure(custody.release(lease))
    })

    const failure = await run(program.pipe(Effect.scoped))
    const elapsed = Date.now() - startedAt

    expect(failure).toBeInstanceOf(DrainFailed)
    expect(failure.reason).toBe("drain_timeout")
    expect(elapsed).toBeLessThan(1000)
  })

  it("concurrent joiners of a hanging drain all observe DrainFailed", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("owners")
      const gate = yield* Deferred.make<void>()

      const lease = yield* custody.acquire(
        acquisition(tracker, "hangs-together", {
          drainTimeoutMs: 50,
          dispose: () => Deferred.await(gate).pipe(Effect.andThen(Effect.never), Effect.asVoid),
        }),
      )

      yield* custody.adopt(lease, lifetime)

      const releaseFiber = yield* forkFailure(custody.release(lease))

      /*
       * Interleave deterministically: the drain caller arrives while the
       * release-triggered close is already in flight, so both joiners must
       * converge on the same single cleanup execution.
       */
      yield* Effect.sleep(20)

      const drainFiber = yield* forkFailure(custody.drain(lifetime))
      const released = yield* joinSuccess(releaseFiber)
      const drained = yield* joinSuccess(drainFiber)

      return { released, drained }
    })

    const { released, drained } = await run(program.pipe(Effect.scoped))

    expect(released).toBeInstanceOf(DrainFailed)
    expect(drained).toBeInstanceOf(DrainFailed)
    expect(released.reason).toBe("drain_timeout")
    expect(drained.reason).toBe("drain_timeout")
  })

  it("a disposal within the timeout succeeds normally", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody

      const lease = yield* custody.acquire(
        acquisition(tracker, "timely", {
          drainTimeoutMs: 200,
          dispose: (probe) =>
            Effect.sleep(30).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  tracker.disposed.push(probe.value)
                }),
              ),
            ),
        }),
      )

      yield* custody.release(lease)
    })

    await run(program.pipe(Effect.scoped))

    expect(tracker.disposed).toEqual(["timely"])
  })
})

describe("isActive", () => {
  it("reflects open, closed and closing states", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lease: Lease<Probe> = yield* custody.acquire(acquisition(tracker, "stateful"))
      const before = yield* custody.isActive(lease)

      yield* custody.release(lease)

      const after = yield* custody.isActive(lease)

      return { before, after }
    })

    const { before, after } = await run(program.pipe(Effect.scoped))

    expect(before).toBe(true)
    expect(after).toBe(false)
  })
})

describe("drain of multiple leases", () => {
  it("drains every adopted lease exactly once", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("fleet")
      const first = yield* custody.acquire(acquisition(tracker, "one"))
      const second = yield* custody.acquire(acquisition(tracker, "two"))

      yield* custody.adopt(first, lifetime)
      yield* custody.adopt(second, lifetime)
      yield* custody.drain(lifetime)

      return { first, second }
    })

    await run(program.pipe(Effect.scoped))

    expect(tracker.disposed.sort()).toEqual(["one", "two"])
  })

  it("leases never adopted into the lifetime are untouched by drain", async () => {
    const tracker = makeTracker()

    const program = Effect.gen(function* () {
      const custody = yield* Custody
      const lifetime = yield* custody.createLifetime("exclusive")
      const inside = yield* custody.acquire(acquisition(tracker, "inside"))
      const outside = yield* custody.acquire(acquisition(tracker, "outside"))

      yield* custody.adopt(inside, lifetime)
      yield* custody.drain(lifetime)

      expect(tracker.disposed).toEqual(["inside"])
      expect(yield* custody.isActive(outside)).toBe(true)
    })

    await run(program.pipe(Effect.scoped))
  })
})
