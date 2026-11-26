import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import { Artifacts, artifactsLayer, parseArtifactRef } from "../../src/artifacts/index.ts"
import { Authority, authorityLayer } from "../../src/authority/index.ts"
import type { Demand } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { CallersApi, Conversation, TargetRef } from "../../src/caller/index.ts"
import {
  Capabilities,
  capabilitiesLayer,
  InvalidInput,
  PeerFailure,
} from "../../src/capabilities/index.ts"
import type {
  BoundOperation,
  Definition,
  Invocation,
  OperationFamily,
} from "../../src/capabilities/index.ts"
import { Disclosure, disclosureLayer, ReleasePayload } from "../../src/disclosure/index.ts"
import { Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import type { GuidanceApi } from "../../src/guidance/index.ts"
import { CURRENT_GUIDE_EDITION } from "../../src/guidance/index.ts"
import {
  buildRoster,
  CallFailure,
  createView,
  DiscoveryPage,
  InvalidBatch,
  Presented,
  Presentation,
  presentationLayer,
} from "../../src/presentation/index.ts"
import type { OperationRoster } from "../../src/presentation/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeServices = (options?: {
  readonly maxAutonomy?: "off" | "low" | "medium" | "high"
  readonly protectedValues?: ReadonlyArray<string>
  readonly artifactOptions?: {
    readonly singleValueByteLimit?: number
    readonly aggregateByteLimit?: number
  }
}) => {
  const disclosureLive = disclosureLayer({ protectedValues: options?.protectedValues })
  const callersLive = callersLayer({})
  const authorityLive = authorityLayer({ maxAutonomy: options?.maxAutonomy ?? "high" })
  const guidanceLive = guidanceLayer({})

  const baseDeps = Layer.mergeAll(callersLive, authorityLive, guidanceLive, disclosureLive)
  const capabilitiesLive = Layer.provideMerge(capabilitiesLayer, baseDeps)
  const artifactsLive = Layer.provideMerge(artifactsLayer(options?.artifactOptions), disclosureLive)

  const presentationLive = Layer.provideMerge(
    presentationLayer,
    Layer.merge(capabilitiesLive, artifactsLive),
  )

  const merged = Layer.mergeAll(
    presentationLive,
    capabilitiesLive,
    artifactsLive,
    callersLive,
    authorityLive,
    guidanceLive,
    disclosureLive,
  )

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const presentation = yield* Presentation
        const capabilities = yield* Capabilities
        const artifacts = yield* Artifacts
        const callers = yield* Callers
        const authority = yield* Authority
        const guidance = yield* Guidance
        const disclosure = yield* Disclosure

        return {
          presentation,
          capabilities,
          artifacts,
          callers,
          authority,
          guidance,
          disclosure,
        }
      }),
      merged,
    ),
  )
}

type Services = ReturnType<typeof makeServices>

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

const deliverRoot = (guidance: GuidanceApi, scope: Conversation): void =>
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

// ---------------------------------------------------------------------------
// Fixture operations
// ---------------------------------------------------------------------------

const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

const readAnnotations = { ...annotations, readOnlyHint: true }
const destructiveAnnotations = { ...annotations, destructiveHint: true }

const systemTarget: TargetRef = { kind: "system", id: "system" }

interface FixtureSpec {
  readonly id: string
  readonly family: OperationFamily
  readonly description: string
  readonly aliases?: ReadonlyArray<string>
  readonly readOnly?: boolean
  readonly destructive?: boolean
  readonly output: Schema.Json | ((input: Schema.Json) => Schema.Json)
  readonly prerequisite?: { readonly edition: "droid-v1" }
  readonly performCount?: { count: number }
}

const inputSchemaObject = { type: "object" } satisfies { readonly [key: string]: Schema.Json }

const fixture = (spec: FixtureSpec): Definition<Schema.Json, Schema.Json> => {
  const baseAnnotations = spec.readOnly === true ? readAnnotations : annotations
  const finalAnnotations = spec.destructive === true ? destructiveAnnotations : baseAnnotations

  const effect: "read" | "write" = spec.readOnly === true ? "read" : "write"
  const replay: "safe_read" | "no_retry" = spec.readOnly === true ? "safe_read" : "no_retry"

  const baseFacts = {
    id: spec.id,
    family: spec.family,
    description: spec.description,
    inputSchema: inputSchemaObject,
    effect,
    replay,
    annotations: finalAnnotations,
  }

  const withAliases =
    spec.aliases !== undefined ? { ...baseFacts, aliases: spec.aliases } : baseFacts

  const facts =
    spec.prerequisite !== undefined
      ? { ...withAliases, prerequisite: spec.prerequisite }
      : withAliases

  return {
    facts,
    decode: (input) => Effect.succeed(input),
    target: () => systemTarget,
    demand: (): Demand => ({ effect: "read" }),
    perform: (_grant, input) => {
      if (spec.performCount !== undefined) spec.performCount.count += 1

      const outputValue = spec.output

      if (Predicate.isFunction(outputValue)) {
        // SAFETY: FixtureSpec's output union is either a Json value or a
        // function producing one; the predicate just established the
        // function arm, whose parameter and return types are fixed by the
        // union member.
        return Effect.succeed((outputValue as (input: Schema.Json) => Schema.Json)(input))
      }

      return Effect.succeed(outputValue)
    },
    classify: (_input, output) => ({
      payload: ReleasePayload.JsonValue({ value: output }),
    }),
  }
}

interface BoundFixtures {
  readonly entries: ReadonlyArray<BoundOperation>
  readonly roster: OperationRoster
}

const bindFixtures = (services: Services, specs: ReadonlyArray<FixtureSpec>): BoundFixtures => {
  const entries = specs.map((spec) => services.capabilities.bind(fixture(spec)))
  const catalog = Effect.runSync(services.capabilities.assemble(entries))

  return { entries, roster: buildRoster(catalog, entries) }
}

