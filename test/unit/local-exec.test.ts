import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
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
import {
  ExecRejected,
  ExecSubmissionUncertain,
  InitFailed,
  LocalExec,
  localExecLayer,
  LocalNotice,
  PeerLost,
} from "../../src/local-exec/index.ts"
import type { LocalLease } from "../../src/local-exec/index.ts"
import { Workspaces, workspacesLayer } from "../../src/workspace/index.ts"
import type { WorkspaceLease } from "../../src/workspace/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAKE = join(import.meta.dirname, "../support/fake-droid-exec.mjs")

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "local-exec-test-")))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

interface Services {
  readonly localExec: LocalExec["Service"]
  readonly callers: Callers["Service"]
  readonly authority: Authority["Service"]
  readonly workspaces: Workspaces["Service"]
  readonly custody: Custody["Service"]
}

interface HarnessOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly baseEnv?: Readonly<Record<string, string | undefined>>
  readonly maxAutonomy?: AutonomyLevel
  readonly spawnTimeoutMs?: number
  readonly protectedValues?: ReadonlyArray<string>
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
    disclosureLayer({ protectedValues: options?.protectedValues }),
    dialectLayer,
  )

  const localLive = Layer.provideMerge(
    localExecLayer({
      droidPath: process.execPath,
      args: [FAKE],
      baseEnv: options?.baseEnv,
      env: options?.env,
      spawnTimeoutMs: options?.spawnTimeoutMs,
    }),
    deps,
  )

  const merged = Layer.mergeAll(localLive, deps)

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const localExec = yield* LocalExec
        const callers = yield* Callers
        const authority = yield* Authority
        const workspaces = yield* Workspaces
        const custody = yield* Custody

        return { localExec, callers, authority, workspaces, custody }
      }),
      merged,
    ),
  )
}

const admitCaller = (services: Services, principal: string): Caller =>
  Effect.runSync(services.callers.admit(Option.getOrThrow(trustedEvidence(principal))))

const grantAt = (services: Services, caller: Caller, ceiling: AutonomyLevel): Grant =>
  Effect.runSync(
    services.authority.decide(
      caller,
      { kind: "local", id: "local-1" },
      { effect: "execute" },
      Evidence.Explicit({ ceiling }),
    ),
  )

const acquireWorkspace = (
  services: Services,
  caller: Caller,
  scope: Scope.Scope,
): Promise<WorkspaceLease> =>
  Effect.runPromise(
    services.workspaces
      .acquire(caller, { kind: "borrowed", path: sandbox })
      .pipe(Scope.provide(scope)),
  )

/** Captures the typed failure of an effect. */
const captureFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)

    if (Exit.isFailure(exit)) {
      const found = Cause.findErrorOption(exit.cause)

      if (Option.isSome(found)) return found.value
    }

    return yield* Effect.die(null)
  })

/** Collects notices until `predicate` matches, with a bounded wait. */
const collectUntil = (
  services: Services,
  lease: LocalLease,
  predicate: (notice: LocalNotice) => boolean,
  limit: number,
) =>
  Effect.gen(function* () {
    const notices: Array<LocalNotice> = []

    yield* services.localExec.notices(lease).pipe(
      Stream.takeWhile((notice) => {
        notices.push(notice)

        return !predicate(notice)
      }),
      Stream.take(limit),
      Stream.runDrain,
      Effect.timeout("5 seconds"),
    )

    return notices
  })

const openLease = (
  services: Services,
  workspace: WorkspaceLease,
  grant: Grant,
  scope: Scope.Scope,
  settings?: { readonly autonomyLevel?: AutonomyLevel },
): Promise<LocalLease> =>
  Effect.runPromise(
    services.localExec
      .open(workspace, grant, { autonomyLevel: settings?.autonomyLevel ?? "high" })
      .pipe(Scope.provide(scope)),
  )

// ---------------------------------------------------------------------------
// open + custody
// ---------------------------------------------------------------------------

