import { mkdtempSync, rmSync } from "node:fs"
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

import { authorityLayer } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { CallersApi } from "../../src/caller/index.ts"
import { Capabilities, capabilitiesLayer, PeerFailure } from "../../src/capabilities/index.ts"
import type {
  CapabilitiesApi,
  Catalog,
  Invocation,
  InvocationFailure,
} from "../../src/capabilities/index.ts"
import { custodyLayer } from "../../src/custody/index.ts"
import { daemonLinkLayer } from "../../src/daemon-link/index.ts"
import type { DaemonLinkOptions } from "../../src/daemon-link/index.ts"
import {
  DaemonFacetUnsupported,
  DaemonOperations,
  daemonOperationsLayer,
} from "../../src/daemon-operations/index.ts"
import type {
  DaemonInstallation,
  DaemonOperationsService,
} from "../../src/daemon-operations/index.ts"
import { disclosureLayer, releasedJson } from "../../src/disclosure/index.ts"
import type { Released } from "../../src/disclosure/index.ts"
import { dialectLayer } from "../../src/factory-dialect/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import type { GuidanceApi } from "../../src/guidance/index.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply, SeenRequest } from "../support/fake-daemon.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const AUTH_RESULT = { userId: "user-1", orgId: "org-1" }

/**
 * Replies to the authentication handshake like a current daemon unless the
 * test scripts it; every other method is scripted per test.
 */
const handler = (onRequest?: (request: SeenRequest) => ScriptedReply | undefined) => ({
  onRequest: (request: SeenRequest) => {
    const scripted = onRequest?.(request)

    if (scripted !== undefined) return scripted

    if (request.method === "daemon.authenticate") return { result: AUTH_RESULT }

    return undefined
  },
})

const daemons: Array<FakeDaemon> = []
const dirs: Array<string> = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.close()
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const fakeDaemon = async (
  onRequest?: (request: SeenRequest) => ScriptedReply | undefined,
): Promise<FakeDaemon> => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-operations-test-"))
  dirs.push(dir)
  const daemon = await startFakeDaemon(join(dir, "daemon.sock"), handler(onRequest))
  daemons.push(daemon)

  return daemon
}

interface Services {
  readonly daemonOperations: DaemonOperationsService
  readonly capabilities: CapabilitiesApi
  readonly callers: CallersApi
  readonly guidance: GuidanceApi
  readonly close: () => Promise<void>
}

const openScopes: Array<Scope.Closeable> = []