const sessionFixtures: ReadonlyArray<FixtureSpec> = [
  {
    id: "server_info",
    family: "server",
    description: "Server information. Read-only.",
    readOnly: true,
    output: { name: "droid" },
  },
  {
    id: "skill_read",
    family: "skill",
    description: "Read a skill. Guidance first.",
    readOnly: true,
    output: { skill: "x" },
  },
  {
    id: "session_create",
    family: "session",
    description: "Create a session. Writes state.",
    output: { sessionId: "s1" },
  },
  {
    id: "session_stream",
    family: "session",
    description: "Stream a session.",
    output: { ok: true },
  },
  {
    id: "session_events",
    family: "session",
    description: "Read session events. Waiting.",
    readOnly: true,
    output: { events: [] },
  },
  {
    id: "session_interrupt",
    family: "session",
    description: "Interrupt a session.",
    output: { ok: true },
  },
  {
    id: "session_close",
    family: "session",
    description: "Close a session.",
    output: { closed: true },
  },
  {
    id: "session_list",
    family: "session",
    description: "List sessions. Read-only.",
    readOnly: true,
    output: { sessions: [] },
  },
  {
    id: "session_respond_permission",
    family: "session",
    description: "Respond to permission.",
    output: { ok: true },
  },
  {
    id: "session_answer_question",
    family: "session",
    description: "Answer a question.",
    output: { ok: true },
  },
  {
    id: "session_pick_options",
    family: "session",
    description: "Pick options.",
    output: { ok: true },
  },
  {
    id: "session_run",
    family: "session",
    description: "Run a session once.",
    output: { done: true },
  },
  {
    id: "session_update_settings",
    family: "session",
    description: "Update session settings.",
    output: { ok: true },
  },
]

const daemonFixtures: ReadonlyArray<FixtureSpec> = [
  {
    id: "daemon_list_models",
    family: "daemon",
    description: "List daemon models. Read-only query.",
    readOnly: true,
    output: { models: [] },
  },
  {
    id: "daemon_initialize",
    family: "daemon",
    description: "Initialize the daemon. Mutating and destructive.",
    destructive: true,
    output: { ok: true },
  },
]

const hostedFixtures: ReadonlyArray<FixtureSpec> = [
  {
    id: "rest_computer_list",
    family: "rest",
    description: "List hosted computers. Read-only.",
    readOnly: true,
    output: { computers: [] },
  },
]

const contextFixtures: ReadonlyArray<FixtureSpec> = [
  {
    id: "context_document_get",
    family: "context",
    description: "Get a context document. Read-only.",
    readOnly: true,
    output: { doc: {} },
  },
]

const allFixtures: ReadonlyArray<FixtureSpec> = [
  ...sessionFixtures,
  ...daemonFixtures,
  ...hostedFixtures,
  ...contextFixtures,
]

const encodeLength = (text: string): number => new TextEncoder().encode(text).length

const run = <A, E>(program: Effect.Effect<A, E, never>): Exit.Exit<A, E> =>
  Effect.runSyncExit(program)

const succeed = <A, E>(program: Effect.Effect<A, E, never>): A => {
  const exit = run(program)

  if (!Exit.isSuccess(exit)) throw new Error("expected success, got: " + JSON.stringify(exit))

  return exit.value
}

const jsonText = (value: Schema.Json): string => JSON.stringify(value)

// ---------------------------------------------------------------------------
// advertise: compact vs full
// ---------------------------------------------------------------------------

describe("advertise", () => {
  it("compact advertises only installed direct tools plus the 5 dispatch tools, with dynamically derived counts", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, allFixtures)

    const view = createView({ roster, profile: "compact" })
    const inventory = succeed(services.presentation.advertise(view, who))

    // 11 direct tools are installed in this fixture + 5 dispatch tools
    expect(inventory.toolCount).toBe(16)
    expect(inventory.operationCount).toBe(allFixtures.length)

    const directNames = inventory.tools.filter((tool) => tool.direct).map((tool) => tool.name)

    expect(directNames).toHaveLength(11)
    expect(directNames).toContain("session_create")
    expect(directNames).not.toContain("session_run")
    expect(directNames).not.toContain("daemon_list_models")

    const dispatchNames = inventory.tools.filter((tool) => !tool.direct).map((tool) => tool.name)

    expect(dispatchNames).toEqual([
      "tools_search",
      "tools_describe",
      "tool_call",
      "batch",
      "result_read",
    ])

    // There is no full toolkit beneath compact: undiscovered operations are
    // never first-class entries.
    const advertised = inventory.tools.map((tool) => tool.name)

    expect(advertised).not.toContain("daemon_initialize")
    expect(advertised).not.toContain("rest_computer_list")

    // Family counts derived dynamically: 13 entries in the session fixture
    // array split across server (1), skill (1) and session (11).
    expect(inventory.familyCounts.session).toBe(11)
    expect(inventory.familyCounts.server).toBe(1)
    expect(inventory.familyCounts.skill).toBe(1)
    expect(inventory.familyCounts.daemon).toBe(2)
    expect(inventory.familyCounts.rest).toBe(1)
    expect(inventory.familyCounts.context).toBe(1)
    expect(inventory.providerKinds).toEqual(["daemon", "hosted", "context"])
  })

  it("full advertises every installed operation directly and no dispatch tools", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, allFixtures)

    const view = createView({ roster, profile: "full" })
    const inventory = succeed(services.presentation.advertise(view, who))

    expect(inventory.toolCount).toBe(allFixtures.length)
    expect(inventory.operationCount).toBe(allFixtures.length)

    const names = inventory.tools.map((tool) => tool.name)

    expect(names).toContain("daemon_initialize")
    expect(names).toContain("rest_computer_list")
    expect(names).not.toContain("tools_search")
    expect(names).not.toContain("tool_call")
    expect(names).not.toContain("batch")
    expect(inventory.tools.every((tool) => tool.direct)).toBe(true)
  })

  it("counts adjust automatically when an optional provider contributes nothing", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    // Omit daemon, hosted and context providers entirely.
    const { roster } = bindFixtures(services, sessionFixtures)

    const view = createView({ roster, profile: "compact" })
    const inventory = succeed(services.presentation.advertise(view, who))

    expect(inventory.operationCount).toBe(sessionFixtures.length)
    expect(inventory.familyCounts.daemon).toBe(0)
    expect(inventory.familyCounts.rest).toBe(0)
    expect(inventory.familyCounts.context).toBe(0)
    expect(inventory.providerKinds).toEqual([])
    // The same 11 direct tools + 5 dispatch.
    expect(inventory.toolCount).toBe(16)
  })

  it("drops direct tools whose operation is not installed", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    // Only 2 of the 11 direct operations installed.
    const { roster } = bindFixtures(services, [sessionFixtures[0]!, sessionFixtures[2]!])

    const view = createView({ roster, profile: "compact" })
    const inventory = succeed(services.presentation.advertise(view, who))

    expect(inventory.toolCount).toBe(2 + 5)

    const directNames = inventory.tools.filter((tool) => tool.direct).map((tool) => tool.name)

    expect(directNames).toEqual(["server_info", "session_create"])
  })
})

