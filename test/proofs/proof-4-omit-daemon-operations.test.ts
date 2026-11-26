import { execFile } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { promisify } from "node:util"

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { afterEach, describe, expect, it } from "vitest"

import { Artifacts, artifactsLayer } from "../../src/artifacts/index.ts"
import { Authority, authorityLayer } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import { Capabilities, capabilitiesLayer } from "../../src/capabilities/index.ts"
import type { BoundOperation, Invocation } from "../../src/capabilities/index.ts"
import { Custody, custodyLayer } from "../../src/custody/index.ts"
import { daemonLinkLayer } from "../../src/daemon-link/index.ts"
import { DaemonOperations, daemonOperationsLayer } from "../../src/daemon-operations/index.ts"
import { decisionsLayer } from "../../src/decisions/index.ts"
import { Disclosure, disclosureLayer } from "../../src/disclosure/index.ts"
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
  Presented,
} from "../../src/presentation/index.ts"
import type { View } from "../../src/presentation/index.ts"
import { Sessions, sessionsLayer } from "../../src/sessions/index.ts"
import { Turns, turnsLayer } from "../../src/turns/index.ts"
import { workspacesLayer } from "../../src/workspace/index.ts"
import { startFakeContextApi } from "../support/fake-context-api.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply, SeenRequest } from "../support/fake-daemon.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"

// ---------------------------------------------------------------------------
// Structural Proof 4: omit `daemon-operations`.
//
// Copy the whole `src/` tree into an isolated temp directory, DELETE
// `daemon-operations/` completely so the provider is literally unavailable
// to the module loader, then run a fresh child Node process that assembles
// capabilities + presentation with only sessions, hosted-factory and
// prem-context. Inside the child, a `module.registerHooks` load hook records
// every module URL the loader resolves, and a patched `net.connect` records
// every unix-socket connection attempt: the proof is that no file under
// `daemon-operations` or `daemon-link` is ever loaded and no daemon socket
// is ever dialed, while hosted, context and local-session operations run
// end to end against their fixture peers.
//
// The parent process then assembles the full daemon-enabled roster against
// the fake daemon, runs the exact same operation matrix and session
// lifecycle, and asserts every non-daemon result, grant/denial outcome and
// operation descriptor matches the omitted assembly — with only daemon
// entries absent.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "../..")
const SRC_DIR = join(REPO_ROOT, "src")
const FAKE_EXEC = join(REPO_ROOT, "test/support/fake-droid-exec.mjs")

const HOSTED_CREDENTIAL = "proof4-hosted-credential"
const CONTEXT_TOKEN = "proof4-context-token"
const CONTEXT_TENANT = "proof4-tenant"

// ---------------------------------------------------------------------------
// Child-process harness: plain JavaScript written into the temp tree. It
// patches the net module BEFORE anything loads, registers loader hooks, then
// dynamically imports the copied `.ts` modules so every resolution is
// observed. It prints one JSON verdict line.
// ---------------------------------------------------------------------------