afterEach(async () => {
  for (const scope of openScopes.splice(0)) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

/**
 * Builds the whole gate stack — capabilities over callers, authority,
 * guidance and disclosure — then layers daemon-operations over that plus a
 * real `DaemonLink` pointed at the fake daemon's socket. Nothing is mocked:
 * invocations travel the socket end to end. The layer graph is built into a
 * manually managed scope that stays open for the lifetime of the services,
 * because the link's custody leases die with their build scope; `close`
 * drains them exactly once.
 */
const makeServices = (
  linkOptions: DaemonLinkOptions,
  options?: {
    readonly maxAutonomy?: "off" | "low" | "medium" | "high"
    readonly allowUnverifiedDaemonAuthority?: boolean
    readonly guidanceRequired?: boolean
  },
): Services => {
  const disclosureLive = disclosureLayer()
  const callersLive = callersLayer()

  const authorityLive = authorityLayer({
    maxAutonomy: options?.maxAutonomy ?? "high",
    allowUnverifiedDaemonAuthority: options?.allowUnverifiedDaemonAuthority,
  })

  const guidanceLive = guidanceLayer({ required: options?.guidanceRequired ?? false })

  const capabilitiesLive = Layer.provideMerge(
    capabilitiesLayer,
    Layer.merge(Layer.merge(callersLive, authorityLive), Layer.merge(guidanceLive, disclosureLive)),
  )

  const linkLive = Layer.provideMerge(
    daemonLinkLayer(linkOptions),
    Layer.merge(custodyLayer, disclosureLive),
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

  const merged = Layer.mergeAll(
    daemonOperationsLive,
    capabilitiesLive,
    callersLive,
    guidanceLive,
    linkLive,
  )

  const scope = Scope.makeUnsafe()
  openScopes.push(scope)

  const memoMap = Layer.makeMemoMapUnsafe()

  const context = Effect.runSync(Layer.buildWithMemoMap(merged, memoMap, scope))

  const daemonOperations = Context.getUnsafe(context, DaemonOperations)
  const capabilities = Context.getUnsafe(context, Capabilities)
  const callers = Context.getUnsafe(context, Callers)
  const guidance = Context.getUnsafe(context, Guidance)

  return {
    daemonOperations,
    capabilities,
    callers,
    guidance,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

const makeInvocation = (
  callers: Pick<CallersApi, "admit" | "conversation">,
  principal: string,
): Invocation =>
  Effect.runSync(
    Effect.gen(function* () {
      const caller = yield* callers.admit(Option.getOrThrow(trustedEvidence(principal)))
      const conversation = yield* callers.conversation(caller)

      const invocation: Invocation = { caller, conversation }

      return invocation
    }),
  )

const deliverRoot = (guidance: GuidanceApi, scope: Invocation["conversation"]): void =>
  Effect.runSync(
    Effect.gen(function* () {
      const doc = yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
      const delivered = yield* guidance.confirmRootDelivery(doc)

      yield* guidance.acknowledge(scope, delivered)
    }),
  )

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

type InvokeExit = Exit.Exit<Released<"client">, InvocationFailure>

const jsonOf = (exit: InvokeExit): Schema.Json => {
  if (!Exit.isSuccess(exit)) throw new Error("expected success, got failure")

  const json = releasedJson(exit.value)

  if (Option.isNone(json)) throw new Error("expected a JSON payload")

  return json.value
}

interface Harness {
  readonly services: Services
  readonly catalog: Catalog
  readonly who: Invocation
}

const makeHarness = async (
  daemon: FakeDaemon,
  installation?: Partial<DaemonInstallation>,
  options?: Parameters<typeof makeServices>[1],
): Promise<Harness> => {
  const services = makeServices(
    {
      endpoint: { socketPath: daemon.socketPath },
      auth: { apiKey: "test-key" },
      handshakeTimeoutMs: 5_000,
    },
    options,
  )

  const peer: DaemonInstallation = { peerId: "daemon-under-test", ...installation }

  const entries = await Effect.runPromise(services.daemonOperations.entries(peer))
  const catalog = await Effect.runPromise(services.capabilities.assemble(entries))
  const who = makeInvocation(services.callers, "operator")

  if (services.guidance !== undefined && installation?.guidanceRequired !== false) {
    deliverRoot(services.guidance, who.conversation)
  }

  return { services, catalog, who }
}

const invoke = (harness: Harness, id: string, input: Schema.Json): Promise<InvokeExit> =>
  Effect.runPromiseExit(
    harness.services.capabilities.invoke(harness.catalog, harness.who, id, input),
  )

const requestsFor = (daemon: FakeDaemon, method: string): ReadonlyArray<SeenRequest> =>
  daemon.requests.filter((request) => request.method === method)

const appRequests = (daemon: FakeDaemon): ReadonlyArray<SeenRequest> =>
  daemon.requests.filter((request) => request.method !== "daemon.authenticate")

const SESSIONS_REPLY: ScriptedReply = {
  result: {
    sessions: [
      {
        sessionId: "sess-1",
        hostId: "host-1",
        updatedAt: 1234567890,
        workingState: "idle",
      },
    ],
  },
}

const LISTENING = {
  list_opened: SESSIONS_REPLY,
} as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("entries assembly", () => {
  it("binds only reviewed served methods and omits session-owned, unserved and transport methods", async () => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon)

    const listed = await Effect.runPromise(
      harness.services.capabilities.available(harness.catalog, harness.who),
    )

    const ids = listed.map((entry) => entry.id)

    // A broad reviewed read and a write are present under their canonical ids.
    expect(ids).toContain("daemon_list_opened_sessions")
    expect(ids).toContain("daemon_list_models")
    expect(ids).toContain("daemon_update_session_settings")
    expect(ids).toContain("droid_update_session_settings")
    expect(ids).toContain("droid_load_session")
    expect(ids).toContain("daemon_load_session")

    // Session-owned methods are owned by the session runtime, never bound here.
    for (const id of [
      "droid_initialize_session",
      "droid_add_user_message",
      "droid_interrupt_session",
      "droid_close_session",
      "droid_request_permission",
      "droid_ask_user",
      "droid_pick_options",
      "droid_session_notification",
    ]) {
      expect(ids).not.toContain(id)
    }

    // Unserved exec reads are never advertised.
    for (const id of [
      "droid_list_skills",
      "droid_list_tools",
      "droid_list_mcp_tools",
      "droid_list_mcp_registry",
    ]) {
      expect(ids).not.toContain(id)
    }

    // The transport handshake is never a public operation.
    expect(ids).not.toContain("daemon_authenticate")

    // The catalog is broad: well over a hundred reviewed served methods.
    expect(ids.length).toBeGreaterThan(120)
  })

  it("assembles into a catalog with zero duplicate identities", async () => {
    const daemon = await fakeDaemon()

    const services = makeServices({
      endpoint: { socketPath: daemon.socketPath },
      auth: { apiKey: "test-key" },
    })

    const entries = await Effect.runPromise(
      services.daemonOperations.entries({ peerId: "daemon-under-test" }),
    )

    const ids = entries.map((entry) => entry.facts.id)

    expect(new Set(ids).size).toBe(ids.length)

    const exit = await Effect.runPromiseExit(services.capabilities.assemble(entries))

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("publishes underscore-only IDs for all Smart Factory operations and keeps dotted wire methods", async () => {
    const cases: ReadonlyArray<readonly [string, Schema.Json]> = [
      ["create_workstream", { title: "Example", goal: "Check dispatch" }],
      ["delete_workstream", { idOrSlug: "workstream-1" }],
      ["get_workstream", { idOrSlug: "workstream-1" }],
      ["hydrate_workstream_content", { workstreamId: "workstream-1" }],
      ["list_activities", {}],
      ["list_changes", {}],
      ["list_events", {}],
      ["list_signals", {}],
      ["list_workstreams", {}],
      ["mark_events_read", { workstreamIdOrSlug: "workstream-1" }],
      ["mark_events_unread", { workstreamIdOrSlug: "workstream-1", eventIds: ["event-1"] }],
      ["publish_workstream_content", { workstreamId: "workstream-1", expectedGeneration: 1 }],
      ["resolve_activity_review", { activityId: "activity-1", decision: "approved" }],
      ["update_workstream", { idOrSlug: "workstream-1" }],
    ]

    const daemon = await fakeDaemon((request) =>
      request.method.startsWith("daemon.sf.")
        ? { error: { code: -32602, message: "fixture rejection" } }
        : undefined,
    )

    const harness = await makeHarness(daemon, {
      servedMethods: new Set(cases.map(([name]) => `daemon.sf.${name}`)),
    })

    const listed = await Effect.runPromise(
      harness.services.capabilities.available(harness.catalog, harness.who),
    )

    expect(listed.map((entry) => entry.id).sort()).toEqual(
      cases.map(([name]) => `daemon_sf_${name}`).sort(),
    )

    for (const [name, params] of cases) {
      const exit = await invoke(harness, `daemon_sf_${name}`, params)

      expect(expectFailure(exit)).toBeInstanceOf(PeerFailure)
    }

    expect(appRequests(daemon).map(({ method, params }) => ({ method, params }))).toEqual(
      cases.map(([name, params]) => ({ method: `daemon.sf.${name}`, params })),
    )
  })

  it("restricts binding to the peer's served-method subset when specified", async () => {
    const daemon = await fakeDaemon()

    const harness = await makeHarness(daemon, {
      servedMethods: new Set(["daemon.list_opened_sessions", "daemon.list_models"]),
    })

    const listed = await Effect.runPromise(
      harness.services.capabilities.available(harness.catalog, harness.who),
    )

    const ids = listed.map((entry) => entry.id).sort()

    expect(ids).toEqual(["daemon_list_models", "daemon_list_opened_sessions"])
  })

  it("fails with UnsupportedBinding when the peer requests a method with no reviewed served binding", async () => {
    const daemon = await fakeDaemon()

    const services = makeServices({
      endpoint: { socketPath: daemon.socketPath },
      auth: { apiKey: "test-key" },
    })

    for (const method of [
      "daemon.nonexistent_method",
      "droid.initialize_session",
      "droid.list_skills",
    ]) {
      const exit = await Effect.runPromiseExit(
        services.daemonOperations.entries({
          peerId: "daemon-under-test",
          servedMethods: new Set([method]),
        }),
      )

      const error = expectFailure(exit)

      expect(error._tag).toBe("UnsupportedBinding")
    }
  })
})

describe("read operations end to end", () => {
  it("executes daemon_list_opened_sessions against the fake daemon through capabilities.invoke", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") return LISTENING.list_opened

      return undefined
    })

    const harness = await makeHarness(daemon)
    const exit = await invoke(harness, "daemon_list_opened_sessions", {})

    const json = jsonOf(exit)

    expect(json).toEqual(LISTENING.list_opened.result)
    expect(requestsFor(daemon, "daemon.list_opened_sessions")).toHaveLength(1)
  })

  it("executes daemon_list_models end to end and marks read operations as safe reads", async () => {
    const models = { models: [{ id: "model-1" }] }

    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_models") return { result: models }

      return undefined
    })

    const harness = await makeHarness(daemon)

    const description = await Effect.runPromise(
      harness.services.capabilities.describe(harness.catalog, harness.who, "daemon_list_models"),
    )

    expect(description.annotations.readOnlyHint).toBe(true)
    expect(description.family).toBe("daemon")

    const exit = await invoke(harness, "daemon_list_models", {})

    expect(jsonOf(exit)).toEqual(models)
    expect(requestsFor(daemon, "daemon.list_models")).toHaveLength(1)
  })

  it("a write operation carries no_retry replay facts and write annotations", async () => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon)

    const description = await Effect.runPromise(
      harness.services.capabilities.describe(
        harness.catalog,
        harness.who,
        "daemon_update_session_settings",
      ),
    )

    expect(description.annotations.readOnlyHint).toBe(false)
    expect(description.id).toBe("daemon_update_session_settings")
  })
})