// ---------------------------------------------------------------------------
// describe: search and names
// ---------------------------------------------------------------------------

describe("describe search", () => {
  const setup = () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, allFixtures)
    const view = createView({ roster, profile: "compact" })

    return { services, who, view }
  }

  it("ranks a name hit above a description-only hit", () => {
    const { services, who, view } = setup()

    const page = succeed(services.presentation.describe(view, who, { query: "models" }))

    expect(DiscoveryPage.$is("Search")(page)).toBe(true)

    if (!DiscoveryPage.$is("Search")(page)) return

    // "daemon_list_models" hits the name; nothing else mentions models in the id.
    expect(page.entries[0]?.name).toBe("daemon_list_models")
  })

  it("requires every query token to hit somewhere", () => {
    const { services, who, view } = setup()

    const page = succeed(services.presentation.describe(view, who, { query: "session list" }))

    if (!DiscoveryPage.$is("Search")(page)) throw new Error("expected Search page")

    const names = page.entries.map((entry) => entry.name)

    expect(names).toContain("session_list")
    // An entry matching neither token must be absent.
    expect(names).not.toContain("daemon_initialize")
  })

  it("filters by family", () => {
    const { services, who, view } = setup()

    const page = succeed(services.presentation.describe(view, who, { family: "daemon" }))

    if (!DiscoveryPage.$is("Search")(page)) throw new Error("expected Search page")

    expect(page.total).toBe(2)
    expect(page.entries.every((entry) => entry.family === "daemon")).toBe(true)
  })

  it("filters by readOnly", () => {
    const { services, who, view } = setup()

    const reads = succeed(services.presentation.describe(view, who, { readOnly: true }))

    if (!DiscoveryPage.$is("Search")(reads)) throw new Error("expected Search page")

    expect(reads.entries.every((entry) => entry.readOnly)).toBe(true)
    expect(reads.entries.some((entry) => entry.name === "daemon_initialize")).toBe(false)

    const writes = succeed(services.presentation.describe(view, who, { readOnly: false }))

    if (!DiscoveryPage.$is("Search")(writes)) throw new Error("expected Search page")

    expect(writes.entries.every((entry) => !entry.readOnly)).toBe(true)
  })

  it("paginates with offset, limit and nextOffset", () => {
    const { services, who, view } = setup()

    const first = succeed(services.presentation.describe(view, who, { limit: 5, offset: 0 }))

    if (!DiscoveryPage.$is("Search")(first)) throw new Error("expected Search page")

    expect(first.total).toBe(allFixtures.length)
    expect(first.entries).toHaveLength(5)
    expect(first.nextOffset).toBe(5)

    const second = succeed(services.presentation.describe(view, who, { limit: 5, offset: 5 }))

    if (!DiscoveryPage.$is("Search")(second)) throw new Error("expected Search page")

    expect(second.entries).toHaveLength(5)
    expect(second.entries.map((entry) => entry.name)).not.toEqual(
      first.entries.map((entry) => entry.name),
    )

    // Page to the end: nextOffset becomes null.
    const last = succeed(services.presentation.describe(view, who, { limit: 50, offset: 0 }))

    if (!DiscoveryPage.$is("Search")(last)) throw new Error("expected Search page")

    expect(last.entries).toHaveLength(allFixtures.length)
    expect(last.nextOffset).toBeNull()
  })

  it("clamps limit to the 1..50 range", () => {
    const { services, who, view } = setup()

    const page = succeed(services.presentation.describe(view, who, { limit: 200 }))

    if (!DiscoveryPage.$is("Search")(page)) throw new Error("expected Search page")

    // Clamped to at most 50; the fixture has fewer entries than that.
    expect(page.entries.length).toBeLessThanOrEqual(50)
  })
})