const HARNESS = `import { createRequire, registerHooks } from "node:module"

const require = createRequire(import.meta.url)
const net = require("node:net")

// ---------------------------------------------------------------------------
// Observation 1: every unix-socket connection attempt. TCP connections to
// the fixture HTTP servers are expected; anything carrying a unix socket
// path is not.
// ---------------------------------------------------------------------------

const unixSocketAttempts = []

const originalConnect = net.connect

const patchedConnect = function (target, ...rest) {
  if (target !== null && typeof target === "object" && target.path !== undefined) {
    unixSocketAttempts.push(String(target.path))
  }

  return originalConnect.call(this, target, ...rest)
}

net.connect = patchedConnect
net.createConnection = patchedConnect

// ---------------------------------------------------------------------------
// Observation 2: every module URL the loader resolves, via registerHooks.
// ---------------------------------------------------------------------------

const loadedUrls = []

registerHooks({
  load(url, context, nextLoad) {
    loadedUrls.push(url)

    return nextLoad(url, context)
  },
})

const [sandbox, fakeExec, factoryBaseUrl, contextBaseUrl] = process.argv.slice(2)

const effectModule = await import("effect")
const { Cause, Context, Effect, Exit, Layer, Option, Schema, Scope } = effectModule

const artifactsModule = await import("./src/artifacts/index.ts")
const authorityModule = await import("./src/authority/index.ts")
const callerModule = await import("./src/caller/index.ts")
const capabilitiesModule = await import("./src/capabilities/index.ts")
const custodyModule = await import("./src/custody/index.ts")
const decisionsModule = await import("./src/decisions/index.ts")
const disclosureModule = await import("./src/disclosure/index.ts")
const dialectModule = await import("./src/factory-dialect/index.ts")
const guidanceModule = await import("./src/guidance/index.ts")
const hostedModule = await import("./src/hosted-factory/index.ts")
const localExecModule = await import("./src/local-exec/index.ts")
const observationsModule = await import("./src/observations/index.ts")
const placementModule = await import("./src/placement/index.ts")
const contextModule = await import("./src/prem-context/index.ts")
const presentationModule = await import("./src/presentation/index.ts")
const sessionsModule = await import("./src/sessions/index.ts")
const turnsModule = await import("./src/turns/index.ts")
const workspacesModule = await import("./src/workspace/index.ts")

const { Artifacts, artifactsLayer } = artifactsModule
const { Authority, authorityLayer } = authorityModule
const { Callers, callersLayer, trustedEvidence } = callerModule
const { Capabilities, capabilitiesLayer } = capabilitiesModule
const { Custody, custodyLayer } = custodyModule
const { decisionsLayer } = decisionsModule
const { Disclosure, disclosureLayer } = disclosureModule
const { dialectLayer } = dialectModule
const { CURRENT_GUIDE_EDITION, Guidance, guidanceLayer } = guidanceModule
const { HostedOperations, hostedOperationsLayer } = hostedModule
const { localExecLayer } = localExecModule
const { observationsLayer } = observationsModule
const { Placement, placementLayer } = placementModule
const { ContextOperations, contextOperationsLayer } = contextModule
const { Presentation, buildRoster, createView, presentationLayer } = presentationModule
const { Sessions, sessionsLayer } = sessionsModule
const { Turns, turnsLayer } = turnsModule
const { workspacesLayer } = workspacesModule

const checks = []

const record = (name, pass, detail) => {
  checks.push({ name, pass, detail: detail ?? null })
}

// ---------------------------------------------------------------------------
// Layer assembly: everything except daemon-link and daemon-operations.
// ---------------------------------------------------------------------------

const scope = Effect.runSync(Scope.make())

const disclosureLive = disclosureLayer()

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
  localExecLayer({ droidPath: process.execPath, args: [fakeExec] }),
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
  hostedOperationsLive,
  contextOperationsLive,
  presentationLive,
  capabilitiesLive,
  turnsLive,
  placementLive,
  decisionsLive,
  observationsLive,
  localLive,
  baseDeps,
)

const memoMap = Layer.makeMemoMapUnsafe()
const built = Effect.runSync(Layer.buildWithMemoMap(merged, memoMap, scope))

const get = (service) => Context.getUnsafe(built, service)

const services = {
  sessions: get(Sessions),
  hostedOperations: get(HostedOperations),
  contextOperations: get(ContextOperations),
  capabilities: get(Capabilities),
  presentation: get(Presentation),
  callers: get(Callers),
  guidance: get(Guidance),
}

// ---------------------------------------------------------------------------
// Caller helpers
// ---------------------------------------------------------------------------

const admit = (principal) =>
  Effect.runSync(
    Effect.gen(function* () {
      const caller = yield* services.callers.admit(Option.getOrThrow(trustedEvidence(principal)))
      const conversation = yield* services.callers.conversation(caller)

      return { caller, conversation }
    }),
  )

const deliverRoot = (who) =>
  Effect.runSync(
    Effect.gen(function* () {
      const document = yield* services.guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
      const delivered = yield* services.guidance.confirmRootDelivery(document)

      yield* services.guidance.acknowledge(who.conversation, delivered)
    }),
  )

// ---------------------------------------------------------------------------
// Fingerprints and payload extraction
// ---------------------------------------------------------------------------

const failureOf = (exit) => {
  const found = Cause.findErrorOption(exit.cause)

  if (Option.isNone(found)) return { _tag: "defect", code: "defect" }

  return found.value
}

const fingerprintCall = (exit) => {
  if (Exit.isSuccess(exit)) return { kind: "presented", presentation: exit.value._tag }

  const failure = failureOf(exit)

  return { kind: "fail", presentation: "fail", code: failure.code ?? failure._tag ?? "untagged" }
}

const inlineValue = (exit) => {
  if (!Exit.isSuccess(exit)) return null
  if (exit.value._tag !== "Inline") return null

  return exit.value.value
}

const call = (view, who, name, input) =>
  Effect.runPromiseExit(
    services.presentation.call(view, who, { name, arguments: input, maxBytes: 65536 }),
  )

// ---------------------------------------------------------------------------
// The proof body
// ---------------------------------------------------------------------------

const report = {
  checks,
  loadedDaemonUrls: [],
  resolvedDaemonSpecifiers: [],
  unixSocketAttempts,
  inventories: {},
  describeProbe: { entries: [], unknown: [] },
  rows: [],
  session: {},
}

try {
  // ---------------------------------------------------------------------
  // 1. Assemble the roster WITHOUT daemon-operations.
  // ---------------------------------------------------------------------
  const sessionEntries = services.sessions.entries()

  const hostedEntries = await Effect.runPromise(
    services.hostedOperations.entries({
      origin: factoryBaseUrl,
      credential: () => Effect.succeed("proof4-hosted-credential"),
      timeoutMs: 2_000,
      guidanceRequired: true,
    }),
  )

  const contextEntries = await Effect.runPromise(
    services.contextOperations.entries({
      origin: contextBaseUrl,
      token: () => Effect.succeed("proof4-context-token"),
      headers: { "x-factory-organization": "proof4-tenant" },
      timeoutMs: 2_000,
    }),
  )

  const allEntries = [...sessionEntries, ...hostedEntries, ...contextEntries]

  const catalog = await Effect.runPromise(services.capabilities.assemble(allEntries))
  const roster = buildRoster(catalog, allEntries)

  const compactView = createView({ roster, profile: "compact" })
  const fullView = createView({ roster, profile: "full" })

  // ---------------------------------------------------------------------
  // 2. Zero daemon entries in advertise (compact AND full) and describe,
  //    while session/rest/context entries are present.
  // ---------------------------------------------------------------------
  const who = admit("operator")
  deliverRoot(who)

  const unguided = admit("unguided")

  const captureInventory = (label, view) =>
    Effect.runPromise(services.presentation.advertise(view, who)).then((inventory) => {
      const names = inventory.tools.map((tool) => tool.name)

      report.inventories[label] = {
        names,
        toolCount: inventory.toolCount,
        operationCount: inventory.operationCount,
        familyCounts: inventory.familyCounts,
        providerKinds: inventory.providerKinds,
      }

      return names
    })

  const compactNames = await captureInventory("compact", compactView)
  const fullNames = await captureInventory("full", fullView)

  const daemonish = (name) => name.startsWith("daemon_") || name.startsWith("droid_")

  record(
    "advertise-compact-zero-daemon",
    compactNames.filter(daemonish).length === 0,
    JSON.stringify(compactNames.filter(daemonish)),
  )

  record(
    "advertise-full-zero-daemon",
    fullNames.filter(daemonish).length === 0,
    JSON.stringify(fullNames.filter(daemonish)),
  )

  record(
    "advertise-full-has-session-rest-context",
    fullNames.some((name) => name.startsWith("session_")) &&
      fullNames.some((name) => name.startsWith("rest_")) &&
      fullNames.some((name) => name.startsWith("context_")),
    "session=" +
      String(fullNames.filter((name) => name.startsWith("session_")).length) +
      " rest=" +
      String(fullNames.filter((name) => name.startsWith("rest_")).length) +
      " context=" +
      String(fullNames.filter((name) => name.startsWith("context_")).length),
  )

  record(
    "full-advertises-every-operation",
    report.inventories.full.toolCount === report.inventories.full.operationCount &&
      report.inventories.full.familyCounts.daemon === 0 &&
      report.inventories.full.familyCounts.droid === 0,
    JSON.stringify(report.inventories.full.familyCounts),
  )

  record(
    "provider-kinds-exclude-daemon",
    !report.inventories.full.providerKinds.includes("daemon") &&
      report.inventories.full.providerKinds.includes("hosted") &&
      report.inventories.full.providerKinds.includes("context"),
    JSON.stringify(report.inventories.full.providerKinds),
  )

  // Discovery: daemon operation names are unknown; installed names describe.
  const probeNames = [
    "session_create",
    "session_stream",
    "session_close",
    "rest_list_computers",
    "rest_create_computer",
    "context_list_spaces",
    "context_create_document",
    "daemon_list_models",
    "daemon_delete_cron",
    "droid_load_session",
  ]

  const describePage = await Effect.runPromise(
    services.presentation.describe(compactView, who, { names: probeNames }),
  )

  if (describePage._tag !== "Describe") {
    record("describe-probe-shape", false, describePage._tag)
  } else {
    const described = describePage.entries.map((entry) => entry.name)
    const unknown = [...describePage.unknown].sort()

    record(
      "describe-daemon-names-unknown",
      unknown.join(",") === "daemon_delete_cron,daemon_list_models,droid_load_session",
      JSON.stringify(unknown),
    )

    record(
      "describe-installed-names-present",
      probeNames.filter((name) => !daemonish(name)).every((name) => described.includes(name)),
      JSON.stringify(described),
    )

    report.describeProbe = {
      entries: describePage.entries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
        annotations: entry.annotations,
        effect: entry.effect,
        replay: entry.replay,
        family: entry.family,
        requiresGuidance: entry.requiresGuidance,
      })),
      unknown,
    }
  }

  // ---------------------------------------------------------------------
  // 3. Operation matrix, driven strictly through presentation.call, in a
  //    fixed order the parent replays exactly.
  // ---------------------------------------------------------------------
  const pushRow = (label, exit, exact) => {
    const row = { label, fingerprint: fingerprintCall(exit) }

    if (exact === true) row.payload = inlineValue(exit)

    report.rows.push(row)
  }

  // Deterministic reads on the untouched fixture state: byte-comparable.
  pushRow("read-rest-list-computers", await call(compactView, who, "rest_list_computers", {}), true)

  pushRow(
    "read-rest-list-machine-templates",
    await call(compactView, who, "rest_list_machine_templates", {}),
    true,
  )

  pushRow("read-context-list-spaces", await call(compactView, who, "context_list_spaces", {}), true)

  // Writes: outcomes compare, minted payloads do not.
  pushRow(
    "write-rest-create-computer",
    await call(compactView, who, "rest_create_computer", { name: "proof4-machine" }),
  )

  const spaceExit = await call(compactView, who, "context_create_space", {
    name: "proof4-space",
    accessScope: "organization",
  })

  pushRow("write-context-create-space", spaceExit)

  const spaceValue = inlineValue(spaceExit)
  const spaceId = spaceValue !== null && typeof spaceValue === "object" && !Array.isArray(spaceValue)
    ? spaceValue.id
    : undefined

  if (typeof spaceId === "string") {
    pushRow(
      "write-context-create-document",
      await call(compactView, who, "context_create_document", {
        spaceId,
        path: "proof4.md",
        body: "proof body\\n",
      }),
    )
  } else {
    record("space-id-minted", false, JSON.stringify(spaceValue))
  }

  // Grant and denial outcomes.
  pushRow(
    "denial-session-autonomy-excess",
    await call(compactView, who, "session_create", { cwd: sandbox, autonomyLevel: "high" }),
  )

  pushRow(
    "invalid-context-create-document",
    await call(compactView, who, "context_create_document", null),
  )

  pushRow(
    "guidance-rest-list-computers",
    await call(compactView, unguided, "rest_list_computers", {}),
  )

  // ---------------------------------------------------------------------
  // 4. Local session lifecycle: create, submit "hello", wait to terminal,
  //    inspect the result, close.
  // ---------------------------------------------------------------------
  const createExit = await call(compactView, who, "session_create", {
    cwd: sandbox,
    autonomyLevel: "low",
  })

  const createValue = inlineValue(createExit)
  const sessionId =
    createValue !== null && typeof createValue === "object" && !Array.isArray(createValue)
      ? createValue.sessionId
      : undefined

  report.session.create = fingerprintCall(createExit)

  if (typeof sessionId === "string") {
    const streamExit = await call(compactView, who, "session_stream", {
      sessionId,
      prompt: "hello",
      waitMs: 5000,
    })

    const streamValue = inlineValue(streamExit)

    report.session.stream = {
      fingerprint: fingerprintCall(streamExit),
      status:
        streamValue !== null && typeof streamValue === "object" && !Array.isArray(streamValue)
          ? streamValue.status
          : null,
      eventKinds:
        streamValue !== null && typeof streamValue === "object" && !Array.isArray(streamValue)
          ? streamValue.events
              .map((event) =>
                event !== null && typeof event === "object" && !Array.isArray(event)
                  ? event.kind
                  : null,
              )
              .filter((kind) => typeof kind === "string")
          : [],
    }

    const listExit = await call(compactView, who, "session_list", {})
    const listValue = inlineValue(listExit)

    report.session.list = {
      fingerprint: fingerprintCall(listExit),
      count:
        listValue !== null && typeof listValue === "object" && !Array.isArray(listValue)
          ? listValue.sessions.length
          : -1,
    }

    const closeExit = await call(compactView, who, "session_close", { sessionId })

    const closeValue = inlineValue(closeExit)

    report.session.close = {
      fingerprint: fingerprintCall(closeExit),
      closed:
        closeValue !== null && typeof closeValue === "object" && !Array.isArray(closeValue)
          ? closeValue.closed
          : null,
    }
  } else {
    record("session-id-minted", false, JSON.stringify(createValue))
  }

  record(
    "session-lifecycle-terminal",
    report.session.create.kind === "presented" &&
      report.session.stream !== undefined &&
      report.session.stream.fingerprint.kind === "presented" &&
      report.session.stream.status === "completed" &&
      report.session.stream.eventKinds.includes("turn_completed") &&
      report.session.close !== undefined &&
      report.session.close.closed === true,
    JSON.stringify(report.session),
  )
} catch (error) {
  record("harness-error", false, error instanceof Error ? error.message : String(error))
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void))
}

// ---------------------------------------------------------------------------
// Loader evidence: nothing under daemon-operations or daemon-link may ever
// have been loaded. The harness itself never imports them, so any hit proves
// a hidden transitive runtime edge.
// ---------------------------------------------------------------------------

report.loadedDaemonUrls = loadedUrls.filter(
  (url) => url.includes("daemon-operations") || url.includes("daemon-link"),
)

record(
  "zero-daemon-module-loads",
  report.loadedDaemonUrls.length === 0,
  JSON.stringify(report.loadedDaemonUrls.slice(0, 5)),
)

record(
  "zero-daemon-socket-attempts",
  unixSocketAttempts.length === 0,
  JSON.stringify(unixSocketAttempts.slice(0, 5)),
)

console.log("PROOF4_RESULT " + JSON.stringify(report))
`