describe("daemon write annotations", () => {
  it.each([
    ["daemon_apply_automation_config", true],
    ["daemon_apply_user_preferences", true],
    ["daemon_archive_session", true],
    ["daemon_close_session", false],
    ["daemon_compact_session", false],
    ["daemon_execute_rewind", true],
    ["daemon_fork_session", false],
    ["daemon_git_commit", false],
    ["daemon_interrupt_session", false],
    ["daemon_kill_worker_session", true],
    ["daemon_resolve_user_preferences", false],
    ["daemon_sf_hydrate_workstream_content", false],
    ["daemon_update_mcp_config", true],
  ] as const)("describes %s as a write (destructive: %s)", async (id, destructiveHint) => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon)

    const description = await Effect.runPromise(
      harness.services.capabilities.describe(harness.catalog, harness.who, id),
    )

    expect(description.annotations).toMatchObject({ readOnlyHint: false, destructiveHint })
  })
})

describe("daemon rejections", () => {
  it.each([
    [-32601, "daemon_method_unsupported"],
    [-32602, "daemon_rejected_-32602"],
  ])("maps RPC rejection %i to %s", async (rpcCode, code) => {
    const daemon = await fakeDaemon((request) =>
      request.method === "daemon.list_opened_sessions"
        ? { error: { code: rpcCode, message: "rejected" } }
        : undefined,
    )

    const harness = await makeHarness(daemon)
    const exit = await invoke(harness, "daemon_list_opened_sessions", {})

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(PeerFailure)
    expect(failure).toMatchObject({ code })
    expect(requestsFor(daemon, "daemon.list_opened_sessions")).toHaveLength(1)
  })
})