describe("describe by names", () => {
  it("returns full details for known names and lists unknown ones", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, allFixtures)
    const view = createView({ roster, profile: "compact" })

    const page = succeed(
      services.presentation.describe(view, who, {
        names: ["daemon_initialize", "does_not_exist"],
      }),
    )

    if (!DiscoveryPage.$is("Describe")(page)) throw new Error("expected Describe page")

    expect(page.entries).toHaveLength(1)
    expect(page.unknown).toEqual(["does_not_exist"])

    const detail = page.entries[0]

    expect(detail?.name).toBe("daemon_initialize")
    expect(detail?.description).toContain("Initialize the daemon")
    expect(detail?.inputSchema).toEqual({ type: "object" })
    expect(detail?.annotations.destructiveHint).toBe(true)
    expect(detail?.effect).toBe("write")
    expect(detail?.replay).toBe("no_retry")
    expect(detail?.family).toBe("daemon")
  })

  it("resolves view aliases to canonical names", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, daemonFixtures)

    const view = createView({
      roster,
      profile: "compact",
      aliases: { list_models: "daemon_list_models" },
    })

    const page = succeed(services.presentation.describe(view, who, { names: ["list_models"] }))

    if (!DiscoveryPage.$is("Describe")(page)) throw new Error("expected Describe page")

    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.name).toBe("daemon_list_models")
    expect(page.unknown).toEqual([])
  })

  it("refuses more than 20 names", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, allFixtures)
    const view = createView({ roster, profile: "compact" })

    const exit = run(
      services.presentation.describe(view, who, {
        names: Array.from({ length: 21 }, (_, index) => "op_" + String(index)),
      }),
    )

    expect(Predicate.isTagged("ViewRefused")(expectFailure(exit))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// call: direct vs discovered parity
// ---------------------------------------------------------------------------

describe("call", () => {
  it("returns Inline for a small result", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, daemonFixtures)
    const view = createView({ roster, profile: "compact" })

    const presented = succeed(
      services.presentation.call(view, who, { name: "daemon_list_models", arguments: {} }),
    )

    expect(Presented.$is("Inline")(presented)).toBe(true)

    if (Presented.$is("Inline")(presented)) {
      expect(presented.value).toEqual({ models: [] })
    }
  })

  it("direct and discovered calls enter the same pipeline with identical results", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, daemonFixtures)
    const view = createView({ roster, profile: "full" })

    const direct = succeed(
      services.presentation.call(view, who, { name: "daemon_list_models", arguments: {} }),
    )

    const compact = createView({ roster, profile: "compact" })

    const discovered = succeed(
      services.presentation.call(view, who, { name: "daemon_list_models", arguments: {} }),
    )

    expect(direct).toEqual(discovered)
    expect(compact.profile).toBe("compact")
  })

  it("resolves view aliases before dispatch", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, daemonFixtures)

    const view = createView({
      roster,
      profile: "compact",
      aliases: { models: "daemon_list_models" },
    })

    const presented = succeed(services.presentation.call(view, who, { name: "models" }))

    expect(Presented.$is("Inline")(presented)).toBe(true)
  })

  it("unknown names fail with unknown_operation and use unserved replacement hints", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, daemonFixtures)

    const view = createView({
      roster,
      profile: "compact",
      unservedHints: { daemon_exec: ["daemon_initialize", "session_create"] },
    })

    const missing = run(services.presentation.call(view, who, { name: "nope_missing" }))
    const failure = expectFailure(missing)

    expect(Predicate.isTagged("CallFailure")(failure)).toBe(true)

    if (failure instanceof CallFailure) {
      expect(failure.code).toBe("unknown_operation")
      expect(failure.message).toContain("tools_search")
    }

    const unserved = run(services.presentation.call(view, who, { name: "daemon_exec" }))
    const unservedFailure = expectFailure(unserved)

    if (unservedFailure instanceof CallFailure) {
      expect(unservedFailure.message).toContain("not served")
      expect(unservedFailure.message).toContain("daemon_initialize")
    } else {
      throw new Error("expected CallFailure")
    }
  })

  it("invalid input fails with invalid_arguments through the same pipeline", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const strictEntries = [
      services.capabilities.bind({
        facts: {
          id: "daemon_strict",
          family: "daemon",
          description: "Strict input.",
          inputSchema: { type: "object" },
          effect: "read",
          replay: "safe_read",
          annotations: readAnnotations,
        },
        decode: (input) => {
          if (Predicate.isObject(input) && Predicate.isString(input["path"])) {
            return Effect.succeed(input)
          }

          return Effect.fail(
            new InvalidInput({ message: "input must be an object with a string path" }),
          )
        },
        target: () => systemTarget,
        demand: (): Demand => ({ effect: "read" }),
        perform: () => Effect.succeed({ ok: true }),
        classify: (_input, output) => ({ payload: ReleasePayload.JsonValue({ value: output }) }),
      }),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(strictEntries))
    const roster = buildRoster(catalog, strictEntries)
    const view = createView({ roster, profile: "compact" })

    const exit = run(
      services.presentation.call(view, who, { name: "daemon_strict", arguments: {} }),
    )

    const failure = expectFailure(exit)

    if (failure instanceof CallFailure) {
      expect(failure.code).toBe("invalid_arguments")
    } else {
      throw new Error("expected CallFailure, got " + JSON.stringify(failure))
    }
  })

  it("guidance-gated operations fail with guidance_required before performing", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const counter = { count: 0 }

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "session_create",
          family: "session",
          description: "Create.",
          output: { ok: true },
          prerequisite: { edition: "droid-v1" },
          performCount: counter,
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact" })

    const exit = run(services.presentation.call(view, who, { name: "session_create" }))
    const failure = expectFailure(exit)

    if (failure instanceof CallFailure) {
      expect(failure.code).toBe("guidance_required")
    } else {
      throw new Error("expected CallFailure")
    }

    expect(counter.count).toBe(0)

    // After acknowledging the guide, the same call passes the gate.
    deliverRoot(services.guidance, who.conversation)

    const presented = succeed(services.presentation.call(view, who, { name: "session_create" }))

    expect(Presented.$is("Inline")(presented)).toBe(true)
    expect(counter.count).toBe(1)
  })

  it("authority denial surfaces as denied before perform", () => {
    const services = makeServices({ maxAutonomy: "off" })
    const who = makeInvocation(services.callers, "alice")

    const counter = { count: 0 }

    const entries = [
      services.capabilities.bind({
        facts: {
          id: "daemon_initialize",
          family: "daemon",
          description: "Init.",
          inputSchema: { type: "object" },
          effect: "write",
          replay: "no_retry",
          annotations,
        },
        decode: (input) => Effect.succeed(input),
        target: () => systemTarget,
        demand: (): Demand => ({ effect: "write", requestedLevel: "high" }),
        perform: () => {
          counter.count += 1

          return Effect.succeed({ ok: true })
        },
        classify: (_input, output) => ({ payload: ReleasePayload.JsonValue({ value: output }) }),
      }),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact" })

    const exit = run(services.presentation.call(view, who, { name: "daemon_initialize" }))
    const failure = expectFailure(exit)

    if (failure instanceof CallFailure) {
      expect(failure.code).toBe("denied")
    } else {
      throw new Error("expected CallFailure")
    }

    expect(counter.count).toBe(0)
  })

  it("disclosure scrubbing applies to the presented payload", () => {
    const secret = "super-secret-token-value"
    const services = makeServices({ protectedValues: [secret] })
    const who = makeInvocation(services.callers, "alice")

    const entries = [
      services.capabilities.bind({
        facts: {
          id: "daemon_leak",
          family: "daemon",
          description: "Leaks a secret in output.",
          inputSchema: { type: "object" },
          effect: "read",
          replay: "safe_read",
          annotations: readAnnotations,
        },
        decode: (input) => Effect.succeed(input),
        target: () => systemTarget,
        demand: (): Demand => ({ effect: "read" }),
        perform: () => Effect.succeed({ token: secret }),
        classify: (_input, output) => ({
          payload: ReleasePayload.JsonValue({ value: output }),
          sensitiveValues: [secret],
        }),
      }),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact" })

    const presented = succeed(services.presentation.call(view, who, { name: "daemon_leak" }))

    if (!Presented.$is("Inline")(presented)) throw new Error("expected Inline")

    expect(jsonText(presented.value)).not.toContain(secret)
  })
})