// ---------------------------------------------------------------------------
// Shared types for the child report and the parent-side mirror run
// ---------------------------------------------------------------------------

interface ProofCheck {
  readonly name: string
  readonly pass: boolean
  readonly detail: string | null
}

interface CallFingerprint {
  readonly kind: "presented" | "fail"
  readonly presentation: string
  readonly code?: string
}

interface MatrixRowReport {
  readonly label: string
  readonly fingerprint: CallFingerprint
  readonly payload?: Schema.Json
}

interface InventoryReport {
  readonly names: ReadonlyArray<string>
  readonly toolCount: number
  readonly operationCount: number
  readonly familyCounts: Readonly<Record<string, number>>
  readonly providerKinds: ReadonlyArray<string>
}

interface DescriptorReport {
  readonly name: string
  readonly description: string
  readonly inputSchema: { readonly [key: string]: Schema.Json }
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
  readonly effect: string
  readonly replay: string
  readonly family: string
  readonly requiresGuidance: boolean
}

interface DescribeProbeReport {
  readonly entries: ReadonlyArray<DescriptorReport>
  readonly unknown: ReadonlyArray<string>
}

interface SessionReport {
  readonly create?: CallFingerprint
  readonly stream?: {
    readonly fingerprint: CallFingerprint
    readonly status: string | null
    readonly eventKinds: ReadonlyArray<string>
  }
  readonly list?: {
    readonly fingerprint: CallFingerprint
    readonly count: number
  }
  readonly close?: {
    readonly fingerprint: CallFingerprint
    readonly closed: boolean | null
  }
}

