import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Authority, authorityLayer, Evidence } from "../../src/authority/index.ts"
import type { AutonomyLevel } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { Caller } from "../../src/caller/index.ts"
import {
  Capabilities,
  capabilitiesLayer,
  withReplacedDescription,
} from "../../src/capabilities/index.ts"
import type { Invocation } from "../../src/capabilities/index.ts"
import { Custody, custodyLayer } from "../../src/custody/index.ts"
import {
  Decisions,
  decisionsLayer,
  decisionRefLabel,
  HumanChoice,
} from "../../src/decisions/index.ts"
import { Disclosure, disclosureLayer, releasedJson } from "../../src/disclosure/index.ts"
import { dialectLayer } from "../../src/factory-dialect/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import { localExecLayer } from "../../src/local-exec/index.ts"
import { Observations, observationsLayer } from "../../src/observations/index.ts"
import { Placement, placementLayer, PlacementPeerLost } from "../../src/placement/index.ts"
import type { PlacementProviderAdapter, ProviderHandle } from "../../src/placement/index.ts"
import {
  NotVisible,
  SessionChange,
  SessionIntent,
  SessionOperationFailed,
  SessionRefused,
  sessionRefId,
  Sessions,
  sessionsLayer,
} from "../../src/sessions/index.ts"
import type { SessionsOptions } from "../../src/sessions/index.ts"
import { Turns, turnsLayer } from "../../src/turns/index.ts"
import type { TurnsOptions } from "../../src/turns/index.ts"
import { workspacesLayer } from "../../src/workspace/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAKE = join(import.meta.dirname, "../support/fake-droid-exec.mjs")

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sessions-test-")))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

interface HarnessServices {
  readonly sessions: Sessions["Service"]
  readonly capabilities: Capabilities["Service"]
  readonly callers: Callers["Service"]
  readonly authority: Authority["Service"]
  readonly guidance: Guidance["Service"]
  readonly turns: Turns["Service"]
  readonly placement: Placement["Service"]
  readonly decisions: Decisions["Service"]
  readonly observations: Observations["Service"]
  readonly disclosure: Disclosure["Service"]
  readonly custody: Custody["Service"]
  readonly finalize: Effect.Effect<void>
  readonly close: () => Promise<void>
}

interface HarnessOptions {
  readonly maxAutonomy?: AutonomyLevel
  readonly sharedSessions?: boolean
  readonly callersSharedSessions?: boolean
  readonly guidanceRequired?: boolean
  readonly defaultWaitMs?: number
  readonly turnsOptions?: TurnsOptions
  readonly beforeRetireLease?: Effect.Effect<void>
  readonly protectedValues?: ReadonlyArray<string>
  readonly providers?: ReadonlyArray<PlacementProviderAdapter>
  readonly extraEnv?: Readonly<Record<string, string>>
}

const buildHarness = (options?: HarnessOptions): HarnessServices => {
  const scope = Effect.runSync(Scope.make())

  const disclosureLive = disclosureLayer({
    protectedValues: options?.protectedValues,
  })

  const authorityLive = authorityLayer({
    maxAutonomy: options?.maxAutonomy ?? "high",
  })

  const callersLive = callersLayer({
    sharedSessions: options?.callersSharedSessions ?? options?.sharedSessions ?? false,
  })

  const guidanceLive = guidanceLayer({
    required: options?.guidanceRequired ?? true,
  })

  const workspacesLive = Layer.provideMerge(
    workspacesLayer({ allowedRoots: [sandbox] }),
    custodyLayer,
  )

  const baseDeps = Layer.mergeAll(
    custodyLayer,
    workspacesLive,
    authorityLive,
    callersLive,
    guidanceLive,
    disclosureLive,
    dialectLayer,
  )

  const capabilitiesLive = Layer.provideMerge(capabilitiesLayer, baseDeps)
  const decisionsLive = Layer.provideMerge(decisionsLayer, baseDeps)
  const observationsLive = Layer.provideMerge(observationsLayer, baseDeps)

  const localLive = Layer.provideMerge(
    localExecLayer({
      droidPath: process.execPath,
      args: [FAKE],
      env: options?.extraEnv,
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

  const beforeRetireLease = options?.beforeRetireLease

  const sessionTurns =
    beforeRetireLease === undefined
      ? turnsLive
      : Layer.effect(
          Turns,
          Effect.map(Turns, (turns) => ({
            ...turns,
            retireLease: (lease) => Effect.andThen(beforeRetireLease, turns.retireLease(lease)),
          })),
        ).pipe(Layer.provide(turnsLive))

  const sessionsOptions: SessionsOptions = {
    sharedSessions: options?.sharedSessions,
    guidanceRequired: options?.guidanceRequired,
    defaultWaitMs: options?.defaultWaitMs ?? 5_000,
  }

  const sessionsLive = Layer.provideMerge(
    sessionsLayer(sessionsOptions),
    Layer.mergeAll(sessionTurns, placementLive, capabilitiesLive, baseDeps),
  )

  const merged = Layer.mergeAll(
    sessionsLive,
    capabilitiesLive,
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
        const sessions = yield* Sessions
        const capabilities = yield* Capabilities
        const callers = yield* Callers
        const authority = yield* Authority
        const guidance = yield* Guidance
        const turns = yield* Turns
        const placement = yield* Placement
        const decisions = yield* Decisions
        const observations = yield* Observations
        const disclosure = yield* Disclosure
        const custody = yield* Custody

        return {
          sessions,
          capabilities,
          callers,
          authority,
          guidance,
          turns,
          placement,
          decisions,
          observations,
          disclosure,
          custody,
        }
      }),
      context,
    ),
  )

  const finalize = Scope.close(scope, Exit.void)

  return {
    ...built,
    finalize,
    close: () => Effect.runPromise(finalize),
  }
}