describe("fail-closed unverifiable authority", () => {
  it("daemon_load_session fails with authority_unverifiable before any RPC dispatch", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.load_session") return { result: {} }

      return undefined
    })

    const harness = await makeHarness(daemon)

    const exit = await invoke(harness, "daemon_load_session", {
      sessionId: "sess-1",
      token: "tok-fixture",
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("authority_unverifiable")

    // Zero application RPCs: the refusal happened before any dispatch.
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("droid_load_session fails closed the same way before dispatch", async () => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon)

    const exit = await invoke(harness, "droid_load_session", {
      sessionId: "sess-1",
      token: "tok-fixture",
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("authority_unverifiable")
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("queued work fails closed before any dispatch", async () => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon)

    const exit = await invoke(harness, "daemon_add_user_message", {
      messageId: "msg-1",
      sessionId: "sess-1",
      text: "queued prompt",
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("authority_unverifiable")
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("permits unverified load through operator passthrough without reporting it verified", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.load_session") return { result: { loaded: true } }

      return undefined
    })

    const harness = await makeHarness(
      daemon,
      { allowUnverifiedDaemonAuthority: true },
      { allowUnverifiedDaemonAuthority: true },
    )

    const exit = await invoke(harness, "daemon_load_session", {
      sessionId: "sess-1",
      token: "tok-fixture",
    })

    expect(jsonOf(exit)).toEqual({ loaded: true })
    expect(requestsFor(daemon, "daemon.load_session")).toHaveLength(1)
  })

  it("explicit excess autonomy still fails with Denied under the operator passthrough", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.load_session") return { result: {} }

      return undefined
    })

    // The operator passthrough is on, but the ceiling is medium: explicit
    // high-level authority in the load request is a known denial, never
    // bypassed and never dispatched.
    const harness = await makeHarness(
      daemon,
      { allowUnverifiedDaemonAuthority: true },
      { allowUnverifiedDaemonAuthority: true, maxAutonomy: "medium" },
    )

    const exit = await invoke(harness, "daemon_load_session", {
      sessionId: "sess-1",
      token: "tok-fixture",
      skipPermissionsUnsafe: true,
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("Denied")
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("queued work passes through the operator opt-in when enabled", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.add_user_message") return { result: { queued: true } }

      return undefined
    })

    const harness = await makeHarness(
      daemon,
      { allowUnverifiedDaemonAuthority: true },
      { allowUnverifiedDaemonAuthority: true },
    )

    const exit = await invoke(harness, "daemon_add_user_message", {
      messageId: "msg-1",
      sessionId: "sess-1",
      text: "queued prompt",
    })

    expect(jsonOf(exit)).toEqual({ queued: true })
    expect(requestsFor(daemon, "daemon.add_user_message")).toHaveLength(1)
  })
})