interface ProofReport {
  readonly checks: ReadonlyArray<ProofCheck>
  readonly loadedDaemonUrls: ReadonlyArray<string>
  readonly unixSocketAttempts: ReadonlyArray<string>
  readonly inventories: Readonly<Record<string, InventoryReport>>
  readonly describeProbe: DescribeProbeReport
  readonly rows: ReadonlyArray<MatrixRowReport>
  readonly session: SessionReport
}

const readResult = (stdout: string): ProofReport => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("PROOF4_RESULT "))

  if (line === undefined) {
    throw new Error("child process produced no PROOF4_RESULT line; stdout:\n" + stdout)
  }

  // SAFETY: the child harness serializes exactly this shape on its single
  // result line; a parse failure here is a test failure either way.
  return JSON.parse(line.slice("PROOF4_RESULT ".length)) as ProofReport
}

// ---------------------------------------------------------------------------
// Parent-side daemon-enabled assembly
// ---------------------------------------------------------------------------

const AUTH_RESULT = { userId: "proof4-user", orgId: "proof4-org" }

const permissiveDaemonHandler = {
  onRequest: (request: SeenRequest): ScriptedReply | undefined => {
    if (request.method === "daemon.authenticate") return { result: AUTH_RESULT }

    return { result: { ok: true } }
  },
}