const admitPrincipal = (services: HarnessServices, name: string, acknowledgeGuide = true) =>
  Effect.gen(function* () {
    const evidence = Option.getOrThrow(trustedEvidence(name))
    const caller = yield* services.callers.admit(evidence)
    const conversation = yield* services.callers.conversation(caller, { bindingId: "conv-" + name })

    if (acknowledgeGuide) {
      const rootDoc = yield* services.guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
      const delivered = yield* services.guidance.confirmRootDelivery(rootDoc)

      yield* services.guidance.acknowledge(conversation, delivered)
    }

    const who: Invocation = { caller, conversation }

    return who
  })

const localIntent = (autonomyLevel: AutonomyLevel = "medium") =>
  SessionIntent.Local({
    workspace: { kind: "borrowed", path: sandbox },
    settings: { autonomyLevel },
  })

const mintGrant = (
  services: HarnessServices,
  caller: Caller,
  targetId: string,
  level?: AutonomyLevel,
) =>
  services.authority.decide(
    caller,
    { kind: "session", id: targetId },
    level !== undefined ? { effect: "execute", requestedLevel: level } : { effect: "execute" },
    Evidence.Explicit(
      level !== undefined
        ? { ceiling: services.authority.ceiling(), requestedLevel: level }
        : { ceiling: services.authority.ceiling() },
    ),
  )

const decodeReleased = <A>(schema: Schema.Codec<A, Schema.Json>, value: Schema.Json): A =>
  Option.getOrThrow(Schema.decodeUnknownOption(schema)(value))

const expectJsonPayload = (released: Parameters<typeof releasedJson>[0]): Schema.Json =>
  Option.getOrThrow(releasedJson(released))

// ---------------------------------------------------------------------------
// 1. Default per-caller isolation & opaque refs
// ---------------------------------------------------------------------------

describe("sessions: default per-caller isolation", () => {
  it("isolates listVisible, resolve, close, bound ops and watchVisible per caller", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")
          const bob = yield* admitPrincipal(services, "bob")

          const aliceEvents: Array<SessionChange> = []
          const bobEvents: Array<SessionChange> = []

          const aliceWatcher = yield* Effect.forkDetach(
            services.sessions.watchVisible(alice.caller).pipe(
              Stream.runForEach((change) =>
                Effect.sync(() => {
                  aliceEvents.push(change)
                }),
              ),
            ),
          )

          const bobWatcher = yield* Effect.forkDetach(
            services.sessions.watchVisible(bob.caller).pipe(
              Stream.runForEach((change) =>
                Effect.sync(() => {
                  bobEvents.push(change)
                }),
              ),
            ),
          )

          // Let PubSub subscriptions attach before creating the session
          yield* Effect.sleep(20)

          const ref = yield* services.sessions.create(alice, localIntent("medium"))
          const id = sessionRefId(ref)

          // Public id is fresh and module-minted, never provider id or caller id
          expect(id).not.toBe("fake-session")
          expect(id).not.toContain(String(alice.caller.id))
          expect(id.startsWith("sess-")).toBe(true)

          // Provider session id never grants access, even for the owner
          const providerLookup = yield* Effect.flip(
            services.sessions.resolveId(alice.caller, "fake-session", "read"),
          )

          expect(providerLookup).toBeInstanceOf(NotVisible)

          // listVisible: Alice sees 1 session, Bob sees 0
          const aliceList = yield* services.sessions.listVisible(alice.caller)
          const bobList = yield* services.sessions.listVisible(bob.caller)

          expect(aliceList.length).toBe(1)
          expect(aliceList[0]?.sessionId).toBe(id)
          expect(bobList.length).toBe(0)

          // Foreign resolve produces the exact same NotVisible shape as missing
          const missingRefErr = yield* Effect.flip(
            services.sessions.resolveId(bob.caller, "sess-does-not-exist", "read"),
          )

          for (const right of ["read", "submit", "answer", "admin"] as const) {
            const foreignErr = yield* Effect.flip(services.sessions.resolve(bob.caller, ref, right))

            expect(foreignErr).toBeInstanceOf(NotVisible)
            expect(foreignErr.message).toBe(missingRefErr.message)
          }

          // Foreign close fails NotVisible
          const foreignClose = yield* Effect.flip(services.sessions.close(bob.caller, ref))

          expect(foreignClose).toBeInstanceOf(NotVisible)
          expect(foreignClose.message).toBe(missingRefErr.message)

          // Foreign caller cannot reach Alice's session through ANY bound operation
          const catalog = yield* services.capabilities.assemble(services.sessions.entries())

          const bobEventsErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, bob, "session_events", {
              sessionId: id,
              cursor: 0,
              waitMs: 0,
            }),
          )

          const bobMissingErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, bob, "session_events", {
              sessionId: "sess-missing",
              cursor: 0,
              waitMs: 0,
            }),
          )

          expect(bobEventsErr._tag).toBe("OperationNotVisible")
          expect(bobEventsErr.message).toBe(bobMissingErr.message)

          const bobModelsErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, bob, "session_models", { sessionId: id }),
          )

          expect(bobModelsErr._tag).toBe("OperationNotVisible")

          const bobCloseErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, bob, "session_close", { sessionId: id }),
          )

          expect(bobCloseErr._tag).toBe("OperationNotVisible")

          // Alice submits a turn, then closes
          const submitter = yield* services.sessions.resolve(alice.caller, ref, "submit")
          const aliceGrant = yield* mintGrant(services, alice.caller, id, "medium")

          yield* submitter.submit({ text: "hello" }, aliceGrant)

          const turnView = yield* submitter.wait("terminal", 5_000)

          expect(turnView?.status).toBe("completed")

          yield* services.sessions.close(alice.caller, ref)
          yield* Effect.sleep(30)

          // Watchers: Alice saw Created, Updated, Closed; Bob saw ZERO events
          expect(bobEvents.length).toBe(0)
          expect(aliceEvents.some((ev) => SessionChange.$is("Created")(ev))).toBe(true)
          expect(aliceEvents.some((ev) => SessionChange.$is("Updated")(ev))).toBe(true)
          expect(aliceEvents.some((ev) => SessionChange.$is("Closed")(ev))).toBe(true)

          yield* Fiber.interrupt(aliceWatcher)
          yield* Fiber.interrupt(bobWatcher)
        }),
      )
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. --shared-sessions opt-in
// ---------------------------------------------------------------------------