// ---------------------------------------------------------------------------
// Continuation + continueResult
// ---------------------------------------------------------------------------

describe("continuation and continueResult", () => {
  const bigFixture = (size: number): FixtureSpec => ({
    id: "daemon_big",
    family: "daemon",
    description: "Big output.",
    readOnly: true,
    output: { data: "x".repeat(size) },
  })

  it("returns Continuation for results over maxBytes and pages exact bytes with continueResult", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const { roster } = bindFixtures(services, [bigFixture(40_000)])
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(services.presentation.call(view, who, { name: "daemon_big" }))

    if (!Presented.$is("Continuation")(presented)) {
      throw new Error("expected Continuation, got " + presented._tag)
    }

    expect(presented.totalBytes).toBe(encodeLength(jsonText({ data: "x".repeat(40_000) })))
    expect(presented.preview.length).toBeGreaterThan(0)
    expect(presented.hint).toContain("result_read")

    // Page the entire artifact and reconstruct the exact bytes.
    let offset = 0
    let assembled = ""

    for (;;) {
      const page = succeed(
        services.presentation.continueResult(who, presented.ref, { offset, length: 997 }),
      )

      assembled += page.chunk

      if (page.done || page.nextOffset === null) break

      offset = page.nextOffset
    }

    expect(assembled).toBe(jsonText({ data: "x".repeat(40_000) }))
  })

  it("reconstructs multi-byte UTF-8 exactly across arbitrary page lengths", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const unicode = "héllo wörld ✨ ".repeat(500)

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_unicode",
          family: "daemon",
          description: "Unicode output.",
          readOnly: true,
          output: { text: unicode },
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(services.presentation.call(view, who, { name: "daemon_unicode" }))

    if (!Presented.$is("Continuation")(presented)) throw new Error("expected Continuation")

    // 997 bytes is deliberately odd so multi-byte characters straddle pages;
    // continuation offsets land on exact UTF-8 boundaries.
    let offset = 0
    let assembled = ""

    for (;;) {
      const page = succeed(
        services.presentation.continueResult(who, presented.ref, { offset, length: 997 }),
      )

      assembled += page.chunk

      if (page.done || page.nextOffset === null) break

      offset = page.nextOffset
    }

    expect(assembled).toBe(jsonText({ text: unicode }))
  })

  it("an invalid UTF-8 continuation offset fails with InvalidRange", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_unicode",
          family: "daemon",
          description: "Unicode output.",
          readOnly: true,
          output: { text: "✨".repeat(2_000) },
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(services.presentation.call(view, who, { name: "daemon_unicode" }))

    if (!Presented.$is("Continuation")(presented)) throw new Error("expected Continuation")

    // Find a UTF-8 continuation byte so the offset lands inside a character.
    const full = jsonText({ text: "✨".repeat(2_000) })
    const bytes = new TextEncoder().encode(full)

    let mid = -1

    for (let index = 1; index < 200; index += 1) {
      if ((bytes[index]! & 0xc0) === 0x80) {
        mid = index
        break
      }
    }

    expect(mid).toBeGreaterThan(0)

    const exit = run(services.presentation.continueResult(who, presented.ref, { offset: mid }))

    expect(Predicate.isTagged("InvalidRange")(expectFailure(exit))).toBe(true)
  })

  it("caller B cannot read caller A's artifact ref", () => {
    const services = makeServices()
    const alice = makeInvocation(services.callers, "alice")
    const bob = makeInvocation(services.callers, "bob")
    const { roster } = bindFixtures(services, [bigFixture(40_000)])
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(services.presentation.call(view, alice, { name: "daemon_big" }))

    if (!Presented.$is("Continuation")(presented)) throw new Error("expected Continuation")

    const exit = run(services.presentation.continueResult(bob, presented.ref, {}))

    expect(Predicate.isTagged("ArtifactUnavailable")(expectFailure(exit))).toBe(true)
  })

  it("continueResult supports pointer selection within the stored document", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const output = {
      outer: { inner: [1, 2, { deep: "x".repeat(5_000) }] },
      other: "y".repeat(40_000),
    }

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_nested",
          family: "daemon",
          description: "Nested output.",
          readOnly: true,
          output,
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(services.presentation.call(view, who, { name: "daemon_nested" }))

    if (!Presented.$is("Continuation")(presented)) throw new Error("expected Continuation")

    const page = succeed(
      services.presentation.continueResult(who, presented.ref, { select: "/outer/inner/2" }),
    )

    expect(page.chunk).toBe(jsonText({ deep: "x".repeat(5_000) }))
    expect(page.done).toBe(true)
  })

  it("malformed refs fail with ArtifactUnavailable without touching the store", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const exit = run(services.presentation.continueResult(who, "not-a-ref", {}))

    expect(Predicate.isTagged("ArtifactUnavailable")(expectFailure(exit))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Recovery after committed writes
// ---------------------------------------------------------------------------

describe("recovery after completion", () => {
  it("an invalid select pointer on a write returns CompletedUnpresentable with a usable recovery ref, and the write ran exactly once", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const counter = { count: 0 }
    const output = { written: true, bytes: "w".repeat(2_000) }

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_write",
          family: "daemon",
          description: "Write.",
          output,
          performCount: counter,
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(
      services.presentation.call(view, who, { name: "daemon_write", select: "/missing" }),
    )

    if (!Presented.$is("CompletedUnpresentable")(presented)) {
      throw new Error("expected CompletedUnpresentable, got " + presented._tag)
    }

    expect(presented.code).toBe("invalid_select")
    expect(presented.reason).toBe("invalid_select")
    expect(presented.ref).toBeDefined()
    expect(presented.message).toContain("do not repeat")

    // The write ran exactly once.
    expect(counter.count).toBe(1)

    // The recovery ref pages the FULL safe result.
    const ref = presented.ref

    if (ref === undefined) throw new Error("expected recovery ref")

    expect(Option.isSome(parseArtifactRef(ref))).toBe(true)

    let offset = 0
    let assembled = ""

    for (;;) {
      const page = succeed(services.presentation.continueResult(who, ref, { offset, length: 512 }))

      assembled += page.chunk

      if (page.done || page.nextOffset === null) break

      offset = page.nextOffset
    }

    expect(assembled).toBe(jsonText(output))
  })

  it("a valid select on a completed result returns only the selected part inline", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_mixed",
          family: "daemon",
          description: "Mixed output.",
          readOnly: true,
          output: { big: "b".repeat(10_000), small: "ok" },
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(
      services.presentation.call(view, who, { name: "daemon_mixed", select: "/small" }),
    )

    if (!Presented.$is("Inline")(presented)) throw new Error("expected Inline")

    expect(presented.value).toBe("ok")
  })

  it("an oversized single value returns CompletedUnpresentable with ref undefined and evicts nothing", async () => {
    // Small single-value limit so the fixture value exceeds it.
    const services = makeServices({ artifactOptions: { singleValueByteLimit: 4_096 } })
    const who = makeInvocation(services.callers, "alice")

    // First store a small artifact so we can verify zero eviction.
    const small = [
      services.capabilities.bind(
        fixture({
          id: "daemon_small",
          family: "daemon",
          description: "Small output.",
          readOnly: true,
          output: { data: "s".repeat(2_000) },
        }),
      ),
    ]

    const smallCatalog = Effect.runSync(services.capabilities.assemble(small))
    const smallRoster = buildRoster(smallCatalog, small)
    const smallView = createView({ roster: smallRoster, profile: "compact", maxInlineBytes: 1_024 })

    const smallPresented = succeed(
      services.presentation.call(smallView, who, { name: "daemon_small" }),
    )

    if (!Presented.$is("Continuation")(smallPresented)) throw new Error("expected Continuation")

    const smallRef = smallPresented.ref

    // Now the oversized value: 8 KB payload against a 4 KB single-value cap.
    const big = [
      services.capabilities.bind(
        fixture({
          id: "daemon_huge",
          family: "daemon",
          description: "Huge output.",
          readOnly: true,
          output: { data: "h".repeat(8_000) },
        }),
      ),
    ]

    const bigCatalog = Effect.runSync(services.capabilities.assemble(big))
    const bigRoster = buildRoster(bigCatalog, big)
    const bigView = createView({ roster: bigRoster, profile: "compact", maxInlineBytes: 1_024 })

    const presented = succeed(services.presentation.call(bigView, who, { name: "daemon_huge" }))

    if (!Presented.$is("CompletedUnpresentable")(presented)) {
      throw new Error("expected CompletedUnpresentable, got " + presented._tag)
    }

    expect(presented.code).toBe("result_too_large")
    expect(presented.ref).toBeUndefined()
    expect(presented.reason).toBe("single_value_limit")

    // The previously stored artifact was NOT evicted by the oversized check.
    const page = succeed(services.presentation.continueResult(who, smallRef, { length: 100 }))

    expect(page.chunk.length).toBeGreaterThan(0)
  })

  it("recovery refs are caller-scoped like any other artifact", () => {
    const services = makeServices()
    const alice = makeInvocation(services.callers, "alice")
    const bob = makeInvocation(services.callers, "bob")

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_write",
          family: "daemon",
          description: "Write.",
          output: { written: true },
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact" })

    const presented = succeed(
      services.presentation.call(view, alice, { name: "daemon_write", select: "/nope" }),
    )

    if (!Presented.$is("CompletedUnpresentable")(presented)) throw new Error("expected CU")

    const ref = presented.ref

    if (ref === undefined) throw new Error("expected recovery ref")

    const exit = run(services.presentation.continueResult(bob, ref, {}))

    expect(Predicate.isTagged("ArtifactUnavailable")(expectFailure(exit))).toBe(true)

    const page = succeed(services.presentation.continueResult(alice, ref, {}))

    expect(page.chunk).toBe(jsonText({ written: true }))
  })
})

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

