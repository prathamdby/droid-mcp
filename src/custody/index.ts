/**
 * Level 0 `custody` module: provisional acquisition, owned versus borrowed
 * resources, active use, scope transfer and bounded shutdown.
 *
 * A `Lease<A>` exposes only the acquired facility through `use`; disposal
 * rights stay inside this module. Cleanup is installed on the acquisition
 * scope before the lease escapes, so a scope closed immediately after
 * `acquire`/`borrow` still disposes the resource exactly once. `adopt`
 * transfers ownership to a `Lifetime`; closing the original scope afterwards
 * does not dispose, and `drain(lifetime)` joins the same single cleanup
 * execution as `release`.
 *
 * Each lease is supervised by one daemon fiber. Concurrent closers, idle
 * expiry, the bounded drain window and active-use draining are all sequenced
 * through that fiber, so disposal runs at most once and every joiner observes
 * the same outcome. The drain window is bounded: a disposal that hangs past
 * `drainTimeoutMs` loses its race against the timeout, and every joiner fails
 * with `DrainFailed` instead of blocking forever. Borrowed leases never
 * destroy their host: releasing a borrowing only ends local use through the
 * supplied `disconnect` effect.
 */

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

export type LeaseKind = "owned" | "borrowed"

declare const lifetimeBrand: unique symbol

/** An opaque ownership scope created only by `Custody.createLifetime`. */
export interface Lifetime {
  readonly [lifetimeBrand]: true
}

declare const leaseBrand: unique symbol
declare const leaseType: unique symbol

/**
 * An opaque handle to an acquired facility. The value is reachable only
 * through `Custody.use`; the handle never exposes disposal of its host.
 * The type parameter is phantom: it links the handle to the value type
 * `use` will supply, without exposing the value itself.
 */
export interface Lease<out A> {
  readonly [leaseBrand]: true
  readonly id: string
  readonly name: string
  readonly kind: LeaseKind
  readonly [leaseType]?: A
}

export interface Acquisition<A> {
  readonly name: string
  readonly acquire: Effect.Effect<A, AcquireFailed>
  readonly dispose: (value: A) => Effect.Effect<void, DrainFailed>
  readonly idleTimeoutMs?: number
  readonly drainTimeoutMs?: number
}

export interface Borrowing<A> {
  readonly name: string
  readonly connect: Effect.Effect<A, AcquireFailed>
  readonly disconnect: (value: A) => Effect.Effect<void, DrainFailed>
  readonly drainTimeoutMs?: number
}

export class AcquireFailed extends Schema.TaggedError<AcquireFailed>()("AcquireFailed", {
  message: Schema.String,
  name: Schema.String,
  cause: Schema.optional(Schema.String),
}) {}

export class LeaseClosed extends Schema.TaggedError<LeaseClosed>()("LeaseClosed", {
  message: Schema.String,
  leaseId: Schema.String,
}) {}

export class DrainFailed extends Schema.TaggedError<DrainFailed>()("DrainFailed", {
  message: Schema.String,
  name: Schema.String,
  reason: Schema.String,
}) {}

type CloseTrigger = "released" | "drained" | "scope" | "idle"

/**
 * Mutable per-lease record. Disposal rights are confined to this module.
 * The cell is typed at construction time; every operation that only needs
 * the type-erased control plane works through the `AnyLeaseCell` view,
 * which is a safe supertype because the mutable control-plane fields never
 * mention `A` in a variant position.
 */
interface LeaseCell<out A> {
  readonly id: string
  readonly name: string
  readonly kind: LeaseKind
  readonly drainTimeoutMs: number
  readonly idleTimeoutMs: number | undefined
  readonly disposeValue: Effect.Effect<void, DrainFailed>
  readonly value: A
  /** Number of `use` bodies currently inside the resource. */
  activeUsers: number
  /** Suspended drains waiting for `activeUsers` to reach zero. */
  usersWakeups: Array<() => void>
  /**
   * Present only while no closing has started. Taken out by the single
   * authoritative start-close, which any number of closers may then join.
   */
  startLatch: Latch.Latch | undefined
  /** Completes when the single cleanup execution finishes; never fails silently. */
  done: Deferred.Deferred<void, DrainFailed>
  /** Settles the drain outcome once either the disposal or the timeout wins. */
  drainSettlement: Deferred.Deferred<DrainFailed | undefined, never> | undefined
  drainFiber: Fiber.Fiber<void, DrainFailed> | undefined
  supervisor: Fiber.Fiber<void, never> | undefined
  /** Fibers joining this close; interrupted drain-fiber awaiters never block completion. */
  drainAncillary: Set<Fiber.Fiber<void, never>>
  /** True once `close` is initiated through `release` or idle expiry. */
  detached: boolean
  idleTimer: ReturnType<typeof setTimeout> | undefined
  lifetimes: Set<LifetimeRecord>
  trigger: CloseTrigger | undefined
}