describe("sessions: --shared-sessions opt-in", () => {
  it("shares session directory while keeping guidance receipts and grants caller-scoped", async () => {
    const services = buildHarness({ sharedSessions: true })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice", true)
          const bobNoGuide = yield* admitPrincipal(services, "bob", false)

          const bobWatch: Array<SessionChange> = []

          const watcher = yield* Effect.forkDetach(
            services.sessions.watchVisible(bobNoGuide.caller).pipe(
              Stream.runForEach((change) =>
                Effect.sync(() => {
                  bobWatch.push(change)
                }),
              ),
            ),
          )

          yield* Effect.sleep(20)

          const ref = yield* services.sessions.create(alice, localIntent("medium"))
          const id = sessionRefId(ref)

          // Bob sees Alice's session in listVisible
          const bobList = yield* services.sessions.listVisible(bobNoGuide.caller)

          expect(bobList.length).toBe(1)
          expect(bobList[0]?.sessionId).toBe(id)

          // Guidance receipts are NEVER shared: Bob without a receipt is refused
          const catalog = yield* services.capabilities.assemble(services.sessions.entries())

          const bobUnacknowledged = yield* Effect.flip(
            services.capabilities.invoke(catalog, bobNoGuide, "session_list", {}),
          )

          expect(bobUnacknowledged._tag).toBe("GuidanceRequired")

          // Grants are NEVER shared: Bob cannot use Alice's grant on the shared session
          const aliceGrant = yield* mintGrant(services, alice.caller, id, "medium")
          const bobSubmitter = yield* services.sessions.resolve(bobNoGuide.caller, ref, "submit")

          const foreignGrantErr = yield* Effect.flip(
            bobSubmitter.submit({ text: "hello" }, aliceGrant),
          )

          expect(foreignGrantErr).toBeInstanceOf(SessionOperationFailed)

          if (foreignGrantErr instanceof SessionOperationFailed) {
            expect(foreignGrantErr.code).toBe("denied")
            expect(foreignGrantErr.reason).toBe("foreign_grant")
          }

          // Once Bob uses his OWN grant (and acknowledges guide for bound ops), Bob can run
          const bobGrant = yield* mintGrant(services, bobNoGuide.caller, id, "medium")

          yield* bobSubmitter.submit({ text: "hello" }, bobGrant)

          const view = yield* bobSubmitter.wait("terminal", 5_000)

          expect(view?.status).toBe("completed")

          // Bob acknowledges guide in his own conversation and closes via bound op
          const rootDoc = yield* services.guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
          const delivered = yield* services.guidance.confirmRootDelivery(rootDoc)

          yield* services.guidance.acknowledge(bobNoGuide.conversation, delivered)

          const closedRes = yield* services.capabilities.invoke(
            catalog,
            bobNoGuide,
            "session_close",
            { sessionId: id },
          )

          const closedJson = decodeReleased(
            Schema.Struct({ sessionId: Schema.String, closed: Schema.Boolean }),
            expectJsonPayload(closedRes),
          )

          expect(closedJson.closed).toBe(true)

          yield* Effect.sleep(30)

          expect(bobWatch.some((ev) => SessionChange.$is("Created")(ev))).toBe(true)
          expect(bobWatch.some((ev) => SessionChange.$is("Closed")(ev))).toBe(true)

          yield* Fiber.interrupt(watcher)
        }),
      )
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. ScopedSession right enforcement & close revocation
// ---------------------------------------------------------------------------

describe("sessions: ScopedSession capabilities and close revocation", () => {
  it("exposes strictly the requested right and revokes access immediately on close", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")
          const ref = yield* services.sessions.create(alice, localIntent("low"))
          const id = sessionRefId(ref)

          const reader = yield* services.sessions.resolve(alice.caller, ref, "read")
          const submitter = yield* services.sessions.resolve(alice.caller, ref, "submit")
          const answerer = yield* services.sessions.resolve(alice.caller, ref, "answer")
          const admin = yield* services.sessions.resolve(alice.caller, ref, "admin")

          // Verify strict surface narrowing at runtime
          expect("submit" in reader).toBe(false)
          expect("decide" in reader).toBe(false)
          expect("updateSettings" in reader).toBe(false)
          expect("close" in reader).toBe(false)

          expect("decide" in submitter).toBe(false)
          expect("updateSettings" in submitter).toBe(false)
          expect("close" in submitter).toBe(false)

          expect("submit" in answerer).toBe(false)
          expect("updateSettings" in answerer).toBe(false)
          expect("close" in answerer).toBe(false)

          expect("submit" in admin).toBe(false)
          expect("decide" in admin).toBe(false)
          expect("observe" in admin).toBe(false)

          const summary = yield* reader.summary()

          expect(summary.sessionId).toBe(id)
          expect(summary.status).toBe("idle")
          expect(reader.facets()).toContain("submit")

          // Close via admin handle
          yield* admin.close()

          // Double close fails with NotVisible
          const doubleClose = yield* Effect.flip(services.sessions.close(alice.caller, ref))

          expect(doubleClose).toBeInstanceOf(NotVisible)

          // Previously resolved handles immediately fail with NotVisible
          const staleRead = yield* Effect.flip(reader.summary())
          const staleInspect = yield* Effect.flip(submitter.inspect())
          const stalePending = yield* Effect.flip(answerer.outstandingDecisions())
          const staleAdminClose = yield* Effect.flip(admin.close())

          expect(staleRead).toBeInstanceOf(NotVisible)
          expect(staleInspect).toBeInstanceOf(NotVisible)
          expect(stalePending).toBeInstanceOf(NotVisible)
          expect(staleAdminClose).toBeInstanceOf(NotVisible)

          const remaining = yield* services.sessions.listVisible(alice.caller)

          expect(remaining.length).toBe(0)
        }),
      )
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Direct methods enforce the exact same gates as bound entries
// ---------------------------------------------------------------------------

describe("sessions: direct methods enforce guidance and authority ceiling", () => {
  it("refuses create and runOnce without guidance receipt identically to bound entries", async () => {
    const services = buildHarness({ guidanceRequired: true })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice", false)

          const createErr = yield* Effect.flip(services.sessions.create(alice, localIntent("low")))

          expect(createErr).toBeInstanceOf(SessionRefused)

          if (createErr instanceof SessionRefused) {
            expect(createErr.reason).toBe("guidance_required")
            expect(createErr.edition).toBe(CURRENT_GUIDE_EDITION)
          }

          const runErr = yield* Effect.flip(
            services.sessions.runOnce(alice, {
              session: localIntent("low"),
              prompt: { text: "hello" },
            }),
          )

          expect(runErr).toBeInstanceOf(SessionRefused)

          if (runErr instanceof SessionRefused) {
            expect(runErr.reason).toBe("guidance_required")
          }

          // Bound entries enforce the same gate (after decode!)
          const catalog = yield* services.capabilities.assemble(services.sessions.entries())

          const invalidFirst = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_create", { cwd: "" }),
          )

          expect(invalidFirst._tag).toBe("InvalidInput")

          const boundCreateErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_create", {
              cwd: sandbox,
              autonomyLevel: "low",
            }),
          )

          expect(boundCreateErr._tag).toBe("GuidanceRequired")

          const list = yield* services.sessions.listVisible(alice.caller)

          expect(list.length).toBe(0)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("refuses create, runOnce and bound entries when requested autonomy exceeds ceiling", async () => {
    const services = buildHarness({ maxAutonomy: "low" })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")

          const createErr = yield* Effect.flip(services.sessions.create(alice, localIntent("high")))

          expect(createErr).toBeInstanceOf(SessionRefused)

          if (createErr instanceof SessionRefused) {
            expect(createErr.reason).toBe("requested_level_exceeds_ceiling")
            expect(createErr.ceiling).toBe("low")
            expect(createErr.requestedLevel).toBe("high")
          }

          const runErr = yield* Effect.flip(
            services.sessions.runOnce(alice, {
              session: localIntent("medium"),
              prompt: { text: "hello" },
            }),
          )

          expect(runErr).toBeInstanceOf(SessionRefused)

          const catalog = yield* services.capabilities.assemble(services.sessions.entries())

          const boundErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_create", {
              cwd: sandbox,
              autonomyLevel: "high",
            }),
          )

          expect(boundErr._tag).toBe("Denied")

          // Mismatched caller/conversation is also refused
          const bob = yield* admitPrincipal(services, "bob")

          const mismatchErr = yield* Effect.flip(
            services.sessions.create(
              { caller: alice.caller, conversation: bob.conversation },
              localIntent("low"),
            ),
          )

          expect(mismatchErr).toBeInstanceOf(SessionRefused)

          if (mismatchErr instanceof SessionRefused) {
            expect(mismatchErr.reason).toBe("caller_mismatch")
          }

          expect((yield* services.sessions.listVisible(alice.caller)).length).toBe(0)
        }),
      )
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Registration / open failure cleans up acquired resources
// ---------------------------------------------------------------------------