const batchFixtures = (services: Services, counter: { count: number }): OperationRoster => {
  const entries = [
    services.capabilities.bind(
      fixture({
        id: "daemon_write",
        family: "daemon",
        description: "Write.",
        output: (input) => ({ echo: input, writeId: "w1" }),
        performCount: counter,
      }),
    ),
    services.capabilities.bind(
      fixture({
        id: "daemon_read",
        family: "daemon",
        description: "Read.",
        readOnly: true,
        output: (input) => ({ read: input }),
      }),
    ),
  ]

  const catalog = Effect.runSync(services.capabilities.assemble(entries))

  return buildRoster(catalog, entries)
}

describe("batch", () => {
  it("runs steps sequentially in order", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const order: Array<string> = []

    const entries = ["first", "second", "third"].map((label) =>
      services.capabilities.bind({
        facts: {
          id: "daemon_" + label,
          family: "daemon",
          description: label,
          inputSchema: { type: "object" },
          effect: "write",
          replay: "no_retry",
          annotations,
        },
        decode: (input) => Effect.succeed(input),
        target: () => systemTarget,
        demand: (): Demand => ({ effect: "write" }),
        perform: () => {
          order.push(label)

          return Effect.succeed({ label })
        },
        classify: (_input, output) => ({ payload: ReleasePayload.JsonValue({ value: output }) }),
      }),
    )

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact" })

    const report = succeed(
      services.presentation.batch(view, who, {
        steps: [{ name: "daemon_first" }, { name: "daemon_second" }, { name: "daemon_third" }],
      }),
    )

    expect(order).toEqual(["first", "second", "third"])
    expect(report.completed).toBe(3)
    expect(report.failed).toBe(0)
    expect(report.skipped).toBe(0)
    expect(report.steps.map((step) => step.id)).toEqual(["0", "1", "2"])
    expect(report.steps.every((step) => step.status === "ok")).toBe(true)
  })

  it("$from resolves against the FULL safe earlier result even when the step used select", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const counter = { count: 0 }
    const roster = batchFixtures(services, counter)
    const view = createView({ roster, profile: "compact" })

    const report = succeed(
      services.presentation.batch(view, who, {
        steps: [
          {
            id: "w",
            name: "daemon_write",
            arguments: { value: 42 },
            // The step's own report selects a sub-part — but the stored
            // reference keeps the FULL result.
            select: "/writeId",
          },
          {
            id: "r",
            name: "daemon_read",
            arguments: { echoed: { $from: "w", path: "/echo/value" } },
          },
        ],
      }),
    )

    expect(report.completed).toBe(2)

    const first = report.steps[0]
    const second = report.steps[1]

    expect(first?.status).toBe("ok")

    if (first?.presented !== undefined && Presented.$is("Inline")(first.presented)) {
      // The step report itself only carries the selected part.
      expect(first.presented.value).toBe("w1")
    }

    expect(second?.status).toBe("ok")

    if (second?.presented !== undefined && Presented.$is("Inline")(second.presented)) {
      // The second step received the full-resolution value 42 — not the
      // truncated or selected report of step one.
      expect(second.presented.value).toEqual({ read: { echoed: 42 } })
    } else {
      throw new Error("expected inline second step")
    }
  })

  it("$from reads the full result even when the earlier step returned a truncated Continuation", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_bigwrite",
          family: "daemon",
          description: "Big write.",
          output: { payload: "p".repeat(20_000), marker: "m-value" },
        }),
      ),
      services.capabilities.bind(
        fixture({
          id: "daemon_consume",
          family: "daemon",
          description: "Consume.",
          readOnly: true,
          output: (input) => ({ got: input }),
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact", maxInlineBytes: 1_024 })

    const report = succeed(
      services.presentation.batch(view, who, {
        steps: [
          { id: "big", name: "daemon_bigwrite" },
          {
            id: "use",
            name: "daemon_consume",
            arguments: { marker: { $from: "big", path: "/marker" } },
          },
        ],
      }),
    )

    expect(report.completed).toBe(2)

    const first = report.steps[0]

    expect(first?.status).toBe("ok")

    // The first step's report is a truncated continuation...
    if (first?.presented !== undefined) {
      expect(Presented.$is("Continuation")(first.presented)).toBe(true)
    }

    // ...but the second step still read the full result's /marker.
    const second = report.steps[1]

    if (second?.presented !== undefined && Presented.$is("Inline")(second.presented)) {
      expect(second.presented.value).toEqual({ got: { marker: "m-value" } })
    } else {
      throw new Error("expected inline second step")
    }
  })

  it("stopOnError true stops at the first failure and marks the rest skipped, completed steps stay done", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const counter = { count: 0 }

    const entries = [
      services.capabilities.bind(
        fixture({
          id: "daemon_ok",
          family: "daemon",
          description: "OK.",
          output: { ok: true },
          performCount: counter,
        }),
      ),
      services.capabilities.bind({
        facts: {
          id: "daemon_fail",
          family: "daemon",
          description: "Fails.",
          inputSchema: { type: "object" },
          effect: "write",
          replay: "no_retry",
          annotations,
        },
        decode: (input) => Effect.succeed(input),
        target: () => systemTarget,
        demand: (): Demand => ({ effect: "write" }),
        perform: () =>
          Effect.fail(new PeerFailure({ code: "peer_rejected", message: "the peer said no" })),
        classify: (_input, output) => ({ payload: ReleasePayload.JsonValue({ value: output }) }),
      }),
      services.capabilities.bind(
        fixture({
          id: "daemon_never",
          family: "daemon",
          description: "Never runs.",
          output: { never: true },
          performCount: counter,
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact" })

    const writesBefore = counter.count

    const report = succeed(
      services.presentation.batch(view, who, {
        steps: [
          { id: "a", name: "daemon_ok" },
          { id: "b", name: "daemon_fail" },
          { id: "c", name: "daemon_never" },
        ],
      }),
    )

    expect(report.completed).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.steps[0]?.status).toBe("ok")
    expect(report.steps[1]?.status).toBe("failed")
    expect(report.steps[1]?.failure?.code).toBe("peer_failure")
    expect(report.steps[2]?.status).toBe("skipped")

    // The completed step ran (nontransactional); the skipped one never did.
    expect(counter.count).toBe(writesBefore + 1)
  })

  it("stopOnError false continues running after a failure", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")

    const entries = [
      services.capabilities.bind({
        facts: {
          id: "daemon_fail",
          family: "daemon",
          description: "Fails.",
          inputSchema: { type: "object" },
          effect: "write",
          replay: "no_retry",
          annotations,
        },
        decode: (input) => Effect.succeed(input),
        target: () => systemTarget,
        demand: (): Demand => ({ effect: "write" }),
        perform: () => Effect.fail(new PeerFailure({ code: "nope", message: "failure" })),
        classify: (_input, output) => ({ payload: ReleasePayload.JsonValue({ value: output }) }),
      }),
      services.capabilities.bind(
        fixture({
          id: "daemon_after",
          family: "daemon",
          description: "Runs after.",
          output: { after: true },
        }),
      ),
    ]

    const catalog = Effect.runSync(services.capabilities.assemble(entries))
    const roster = buildRoster(catalog, entries)
    const view = createView({ roster, profile: "compact" })

    const report = succeed(
      services.presentation.batch(view, who, {
        stopOnError: false,
        steps: [
          { id: "x", name: "daemon_fail" },
          { id: "y", name: "daemon_after" },
        ],
      }),
    )

    expect(report.failed).toBe(1)
    expect(report.completed).toBe(1)
    expect(report.skipped).toBe(0)
    expect(report.steps[1]?.status).toBe("ok")
  })

  it("rejects 0 steps, more than 20 steps and duplicate step ids with InvalidBatch", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const counter = { count: 0 }
    const roster = batchFixtures(services, counter)
    const view = createView({ roster, profile: "compact" })

    const empty = run(services.presentation.batch(view, who, { steps: [] }))

    expect(Predicate.isTagged("InvalidBatch")(expectFailure(empty))).toBe(true)

    const tooMany = run(
      services.presentation.batch(view, who, {
        steps: Array.from({ length: 21 }, () => ({ name: "daemon_read" })),
      }),
    )

    expect(Predicate.isTagged("InvalidBatch")(expectFailure(tooMany))).toBe(true)

    const duplicates = run(
      services.presentation.batch(view, who, {
        steps: [
          { id: "same", name: "daemon_read" },
          { id: "same", name: "daemon_read" },
        ],
      }),
    )

    const failure = expectFailure(duplicates)

    expect(Predicate.isTagged("InvalidBatch")(failure)).toBe(true)

    if (failure instanceof InvalidBatch) {
      expect(failure.message).toContain("unique")
    }
  })

  it("a $from reference to an unknown or later step fails the step with invalid_reference", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const counter = { count: 0 }
    const roster = batchFixtures(services, counter)
    const view = createView({ roster, profile: "compact" })

    const report = succeed(
      services.presentation.batch(view, who, {
        steps: [
          { id: "a", name: "daemon_read", arguments: { x: { $from: "missing", path: "/y" } } },
        ],
      }),
    )

    expect(report.failed).toBe(1)
    expect(report.steps[0]?.failure?.code).toBe("invalid_reference")
  })

  it("a $from path that misses inside a valid earlier result fails with invalid_reference", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const counter = { count: 0 }
    const roster = batchFixtures(services, counter)
    const view = createView({ roster, profile: "compact" })

    const report = succeed(
      services.presentation.batch(view, who, {
        steps: [
          { id: "w", name: "daemon_write", arguments: { value: 1 } },
          { id: "r", name: "daemon_read", arguments: { x: { $from: "w", path: "/nonexistent" } } },
        ],
      }),
    )

    expect(report.steps[0]?.status).toBe("ok")
    expect(report.steps[1]?.status).toBe("failed")
    expect(report.steps[1]?.failure?.code).toBe("invalid_reference")
  })

  it("nested references inside arrays and objects resolve recursively", () => {
    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const counter = { count: 0 }
    const roster = batchFixtures(services, counter)
    const view = createView({ roster, profile: "compact" })

    const report = succeed(
      services.presentation.batch(view, who, {
        steps: [
          { id: "w", name: "daemon_write", arguments: { value: 7 } },
          {
            id: "r",
            name: "daemon_read",
            arguments: {
              list: [
                { $from: "w", path: "/echo/value" },
                { nested: { $from: "w", path: "/echo" } },
              ],
            },
          },
        ],
      }),
    )

    const second = report.steps[1]

    if (second?.presented !== undefined && Presented.$is("Inline")(second.presented)) {
      expect(second.presented.value).toEqual({
        read: { list: [7, { nested: { value: 7 } }] },
      })
    } else {
      throw new Error("expected inline second step")
    }
  })
})