const daemons: Array<FakeDaemon> = []
const tempDirs: Array<string> = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const startDaemon = async (): Promise<FakeDaemon> => {
  const dir = mkdtempSync(join(tmpdir(), "proof4-daemon-"))
  tempDirs.push(dir)
  const daemon = await startFakeDaemon(join(dir, "daemon.sock"), permissiveDaemonHandler)
  daemons.push(daemon)

  return daemon
}

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
      auth: { apiKey: "proof4-key" },
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
// Parent-side helpers mirroring the harness exactly
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

interface FailureTagged {
  readonly _tag: string
  readonly code?: string
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

const fingerprintCall = (exit: Exit.Exit<Presented, FailureTagged>): CallFingerprint => {
  if (Exit.isSuccess(exit)) {
    return { kind: "presented", presentation: exit.value._tag }
  }

  const failure = failureOf(exit)

  return {
    kind: "fail",
    presentation: "fail",
    code: failure.code ?? failure._tag,
  }
}

const inlineValue = (exit: Exit.Exit<Presented, FailureTagged>): Schema.Json | null => {
  if (!Exit.isSuccess(exit)) return null

  if (!Presented.$is("Inline")(exit.value)) return null

  return exit.value.value
}

const isJsonObject = (
  value: Schema.Json | null,
): value is { readonly [key: string]: Schema.Json } =>
  value !== null && !Array.isArray(value) && value instanceof Object

// ---------------------------------------------------------------------------
// Recursive file listing (structural byte-identity check)
// ---------------------------------------------------------------------------

const collectRelativePaths = (root: string): ReadonlyArray<string> => {
  const collected: Array<string> = []

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        collected.push(relative(root, path).split(sep).join("/"))
      }
    }
  }

  walk(root)

  return collected.sort()
}