describe("open", () => {
  it("opens a session against the fake peer and reports its session id", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "open-basic")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const lease = await openLease(services, ws, grant, scope)

    expect(lease.sessionId).toBe("fake-session")
    expect(lease.facilities.updateSettings).toBe(true)
    expect(lease.facilities.interrupt).toBe(true)

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("launches the child with the scrubbed default environment when no baseEnv is given", async () => {
    const dump = join(sandbox, "env-default.json")
    const services = makeServices({ env: { FAKE_DROID_ENV_DUMP: dump } })
    const caller = admitCaller(services, "open-env-default")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const lease = await openLease(services, ws, grant, scope)
    await Effect.runPromise(services.localExec.release(lease))

    // SAFETY: the fake writes its own `process.env` as JSON, which is always
    // a flat string-to-string record.
    const visible = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>

    // Without operator-supplied base entries the launch allowlist falls back
    // to the minimal safe values — never ambient process.env entries such as
    // the very PATH/HOME/LANG of the test runner itself.
    expect(visible["PATH"]).toBe("/usr/bin:/bin")
    expect(visible["HOME"]).toBe("/")
    expect(visible["LANG"]).toBeUndefined()
    expect(visible["TERM"]).toBeUndefined()
    expect(visible["FACTORY_UPSTREAM_CLIENT_TYPE"]).toBe("sdk")
    expect(visible["FAKE_DROID_ENV_DUMP"]).toBe(dump)

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("reads PATH, HOME, LANG and TERM from baseEnv instead of ambient process state", async () => {
    const dump = join(sandbox, "env-base.json")

    const services = makeServices({
      baseEnv: {
        PATH: "/custom/bin",
        HOME: "/custom-home",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
      },
      env: { FAKE_DROID_ENV_DUMP: dump },
    })

    const caller = admitCaller(services, "open-env-base")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const lease = await openLease(services, ws, grant, scope)
    await Effect.runPromise(services.localExec.release(lease))

    // SAFETY: the fake writes its own `process.env` as JSON, which is always
    // a flat string-to-string record.
    const visible = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>

    expect(visible["PATH"]).toBe("/custom/bin")
    expect(visible["HOME"]).toBe("/custom-home")
    expect(visible["LANG"]).toBe("en_US.UTF-8")
    expect(visible["TERM"]).toBe("xterm-256color")

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("terminates the child process when the acquisition scope closes", async () => {
    const piddir = join(sandbox, "pids")
    const services = makeServices({ env: { FAKE_DROID_PIDDIR: piddir } })
    const caller = admitCaller(services, "open-custody")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const lease = await openLease(services, ws, grant, scope)

    // The fake records its pid at spawn; give it a moment to write.
    await Effect.runPromise(Effect.sleep("100 millis"))

    const pidFiles = readdirSync(piddir)
    expect(pidFiles.length).toBe(1)

    const pid = Number(pidFiles[0])

    await Effect.runPromise(Scope.close(scope, Exit.void))

    // After scope close, the child must be gone — custody's drain ran the
    // bounded shutdown even though nothing released the lease explicitly.
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
    void lease
  })

  it("fails with InitFailed when initialize never answers", async () => {
    const services = makeServices({
      env: { FAKE_DROID_INIT: "hang" },
      spawnTimeoutMs: 800,
    })

    const caller = admitCaller(services, "open-hang")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const failure = await Effect.runPromise(
      captureFailure(
        services.localExec.open(ws, grant, { autonomyLevel: "high" }).pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(InitFailed)

    if (failure instanceof InitFailed) {
      expect(failure.reason).toBe("spawn_timeout")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("succeeds even though initialization supplies no usable model catalog", async () => {
    // The fake's initialize reply carries availableModels entries whose shape
    // is thinner than the dialect's strictest schema. Initialization must
    // still succeed and never assume models arrive — exactly what the
    // contract demands.
    const services = makeServices()
    const caller = admitCaller(services, "open-models")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const lease = await openLease(services, ws, grant, scope)
    const models = await Effect.runPromise(services.localExec.listModels(lease))

    // The fake does supply one model entry with a bare id; that much is
    // leniently recoverable. Nothing richer is ever assumed.
    expect(models).toEqual([{ id: "fake-model", displayName: undefined, provider: undefined }])

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("fails with InitFailed when the settings update is rejected", async () => {
    const services = makeServices({ env: { FAKE_DROID_SETTINGS: "reject" } })
    const caller = admitCaller(services, "open-settings-reject")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const failure = await Effect.runPromise(
      captureFailure(
        services.localExec.open(ws, grant, { autonomyLevel: "high" }).pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(InitFailed)

    if (failure instanceof InitFailed) {
      expect(failure.reason).toBe("settings_rejected")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// submit + notices
// ---------------------------------------------------------------------------

describe("submit and notices", () => {
  it("captures fast notices that race the send reply", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "submit-race")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    // Start collecting BEFORE the submit returns; the fake emits completion
    // notices immediately after the reply, so capture must precede the work.
    const collectedFiber = await Effect.runPromise(
      collectUntil(
        services,
        lease,
        (notice) =>
          Predicate.isTagged("TurnCompleted")(notice) || Predicate.isTagged("SessionDelta")(notice),
        20,
      ).pipe(Effect.forkDetach),
    )

    const workRef = await Effect.runPromise(
      services.localExec.submit(lease, { text: "hello" }, grant),
    )

    expect(workRef.generation).toBe(1)
    expect(workRef.leaseId).toBe(lease.id)

    const exit = await Effect.runPromise(
      Fiber.await(collectedFiber).pipe(
        Effect.flatMap((outcome) =>
          Exit.isSuccess(outcome) ? Effect.succeed(outcome.value) : Effect.die(null),
        ),
      ),
    )

    expect(exit.length).toBeGreaterThan(0)

    // The hello script emits create_message, tool calls, deltas and a
    // completion — every one of them captured even though several raced the
    // reply itself.
    const kinds = exit.map((notice) => notice._tag)

    expect(kinds).toContain("SessionDelta")

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("mints strictly monotonic work refs for each submission", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "submit-refs")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const first = await Effect.runPromise(services.localExec.submit(lease, { text: "hang" }, grant))

    const second = await Effect.runPromise(
      services.localExec.submit(lease, { text: "hang" }, grant),
    )

    expect(first.generation).toBe(1)
    expect(second.generation).toBe(2)
    expect(second.correlationId).not.toBe(first.correlationId)

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("correlates notices to the active work ref", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "submit-correlation")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const workRef = await Effect.runPromise(
      services.localExec.submit(lease, { text: "hello" }, grant),
    )

    // Give notices a moment to arrive, then pull whatever is in the queue.
    await Effect.runPromise(Effect.sleep("400 millis"))

    const collected = await Effect.runPromise(
      services.localExec.notices(lease).pipe(
        Stream.take(6),
        Stream.runCollect,
        Effect.timeout("2 seconds"),
        Effect.catch(() => Effect.succeed(null)),
      ),
    )

    const items: ReadonlyArray<LocalNotice> = collected === null ? [] : [...collected]

    const sessionDeltas = items.filter((notice): notice is SessionDeltaNotice =>
      Predicate.isTagged("SessionDelta")(notice),
    )

    expect(sessionDeltas.length).toBeGreaterThan(0)

    for (const delta of sessionDeltas) {
      // Every notice belonging to this session is attributed to the newest
      // active work ref — never backwards, never to a foreign lease.
      expect(delta.leaseId).toBe(lease.id)

      if (delta.workRef !== undefined) {
        expect(delta.workRef.correlationId).toBe(workRef.correlationId)
      }
    }

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// interrupt
// ---------------------------------------------------------------------------

describe("interrupt", () => {
  it("rejects a work ref belonging to a different lease", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "interrupt-foreign")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const other = await openLease(services, ws, grant, scope)

    const foreignRef = await Effect.runPromise(
      services.localExec.submit(other, { text: "hang" }, grant),
    )

    const failure = await Effect.runPromise(
      captureFailure(services.localExec.interrupt(lease, foreignRef, grant)),
    )

    expect(failure).toBeInstanceOf(ExecRejected)

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(services.localExec.release(other))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// updateSettings
// ---------------------------------------------------------------------------

describe("updateSettings", () => {
  it("applies a patch and reports the effective view", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "settings-apply")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const view = await Effect.runPromise(
      services.localExec.updateSettings(lease, { modelId: "other-model" }, grant),
    )

    expect(view.modelId).toBe("other-model")
    expect(view.autonomyLevel).toBe("high")

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("never passes autonomy above the grant ceiling", async () => {
    // The grant ceiling is low, but the caller asks for high. The wire must
    // never see more than the ceiling; the fake echoes the exact params.
    const services = makeServices()
    const caller = admitCaller(services, "settings-ceiling")
    const grant = grantAt(services, caller, "low")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    // open with low: the grant allows it
    const lease = await Effect.runPromise(
      services.localExec.open(ws, grant, { autonomyLevel: "low" }).pipe(Scope.provide(scope)),
    )

    const view = await Effect.runPromise(
      services.localExec.updateSettings(lease, { autonomyLevel: "high" }, grant),
    )

    // The view is clamped: even if the caller asks for high, the effective
    // autonomy under a low-ceiling grant is low.
    expect(view.autonomyLevel).toBe("low")

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

describe("fork", () => {
  it("returns an external reference, never a runnable claim", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "fork-external")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const outcome = await Effect.runPromise(services.localExec.fork(lease, {}, grant))

    // The fork creates a distinct session; this lease stays bound to the
    // original, so the fork is never claimed runnable.
    expect(outcome.kind).toBe("external")

    if (outcome.kind === "external") {
      expect(outcome.externalSessionId).toBe("forked-session")
    }

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("rejects a fork reply that only carries sessionId", async () => {
    const services = makeServices({ env: { FAKE_DROID_FORK: "legacy" } })
    const caller = admitCaller(services, "fork-legacy")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const failure = await Effect.runPromise(
      captureFailure(services.localExec.fork(lease, {}, grant)),
    )

    expect(failure).toBeInstanceOf(ExecRejected)

    if (failure instanceof ExecRejected) {
      expect(failure.message).toContain("reviewed result schema")
    }

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// challenges: single-use reply closure
// ---------------------------------------------------------------------------

describe("challenges", () => {
  it("delivers a permission challenge whose reply resolves exactly once", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "challenge-once")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const workRef = await Effect.runPromise(
      services.localExec.submit(lease, { text: "permission" }, grant),
    )

    // Wait for the challenge to arrive.
    const challenge = await waitForChallenge(services, lease)
    expect(challenge.peerRequestId).toBe("prompt-1")
    expect(challenge.workRef?.correlationId).toBe(workRef.correlationId)

    // First reply wins.
    await Effect.runPromise(challenge.reply({ selectedOption: "proceed_once" }))

    // Second reply fails: single-use, even though the peer id could be reused.
    const second = await Effect.runPromise(
      captureFailure(challenge.reply({ selectedOption: "cancel" })),
    )

    expect(second).toBeInstanceOf(ExecRejected)

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("a reused peer request id never receives a stale reply", async () => {
    // `permission:late` answers the first challenge, then reuses the same
    // wire id for a second challenge. The first challenge's reply closure is
    // exhausted; the second challenge is a fresh epoch with its own closure.
    const services = makeServices()
    const caller = admitCaller(services, "challenge-reuse")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    await Effect.runPromise(services.localExec.submit(lease, { text: "permission:late" }, grant))

    const first = await waitForChallenge(services, lease)
    expect(first.peerRequestId).toBe("prompt-same")

    // Answer the first challenge; the fake then reuses the id.
    await Effect.runPromise(first.reply({ selectedOption: "proceed_once" }))

    // The second challenge arrives with the SAME wire id but is a distinct
    // epoch with a distinct live closure.
    const secondChallenge = await waitForChallenge(services, lease)
    expect(secondChallenge.peerRequestId).toBe("prompt-same")

    // The first closure is long settled; using it again fails without
    // touching the peer — critically, it cannot answer the second challenge.
    const staleReply = await Effect.runPromise(
      captureFailure(first.reply({ selectedOption: "cancel" })),
    )

    expect(staleReply).toBeInstanceOf(ExecRejected)

    // The second challenge still accepts its own exactly-once reply.
    await Effect.runPromise(secondChallenge.reply({ selectedOption: "proceed_once" }))

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }, 15000)
})

type PermissionChallengeNotice = Extract<LocalNotice, { _tag: "PermissionChallenge" }>

type PeerExitedNotice = Extract<LocalNotice, { _tag: "PeerExited" }>

type SessionDeltaNotice = Extract<LocalNotice, { _tag: "SessionDelta" }>

const waitForChallenge = (
  services: Services,
  lease: LocalLease,
): Promise<PermissionChallengeNotice> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const found: Array<PermissionChallengeNotice> = []

      yield* services.localExec.notices(lease).pipe(
        Stream.takeWhile((notice) => {
          if (Predicate.isTagged("PermissionChallenge")(notice)) found.push(notice)

          return !Predicate.isTagged("PermissionChallenge")(notice)
        }),
        Stream.runDrain,
        Effect.timeout("5 seconds"),
      )

      const first = found[0]

      if (first === undefined) return yield* Effect.die(null)

      return first
    }).pipe(Effect.orDie),
  )

// ---------------------------------------------------------------------------
// peer exit: fact, then PeerLost
// ---------------------------------------------------------------------------

describe("peer exit", () => {
  it("emits a PeerExited fact and ends the notice stream with PeerLost", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "exit-fact")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    // Start the notice consumer before crashing the peer, recording every
    // notice as it flows so the PeerExited fact is observable even though
    // the stream ultimately fails.
    const seen: Array<LocalNotice> = []

    const streamFiber = await Effect.runPromise(
      Effect.forkDetach(
        Effect.exit(
          Stream.runForEach(services.localExec.notices(lease), (notice) =>
            Effect.sync(() => {
              seen.push(notice)
            }),
          ),
        ),
      ),
    )

    // The fake crashes mid-turn without answering the submission, so the
    // submission itself is genuinely uncertain — that is the correct typed
    // outcome and not what this case is about.
    const submission = await Effect.runPromise(
      Effect.exit(services.localExec.submit(lease, { text: "crash" }, grant)),
    )

    expect(Exit.isFailure(submission)).toBe(true)

    if (Exit.isFailure(submission)) {
      const failure = Cause.findErrorOption(submission.cause)

      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(ExecSubmissionUncertain)
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
        expect(failure.value).toBeInstanceOf(PeerLost)

        if (failure.value instanceof PeerLost) {
          expect(failure.value.code).toBe(3)
        }
      }
    }

    // The fact itself was emitted before the stream terminated: exit code,
    // signal and a scrubbed stderr summary — never a final turn status.
    const exitFacts = seen.filter((notice): notice is PeerExitedNotice =>
      Predicate.isTagged("PeerExited")(notice),
    )

    expect(exitFacts.length).toBe(1)

    const fact = exitFacts[0]

    if (fact === undefined) throw new Error("missing exit fact")

    expect(fact.code).toBe(3)
    expect(fact.stderrSummary).toContain("boom: fake crash")

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// adopt + drain
// ---------------------------------------------------------------------------

describe("adopt", () => {
  it("adopts the session into a lifetime so drain terminates the child", async () => {
    const piddir = join(sandbox, "pids-adopt")
    const services = makeServices({ env: { FAKE_DROID_PIDDIR: piddir } })
    const caller = admitCaller(services, "adopt-drain")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    await Effect.runPromise(Effect.sleep("100 millis"))

    const pidFiles = readdirSync(piddir)
    const pid = Number(pidFiles[0])

    const lifetime = await Effect.runPromise(services.custody.createLifetime("test-lifetime"))

    await Effect.runPromise(services.localExec.adopt(lease, lifetime))

    // Closing the original scope must NOT terminate the child now.
    await Effect.runPromise(Scope.close(scope, Exit.void))

    const stillAlive = await Effect.runPromise(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)

          return true
        } catch {
          return false
        }
      }),
    )

    expect(stillAlive).toBe(true)

    // Draining the lifetime terminates it.
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
})

// ---------------------------------------------------------------------------
// disclosure scrubbing
// ---------------------------------------------------------------------------

describe("disclosure scrubbing", () => {
  it("scrubs protected values out of notice payloads before they leave the module", async () => {
    const services = makeServices({ protectedValues: ["hunter2-secret"] })
    const caller = admitCaller(services, "scrub-notices")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const seen: Array<LocalNotice> = []

    const consumer = await Effect.runPromise(
      Effect.forkDetach(
        Stream.runForEach(services.localExec.notices(lease), (notice) =>
          Effect.sync(() => {
            seen.push(notice)
          }),
        ),
      ),
    )

    // `echo:` completes the turn with structuredOutput carrying the secret.
    await Effect.runPromise(
      services.localExec.submit(lease, { text: "echo:hunter2-secret" }, grant),
    )

    await Effect.runPromise(Effect.sleep("600 millis"))
    void consumer

    const serialized = JSON.stringify(
      seen.map((notice) => {
        if (Predicate.isTagged("PermissionChallenge")(notice)) {
          const { reply: _reply, ...rest } = notice

          return rest
        }

        if (Predicate.isTagged("QuestionChallenge")(notice)) {
          const { reply: _reply, ...rest } = notice

          return rest
        }

        if (Predicate.isTagged("OptionsChallenge")(notice)) {
          const { reply: _reply, ...rest } = notice

          return rest
        }

        return notice
      }),
    )

    expect(serialized).not.toContain("hunter2-secret")
    expect(serialized).toContain("[REDACTED]")

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// interrupt success path
// ---------------------------------------------------------------------------

describe("interrupt success", () => {
  it("interrupts a running turn", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "interrupt-ok")
    const grant = grantAt(services, caller, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const workRef = await Effect.runPromise(
      services.localExec.submit(lease, { text: "interrupt" }, grant),
    )

    // The turn stays running until interrupted; the interrupt round-trip
    // itself succeeds without uncertainty.
    await Effect.runPromise(services.localExec.interrupt(lease, workRef, grant))

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// grant enforcement
// ---------------------------------------------------------------------------

describe("grant enforcement", () => {
  it("refuses to open when the requested autonomy exceeds the grant", async () => {
    // A low-ceiling grant cannot open a session asking for high autonomy.
    // The module fails closed before any frame reaches the peer.
    const services = makeServices({ maxAutonomy: "low" })
    const caller = admitCaller(services, "grant-denied")
    const grant = grantAt(services, caller, "low")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)

    const failure = await Effect.runPromise(
      captureFailure(
        services.localExec.open(ws, grant, { autonomyLevel: "high" }).pipe(Scope.provide(scope)),
      ),
    )

    expect(failure).toBeInstanceOf(InitFailed)

    if (failure instanceof InitFailed) {
      expect(failure.reason).toBe("denied")
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("rejects operations under a grant belonging to a different caller", async () => {
    const services = makeServices()
    const caller = admitCaller(services, "grant-owner")
    const stranger = admitCaller(services, "grant-stranger")
    const grant = grantAt(services, caller, "high")
    const strangerGrant = grantAt(services, stranger, "high")
    const scope = await Effect.runPromise(Scope.make())
    const ws = await acquireWorkspace(services, caller, scope)
    const lease = await openLease(services, ws, grant, scope)

    const failure = await Effect.runPromise(
      captureFailure(services.localExec.submit(lease, { text: "hello" }, strangerGrant)),
    )

    expect(failure).toBeInstanceOf(ExecRejected)

    await Effect.runPromise(services.localExec.release(lease))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})
