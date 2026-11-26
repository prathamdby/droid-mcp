import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { afterEach, describe, expect, it } from "vitest"

import { Artifacts, artifactsLayer } from "../../src/artifacts/index.ts"
import { Authority, authorityLayer } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import { Capabilities, capabilitiesLayer } from "../../src/capabilities/index.ts"
import type { BoundOperation, Invocation, OperationFamily } from "../../src/capabilities/index.ts"
import { withReplacedDescription } from "../../src/capabilities/index.ts"
import { Custody, custodyLayer } from "../../src/custody/index.ts"
import { daemonLinkLayer } from "../../src/daemon-link/index.ts"
import { DaemonOperations, daemonOperationsLayer } from "../../src/daemon-operations/index.ts"
import { decisionsLayer } from "../../src/decisions/index.ts"
import { Disclosure, disclosureLayer, releasedJson } from "../../src/disclosure/index.ts"
import type { Released } from "../../src/disclosure/index.ts"
import { dialectLayer } from "../../src/factory-dialect/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import { HostedOperations, hostedOperationsLayer } from "../../src/hosted-factory/index.ts"
import { localExecLayer } from "../../src/local-exec/index.ts"
import { observationsLayer } from "../../src/observations/index.ts"
import { Placement, placementLayer } from "../../src/placement/index.ts"
import { ContextOperations, contextOperationsLayer } from "../../src/prem-context/index.ts"
import {
  buildRoster,
  createView,
  DiscoveryPage,
  Presentation,
  presentationLayer,
} from "../../src/presentation/index.ts"
import { CallFailure, Presented } from "../../src/presentation/index.ts"
import { Sessions, sessionsLayer } from "../../src/sessions/index.ts"
import { Turns, turnsLayer } from "../../src/turns/index.ts"
import { workspacesLayer } from "../../src/workspace/index.ts"
import { startFakeContextApi } from "../support/fake-context-api.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply, SeenRequest } from "../support/fake-daemon.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"

// ---------------------------------------------------------------------------
// Structural Proof 2: replace every operation description
//
// Assemble the full multi-provider roster from sessions, daemon-operations
// against the fake daemon, hosted-factory against the fake REST API and
// prem-context against the fake context API. Rewrite every installed entry's
// description with adversarial text, then assert zero policy or grant
// differences across a caller/input matrix driven through both
// presentation.call and capabilities.invoke.
// ---------------------------------------------------------------------------

const FAKE_EXEC = join(import.meta.dirname, "../support/fake-droid-exec.mjs")

const HOSTED_CREDENTIAL = "proof2-hosted-credential"
const CONTEXT_TOKEN = "proof2-context-token"
const CONTEXT_TENANT = "proof2-tenant"

// ---------------------------------------------------------------------------
// Fake daemon lifecycle
// ---------------------------------------------------------------------------

const AUTH_RESULT = { userId: "proof-user", orgId: "proof-org" }

/**
 * Replies success to every application method so the success matrix rows can
 * complete; authentication answers like a current daemon.
 */
const permissiveDaemonHandler = {
  onRequest: (request: SeenRequest): ScriptedReply | undefined => {
    if (request.method === "daemon.authenticate") return { result: AUTH_RESULT }

    if (request.method === "daemon.list_models") {
      return { result: { models: [{ id: "proof-model", displayName: "proof" }] } }
    }

    if (request.method === "daemon.delete_cron") return { result: { deleted: true } }

    return { result: { ok: true } }
  },
}

const daemons: Array<FakeDaemon> = []
const tempDirs: Array<string> = []