interface LifetimeRecord {
  readonly name: string
  /**
   * Active adopted membership. A lease leaves this set when its own close
   * starts, so repeated drains and idle expiry do not re-enter it.
   */
  readonly cells: Set<LeaseCell<never>>
  /**
   * Every lease ever adopted into this lifetime while open. `drain` joins
   * closes already in flight through this set, so a concurrent `release`
   * and `drain` converge on the same single cleanup execution instead of
   * the drain missing a lease whose close already began.
   */
  readonly adopted: Set<LeaseCell<never>>
  drained: boolean
}

/**
 * Module-private registry mapping each public handle to its cell. Handles
 * are opaque outside this module, so this registry is the only way back.
 * The key is typed as the broadest lease; the invariant that each entry is
 * keyed by its own lease is established at the single write site.
 */
const leaseCells = new WeakMap<Lease<never>, LeaseCell<never>>()
const lifetimeRecords = new WeakMap<Lifetime, LifetimeRecord>()

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000

let nextLeaseSequence = 0

const nextLeaseId = (): string => "lease:" + String(++nextLeaseSequence)

const drainTimeoutFailure = (name: string, ms: number): DrainFailed =>
  new DrainFailed({
    message: 'Disposal of "' + name + '" exceeded drain timeout of ' + String(ms) + "ms",
    name,
    reason: "drain_timeout",
  })

const drainInvokeFailure = (name: string, reason: string): DrainFailed =>
  new DrainFailed({
    message: 'Disposal of "' + name + '" failed',
    name,
    reason,
  })

const leaseClosedFor = (leaseId: string, message: string): LeaseClosed =>
  new LeaseClosed({ message, leaseId })

const clearIdleTimer = (cell: LeaseCell<never>): void => {
  if (cell.idleTimer !== undefined) {
    clearTimeout(cell.idleTimer)
    cell.idleTimer = undefined
  }
}

/**
 * Schedules idle expiry for an idle lease attached to a lifetime. The timer
 * is disarmed while a `use` body is inside the resource or closing has
 * started, so active use always inhibits idle expiry.
 */
const armIdleTimer = (cell: LeaseCell<never>): void => {
  clearIdleTimer(cell)

  if (cell.idleTimeoutMs === undefined) return

  if (cell.activeUsers !== 0) return

  if (cell.startLatch === undefined) return

  if (cell.detached) return

  if (cell.lifetimes.size === 0) return

  cell.idleTimer = setTimeout(() => {
    cell.idleTimer = undefined

    cell.detached = true

    if (cell.trigger === undefined) cell.trigger = "idle"

    Effect.runFork(closeLease(cell))
  }, cell.idleTimeoutMs)
}

/**
 * Waits for every active `use` body to finish. A `use` that arrives after
 * closing has begun is rejected before entry, so this wait is finite.
 */
const awaitActiveUsers = (cell: LeaseCell<never>): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (cell.activeUsers === 0) return Effect.void

    return Effect.callback<void>((resume) => {
      cell.usersWakeups.push(() => resume(Effect.void))
    })
  })

/**
 * The single cleanup execution for one lease, run inside the lease's
 * supervisor fiber. Every `release`, `drain`, idle-expiry and scope-close
 * path joins the same execution, so disposal runs at most once.
 */