describe("sessions: cleanup on open and adoption failure", () => {
  it("cleans up without leaking directory entries when workspace root is denied or adopt fails", async () => {
    let releasedCount = 0

    const failingAdoptAdapter: PlacementProviderAdapter = {
      provider: "broken-adopt",
      open: () =>
        Effect.succeed<ProviderHandle>({
          providerSessionId: "broken-1",
          facets: ["submit", "observe"],
          submit: () => Effect.die("unused"),
          notices: () => Stream.empty,
          interrupt: () => Effect.void,
          updateSettings: () => Effect.die("unused"),
          listModels: () => Effect.succeed([]),
          fork: () => Effect.die("unused"),
          adopt: () =>
            Effect.fail(new PlacementPeerLost({ message: "simulated adoption failure" })),
          release: () =>
            Effect.sync(() => {
              releasedCount += 1
            }),
        }),
    }

    const services = buildHarness({ providers: [failingAdoptAdapter] })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")

          // Disallowed root outside sandbox -> OpenFailed, zero directory entries
          const rootErr = yield* Effect.flip(
            services.sessions.create(
              alice,
              SessionIntent.Local({
                workspace: { kind: "borrowed", path: "/nonexistent-root-outside-sandbox" },
                settings: { autonomyLevel: "low" },
              }),
            ),
          )

          expect(rootErr._tag).toBe("OpenFailed")

          // Adopt failure -> OpenFailed, release called, zero directory entries
          const adoptErr = yield* Effect.flip(
            services.sessions.create(
              alice,
              SessionIntent.Remote({
                provider: "broken-adopt",
                adapter: failingAdoptAdapter,
              }),
            ),
          )

          expect(adoptErr._tag).toBe("OpenFailed")
          expect(releasedCount).toBeGreaterThanOrEqual(1)

          const visible = yield* services.sessions.listVisible(alice.caller)

          expect(visible.length).toBe(0)
        }),
      )
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. One-shot runOnce semantics
// ---------------------------------------------------------------------------

describe("sessions: runOnce lifecycle", () => {
  it("closes automatically on terminal completion", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")

          const result = yield* services.sessions.runOnce(alice, {
            session: localIntent("low"),
            prompt: { text: "hello" },
            waitMs: 5_000,
          })

          expect(result.closed).toBe(true)
          expect(result.status).toBe("completed")
          expect(result.events.length).toBeGreaterThan(0)
          expect(result.resume).toBeUndefined()

          // Session is already closed and gone from directory
          expect((yield* services.sessions.listVisible(alice.caller)).length).toBe(0)

          const lookup = yield* Effect.flip(
            services.sessions.resolve(alice.caller, result.sessionRef, "read"),
          )

          expect(lookup).toBeInstanceOf(NotVisible)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("keeps session alive and addressable when waitMs expires while still running", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")

          const result = yield* services.sessions.runOnce(alice, {
            session: localIntent("low"),
            prompt: { text: "hang" },
            waitMs: 120,
          })

          expect(result.closed).toBe(false)
          expect(result.status).toBe("running")
          expect(result.resume).toBeDefined()

          // Still addressable by Alice
          const visible = yield* services.sessions.listVisible(alice.caller)

          expect(visible.length).toBe(1)
          expect(visible[0]?.sessionId).toBe(result.sessionId)

          // Alice can close it explicitly
          yield* services.sessions.close(alice.caller, result.sessionRef)
          expect((yield* services.sessions.listVisible(alice.caller)).length).toBe(0)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("keeps session alive on pending permission so owner can answer and complete", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")

          const result = yield* services.sessions.runOnce(alice, {
            session: localIntent("medium"),
            prompt: { text: "permission" },
            waitMs: 5_000,
          })

          expect(result.closed).toBe(false)
          expect(result.status).toBe("running")
          expect(result.outstandingDecisions.length).toBe(1)

          const decision = result.outstandingDecisions[0]

          expect(decision).toBeDefined()

          const answerer = yield* services.sessions.resolve(
            alice.caller,
            result.sessionRef,
            "answer",
          )

          const grant = yield* mintGrant(services, alice.caller, result.sessionId, "medium")

          if (decision !== undefined) {
            yield* answerer.decide(
              decision.ref,
              HumanChoice.Permission({ outcome: "proceed_once" }),
              grant,
            )
          }

          const reader = yield* services.sessions.resolve(alice.caller, result.sessionRef, "read")
          const finalView = yield* reader.wait("terminal", 5_000)

          expect(finalView?.status).toBe("completed")

          yield* services.sessions.close(alice.caller, result.sessionRef)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("closes and cleans up session when runOnce fiber is interrupted externally", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")
          const created = yield* Deferred.make<string>()
          const closed = yield* Deferred.make<string>()

          const watcher = yield* Effect.forkDetach(
            services.sessions.watchVisible(alice.caller).pipe(
              Stream.runForEach((change) =>
                SessionChange.$match(change, {
                  Created: (variant) => Deferred.succeed(created, variant.summary.sessionId),
                  Updated: () => Effect.void,
                  Closed: (variant) => Deferred.succeed(closed, variant.sessionId),
                }),
              ),
            ),
          )

          yield* Effect.sleep(20)

          const runFiber = yield* Effect.forkDetach(
            services.sessions.runOnce(alice, {
              session: localIntent("low"),
              prompt: { text: "hang" },
              waitMs: 10_000,
            }),
          )

          const createdId = yield* Deferred.await(created)

          expect(createdId.startsWith("sess-")).toBe(true)

          // Interrupt runOnce mid-wait
          yield* Fiber.interrupt(runFiber)

          const closedId = yield* Deferred.await(closed)

          expect(closedId).toBe(createdId)
          expect((yield* services.sessions.listVisible(alice.caller)).length).toBe(0)

          yield* Fiber.interrupt(watcher)
        }),
      )
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. All 13 bound operations via Capabilities.assemble & Capabilities.invoke
// ---------------------------------------------------------------------------

describe("sessions: all 13 bound operations end-to-end", () => {
  it("assembles exactly 13 typed operations with zero universal command and description-invariant policy", async () => {
    const services = buildHarness({ maxAutonomy: "low" })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const entries = services.sessions.entries()

          expect(entries.length).toBe(13)

          const ids = entries.map((entry) => entry.facts.id).sort()

          expect(ids).toEqual([
            "session_answer_question",
            "session_close",
            "session_create",
            "session_events",
            "session_fork",
            "session_interrupt",
            "session_list",
            "session_models",
            "session_pick_options",
            "session_respond_permission",
            "session_run",
            "session_stream",
            "session_update_settings",
          ])

          expect(ids).not.toContain("session_command")

          const originalCatalog = yield* services.capabilities.assemble(entries)

          expect(originalCatalog.size).toBe(13)

          const rewritten = entries.map((entry, idx) =>
            withReplacedDescription(entry, "rewritten description #" + String(idx)),
          )

          const rewrittenCatalog = yield* services.capabilities.assemble(rewritten)
          const alice = yield* admitPrincipal(services, "alice")

          const origDescs = yield* services.capabilities.available(originalCatalog, alice)
          const nextDescs = yield* services.capabilities.available(rewrittenCatalog, alice)

          for (let i = 0; i < origDescs.length; i++) {
            const orig = origDescs[i]
            const next = nextDescs[i]

            expect(orig).toBeDefined()
            expect(next).toBeDefined()

            if (orig !== undefined && next !== undefined) {
              expect(next.description).not.toBe(orig.description)
              expect(next.id).toBe(orig.id)
              expect(next.annotations).toEqual(orig.annotations)
              expect(next.requiresGuidance).toBe(orig.requiresGuidance)
            }
          }

          const origDeny = yield* Effect.flip(
            services.capabilities.invoke(originalCatalog, alice, "session_create", {
              cwd: sandbox,
              autonomyLevel: "high",
            }),
          )

          const nextDeny = yield* Effect.flip(
            services.capabilities.invoke(rewrittenCatalog, alice, "session_create", {
              cwd: sandbox,
              autonomyLevel: "high",
            }),
          )

          expect(origDeny._tag).toBe("Denied")
          expect(nextDeny._tag).toBe("Denied")
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("exercises session_create, list, models, update_settings, stream, events, interrupt, fork, run, close", async () => {
    const services = buildHarness({
      maxAutonomy: "medium",
      turnsOptions: { maxEvents: 12 },
    })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const catalog = yield* services.capabilities.assemble(services.sessions.entries())
          const alice = yield* admitPrincipal(services, "alice")

          const created = decodeReleased(
            Schema.Struct({
              sessionId: Schema.String,
              cwd: Schema.String,
              settings: Schema.Struct({ autonomyLevel: Schema.String }),
            }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_create", {
                cwd: sandbox,
                autonomyLevel: "low",
              }),
            ),
          )

          const sessionId = created.sessionId

          expect(created.cwd).toBe(sandbox)
          expect(created.settings.autonomyLevel).toBe("low")

          const listed = decodeReleased(
            Schema.Struct({
              sessions: Schema.Array(Schema.Struct({ sessionId: Schema.String })),
            }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_list", {}),
            ),
          )

          expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId])

          const models = decodeReleased(
            Schema.Struct({
              sessionId: Schema.String,
              models: Schema.Array(Schema.Struct({ id: Schema.String })),
            }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_models", {
                sessionId,
              }),
            ),
          )

          expect(models.sessionId).toBe(sessionId)

          const overCap = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_update_settings", {
              sessionId,
              autonomyLevel: "high",
            }),
          )

          expect(overCap._tag).toBe("Denied")

          const updated = decodeReleased(
            Schema.Struct({
              sessionId: Schema.String,
              settings: Schema.Struct({ autonomyLevel: Schema.String }),
            }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_update_settings", {
                sessionId,
                autonomyLevel: "medium",
                interactionMode: "spec",
              }),
            ),
          )

          expect(updated.settings.autonomyLevel).toBe("medium")

          const TurnPayloadSchema = Schema.Struct({
            sessionId: Schema.String,
            status: Schema.String,
            cursor: Schema.Number,
            events: Schema.Array(Schema.Json),
            truncated: Schema.Boolean,
          })

          const streamed = decodeReleased(
            TurnPayloadSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_stream", {
                sessionId,
                prompt: "hello",
                waitMs: 5_000,
              }),
            ),
          )

          expect(streamed.status).toBe("completed")
          expect(streamed.events.length).toBeGreaterThan(0)
          expect(streamed.cursor).toBeGreaterThan(0)

          // Re-reading at returned cursor yields 0 duplicate events
          const noDupes = decodeReleased(
            TurnPayloadSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_events", {
                sessionId,
                cursor: streamed.cursor,
                waitMs: 0,
              }),
            ),
          )

          expect(noDupes.events.length).toBe(0)
          expect(noDupes.cursor).toBe(streamed.cursor)
          expect(noDupes.truncated).toBe(false)

          // Future cursor fails cleanly with InvalidInput
          const futureErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_events", {
              sessionId,
              cursor: streamed.cursor + 999,
              waitMs: 0,
            }),
          )

          expect(futureErr._tag).toBe("InvalidInput")

          // Trigger eviction with burst:20 (maxEvents = 12), verify truncated: true on old cursor
          const oldCursor = streamed.cursor

          const bursted = decodeReleased(
            TurnPayloadSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_stream", {
                sessionId,
                prompt: "burst:20",
                waitMs: 5_000,
              }),
            ),
          )

          expect(bursted.status).toBe("completed")

          const afterEviction = decodeReleased(
            TurnPayloadSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_events", {
                sessionId,
                cursor: oldCursor,
                waitMs: 0,
              }),
            ),
          )

          expect(afterEviction.truncated).toBe(true)

          const detached = decodeReleased(
            TurnPayloadSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_stream", {
                sessionId,
                prompt: "interrupt",
                delivery: "detach",
              }),
            ),
          )

          expect(detached.events.length).toBe(0)

          const interrupted = decodeReleased(
            Schema.Struct({ sessionId: Schema.String, interrupted: Schema.Boolean }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_interrupt", {
                sessionId,
              }),
            ),
          )

          expect(interrupted.interrupted).toBe(true)

          // Poll until interrupted
          let pollStatus = "running"
          let pollCursor = detached.cursor

          for (let attempt = 0; attempt < 20 && pollStatus === "running"; attempt++) {
            const polled = decodeReleased(
              TurnPayloadSchema,
              expectJsonPayload(
                yield* services.capabilities.invoke(catalog, alice, "session_events", {
                  sessionId,
                  cursor: pollCursor,
                  waitMs: 250,
                }),
              ),
            )

            pollStatus = polled.status
            pollCursor = polled.cursor
          }

          expect(pollStatus).toBe("interrupted")

          const forked = decodeReleased(
            Schema.Struct({
              sessionId: Schema.String,
              kind: Schema.Literals(["runnable", "external"]),
              externalSessionId: Schema.optionalKey(Schema.String),
              forkedSessionId: Schema.optionalKey(Schema.String),
            }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_fork", {
                sessionId,
                title: "branch-test",
              }),
            ),
          )

          expect(forked.sessionId).toBe(sessionId)
          expect(forked.kind).toBe("external")
          expect(forked.externalSessionId).toBeDefined()

          const ran = decodeReleased(
            Schema.Struct({
              sessionId: Schema.String,
              closed: Schema.Boolean,
              status: Schema.String,
            }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_run", {
                cwd: sandbox,
                prompt: "hello",
                autonomyLevel: "low",
                waitMs: 5_000,
              }),
            ),
          )

          expect(ran.closed).toBe(true)
          expect(ran.status).toBe("completed")

          const closed = decodeReleased(
            Schema.Struct({ sessionId: Schema.String, closed: Schema.Boolean }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_close", {
                sessionId,
              }),
            ),
          )

          expect(closed.closed).toBe(true)

          const secondClose = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_close", { sessionId }),
          )

          expect(secondClose._tag).toBe("OperationNotVisible")
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("exercises session_respond_permission, session_answer_question and session_pick_options", async () => {
    const services = buildHarness({ maxAutonomy: "low" })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const catalog = yield* services.capabilities.assemble(services.sessions.entries())
          const alice = yield* admitPrincipal(services, "alice")

          const created = decodeReleased(
            Schema.Struct({ sessionId: Schema.String }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_create", {
                cwd: sandbox,
                autonomyLevel: "low",
              }),
            ),
          )

          const sessionId = created.sessionId

          const DecisionStreamSchema = Schema.Struct({
            status: Schema.String,
            cursor: Schema.Number,
            outstandingDecisions: Schema.Array(
              Schema.Struct({
                requestId: Schema.String,
                kind: Schema.String,
              }),
            ),
          })

          // --- Permission decision ---
          const permStream = decodeReleased(
            DecisionStreamSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_stream", {
                sessionId,
                prompt: "permission",
                waitMs: 5_000,
              }),
            ),
          )

          expect(permStream.status).toBe("running")
          expect(permStream.outstandingDecisions.length).toBe(1)

          const permRequestId = permStream.outstandingDecisions[0]?.requestId ?? ""

          expect(permRequestId.length).toBeGreaterThan(0)

          // Autonomy ceiling refuses proceed_auto_run_high under "low" cap
          const overCapPerm = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_respond_permission", {
              sessionId,
              requestId: permRequestId,
              outcome: "proceed_auto_run_high",
            }),
          )

          expect(overCapPerm._tag).toBe("Denied")

          // Valid proceed_once resolves it
          const permResolved = decodeReleased(
            Schema.Struct({ resolved: Schema.Boolean }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_respond_permission", {
                sessionId,
                requestId: permRequestId,
                outcome: "proceed_once",
              }),
            ),
          )

          expect(permResolved.resolved).toBe(true)

          const reader = yield* services.sessions.resolveId(alice.caller, sessionId, "read")

          expect((yield* reader.wait("terminal", 5_000))?.status).toBe("completed")

          // --- Question decision ---
          const askStream = decodeReleased(
            DecisionStreamSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_stream", {
                sessionId,
                prompt: "ask",
                waitMs: 5_000,
              }),
            ),
          )

          expect(askStream.status).toBe("running")
          expect(askStream.outstandingDecisions[0]?.kind).toBe("question")

          const askRequestId = askStream.outstandingDecisions[0]?.requestId ?? ""

          const askResolved = decodeReleased(
            Schema.Struct({ resolved: Schema.Boolean }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_answer_question", {
                sessionId,
                requestId: askRequestId,
                answers: [
                  { index: 0, answer: "vitest" },
                  { index: 1, answer: "lint, types" },
                ],
              }),
            ),
          )

          expect(askResolved.resolved).toBe(true)
          expect((yield* reader.wait("terminal", 5_000))?.status).toBe("completed")

          // --- Options decision ---
          const pickStream = decodeReleased(
            DecisionStreamSchema,
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_stream", {
                sessionId,
                prompt: "pick",
                waitMs: 5_000,
              }),
            ),
          )

          expect(pickStream.status).toBe("running")
          expect(pickStream.outstandingDecisions[0]?.kind).toBe("options")

          const pickRequestId = pickStream.outstandingDecisions[0]?.requestId ?? ""

          // Confirm decision label matches AnswerScopedSession.outstandingDecisions
          const answerer = yield* services.sessions.resolveId(alice.caller, sessionId, "answer")
          const pendingDirect = yield* answerer.outstandingDecisions()

          expect(pendingDirect.map((d) => decisionRefLabel(d.ref))).toEqual([pickRequestId])

          const pickResolved = decodeReleased(
            Schema.Struct({ resolved: Schema.Boolean, refresh: Schema.Boolean }),
            expectJsonPayload(
              yield* services.capabilities.invoke(catalog, alice, "session_pick_options", {
                sessionId,
                requestId: pickRequestId,
                selectedIds: ["repo-b"],
              }),
            ),
          )

          expect(pickResolved.resolved).toBe(true)
          expect(pickResolved.refresh).toBe(false)
          expect((yield* reader.wait("terminal", 5_000))?.status).toBe("completed")

          yield* services.capabilities.invoke(catalog, alice, "session_close", { sessionId })
        }),
      )
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Additional edge cases: child exit, detach runOnce, busy conflict, options
// ---------------------------------------------------------------------------

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