describe("initialize narrowing", () => {
  it("materializes omitted initialize authority from one defaults snapshot onto the wire", async () => {
    const daemon = await fakeDaemon((request): ScriptedReply | undefined => {
      if (request.method === "daemon.get_default_settings") {
        return { result: { autonomyLevel: "low", autonomyMode: "auto-low" } }
      }

      if (request.method === "daemon.initialize_session") return { result: { sessionId: "s-1" } }

      return undefined
    })

    // Ceiling high: the observed within-cap defaults carry through unchanged.
    const harness = await makeHarness(daemon)

    const exit = await invoke(harness, "daemon_initialize_session", {
      machineId: "machine-1",
      cwd: "/workspace",
      token: "tok-fixture",
    })

    expect(Exit.isSuccess(exit)).toBe(true)

    const snapshots = requestsFor(daemon, "daemon.get_default_settings")

    // Exactly one snapshot read serves the whole invocation.
    expect(snapshots).toHaveLength(1)

    const initialize = requestsFor(daemon, "daemon.initialize_session")

    expect(initialize).toHaveLength(1)

    const params = initialize[0]?.params

    expect(params).toMatchObject({
      machineId: "machine-1",
      cwd: "/workspace",
      autonomyLevel: "low",
      autonomyMode: "auto-low",
    })
  })

  it("pins omitted skipPermissionsUnsafe to false on the wire below high", async () => {
    const daemon = await fakeDaemon((request): ScriptedReply | undefined => {
      if (request.method === "daemon.get_default_settings") {
        return { result: { autonomyLevel: "low", autonomyMode: "auto-low" } }
      }

      if (request.method === "daemon.initialize_session") return { result: { sessionId: "s-1" } }

      return undefined
    })

    const harness = await makeHarness(daemon, undefined, { maxAutonomy: "medium" })

    const exit = await invoke(harness, "daemon_initialize_session", {
      machineId: "machine-1",
      cwd: "/workspace",
      token: "tok-fixture",
    })

    expect(Exit.isSuccess(exit)).toBe(true)

    const initialize = requestsFor(daemon, "daemon.initialize_session")

    expect(initialize[0]?.params).toMatchObject({ skipPermissionsUnsafe: false })
  })

  it("clamps inherited initialize authority above the ceiling", async () => {
    const daemon = await fakeDaemon((request): ScriptedReply | undefined => {
      if (request.method === "daemon.get_default_settings") {
        return { result: { autonomyLevel: "high", autonomyMode: "auto-high" } }
      }

      if (request.method === "daemon.initialize_session") return { result: { sessionId: "s-1" } }

      return undefined
    })

    const harness = await makeHarness(daemon, undefined, { maxAutonomy: "medium" })

    const exit = await invoke(harness, "daemon_initialize_session", {
      machineId: "machine-1",
      cwd: "/workspace",
      token: "tok-fixture",
    })

    expect(Exit.isSuccess(exit)).toBe(true)

    const initialize = requestsFor(daemon, "daemon.initialize_session")

    expect(initialize[0]?.params).toMatchObject({
      autonomyLevel: "medium",
      autonomyMode: "auto-medium",
      skipPermissionsUnsafe: false,
    })
  })

  it("explicit skipPermissionsUnsafe below high fails with Denied before any dispatch", async () => {
    const daemon = await fakeDaemon((request): ScriptedReply | undefined => {
      if (request.method === "daemon.get_default_settings") {
        return { result: { autonomyLevel: "low", autonomyMode: "auto-low" } }
      }

      if (request.method === "daemon.initialize_session") return { result: { sessionId: "s-1" } }

      return undefined
    })

    const harness = await makeHarness(daemon, undefined, { maxAutonomy: "medium" })

    const exit = await invoke(harness, "daemon_initialize_session", {
      machineId: "machine-1",
      cwd: "/workspace",
      token: "tok-fixture",
      skipPermissionsUnsafe: true,
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("Denied")
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("explicit excess autonomy on initialize fails with Denied before any dispatch", async () => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon, undefined, { maxAutonomy: "low" })

    const exit = await invoke(harness, "daemon_initialize_session", {
      machineId: "machine-1",
      cwd: "/workspace",
      token: "tok-fixture",
      autonomyLevel: "high",
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("Denied")
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("never writes persistent defaults to implement an initialize request", async () => {
    const daemon = await fakeDaemon((request): ScriptedReply | undefined => {
      if (request.method === "daemon.get_default_settings") {
        return { result: { autonomyLevel: "low", autonomyMode: "auto-low" } }
      }

      if (request.method === "daemon.initialize_session") return { result: { sessionId: "s-1" } }

      if (request.method === "daemon.update_session_defaults") return { result: { success: true } }

      return undefined
    })

    const harness = await makeHarness(daemon)

    const exit = await invoke(harness, "daemon_initialize_session", {
      machineId: "machine-1",
      cwd: "/workspace",
      token: "tok-fixture",
    })

    expect(Exit.isSuccess(exit)).toBe(true)

    // No persistent-defaults write ever rides along with a single request.
    expect(requestsFor(daemon, "daemon.update_session_defaults")).toHaveLength(0)
    expect(requestsFor(daemon, "daemon.update_session_settings")).toHaveLength(0)
  })
})

describe("uncertain delivery on mutation", () => {
  it("fails with uncertain delivery and never replays the mutation", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.update_session_settings") return { drop: true }

      return undefined
    })

    const harness = await makeHarness(daemon)

    const exit = await invoke(harness, "daemon_update_session_settings", {
      sessionId: "sess-1",
      modelId: "model-1",
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("DeliveryUncertain")

    // Exactly one dispatch: a mutating operation is never resent.
    expect(requestsFor(daemon, "daemon.update_session_settings")).toHaveLength(1)
  })

  it("a pure read replays after handoff uncertainty and succeeds on the retry", async () => {
    let count = 0

    const daemon = await fakeDaemon((request) => {
      if (request.method !== "daemon.list_opened_sessions") return undefined
      count += 1

      if (count === 1) return { drop: true }

      return LISTENING.list_opened
    })

    const harness = await makeHarness(daemon)
    const exit = await invoke(harness, "daemon_list_opened_sessions", {})

    expect(jsonOf(exit)).toEqual(LISTENING.list_opened.result)
    expect(requestsFor(daemon, "daemon.list_opened_sessions")).toHaveLength(2)
  })
})

describe("probeExisting", () => {
  it("delegates to the link probe without spawning a daemon", async () => {
    const daemon = await fakeDaemon()

    const services = makeServices({
      endpoint: { socketPath: daemon.socketPath },
      auth: { apiKey: "test-key" },
    })

    const health = await Effect.runPromise(services.daemonOperations.probeExisting())

    expect(health.reachable).toBe(true)
    expect(health.ownership).toBe("borrowed")

    // The probe dials and authenticates what exists; no application RPC runs.
    expect(appRequests(daemon)).toHaveLength(0)
    expect(requestsFor(daemon, "daemon.authenticate").length).toBeGreaterThan(0)
  })

  it("fails with ProbeUnavailable when nothing is listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-operations-test-"))
    dirs.push(dir)

    const services = makeServices({
      endpoint: { socketPath: join(dir, "absent.sock") },
      auth: { apiKey: "test-key" },
      handshakeTimeoutMs: 500,
      connectTimeoutMs: 200,
    })

    const exit = await Effect.runPromiseExit(services.daemonOperations.probeExisting())
    const error = expectFailure(exit)

    expect(error._tag).toBe("ProbeUnavailable")
  })
})

describe("facets", () => {
  it("fails with DaemonFacetUnsupported when the installation serves no methods", async () => {
    const daemon = await fakeDaemon()

    const services = makeServices({
      endpoint: { socketPath: daemon.socketPath },
      auth: { apiKey: "test-key" },
    })

    const exit = await Effect.runPromiseExit(
      services.daemonOperations.facets({ peerId: "daemon-under-test", servedMethods: new Set() }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(DaemonFacetUnsupported)
  })

  it("exposes the probe facet for a serving installation and runs it against the peer", async () => {
    const daemon = await fakeDaemon()

    const services = makeServices({
      endpoint: { socketPath: daemon.socketPath },
      auth: { apiKey: "test-key" },
    })

    const facets = await Effect.runPromise(
      services.daemonOperations.facets({ peerId: "daemon-under-test" }),
    )

    expect(facets).toHaveLength(1)
    expect(facets[0]?.kind).toBe("probe")

    const health = await Effect.runPromise(facets[0]?.run() ?? Effect.die(new Error("no facet")))

    expect(health.reachable).toBe(true)
  })
})

describe("guidance prerequisite", () => {
  it("blocks operations at the guidance gate until the root is delivered for that conversation", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") return LISTENING.list_opened

      return undefined
    })

    const services = makeServices(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      { guidanceRequired: true },
    )

    const entries = await Effect.runPromise(
      services.daemonOperations.entries({ peerId: "daemon-under-test", guidanceRequired: true }),
    )

    const catalog = await Effect.runPromise(services.capabilities.assemble(entries))
    const who = makeInvocation(services.callers, "operator")

    const blocked = await Effect.runPromiseExit(
      services.capabilities.invoke(catalog, who, "daemon_list_opened_sessions", {}),
    )

    expect(expectFailure(blocked)._tag).toBe("GuidanceRequired")
    expect(appRequests(daemon)).toHaveLength(0)

    deliverRoot(services.guidance, who.conversation)

    const allowed = await Effect.runPromiseExit(
      services.capabilities.invoke(catalog, who, "daemon_list_opened_sessions", {}),
    )

    expect(Exit.isSuccess(allowed)).toBe(true)
  })
})

describe("settings autonomy enforcement", () => {
  it("explicit excess level on update_session_settings fails with Denied before dispatch", async () => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon, undefined, { maxAutonomy: "low" })

    const exit = await invoke(harness, "daemon_update_session_settings", {
      sessionId: "sess-1",
      autonomyLevel: "high",
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("Denied")
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("explicit auto-high mode counts as high-level authority for the denial check", async () => {
    const daemon = await fakeDaemon()
    const harness = await makeHarness(daemon, undefined, { maxAutonomy: "medium" })

    const exit = await invoke(harness, "daemon_update_session_settings", {
      sessionId: "sess-1",
      autonomyMode: "auto-high",
    })

    const error = expectFailure(exit)

    expect(error._tag).toBe("Denied")
    expect(appRequests(daemon)).toHaveLength(0)
  })

  it("a within-ceiling settings update dispatches with the exact params", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.update_session_settings") return { result: { ok: true } }

      return undefined
    })

    const harness = await makeHarness(daemon, undefined, { maxAutonomy: "medium" })

    const exit = await invoke(harness, "daemon_update_session_settings", {
      sessionId: "sess-1",
      autonomyLevel: "low",
    })

    expect(Exit.isSuccess(exit)).toBe(true)

    const sent = requestsFor(daemon, "daemon.update_session_settings")

    expect(sent).toHaveLength(1)
    expect(sent[0]?.params).toMatchObject({ sessionId: "sess-1", autonomyLevel: "low" })
  })
})