const runSupervisor = (cell: LeaseCell<never>): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    yield* awaitActiveUsers(cell)

    const settlement = yield* Deferred.make<DrainFailed | undefined, never>()

    cell.drainSettlement = settlement

    {
      const drainFiber = yield* Effect.forkDetach(cell.disposeValue)

      cell.drainFiber = drainFiber

      const outcomeWatcher = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const outcome = yield* Fiber.await(drainFiber)

          const failure: DrainFailed | undefined = Exit.isSuccess(outcome)
            ? undefined
            : Cause.hasInterruptsOnly(outcome.cause)
              ? drainInvokeFailure(cell.name, "dispose_interrupted")
              : drainInvokeFailure(cell.name, "dispose_failed")

          yield* Deferred.completeWith(settlement, Effect.succeed(failure))
        }),
      )

      const timeoutWatcher = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Effect.sleep(cell.drainTimeoutMs)
          yield* Deferred.completeWith(
            settlement,
            Effect.succeed(drainTimeoutFailure(cell.name, cell.drainTimeoutMs)),
          )
        }),
      )

      cell.drainAncillary.add(outcomeWatcher)
      cell.drainAncillary.add(timeoutWatcher)
    }

    const failure = yield* Deferred.await(settlement)

    for (const ancillary of cell.drainAncillary) {
      yield* Fiber.interrupt(ancillary)
    }

    cell.drainAncillary.clear()

    if (failure === undefined) {
      yield* Deferred.completeWith(cell.done, Effect.void)
    } else {
      yield* Deferred.completeWith(cell.done, Effect.fail(failure))
    }
  })

/**
 * One authoritative start-close per lease. The first closer claims the latch
 * and starts the supervisor in a daemon fiber, so interrupting any joiner
 * never cancels the disposal itself. Every closer then awaits the same
 * shared outcome.
 */
const closeLease = (cell: LeaseCell<never>): Effect.Effect<void, DrainFailed> =>
  Effect.gen(function* () {
    yield* startClosing(cell)

    return yield* Deferred.await(cell.done)
  })

/**
 * Claims the close exactly once, interruptibly at the claim boundary but
 * uninterruptibly while the supervisor is installed, so no interruption can
 * strand a lease between "latch taken" and "supervisor running".
 */
const startClosing = (cell: LeaseCell<never>): Effect.Effect<void> =>
  Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      if (cell.startLatch !== undefined) {
        const latch = cell.startLatch

        cell.startLatch = undefined

        clearIdleTimer(cell)

        for (const lifetime of cell.lifetimes) {
          lifetime.cells.delete(cell)
        }

        cell.lifetimes.clear()

        const supervisor = yield* Effect.forkDetach(runSupervisor(cell))

        cell.supervisor = supervisor

        Latch.openUnsafe(latch)
      }
    }),
  )

export interface CustodyApi {
  readonly createLifetime: (name: string) => Effect.Effect<Lifetime>
  readonly acquire: <A>(spec: Acquisition<A>) => Effect.Effect<Lease<A>, AcquireFailed, Scope.Scope>
  readonly borrow: <A>(spec: Borrowing<A>) => Effect.Effect<Lease<A>, AcquireFailed, Scope.Scope>
  readonly adopt: <A>(lease: Lease<A>, into: Lifetime) => Effect.Effect<void, LeaseClosed>
  readonly use: <A, B, E>(
    lease: Lease<A>,
    body: (value: A) => Effect.Effect<B, E>,
  ) => Effect.Effect<B, E | LeaseClosed>
  readonly release: <A>(lease: Lease<A>) => Effect.Effect<void, DrainFailed>
  readonly drain: (lifetime: Lifetime) => Effect.Effect<void, DrainFailed>
  readonly isActive: <A>(lease: Lease<A>) => Effect.Effect<boolean>
}

export class Custody extends Context.Service<Custody, CustodyApi>()("droid-mcp-v2/Custody") {}

interface LeaseSpec<A> {
  readonly name: string
  readonly kind: LeaseKind
  readonly connect: Effect.Effect<A, AcquireFailed>
  readonly disconnect: (value: A) => Effect.Effect<void, DrainFailed>
  readonly drainTimeoutMs: number | undefined
  readonly idleTimeoutMs: number | undefined
}

const acquisitionSpec = <A>(spec: Acquisition<A>): LeaseSpec<A> => ({
  name: spec.name,
  kind: "owned",
  connect: spec.acquire,
  disconnect: spec.dispose,
  drainTimeoutMs: spec.drainTimeoutMs,
  idleTimeoutMs: spec.idleTimeoutMs,
})