describe("sessions: child cleanup, detach runOnce, busy conflict and options", () => {
  it("releases the child when close is interrupted during retirement and the layer finalizes", async () => {
    const pidFile = join(sandbox, "child.pid")
    const retiring = Deferred.makeUnsafe<void>()
    const resumeRetirement = Deferred.makeUnsafe<void>()

    const services = buildHarness({
      extraEnv: { FAKE_DROID_PIDFILE: pidFile },
      beforeRetireLease: Deferred.succeed(retiring, undefined).pipe(
        Effect.andThen(Deferred.await(resumeRetirement)),
      ),
    })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")
          const ref = yield* services.sessions.create(alice, localIntent("low"))
          const pid = Number(readFileSync(pidFile, "utf8").trim())
          const wasAlive = processAlive(pid)
          const closing = yield* Effect.forkChild(services.sessions.close(alice.caller, ref))

          yield* Deferred.await(retiring)

          const lookup = yield* Effect.exit(services.sessions.resolve(alice.caller, ref, "read"))

          yield* Effect.forkChild(Fiber.interrupt(closing), { startImmediately: true })

          const finalizing = yield* Effect.forkChild(
            Effect.map(services.finalize, () => processAlive(pid)),
            { startImmediately: true },
          )

          yield* Deferred.succeed(resumeRetirement, undefined)

          expect(wasAlive).toBe(true)
          expect(Exit.isFailure(lookup)).toBe(true)
          expect(Exit.hasInterrupts(yield* Fiber.await(closing))).toBe(true)
          expect(yield* Fiber.join(finalizing)).toBe(false)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("terminates the spawned child process when close completes", async () => {
    const pidFile = join(sandbox, "child.pid")
    const services = buildHarness({ extraEnv: { FAKE_DROID_PIDFILE: pidFile } })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")
          const ref = yield* services.sessions.create(alice, localIntent("low"))

          const pid = Number(readFileSync(pidFile, "utf8").trim())

          expect(Number.isInteger(pid) && pid > 0).toBe(true)
          expect(processAlive(pid)).toBe(true)

          yield* services.sessions.close(alice.caller, ref)
          yield* Effect.sleep(50)

          expect(processAlive(pid)).toBe(false)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("supports guidanceRequired: false and sharedSessions with default callersLayer", async () => {
    const services = buildHarness({
      guidanceRequired: false,
      sharedSessions: true,
      callersSharedSessions: false,
    })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice", false)
          const bob = yield* admitPrincipal(services, "bob", false)

          const catalog = yield* services.capabilities.assemble(services.sessions.entries())
          const descriptions = yield* services.capabilities.available(catalog, alice)

          expect(descriptions.every((d) => d.requiresGuidance === false)).toBe(true)

          const ref = yield* services.sessions.create(alice, localIntent("low"))
          const id = sessionRefId(ref)

          // Bob resolves Alice's session even when callersLayer has default sharedSessions=false
          const bobReader = yield* services.sessions.resolveId(bob.caller, id, "read")
          const summary = yield* bobReader.summary()

          expect(summary.sessionId).toBe(id)

          yield* services.sessions.close(bob.caller, ref)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("retains session on runOnce with delivery detach and reports OperationConflict when busy", async () => {
    const services = buildHarness({ maxAutonomy: "high" })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admitPrincipal(services, "alice")
          const catalog = yield* services.capabilities.assemble(services.sessions.entries())

          const detached = yield* services.sessions.runOnce(alice, {
            session: localIntent("low"),
            prompt: { text: "hang" },
            delivery: "detach",
          })

          expect(detached.closed).toBe(false)
          expect(detached.status).toBe("running")
          expect(detached.events.length).toBe(0)
          expect(detached.cursor).toBe(0)

          // Submitting a second turn while the first is still running yields OperationConflict
          const busyErr = yield* Effect.flip(
            services.capabilities.invoke(catalog, alice, "session_stream", {
              sessionId: detached.sessionId,
              prompt: "hello",
              waitMs: 500,
            }),
          )

          expect(busyErr._tag).toBe("OperationConflict")

          // Direct AdminScopedSession enforces grant level on updateSettings
          const admin = yield* services.sessions.resolve(alice.caller, detached.sessionRef, "admin")
          const lowGrant = yield* mintGrant(services, alice.caller, detached.sessionId, "low")

          const deniedPatch = yield* Effect.flip(
            admin.updateSettings({ autonomyLevel: "high" }, lowGrant),
          )

          expect(deniedPatch).toBeInstanceOf(SessionOperationFailed)

          if (deniedPatch instanceof SessionOperationFailed) {
            expect(deniedPatch.code).toBe("denied")
          }

          yield* admin.close()
        }),
      )
    } finally {
      await services.close()
    }
  })
})