describe("structural proof 4: omit daemon-operations", () => {
  it("runs the full matrix with daemon-operations deleted from disk and matches the daemon-enabled assembly", async () => {
    const tree = mkdtempSync(join(tmpdir(), "droid-mcp-proof4-"))
    tempDirs.push(tree)

    const childFactoryApi = await startFakeFactoryApi()
    const childContextApi = await startFakeContextApi()
    const parentFactoryApi = await startFakeFactoryApi()
    const parentContextApi = await startFakeContextApi()
    const daemon = await startDaemon()

    const childSandbox = realpathSync(mkdtempSync(join(tmpdir(), "proof4-child-sandbox-")))
    tempDirs.push(childSandbox)

    const parentSandbox = realpathSync(mkdtempSync(join(tmpdir(), "proof4-parent-sandbox-")))
    tempDirs.push(parentSandbox)

    try {
      // 1. Remove the provider from the copied module graph.
      cpSync(SRC_DIR, join(tree, "src"), { recursive: true })
      symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"), "dir")
      rmSync(join(tree, "src", "daemon-operations"), { recursive: true, force: true })
      writeFileSync(join(tree, "harness.mjs"), HARNESS)

      expect(existsSync(join(tree, "src", "daemon-operations"))).toBe(false)
      expect(existsSync(join(tree, "src", "daemon-link"))).toBe(true)

      // Every remaining file is byte-identical to the repo original: the
      // only difference anywhere is the deleted provider directory.
      const copiedRelative = collectRelativePaths(join(tree, "src"))
      const originalRelative = collectRelativePaths(SRC_DIR)

      const omittedPaths = originalRelative.filter((path) => path.startsWith("daemon-operations/"))

      expect(omittedPaths.length).toBeGreaterThan(0)
      expect(copiedRelative).toEqual(
        originalRelative.filter((path) => !path.startsWith("daemon-operations/")),
      )

      const differing: Array<string> = []

      for (const relativePath of copiedRelative) {
        const copied = readFileSync(join(tree, "src", relativePath))
        const original = readFileSync(join(SRC_DIR, relativePath))

        if (!copied.equals(original)) differing.push(relativePath)
      }

      expect(differing).toEqual([])

      // 2. Run the child asynchronously so the parent can serve its fixture requests.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          join(tree, "harness.mjs"),
          childSandbox,
          FAKE_EXEC,
          childFactoryApi.baseUrl,
          childContextApi.baseUrl,
        ],
        {
          encoding: "utf8",
          timeout: 90_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      )

      const child = readResult(stdout)

      // -----------------------------------------------------------------
      // 3. Every self-check the child recorded must pass: zero daemon
      //    entries in advertise/describe, zero daemon module loads, zero
      //    unix socket attempts, full lifecycle to terminal.
      // -----------------------------------------------------------------
      const failed = child.checks.filter((check) => !check.pass)

      expect(failed.map((check) => check.name + ": " + String(check.detail))).toEqual([])

      expect(child.checks.map((check) => check.name).sort()).toEqual(
        [
          "advertise-compact-zero-daemon",
          "advertise-full-has-session-rest-context",
          "advertise-full-zero-daemon",
          "describe-daemon-names-unknown",
          "describe-installed-names-present",
          "full-advertises-every-operation",
          "provider-kinds-exclude-daemon",
          "session-lifecycle-terminal",
          "zero-daemon-module-loads",
          "zero-daemon-socket-attempts",
        ].sort(),
      )

      expect(child.loadedDaemonUrls).toEqual([])
      expect(child.unixSocketAttempts).toEqual([])

      // -----------------------------------------------------------------
      // 4. Assemble the daemon-enabled roster in this process and run the
      //    exact same matrix against its own fresh fixture servers.
      // -----------------------------------------------------------------
      const services = buildServices(daemon, parentSandbox)

      try {
        const sessionEntries = services.sessions.entries()

        const daemonEntries = await Effect.runPromise(
          services.daemonOperations.entries({ peerId: "proof4-daemon" }),
        )

        const hostedEntries = await Effect.runPromise(
          services.hostedOperations.entries({
            origin: parentFactoryApi.baseUrl,
            credential: () => Effect.succeed(HOSTED_CREDENTIAL),
            timeoutMs: 2_000,
            guidanceRequired: true,
          }),
        )

        const contextEntries = await Effect.runPromise(
          services.contextOperations.entries({
            origin: parentContextApi.baseUrl,
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

        // Sanity: the enabled assembly genuinely carries daemon entries,
        // so the comparison is meaningful.
        const daemonish = (name: string): boolean =>
          name.startsWith("daemon_") || name.startsWith("droid_")

        const daemonEntryCount = allEntries.filter((entry) => daemonish(entry.facts.id)).length

        expect(daemonEntryCount).toBeGreaterThan(0)

        const catalog = await Effect.runPromise(services.capabilities.assemble(allEntries))
        const roster = buildRoster(catalog, allEntries)

        const compactView = createView({ roster, profile: "compact" })
        const fullView = createView({ roster, profile: "full" })

        const who = admit(services, "operator")
        deliverRoot(services, who)

        const unguided = admit(services, "unguided")

        // ---------------------------------------------------------------
        // 5. Inventory comparison. Compact advertises only session directs
        //    plus dispatch tools in both assemblies, so those are exactly
        //    equal. Full differs ONLY by daemon entries: filtering them
        //    out of the enabled view must reproduce the omitted view's
        //    advertisement in order.
        // ---------------------------------------------------------------
        const parentCompact = await Effect.runPromise(
          services.presentation.advertise(compactView, who),
        )

        const parentFull = await Effect.runPromise(services.presentation.advertise(fullView, who))

        const childCompact = child.inventories["compact"]
        const childFull = child.inventories["full"]

        expect(childCompact).toBeDefined()
        expect(childFull).toBeDefined()

        if (childCompact === undefined || childFull === undefined) {
          throw new Error("child report missing inventories")
        }

        expect(parentCompact.tools.map((tool) => tool.name)).toEqual(childCompact.names)

        const parentFullNames = parentFull.tools.map((tool) => tool.name)
        const parentFullNonDaemon = parentFullNames.filter((name) => !daemonish(name))

        expect(parentFullNonDaemon).toEqual(childFull.names)
        expect(parentFullNames.filter(daemonish).length).toBeGreaterThan(0)
        expect(childFull.names.filter(daemonish)).toEqual([])

        // Non-daemon family counts match exactly; only daemon/droid differ.
        expect(childFull.familyCounts["session"]).toBe(parentFull.familyCounts["session"])
        expect(childFull.familyCounts["rest"]).toBe(parentFull.familyCounts["rest"])
        expect(childFull.familyCounts["context"]).toBe(parentFull.familyCounts["context"])
        expect(childFull.familyCounts["daemon"]).toBe(0)
        expect(childFull.familyCounts["droid"]).toBe(0)
        expect(parentFull.familyCounts["daemon"]).toBeGreaterThan(0)
        expect(parentFull.familyCounts["droid"]).toBeGreaterThan(0)
        expect(childFull.providerKinds).not.toContain("daemon")
        expect(parentFull.providerKinds).toContain("daemon")

        // ---------------------------------------------------------------
        // 6. Describe probe: every non-daemon descriptor in the omitted
        //    assembly is byte-identical to the enabled assembly, and the
        //    daemon names the child reported unknown are known here.
        // ---------------------------------------------------------------
        const probeNames = [
          "session_create",
          "session_stream",
          "session_close",
          "rest_list_computers",
          "rest_create_computer",
          "context_list_spaces",
          "context_create_document",
          "daemon_list_models",
          "daemon_delete_cron",
          "droid_load_session",
        ]

        const parentDescribe = await Effect.runPromise(
          services.presentation.describe(compactView, who, { names: probeNames }),
        )

        expect(DiscoveryPage.$is("Describe")(parentDescribe)).toBe(true)

        if (!DiscoveryPage.$is("Describe")(parentDescribe)) {
          throw new Error("expected a Describe page")
        }

        const childProbe = child.describeProbe

        expect(parentDescribe.unknown).toEqual([])
        expect([...childProbe.unknown].sort()).toEqual([
          "daemon_delete_cron",
          "daemon_list_models",
          "droid_load_session",
        ])

        const parentByName = new Map(parentDescribe.entries.map((entry) => [entry.name, entry]))

        for (const childEntry of childProbe.entries) {
          const parentEntry = parentByName.get(childEntry.name)

          expect(parentEntry).toBeDefined()

          if (parentEntry === undefined) continue

          expect({
            description: parentEntry.description,
            inputSchema: parentEntry.inputSchema,
            annotations: parentEntry.annotations,
            effect: parentEntry.effect,
            replay: parentEntry.replay,
            family: parentEntry.family,
            requiresGuidance: parentEntry.requiresGuidance,
          }).toEqual({
            description: childEntry.description,
            inputSchema: childEntry.inputSchema,
            annotations: childEntry.annotations,
            effect: childEntry.effect,
            replay: childEntry.replay,
            family: childEntry.family,
            requiresGuidance: childEntry.requiresGuidance,
          })
        }

        // ---------------------------------------------------------------
        // 7. The exact same operation matrix, in the same order.
        // ---------------------------------------------------------------
        const parentRows: Array<MatrixRowReport> = []

        const call = (view: View, caller: Invocation, name: string, input: Schema.Json) =>
          Effect.runPromiseExit(
            services.presentation.call(view, caller, {
              name,
              arguments: input,
              maxBytes: 65_536,
            }),
          )

        const pushRow = async (
          label: string,
          caller: Invocation,
          name: string,
          input: Schema.Json,
          exact?: boolean,
        ): Promise<Exit.Exit<Presented, FailureTagged>> => {
          const exit = await call(compactView, caller, name, input)

          const row: MatrixRowReport =
            exact === true
              ? { label, fingerprint: fingerprintCall(exit), payload: inlineValue(exit) }
              : { label, fingerprint: fingerprintCall(exit) }

          parentRows.push(row)

          return exit
        }

        await pushRow("read-rest-list-computers", who, "rest_list_computers", {}, true)
        await pushRow(
          "read-rest-list-machine-templates",
          who,
          "rest_list_machine_templates",
          {},
          true,
        )
        await pushRow("read-context-list-spaces", who, "context_list_spaces", {}, true)
        await pushRow("write-rest-create-computer", who, "rest_create_computer", {
          name: "proof4-machine",
        })

        const spaceExit = await pushRow("write-context-create-space", who, "context_create_space", {
          name: "proof4-space",
          accessScope: "organization",
        })

        const spaceValue = inlineValue(spaceExit)

        const spaceId = isJsonObject(spaceValue) ? spaceValue["id"] : undefined

        expect(Predicate.isString(spaceId)).toBe(true)

        if (Predicate.isString(spaceId)) {
          await pushRow("write-context-create-document", who, "context_create_document", {
            spaceId,
            path: "proof4.md",
            body: "proof body\n",
          })
        }

        await pushRow("denial-session-autonomy-excess", who, "session_create", {
          cwd: parentSandbox,
          autonomyLevel: "high",
        })

        await pushRow("invalid-context-create-document", who, "context_create_document", null)

        await pushRow("guidance-rest-list-computers", unguided, "rest_list_computers", {})

        // 8. Compare corresponding rows.
        expect(child.rows.map((row) => row.label)).toEqual(parentRows.map((row) => row.label))

        for (const [index, childRow] of child.rows.entries()) {
          const parentRow = parentRows[index]

          expect(parentRow).toBeDefined()

          if (parentRow === undefined) continue

          expect(childRow.fingerprint).toEqual(parentRow.fingerprint)

          if (childRow.payload !== undefined || parentRow.payload !== undefined) {
            expect(childRow.payload).toEqual(parentRow.payload)
          }
        }

        // The expected grant/denial outcomes themselves, pinned so a
        // regression in either assembly cannot hide inside the comparison.
        const rowByLabel = new Map(child.rows.map((row) => [row.label, row]))

        expect(rowByLabel.get("read-rest-list-computers")?.fingerprint.kind).toBe("presented")
        expect(rowByLabel.get("write-rest-create-computer")?.fingerprint.kind).toBe("presented")
        expect(rowByLabel.get("write-context-create-space")?.fingerprint.kind).toBe("presented")
        expect(rowByLabel.get("write-context-create-document")?.fingerprint.kind).toBe("presented")
        expect(rowByLabel.get("denial-session-autonomy-excess")?.fingerprint).toEqual({
          kind: "fail",
          presentation: "fail",
          code: "denied",
        })
        expect(rowByLabel.get("invalid-context-create-document")?.fingerprint).toEqual({
          kind: "fail",
          presentation: "fail",
          code: "invalid_arguments",
        })
        expect(rowByLabel.get("guidance-rest-list-computers")?.fingerprint).toEqual({
          kind: "fail",
          presentation: "fail",
          code: "guidance_required",
        })

        // ---------------------------------------------------------------
        // 9. The same local session lifecycle in the enabled assembly.
        // ---------------------------------------------------------------
        const createExit = await call(compactView, who, "session_create", {
          cwd: parentSandbox,
          autonomyLevel: "low",
        })

        const createValue = inlineValue(createExit)
        const sessionId = isJsonObject(createValue) ? createValue["sessionId"] : undefined

        expect(Predicate.isString(sessionId)).toBe(true)

        let parentSession: SessionReport = {}

        if (Predicate.isString(sessionId)) {
          const streamExit = await call(compactView, who, "session_stream", {
            sessionId,
            prompt: "hello",
            waitMs: 5_000,
          })

          const streamValue = inlineValue(streamExit)

          const eventKinds: Array<string> = []

          if (isJsonObject(streamValue)) {
            const events = streamValue["events"]

            if (Array.isArray(events)) {
              for (const event of events) {
                if (isJsonObject(event)) {
                  const kind = event["kind"]

                  if (Predicate.isString(kind)) eventKinds.push(kind)
                }
              }
            }
          }

          const streamStatus = isJsonObject(streamValue) ? streamValue["status"] : undefined
          const listExit = await call(compactView, who, "session_list", {})
          const listValue = inlineValue(listExit)
          const closeExit = await call(compactView, who, "session_close", { sessionId })
          const closeValue = inlineValue(closeExit)

          parentSession = {
            create: fingerprintCall(createExit),
            stream: {
              fingerprint: fingerprintCall(streamExit),
              status: Predicate.isString(streamStatus) ? streamStatus : null,
              eventKinds,
            },
            list: {
              fingerprint: fingerprintCall(listExit),
              count:
                isJsonObject(listValue) && Array.isArray(listValue["sessions"])
                  ? listValue["sessions"].length
                  : -1,
            },
            close: {
              fingerprint: fingerprintCall(closeExit),
              closed: isJsonObject(closeValue) && closeValue["closed"] === true,
            },
          }
        }

        // ---------------------------------------------------------------
        // 10. Session lifecycle comparison: identical fingerprints, same
        //     terminal status, same event kind sequence, same close
        //     outcome. Only server-minted ids and sandbox paths differ.
        // ---------------------------------------------------------------
        expect(child.session.create).toEqual(parentSession.create)
        expect(child.session.stream?.fingerprint).toEqual(parentSession.stream?.fingerprint)
        expect(child.session.stream?.status).toBe("completed")
        expect(child.session.stream?.status).toBe(parentSession.stream?.status)
        expect(child.session.stream?.eventKinds).toEqual(parentSession.stream?.eventKinds)
        expect(child.session.stream?.eventKinds).toContain("turn_completed")
        expect(child.session.list?.fingerprint).toEqual(parentSession.list?.fingerprint)
        expect(child.session.list?.count).toBe(parentSession.list?.count)
        expect(child.session.close?.fingerprint).toEqual(parentSession.close?.fingerprint)
        expect(child.session.close?.closed).toBe(true)
        expect(parentSession.close?.closed).toBe(true)
      } finally {
        await services.close()
      }
    } finally {
      await childFactoryApi.close()
      await childContextApi.close()
      await parentFactoryApi.close()
      await parentContextApi.close()
    }
  }, 120_000)
})