const borrowingSpec = <A>(spec: Borrowing<A>): LeaseSpec<A> => ({
  name: spec.name,
  kind: "borrowed",
  connect: spec.connect,
  disconnect: spec.disconnect,
  drainTimeoutMs: spec.drainTimeoutMs,
  idleTimeoutMs: undefined,
})

/**
 * Lease construction shared by `acquire` and `borrow`. The resource effect
 * runs first; the cleanup installation on the provisional scope completes
 * before the lease escapes, so a scope closed immediately afterwards still
 * disposes the resource exactly once.
 */
const leaseEffect = <A>(spec: LeaseSpec<A>): Effect.Effect<Lease<A>, AcquireFailed, Scope.Scope> =>
  Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      const value = yield* spec.connect
      const scope = yield* Effect.scope
      const latch = Latch.makeUnsafe(false)
      const done = Deferred.makeUnsafe<void, DrainFailed>()
      const id = nextLeaseId()

      const cell: LeaseCell<A> = {
        id,
        name: spec.name,
        kind: spec.kind,
        drainTimeoutMs: spec.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
        idleTimeoutMs: spec.idleTimeoutMs,
        disposeValue: spec.disconnect(value),
        value,
        activeUsers: 0,
        usersWakeups: [],
        startLatch: latch,
        done,
        drainSettlement: undefined,
        drainFiber: undefined,
        supervisor: undefined,
        drainAncillary: new Set(),
        detached: false,
        idleTimer: undefined,
        lifetimes: new Set(),
        trigger: undefined,
      }

      // SAFETY: handles are constructed only inside this module, so the
      // private brands cannot be reproduced by outside code.
      const lease = { id, name: spec.name, kind: spec.kind } as Lease<A>

      /*
       * SAFETY: the control plane never uses `A` in a variant position, so
       * a cell constructed with any `A` is interchangeable with its erased
       * control-plane view; this is the single sanctioned erasure point and
       * every later read passes through `cellOf`, which restores the type.
       */
      const erased: LeaseCell<never> = cell as LeaseCell<never>

      /*
       * SAFETY: the only write to the registry. The cell is constructed with
       * exactly this lease's type parameter `A`, and the handle is opaque
       * outside this module, so no other entry can ever collide with or
       * impersonate this key.
       */
      leaseCells.set(lease as Lease<never>, erased)

      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => {
          if (erased.startLatch === undefined) return Effect.void

          /*
           * Ownership transfer semantics: once the lease is adopted into a
           * lifetime (or already released), this scope no longer owns
           * disposal, so its close is not a close of the lease at all.
           */
          if (erased.lifetimes.size > 0 || erased.detached) return Effect.void

          /*
           * The lease outcome belongs to the release/drain callers, not to
           * the acquisition scope: a drain failure must not poison the exit
           * of unrelated work sharing the scope, so it is deliberately
           * absorbed here. The single cleanup execution still reports it to
           * every genuine joiner through the shared outcome.
           */
          return startClosing(erased).pipe(
            Effect.andThen(Effect.exit(Deferred.await(done))),
            Effect.asVoid,
          )
        }),
      )

      return lease
    }),
  )

/**
 * Reads the cell for a lease. The registry invariant — every lease is stored
 * exactly once, keyed by its own handle, with a cell of its own type — is
 * established at construction; a `Lease<A>` forged outside this module is
 * impossible because the brand is unexported.
 */
const cellOf = <A>(lease: Lease<A>): LeaseCell<A> | undefined =>
  // SAFETY: the only writer stores each cell under its own lease handle, and
  // the brand makes external forgery of a lease impossible, so a present
  // entry is always the cell of exactly this lease's type.
  leaseCells.get(lease as Lease<never>) as LeaseCell<A> | undefined

/**
 * The `Custody` service layer. Lease and lifetime state is keyed by the
 * opaque handles themselves, so independent assemblies never share disposal
 * rights and no external string ever proves access.
 */