const startDaemon = async (): Promise<FakeDaemon> => {
  const dir = mkdtempSync(join(tmpdir(), "proof2-daemon-"))
  tempDirs.push(dir)
  const daemon = await startFakeDaemon(join(dir, "daemon.sock"), permissiveDaemonHandler)
  daemons.push(daemon)

  return daemon
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Service assembly: one unified layer graph per test
// ---------------------------------------------------------------------------

interface ProofServices {
  readonly sessions: Sessions["Service"]
  readonly daemonOperations: DaemonOperations["Service"]
  readonly hostedOperations: HostedOperations["Service"]
  readonly contextOperations: ContextOperations["Service"]
  readonly capabilities: Capabilities["Service"]
  readonly presentation: Presentation["Service"]
  readonly callers: Callers["Service"]
  readonly authority: Authority["Service"]
  readonly guidance: Guidance["Service"]
  readonly disclosure: Disclosure["Service"]
  readonly custody: Custody["Service"]
  readonly artifacts: Artifacts["Service"]
  readonly turns: Turns["Service"]
  readonly placement: Placement["Service"]
  readonly close: () => Promise<void>
}

const buildServices = (daemon: FakeDaemon, sandbox: string): ProofServices => {
  const scope = Scope.makeUnsafe()

  const disclosureLive = disclosureLayer()

  // Ceiling medium: explicit high-autonomy requests are a known denial the
  // description text can never soften, while every success-row write and
  // read stays within the cap.
  const authorityLive = authorityLayer({
    maxAutonomy: "medium",
    allowUnverifiedDaemonAuthority: false,
  })

  const callersLive = callersLayer()
  const guidanceLive = guidanceLayer({ required: true })
  const custodyLive = custodyLayer

  const workspacesLive = Layer.provideMerge(
    workspacesLayer({ allowedRoots: [sandbox] }),
    custodyLive,
  )

  const baseDeps = Layer.mergeAll(
    custodyLive,
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
    localExecLayer({ droidPath: process.execPath, args: [FAKE_EXEC] }),
    baseDeps,
  )

  const placementLive = Layer.provideMerge(placementLayer({}), Layer.mergeAll(localLive, baseDeps))

  const turnsLive = Layer.provideMerge(
    turnsLayer({}),
    Layer.mergeAll(decisionsLive, observationsLive, baseDeps),
  )

  const sessionsLive = Layer.provideMerge(
    sessionsLayer({ guidanceRequired: true, defaultWaitMs: 1_000 }),
    Layer.mergeAll(turnsLive, placementLive, capabilitiesLive, baseDeps),
  )

  const linkLive = Layer.provideMerge(
    daemonLinkLayer({
      endpoint: { socketPath: daemon.socketPath },
      auth: { apiKey: "proof2-key" },
      handshakeTimeoutMs: 5_000,
    }),
    Layer.merge(custodyLive, disclosureLive),
  )

  const daemonOperationsLive = Layer.provideMerge(
    daemonOperationsLayer,
    Layer.mergeAll(
      capabilitiesLive,
      linkLive,
      dialectLayer,
      authorityLive,
      disclosureLive,
      guidanceLive,
      callersLive,
    ),
  )

  const hostedOperationsLive = Layer.provideMerge(
    hostedOperationsLayer,
    Layer.mergeAll(capabilitiesLive, callersLive, authorityLive, guidanceLive, disclosureLive),
  )

  const contextOperationsLive = Layer.provideMerge(
    contextOperationsLayer,
    Layer.mergeAll(capabilitiesLive, callersLive, authorityLive, guidanceLive, disclosureLive),
  )

  const artifactsLive = Layer.provideMerge(artifactsLayer(), disclosureLive)

  const presentationLive = Layer.provideMerge(
    presentationLayer,
    Layer.merge(capabilitiesLive, artifactsLive),
  )

  const merged = Layer.mergeAll(
    sessionsLive,
    daemonOperationsLive,
    hostedOperationsLive,
    contextOperationsLive,
    presentationLive,
    capabilitiesLive,
    turnsLive,
    placementLive,
    decisionsLive,
    observationsLive,
    localLive,
    linkLive,
    baseDeps,
  )

  const memoMap = Layer.makeMemoMapUnsafe()
  const built = Effect.runSync(Layer.buildWithMemoMap(merged, memoMap, scope))

  const get = <I, S>(service: Context.Service<I, S>): S => Context.getUnsafe(built, service)

  return {
    sessions: get(Sessions),
    daemonOperations: get(DaemonOperations),
    hostedOperations: get(HostedOperations),
    contextOperations: get(ContextOperations),
    capabilities: get(Capabilities),
    presentation: get(Presentation),
    callers: get(Callers),
    authority: get(Authority),
    guidance: get(Guidance),
    disclosure: get(Disclosure),
    custody: get(Custody),
    artifacts: get(Artifacts),
    turns: get(Turns),
    placement: get(Placement),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

// ---------------------------------------------------------------------------
// Caller and guidance helpers
// ---------------------------------------------------------------------------

const admit = (services: ProofServices, principal: string): Invocation =>
  Effect.runSync(
    Effect.gen(function* () {
      const caller = yield* services.callers.admit(Option.getOrThrow(trustedEvidence(principal)))
      const conversation = yield* services.callers.conversation(caller)

      return { caller, conversation }
    }),
  )

const deliverRoot = (services: ProofServices, who: Invocation): void =>
  Effect.runSync(
    Effect.gen(function* () {
      const document = yield* services.guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
      const delivered = yield* services.guidance.confirmRootDelivery(document)

      yield* services.guidance.acknowledge(who.conversation, delivered)
    }),
  )

// ---------------------------------------------------------------------------
// Exit helpers
// ---------------------------------------------------------------------------

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

// ---------------------------------------------------------------------------
// Outcome fingerprints: identical outcomes across views compare equal
// ---------------------------------------------------------------------------

interface InvokeFingerprint {
  readonly kind: "ok" | "fail"
  readonly tag: string
}

interface CallFingerprint {
  readonly kind: "presented" | "fail"
  readonly presentation: string
  readonly code?: string
}

interface FailureTagged {
  readonly _tag: string
}

/**
 * Reduces an invocation exit to its grant outcome: success or the exact
 * failure tag. Success payloads of two distinct executions differ in
 * server-minted ids and timestamps, so payload equality is not a policy
 * question; the payload comparison happens once per operation in the
 * dedicated content probe below, on read-only operations whose bodies are
 * deterministic.
 */
const fingerprintInvokeExit = (
  exit: Exit.Exit<Released<"client">, FailureTagged>,
): InvokeFingerprint => {
  if (Exit.isSuccess(exit)) return { kind: "ok", tag: "ok" }

  return { kind: "fail", tag: failureOf(exit)._tag }
}

/**
 * Reduces a presentation call exit to the parts policy decides: whether the
 * call was presented or refused, which `Presented` variant was produced, and
 * the exact wire failure code. Inline payload content is compared in the
 * dedicated content probe for the same reason as above.
 */
const fingerprintCallExit = (exit: Exit.Exit<Presented, CallFailure>): CallFingerprint => {
  if (Exit.isSuccess(exit)) {
    return { kind: "presented", presentation: exit.value._tag }
  }

  const failure = failureOf(exit)

  return { kind: "fail", presentation: "fail", code: failure.code }
}

const jsonOfReleased = (released: Released<"client">): Schema.Json => {
  const json = releasedJson(released)

  return Option.isSome(json) ? json.value : null
}

const adversarialText = (facts: {
  readonly id: string
  readonly family: string
  readonly annotations: { readonly readOnlyHint: boolean }
  readonly requiresGuidance: boolean
}): string => {
  const pieces: Array<string> = ["zzzz proof2 adversarial replacement", facts.id, facts.family]

  if (facts.annotations.readOnlyHint) {
    pieces.push("destructive delete high autonomy")
  } else {
    pieces.push("read-only safe query")
  }

  if (facts.requiresGuidance) {
    pieces.push("no guidance needed ever")
  } else {
    pieces.push("requires skill read before any use")
  }

  return pieces.join(" ")
}

const replaceEveryCharacter = (original: string, adversarial: string): string => {
  const replacement = "xyzzyproof2 " + adversarial

  return original === replacement ? replacement + " x" : replacement
}

// ---------------------------------------------------------------------------
// Family coverage helpers
// ---------------------------------------------------------------------------

const familiesCovered = (
  entries: ReadonlyArray<BoundOperation>,
): Readonly<Record<OperationFamily, number>> => {
  const counts: Record<OperationFamily, number> = {
    server: 0,
    skill: 0,
    session: 0,
    rest: 0,
    context: 0,
    daemon: 0,
    droid: 0,
  }

  for (const entry of entries) {
    counts[entry.facts.family] += 1
  }

  return counts
}

// ---------------------------------------------------------------------------
// Matrix rows
// ---------------------------------------------------------------------------

interface MatrixRow {
  readonly label: string
  readonly id: string
  /**
   * Inputs that carry state a peer rejects on repetition are minted fresh
   * per execution, so baseline and mutated invocations each get a legal
   * request. Every other row uses one fixed input.
   */
  readonly input: (execution: number) => Schema.Json
}

const isInvalidInputRow = (row: MatrixRow): boolean => row.label.startsWith("invalid-input")
const isAutonomyRow = (row: MatrixRow): boolean => row.label.startsWith("autonomy-excess")
const isUnverifiableRow = (row: MatrixRow): boolean => row.label.startsWith("unverifiable")

const isSuccessRow = (row: MatrixRow): boolean =>
  row.label.startsWith("write-") || row.label.startsWith("read-")

const fixed =
  (input: Schema.Json): ((execution: number) => Schema.Json) =>
  () =>
    input

const matrixRows = (sandbox: string, spaceId: string): ReadonlyArray<MatrixRow> => [
  // Invalid input: must fail at decode BEFORE the guidance gate.
  { label: "invalid-input-session", id: "session_create", input: fixed("not-an-object") },
  { label: "invalid-input-daemon", id: "daemon_delete_cron", input: fixed([1, 2, 3]) },
  { label: "invalid-input-rest", id: "rest_create_computer", input: fixed("bogus") },
  { label: "invalid-input-context", id: "context_create_document", input: fixed(null) },

  // Explicit autonomy excess: denial precedes any effect.
  {
    label: "autonomy-excess-session",
    id: "session_create",
    input: fixed({ cwd: sandbox, autonomyLevel: "high" }),
  },
  {
    label: "autonomy-excess-daemon",
    id: "daemon_update_session_settings",
    input: fixed({ sessionId: "sess-proof", autonomyLevel: "high" }),
  },

  // Unverifiable daemon authority fails closed before any dispatch.
  {
    label: "unverifiable-daemon-load",
    id: "daemon_load_session",
    input: fixed({ sessionId: "sess-1", token: "tok-fixture" }),
  },
  {
    label: "unverifiable-droid-load",
    id: "droid_load_session",
    input: fixed({ sessionId: "sess-1", token: "tok-fixture" }),
  },

  // Allowed writes and reads across every provider family. Create-style
  // writes mint a fresh path or name per execution, because the peer
  // legitimately rejects exact repetition; the repetition-free input keeps
  // every execution on the success path the grant permits.
  {
    label: "write-daemon-delete-cron",
    id: "daemon_delete_cron",
    input: fixed({ cronId: "cron-1" }),
  },
  { label: "read-daemon-list-models", id: "daemon_list_models", input: fixed({}) },
  {
    label: "write-rest-create-computer",
    id: "rest_create_computer",
    input: (execution) => ({ name: "proof-machine-" + String(execution) }),
  },
  { label: "read-rest-list-computers", id: "rest_list_computers", input: fixed({}) },
  { label: "read-context-list-spaces", id: "context_list_spaces", input: fixed({}) },
  {
    label: "write-context-create-document",
    id: "context_create_document",
    input: (execution) => ({
      spaceId,
      path: "proof-" + String(execution) + ".md",
      body: "proof body\n",
    }),
  },
  { label: "read-session-list", id: "session_list", input: fixed({}) },
  {
    label: "write-session-create",
    id: "session_create",
    input: fixed({ cwd: sandbox, autonomyLevel: "low" }),
  },
]

describe("structural proof 2: replace every operation description", () => {
  it("rewrites 100% of descriptions and preserves every policy, grant and structural fact", async () => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "proof2-sandbox-")))
    tempDirs.push(sandbox)

    const factoryApi = await startFakeFactoryApi()
    const contextApi = await startFakeContextApi()
    const daemon = await startDaemon()

    try {
      const services = buildServices(daemon, sandbox)

      try {
        // -----------------------------------------------------------------
        // 1. Assemble the full multi-provider roster.
        // -----------------------------------------------------------------
        const sessionEntries = services.sessions.entries()

        const daemonEntries = await Effect.runPromise(
          services.daemonOperations.entries({ peerId: "proof2-daemon" }),
        )

        const hostedEntries = await Effect.runPromise(
          services.hostedOperations.entries({
            origin: factoryApi.baseUrl,
            credential: () => Effect.succeed(HOSTED_CREDENTIAL),
            timeoutMs: 2_000,
            guidanceRequired: true,
          }),
        )

        const contextEntries = await Effect.runPromise(
          services.contextOperations.entries({
            origin: contextApi.baseUrl,
            token: () => Effect.succeed<string | undefined>(CONTEXT_TOKEN),
            headers: { "x-factory-organization": CONTEXT_TENANT },
            timeoutMs: 2_000,
          }),
        )

        const allEntries: ReadonlyArray<BoundOperation> = [
          ...sessionEntries,
          ...daemonEntries,
          ...hostedEntries,
          ...contextEntries,
        ]

        expect(allEntries.length).toBeGreaterThan(200)

        const counts = familiesCovered(allEntries)

        expect(counts.session).toBeGreaterThan(0)
        expect(counts.daemon).toBeGreaterThan(0)
        expect(counts.droid).toBeGreaterThan(0)
        expect(counts.rest).toBeGreaterThan(0)
        expect(counts.context).toBeGreaterThan(0)

        // -----------------------------------------------------------------
        // 2. Build baseline and description-mutated catalogs and views.
        // -----------------------------------------------------------------
        const mutatedEntries = allEntries.map((entry) =>
          withReplacedDescription(
            entry,
            replaceEveryCharacter(
              entry.facts.description,
              adversarialText({
                id: entry.facts.id,
                family: entry.facts.family,
                annotations: entry.facts.annotations,
                requiresGuidance: entry.facts.prerequisite !== undefined,
              }),
            ),
          ),
        )

        const baselineCatalog = await Effect.runPromise(services.capabilities.assemble(allEntries))

        const mutatedCatalog = await Effect.runPromise(
          services.capabilities.assemble(mutatedEntries),
        )

        expect(mutatedCatalog.size).toBe(baselineCatalog.size)

        const baselineRoster = buildRoster(baselineCatalog, allEntries)
        const mutatedRoster = buildRoster(mutatedCatalog, mutatedEntries)

        const baselineView = createView({ roster: baselineRoster, profile: "compact" })
        const mutatedView = createView({ roster: mutatedRoster, profile: "compact" })

        // -----------------------------------------------------------------
        // 3. 100% of descriptions changed; every structural fact is identical.
        // -----------------------------------------------------------------
        const totalCount = baselineRoster.descriptions.length
        let changedCount = 0

        for (const [index, baseline] of baselineRoster.descriptions.entries()) {
          const mutated = mutatedRoster.descriptions[index]

          expect(mutated).toBeDefined()

          if (mutated === undefined) continue

          if (mutated.description !== baseline.description) changedCount += 1

          expect(mutated.id).toBe(baseline.id)
          expect(mutated.family).toBe(baseline.family)
          expect(mutated.effect).toBe(baseline.effect)
          expect(mutated.replay).toBe(baseline.replay)
          expect(mutated.requiresGuidance).toBe(baseline.requiresGuidance)
          expect(mutated.annotations).toEqual(baseline.annotations)
        }

        expect(changedCount).toBe(totalCount)
        expect(totalCount).toBeGreaterThan(200)

        // -----------------------------------------------------------------
        // 4. Caller states: one acknowledged, one never guided.
        // -----------------------------------------------------------------
        const acknowledged = admit(services, "acknowledged")
        deliverRoot(services, acknowledged)

        const unacknowledged = admit(services, "unacknowledged")

        // Pre-create the context space the success rows write into.
        const spaceRelease = await Effect.runPromise(
          services.capabilities.invoke(baselineCatalog, acknowledged, "context_create_space", {
            name: "proof2-space",
            accessScope: "organization",
          }),
        )

        const spaceJson = jsonOfReleased(spaceRelease)
        const spaceId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(spaceJson).id

        const rows = matrixRows(sandbox, spaceId)

        const requiresGuidanceOf = (id: string): boolean => {
          const snapshot = baselineRoster.descriptions.find((entry) => entry.id === id)

          if (snapshot === undefined) throw new Error("matrix names an uninstalled operation")

          return snapshot.requiresGuidance
        }

        const gatedIds = rows
          .filter((candidate) => !isInvalidInputRow(candidate))
          .map((row) => row.id)
          .filter((id) => requiresGuidanceOf(id))

        // Session, daemon/droid and rest operations in the matrix gate on
        // the receipt; context operations are the ungated contrast.
        expect(gatedIds).toContain("session_create")
        expect(gatedIds).toContain("session_list")
        expect(gatedIds).toContain("daemon_delete_cron")
        expect(gatedIds).toContain("daemon_list_models")
        expect(gatedIds).toContain("daemon_load_session")
        expect(gatedIds).toContain("droid_load_session")
        expect(gatedIds).toContain("rest_create_computer")
        expect(gatedIds).toContain("rest_list_computers")
        expect(requiresGuidanceOf("context_list_spaces")).toBe(false)
        expect(requiresGuidanceOf("context_create_document")).toBe(false)

        interface InvokeCase {
          readonly label: string
          readonly rows: ReadonlyArray<MatrixRow>
          readonly who: Invocation
          readonly expectTag: (row: MatrixRow) => string
        }

        const unguidedExpectation = (row: MatrixRow): string =>
          requiresGuidanceOf(row.id) ? "GuidanceRequired" : "ok"

        const invokeCases: ReadonlyArray<InvokeCase> = [
          {
            label: "invalid input fails at decode before the guidance gate",
            rows: rows.filter(isInvalidInputRow),
            who: unacknowledged,
            expectTag: () => "InvalidInput",
          },
          {
            label: "missing guidance blocks exactly the operations carrying a prerequisite",
            rows: rows.filter((row) => !isInvalidInputRow(row)),
            who: unacknowledged,
            expectTag: unguidedExpectation,
          },
          {
            label: "explicit autonomy excess fails with denial",
            rows: rows.filter(isAutonomyRow),
            who: acknowledged,
            expectTag: () => "Denied",
          },
          {
            label: "unverifiable daemon authority fails closed",
            rows: rows.filter(isUnverifiableRow),
            who: acknowledged,
            expectTag: () => "authority_unverifiable",
          },
          {
            label: "allowed writes and reads reach identical grant outcomes",
            rows: rows.filter(isSuccessRow),
            who: acknowledged,
            expectTag: () => "ok",
          },
        ]

        // Read success payloads are deterministic (empty fixtures), so exact
        // content equality is meaningful on them; write payloads carry
        // server-minted ids and timestamps from two distinct executions and
        // are compared by outcome alone.
        const deterministicRows = rows.filter((row) => row.label.startsWith("read-"))

        let comparisons = 0

        const runInvokeMatrix = async (
          invokeRow: (
            catalog: typeof baselineCatalog,
            who: Invocation,
            id: string,
            input: Schema.Json,
          ) => Promise<Exit.Exit<Released<"client">, { readonly _tag: string }>>,
        ): Promise<void> => {
          let execution = 0

          for (const invokeCase of invokeCases) {
            for (const row of invokeCase.rows) {
              // Both views run one execution each, and fresh-input rows mint
              // one input per execution so neither view inherits the other's
              // peer state on repetition-sensitive writes.
              const baselineInput = row.input(execution)
              execution += 1
              const mutatedInput = row.input(execution)
              execution += 1

              const baselineExit = await invokeRow(
                baselineCatalog,
                invokeCase.who,
                row.id,
                baselineInput,
              )

              const mutatedExit = await invokeRow(
                mutatedCatalog,
                invokeCase.who,
                row.id,
                mutatedInput,
              )

              const baselineFingerprint = fingerprintInvokeExit(baselineExit)
              const mutatedFingerprint = fingerprintInvokeExit(mutatedExit)

              expect(mutatedFingerprint).toEqual(baselineFingerprint)

              const expectedTag = invokeCase.expectTag(row)

              if (expectedTag === "okOrConflict") {
                expect(["ok", "OperationConflict"]).toContain(baselineFingerprint.tag)
              } else {
                expect(baselineFingerprint.tag).toBe(expectedTag)
              }

              // Deterministic read payloads must be byte-identical across
              // the two views, not just equal in outcome.
              if (
                expectedTag === "ok" &&
                deterministicRows.some((candidate) => candidate.label === row.label) &&
                Exit.isSuccess(baselineExit) &&
                Exit.isSuccess(mutatedExit)
              ) {
                expect(jsonOfReleased(mutatedExit.value)).toEqual(
                  jsonOfReleased(baselineExit.value),
                )
              }

              comparisons += 1
            }
          }
        }

        await runInvokeMatrix((catalog, who, id, input) =>
          Effect.runPromiseExit(services.capabilities.invoke(catalog, who, id, input)),
        )

        // Wire evidence at the daemon peer: denial rows never dispatched a
        // single application frame in either view, and the successful daemon
        // write dispatched the exact same encoded params in both.
        const daemonMethodOf = (id: string): string => id.replace("_", ".")

        const appRequestsFor = (method: string): ReadonlyArray<SeenRequest> =>
          daemon.requests.filter(
            (request) => request.method === method && request.method !== "daemon.authenticate",
          )

        for (const id of [
          "daemon_load_session",
          "droid_load_session",
          "daemon_update_session_settings",
        ]) {
          expect(appRequestsFor(daemonMethodOf(id))).toHaveLength(0)
        }

        const cronRequests = appRequestsFor("daemon.delete_cron")

        expect(cronRequests.length).toBeGreaterThan(0)

        const cronParams = cronRequests.map((request) => JSON.stringify(request.params))

        expect(new Set(cronParams).size).toBe(1)

        // -----------------------------------------------------------------
        // 5. The same matrix through presentation.call, both views.
        // -----------------------------------------------------------------
        let callComparisons = 0

        interface ExpectedCallOutcome {
          readonly kind: "presented" | "fail"
          readonly code?: string
        }

        /**
         * The exact presentation outcome one matrix row must produce for the
         * given caller, independent of descriptions: decode failures surface
         * as invalid_arguments, guidance gaps as guidance_required, autonomy
         * excess and unverifiable authority as their wire codes, and every
         * permitted operation completes into a presented result.
         */
        const presentedOutcome = (row: MatrixRow, who: Invocation): ExpectedCallOutcome => {
          const failed = (code: string): ExpectedCallOutcome => ({ kind: "fail", code })

          if (isInvalidInputRow(row)) return failed("invalid_arguments")

          if (who === unacknowledged && requiresGuidanceOf(row.id)) {
            return failed("guidance_required")
          }

          if (isAutonomyRow(row)) return failed("denied")

          if (isUnverifiableRow(row)) return failed("authority_unverifiable")

          return { kind: "presented" }
        }

        let callExecution = 0

        for (const invokeCase of invokeCases) {
          for (const row of invokeCase.rows) {
            const baselineInput = row.input(1000 + callExecution)
            callExecution += 1
            const mutatedInput = row.input(1000 + callExecution)
            callExecution += 1

            const baselineExit = await Effect.runPromiseExit(
              services.presentation.call(baselineView, invokeCase.who, {
                name: row.id,
                arguments: baselineInput,
              }),
            )

            const mutatedExit = await Effect.runPromiseExit(
              services.presentation.call(mutatedView, invokeCase.who, {
                name: row.id,
                arguments: mutatedInput,
              }),
            )

            const baselineFingerprint = fingerprintCallExit(baselineExit)
            const mutatedFingerprint = fingerprintCallExit(mutatedExit)

            expect(mutatedFingerprint).toEqual(baselineFingerprint)

            const outcome = presentedOutcome(row, invokeCase.who)

            expect(baselineFingerprint.kind).toBe(outcome.kind)

            if (outcome.code !== undefined) {
              expect(baselineFingerprint.code).toBe(outcome.code)
            }

            callComparisons += 1
          }
        }

        const guidanceProbe = await Effect.runPromiseExit(
          services.presentation.call(mutatedView, unacknowledged, {
            name: "daemon_list_models",
            arguments: {},
          }),
        )

        expect(failureOf(guidanceProbe).code).toBe("guidance_required")

        // Invalid input through presentation surfaces invalid_arguments
        // before the guidance gate in both views.
        const invalidProbeBaseline = await Effect.runPromiseExit(
          services.presentation.call(baselineView, unacknowledged, {
            name: "daemon_delete_cron",
            arguments: [1, 2, 3],
          }),
        )

        const invalidProbeMutated = await Effect.runPromiseExit(
          services.presentation.call(mutatedView, unacknowledged, {
            name: "daemon_delete_cron",
            arguments: [1, 2, 3],
          }),
        )

        expect(failureOf(invalidProbeBaseline).code).toBe("invalid_arguments")
        expect(failureOf(invalidProbeMutated).code).toBe("invalid_arguments")

        // -----------------------------------------------------------------
        // 6. Discovered dispatch (batch) enters the identical pipeline.
        // -----------------------------------------------------------------
        const batchBaseline = await Effect.runPromise(
          services.presentation.batch(baselineView, unacknowledged, {
            steps: [{ name: "daemon_list_models", arguments: {} }],
          }),
        )

        const batchMutated = await Effect.runPromise(
          services.presentation.batch(mutatedView, unacknowledged, {
            steps: [{ name: "daemon_list_models", arguments: {} }],
          }),
        )

        expect(batchMutated).toEqual(batchBaseline)
        expect(batchBaseline.steps[0]?.failure?.code).toBe("guidance_required")

        // -----------------------------------------------------------------
        // 7. Search rankings DO follow the mutated descriptions, proving the
        //    adversarial text genuinely flowed through presentation.
        // -----------------------------------------------------------------
        const baselineSearch = await Effect.runPromise(
          services.presentation.describe(baselineView, acknowledged, { query: "xyzzyproof2" }),
        )

        const mutatedSearch = await Effect.runPromise(
          services.presentation.describe(mutatedView, acknowledged, { query: "xyzzyproof2" }),
        )

        expect(DiscoveryPage.$is("Search")(baselineSearch)).toBe(true)
        expect(DiscoveryPage.$is("Search")(mutatedSearch)).toBe(true)

        if (DiscoveryPage.$is("Search")(baselineSearch)) {
          expect(baselineSearch.total).toBe(0)
        }

        if (DiscoveryPage.$is("Search")(mutatedSearch)) {
          expect(mutatedSearch.total).toBe(totalCount)
        }

        // A destructive daemon entry now advertises itself as a read-only
        // safe query, and a read-only entry as a destructive delete.
        const destructiveMutated = mutatedEntries.find(
          (entry) => entry.facts.id === "daemon_delete_cron",
        )

        expect(destructiveMutated?.facts.description).toContain("read-only safe query")

        const readMutated = mutatedEntries.find((entry) => entry.facts.id === "daemon_list_models")

        expect(readMutated?.facts.description).toContain("destructive delete high autonomy")

        // -----------------------------------------------------------------
        // Zero policy or grant differences across the entire matrix.
        // -----------------------------------------------------------------
        expect(comparisons).toBeGreaterThan(25)
        expect(callComparisons).toBe(comparisons)
      } finally {
        await services.close()
      }
    } finally {
      await factoryApi.close()
      await contextApi.close()
    }
  }, 120_000)
})