// ---------------------------------------------------------------------------
// instructions
// ---------------------------------------------------------------------------

describe("instructions", () => {
  it("reflects the compact profile, installed counts and families", () => {
    const services = makeServices()
    const { roster } = bindFixtures(services, allFixtures)
    const view = createView({ roster, profile: "compact" })

    const text = services.presentation.instructions(view)

    expect(text).toContain("16 tools")
    expect(text).toContain(String(allFixtures.length) + " installed operations")
    expect(text).toContain("tools_search")
    expect(text).toContain("result_read")
    expect(text).toContain("session")
    expect(text).toContain("daemon")
    expect(text).toContain("rest")
    expect(text).toContain("context")
  })

  it("reflects the full profile without dispatch tools", () => {
    const services = makeServices()
    const { roster } = bindFixtures(services, allFixtures)
    const view = createView({ roster, profile: "full" })

    const text = services.presentation.instructions(view)

    expect(text).toContain(String(allFixtures.length) + " direct operation tools")
    expect(text).not.toContain("tools_search")
  })

  it("adjusts when providers are omitted", () => {
    const services = makeServices()
    const { roster } = bindFixtures(services, sessionFixtures)
    const view = createView({ roster, profile: "compact" })

    const text = services.presentation.instructions(view)

    expect(text).toContain(String(sessionFixtures.length) + " installed operations")
    expect(text).not.toContain("daemon")
  })
})