export const custodyLayer: Layer.Layer<Custody> = Layer.sync(Custody, () => {
  const createLifetime: CustodyApi["createLifetime"] = (name) =>
    Effect.sync(() => {
      // SAFETY: lifetimes are constructed only here; the brand is unforgeable
      // outside this module.
      const lifetime = {} as Lifetime

      lifetimeRecords.set(lifetime, {
        name,
        cells: new Set(),
        adopted: new Set(),
        drained: false,
      })

      return lifetime
    })

  const acquire: CustodyApi["acquire"] = (spec) => leaseEffect(acquisitionSpec(spec))

  const borrow: CustodyApi["borrow"] = (spec) => leaseEffect(borrowingSpec(spec))

  const adopt: CustodyApi["adopt"] = (lease, into) =>
    Effect.suspend(() => {
      const cell = cellOf(lease)

      if (cell === undefined) {
        return Effect.fail(leaseClosedFor(lease.id, "lease is closed"))
      }

      const record = lifetimeRecords.get(into)

      if (record === undefined || record.drained) {
        return Effect.fail(leaseClosedFor(lease.id, "lifetime already drained"))
      }

      if (cell.startLatch === undefined) {
        return Effect.fail(leaseClosedFor(lease.id, "lease is closed or closing"))
      }

      /*
       * SAFETY: the control plane never uses the lease value type in a
       * variant position, so the erased view of the same cell object is
       * interchangeable; the type parameter is restored only by `use`,
       * which reads the value through the typed `cellOf` entry.
       */
      const erased = cell as LeaseCell<never>

      if (!record.cells.has(erased)) {
        cell.lifetimes.add(record)
        record.cells.add(erased)
        record.adopted.add(erased)
        cell.detached = false
      }

      armIdleTimer(erased)

      return Effect.void
    })

  const use: CustodyApi["use"] = (lease, body) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const cell = cellOf(lease)

        if (cell === undefined) {
          return yield* Effect.fail(leaseClosedFor(lease.id, "lease is closed"))
        }

        if (cell.startLatch === undefined) {
          return yield* Effect.fail(leaseClosedFor(lease.id, "lease is closed or closing"))
        }

        /*
         * SAFETY: same control-plane erasure as in `adopt`; the typed cell
         * still owns the value handed to `body` below.
         */
        const erased = cell as LeaseCell<never>

        cell.activeUsers += 1
        clearIdleTimer(erased)

        const settle = Effect.suspend(() => {
          cell.activeUsers -= 1

          if (cell.activeUsers === 0) {
            const wakeups = cell.usersWakeups
            cell.usersWakeups = []

            for (const wake of wakeups) {
              wake()
            }

            if (cell.startLatch !== undefined) {
              armIdleTimer(erased)
            }
          }

          return Effect.void
        })

        return yield* restore(body(cell.value).pipe(Effect.ensuring(settle)))
      }),
    )

  const release: CustodyApi["release"] = (lease) =>
    Effect.suspend(() => {
      const cell = cellOf(lease)

      if (cell === undefined) return Effect.void

      if (cell.trigger === undefined) cell.trigger = "released"

      cell.detached = true

      /*
       * SAFETY: same control-plane erasure as in `adopt`; closing never
       * touches the typed value.
       */
      return closeLease(cell as LeaseCell<never>)
    })

  const drain: CustodyApi["drain"] = (lifetime) =>
    Effect.gen(function* () {
      const record = lifetimeRecords.get(lifetime)

      if (record === undefined) return

      record.drained = true

      /*
       * Membership at drain time is every lease ever adopted into this
       * lifetime while open, even one whose close has already begun
       * elsewhere: concurrent release/drain joiners converge on the same
       * single cleanup execution rather than the drain missing a lease
       * whose close already dropped its active membership.
       */
      const joined = Array.from(record.adopted)

      yield* Effect.forEach(
        joined,
        (cell) =>
          Effect.suspend(() => {
            if (cell.trigger === undefined) cell.trigger = "drained"

            return closeLease(cell)
          }),
        { discard: true },
      )
    })

  const isActive: CustodyApi["isActive"] = (lease) =>
    Effect.sync(() => {
      const cell = cellOf(lease)

      if (cell === undefined) return false

      return cell.startLatch !== undefined
    })

  return { createLifetime, acquire, borrow, adopt, use, release, drain, isActive }
})