// ---------------------------------------------------------------------------
// description invariance (Structural Proof 2 shape)
// ---------------------------------------------------------------------------

describe("description invariance", () => {
  it("call and batch never consult descriptions: rewriting every description changes no outcome", async () => {
    const { withReplacedDescription } = await import("../../src/capabilities/index.ts")

    const services = makeServices()
    const who = makeInvocation(services.callers, "alice")
    const counter = { count: 0 }
    const roster = batchFixtures(services, counter)
    const view = createView({ roster, profile: "compact" })

    const baseline = succeed(
      services.presentation.call(view, who, { name: "daemon_write", arguments: { v: 1 } }),
    )

    // Rewrite every description on the same underlying bound operations and
    // rebuild the catalog and view. Discovery text changes entirely; the
    // executable pipeline — targets, demands, bodies, classification — is
    // exactly the one the original binding closed over.
    const originals: Array<BoundOperation> = [
      services.capabilities.bind(
        fixture({
          id: "daemon_write",
          family: "daemon",
          description: "Write.",
          output: (input) => ({ echo: input, writeId: "w1" }),
          performCount: counter,
        }),
      ),
      services.capabilities.bind(
        fixture({
          id: "daemon_read",
          family: "daemon",
          description: "Read.",
          readOnly: true,
          output: (input) => ({ read: input }),
        }),
      ),
    ]

    const rebound: Array<BoundOperation> = originals.map((operation) =>
      withReplacedDescription(operation, "rewritten text with zero overlap " + operation.facts.id),
    )

    for (const operation of rebound) {
      expect(operation.facts.description.startsWith("rewritten text")).toBe(true)
    }

    const reboundCatalog = Effect.runSync(services.capabilities.assemble(rebound))
    const reboundRoster = buildRoster(reboundCatalog, rebound)
    const reboundView = createView({ roster: reboundRoster, profile: "compact" })

    const after = succeed(
      services.presentation.call(reboundView, who, { name: "daemon_write", arguments: { v: 1 } }),
    )

    // Same inputs produce identical presented results regardless of text.
    expect(after).toEqual(baseline)

    // Batch resolution is likewise description-independent.
    const batchBefore = succeed(
      services.presentation.batch(view, who, {
        steps: [
          { id: "w", name: "daemon_write", arguments: { value: 9 } },
          { id: "r", name: "daemon_read", arguments: { x: { $from: "w", path: "/echo/value" } } },
        ],
      }),
    )

    const batchAfter = succeed(
      services.presentation.batch(reboundView, who, {
        steps: [
          { id: "w", name: "daemon_write", arguments: { value: 9 } },
          { id: "r", name: "daemon_read", arguments: { x: { $from: "w", path: "/echo/value" } } },
        ],
      }),
    )

    expect(batchAfter.steps[1]?.presented).toEqual(batchBefore.steps[1]?.presented)
  })
})

void encodeLength
