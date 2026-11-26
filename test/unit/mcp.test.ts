import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Exit, Fiber, Layer, Option, Predicate, Schema, Scope, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { artifactsLayer } from "../../src/artifacts/index.ts"
import { Authority, authorityLayer } from "../../src/authority/index.ts"
import type { AutonomyLevel } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { Conversation } from "../../src/caller/index.ts"
import { Capabilities, capabilitiesLayer } from "../../src/capabilities/index.ts"
import { custodyLayer } from "../../src/custody/index.ts"
import { decisionsLayer } from "../../src/decisions/index.ts"
import { disclosureLayer } from "../../src/disclosure/index.ts"
import { dialectLayer } from "../../src/factory-dialect/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import { localExecLayer } from "../../src/local-exec/index.ts"
import {
  BindRefused,
  EndpointClosed,
  Mcp,
  mcpLayer,
  RevisionUnsupported,
  SESSIONLESS_PROTOCOL_REVISION,
  SUPPORTED_PROTOCOL_REVISIONS,
} from "../../src/mcp/index.ts"
import type { McpEndpoint, McpFrame, McpReply, PeerAbilities } from "../../src/mcp/index.ts"
import { observationsLayer } from "../../src/observations/index.ts"
import { placementLayer } from "../../src/placement/index.ts"
import {
  buildRoster,
  createView,
  Presentation,
  presentationLayer,
} from "../../src/presentation/index.ts"
import type { View } from "../../src/presentation/index.ts"
import { Sessions, sessionsLayer } from "../../src/sessions/index.ts"
import { turnsLayer } from "../../src/turns/index.ts"
import { workspacesLayer } from "../../src/workspace/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAKE = join(import.meta.dirname, "../support/fake-droid-exec.mjs")

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "mcp-test-")))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

interface HarnessServices {
  readonly mcp: Mcp["Service"]
  readonly presentation: Presentation["Service"]
  readonly sessions: Sessions["Service"]
  readonly capabilities: Capabilities["Service"]
  readonly callers: Callers["Service"]
  readonly authority: Authority["Service"]
  readonly guidance: Guidance["Service"]
  readonly view: View
  readonly fullView: View
  readonly close: () => Promise<void>
}

interface HarnessOptions {
  readonly maxAutonomy?: AutonomyLevel
  readonly guidanceRequired?: boolean
  readonly maxEvents?: number
}

const buildHarness = (options?: HarnessOptions): HarnessServices => {
  const scope = Effect.runSync(Scope.make())

  const disclosureLive = disclosureLayer({})
  const authorityLive = authorityLayer({ maxAutonomy: options?.maxAutonomy ?? "high" })
  const callersLive = callersLayer({})
  const guidanceLive = guidanceLayer({ required: options?.guidanceRequired ?? true })

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
  const artifactsLive = Layer.provideMerge(artifactsLayer(), disclosureLive)

  const localLive = Layer.provideMerge(
    localExecLayer({ droidPath: process.execPath, args: [FAKE] }),
    baseDeps,
  )

  const placementLive = Layer.provideMerge(placementLayer({}), Layer.mergeAll(localLive, baseDeps))

  const turnsLive = Layer.provideMerge(
    turnsLayer(options?.maxEvents === undefined ? undefined : { maxEvents: options.maxEvents }),
    Layer.mergeAll(decisionsLive, observationsLive, baseDeps),
  )

  const sessionsLive = Layer.provideMerge(
    sessionsLayer({
      guidanceRequired: options?.guidanceRequired ?? true,
      defaultWaitMs: 5_000,
    }),
    Layer.mergeAll(turnsLive, placementLive, capabilitiesLive, baseDeps),
  )

  const presentationLive = Layer.provideMerge(
    presentationLayer,
    Layer.merge(capabilitiesLive, artifactsLive),
  )

  const mcpLive = Layer.provideMerge(
    mcpLayer({ serverName: "droid-mcp-test", serverVersion: "9.9.9" }),
    Layer.mergeAll(presentationLive, sessionsLive, guidanceLive),
  )

  const merged = Layer.mergeAll(
    mcpLive,
    presentationLive,
    sessionsLive,
    capabilitiesLive,
    artifactsLive,
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
        const mcp = yield* Mcp
        const presentation = yield* Presentation
        const sessions = yield* Sessions
        const capabilities = yield* Capabilities
        const callers = yield* Callers
        const authority = yield* Authority
        const guidance = yield* Guidance

        const catalog = yield* capabilities.assemble(sessions.entries())
        const roster = buildRoster(catalog, sessions.entries())

        const view = createView({
          roster,
          profile: "compact",
          serverName: "droid-mcp-test",
          directNames: [
            "server_info",
            "skill_read",
            "session_create",
            "session_stream",
            "session_events",
            "session_interrupt",
            "session_close",
            "session_list",
            "session_respond_permission",
            "session_answer_question",
            "session_pick_options",
          ],
        })

        const fullView = createView({ roster, profile: "full", serverName: "droid-mcp-test" })

        return {
          mcp,
          presentation,
          sessions,
          capabilities,
          callers,
          authority,
          guidance,
          view,
          fullView,
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

type Services = HarnessServices

const admit = (services: Services, name: string) =>
  Effect.gen(function* () {
    const caller = yield* services.callers.admit(Option.getOrThrow(trustedEvidence(name)))
    const conversation = yield* services.callers.conversation(caller, { bindingId: "conv-" + name })

    return { caller, conversation }
  })

const PEER: PeerAbilities = { supportsForms: false }

const bindEndpoint = (
  services: Services,
  principal: string,
  peer: PeerAbilities = PEER,
  profile: "compact" | "full" = "compact",
) =>
  Effect.gen(function* () {
    const { caller, conversation } = yield* admit(services, principal)
    const view = profile === "compact" ? services.view : services.fullView

    const endpoint = yield* services.mcp.bind(view, caller, conversation, peer)

    return { endpoint, caller, conversation }
  })

const request = (id: number, method: string, params?: Schema.Json): McpFrame => ({
  kind: "request",
  id,
  method,
  params: params ?? {},
})

const notification = (method: string): McpFrame => ({ kind: "notification", method, params: {} })

const receive = (endpoint: McpEndpoint, frame: McpFrame): Promise<McpReply> =>
  Effect.runPromise(endpoint.receive(frame))

const resultPayload = (reply: McpReply): Schema.Json => {
  if (reply.kind !== "result")
    throw new Error("expected result reply, got: " + JSON.stringify(reply))

  return reply.result
}

const FailureBodySchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  ref: Schema.optionalKey(Schema.String),
})

const decodeFailureBody = (value: Schema.Json) => {
  const decoded = Schema.decodeUnknownOption(FailureBodySchema)(value)

  if (Option.isNone(decoded)) throw new Error("failure body is not { code, message, ref? }")

  return decoded.value
}

const errorData = (reply: McpReply) => {
  if (reply.kind !== "error") throw new Error("expected error reply, got: " + JSON.stringify(reply))

  return decodeFailureBody(reply.data ?? null)
}

type JsonObject = { readonly [key: string]: Schema.Json }

const isObject = (value: Schema.Json): value is JsonObject =>
  value !== null && !Array.isArray(value) && value instanceof Object

const asObject = (value: Schema.Json): JsonObject => {
  if (!isObject(value)) {
    throw new Error("expected object, got: " + JSON.stringify(value))
  }

  return value
}

const asArray = (value: Schema.Json): ReadonlyArray<Schema.Json> => {
  if (!Array.isArray(value)) throw new Error("expected array, got: " + JSON.stringify(value))

  return value
}

const fieldOf = (value: Schema.Json, field: string): Schema.Json => {
  const object = asObject(value)

  const member = object[field]

  if (member === undefined)
    throw new Error("missing field " + field + " in " + JSON.stringify(value))

  return member
}

const stringOf = (value: Schema.Json): string => {
  if (!Predicate.isString(value)) {
    throw new Error("expected string, got: " + JSON.stringify(value))
  }

  return value
}

const numberOf = (value: Schema.Json): number => {
  if (!Predicate.isNumber(value)) {
    throw new Error("expected number, got: " + JSON.stringify(value))
  }

  return value
}

/** Parses wire JSON text; the server serialized it from a Schema.Json value. */
const parseJson = (text: string): Schema.Json =>
  // SAFETY: the server serialized this text with JSON.stringify from a
  // Schema.Json value, so parsing it reproduces exactly that Json value.
  JSON.parse(text) as Schema.Json

const toolEnvelope = (reply: McpReply): JsonObject => asObject(resultPayload(reply))

const toolText = (envelope: JsonObject): string => {
  const content = asArray(fieldOf(envelope, "content"))

  if (content.length !== 1) {
    throw new Error("tool result carries " + String(content.length) + " content blocks")
  }

  const block = asObject(content[0] ?? null)

  if (block.type !== "text") throw new Error("tool result content is not a text block")

  const text = stringOf(fieldOf(block, "text"))

  if (text.length === 0) throw new Error("tool result text is empty")

  return text
}

/** Decodes a successful standard CallToolResult and proves its structured mirror. */
const toolResult = (reply: McpReply): Schema.Json => {
  const envelope = toolEnvelope(reply)

  if (envelope.isError === true) throw new Error("expected a successful tool result")

  const payload = parseJson(toolText(envelope))
  const structured = envelope.structuredContent

  if (isObject(payload)) {
    if (structured === undefined) throw new Error("object tool payload has no structuredContent")

    expect(structured).toEqual(payload)
  } else if (structured !== undefined) {
    throw new Error("scalar tool payload unexpectedly carries structuredContent")
  }

  return payload
}

/** Decodes a tool execution failure carried inside a successful JSON-RPC reply. */
const toolFailure = (reply: McpReply) => {
  const envelope = toolEnvelope(reply)

  if (envelope.isError !== true) throw new Error("expected an isError tool result")

  if (envelope.structuredContent !== undefined) {
    throw new Error("tool failure unexpectedly carries structuredContent")
  }

  return decodeFailureBody(parseJson(toolText(envelope)))
}

const textOfResource = (reply: McpReply): string => {
  const contents = asArray(fieldOf(resultPayload(reply), "contents"))
  const first = contents[0]

  if (first === undefined) throw new Error("resource reply carries no contents")

  return stringOf(fieldOf(first, "text"))
}

const hasReceipt = (services: Services, conversation: Conversation): boolean =>
  Effect.runSync(services.guidance.hasReceipt(conversation, { edition: CURRENT_GUIDE_EDITION }))

const initialize = (endpoint: McpEndpoint, protocolVersion?: string): Promise<McpReply> =>
  receive(
    endpoint,
    request(1, "initialize", protocolVersion === undefined ? {} : { protocolVersion }),
  )

const callTool = (
  endpoint: McpEndpoint,
  name: string,
  args: Schema.Json,
  id = 100,
): Promise<McpReply> => receive(endpoint, request(id, "tools/call", { name, arguments: args }))

// ---------------------------------------------------------------------------
// Protocol negotiation and bind-time checks
// ---------------------------------------------------------------------------

describe("mcp: protocol negotiation", () => {
  it("accepts every supported revision at bind and negotiates it in initialize", async () => {
    const services = buildHarness()

    try {
      for (const revision of SUPPORTED_PROTOCOL_REVISIONS) {
        const { endpoint } = await Effect.runPromise(bindEndpoint(services, "peer-" + revision))

        const reply = await initialize(endpoint, revision)

        expect(reply.kind).toBe("result")

        if (reply.kind === "result") {
          expect(fieldOf(reply.result, "protocolVersion")).toBe(revision)
        }

        await Effect.runPromise(endpoint.close())
      }
    } finally {
      await services.close()
    }
  })

  it("omitting the requested revision negotiates the default 2025-11-25", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const reply = await initialize(endpoint)

      expect(reply.kind).toBe("result")

      if (reply.kind === "result") {
        expect(fieldOf(reply.result, "protocolVersion")).toBe("2025-11-25")
      }
    } finally {
      await services.close()
    }
  })

  it("advertises resource subscriptions only when the transport can deliver them", async () => {
    const services = buildHarness()

    try {
      const plain = await Effect.runPromise(bindEndpoint(services, "alice"))
      const init = await initialize(plain.endpoint)

      const resources = asObject(asObject(fieldOf(resultPayload(init), "capabilities")).resources)

      expect(resources.subscribe).toBe(false)

      const capable = await Effect.runPromise(
        bindEndpoint(services, "bob", { supportsForms: false, supportsSubscriptions: true }),
      )

      const capableInit = await initialize(capable.endpoint)

      const capableResources = asObject(
        asObject(fieldOf(resultPayload(capableInit), "capabilities")).resources,
      )

      expect(capableResources.subscribe).toBe(true)
    } finally {
      await services.close()
    }
  })

  it("bind fails RevisionUnsupported for an unsupported peer revision", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { caller, conversation } = yield* admit(services, "alice")

          const failure = yield* Effect.flip(
            services.mcp.bind(services.view, caller, conversation, {
              supportsForms: false,
              protocolRevision: "1999-01-01",
            }),
          )

          expect(failure).toBeInstanceOf(RevisionUnsupported)

          if (failure instanceof RevisionUnsupported) {
            expect(failure.supported).toEqual([...SUPPORTED_PROTOCOL_REVISIONS])
          }
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("initialize with an unsupported requested revision answers a JSON-RPC error", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const reply = await initialize(endpoint, "1999-01-01")

      expect(reply.kind).toBe("error")

      if (reply.kind === "error") {
        expect(reply.message).toContain("unsupported protocol version")
      }
    } finally {
      await services.close()
    }
  })

  it("bind fails BindRefused when the caller does not own the conversation", async () => {
    const services = buildHarness()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alice = yield* admit(services, "alice")
          const bob = yield* admit(services, "bob")

          const failure = yield* Effect.flip(
            services.mcp.bind(services.view, alice.caller, bob.conversation, PEER),
          )

          expect(failure).toBeInstanceOf(BindRefused)
        }),
      )
    } finally {
      await services.close()
    }
  })

  it("initialize returns serverInfo, capabilities and dynamic instructions", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const reply = await initialize(endpoint, "2025-11-25")

      expect(reply.kind).toBe("result")

      if (reply.kind !== "result") return

      const serverInfo = asObject(fieldOf(reply.result, "serverInfo"))

      expect(serverInfo.name).toBe("droid-mcp-test")
      expect(serverInfo.version).toBe("9.9.9")

      const capabilities = asObject(fieldOf(reply.result, "capabilities"))

      expect(capabilities.tools).toBeDefined()
      expect(capabilities.resources).toBeDefined()
      expect(capabilities.prompts).toBeDefined()

      const instructions = stringOf(fieldOf(reply.result, "instructions"))

      expect(instructions).toBe(services.presentation.instructions(services.view))
      expect(instructions).toContain("tools_search")
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("mcp: tools/list", () => {
  it("compact view advertises direct tools plus the 5 dispatch tools with annotations", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const reply = await receive(endpoint, request(2, "tools/list"))
      const tools = asArray(fieldOf(resultPayload(reply), "tools"))
      const names = tools.map((tool) => stringOf(fieldOf(tool, "name")))

      expect(names).toContain("session_create")
      expect(names).toContain("session_stream")
      expect(names).toContain("tools_search")
      expect(names).toContain("tools_describe")
      expect(names).toContain("tool_call")
      expect(names).toContain("batch")
      expect(names).toContain("result_read")

      // Counts derive strictly from the assembled view: compact advertises
      // the installed direct names plus the five dispatch tools.
      expect(tools.length).toBe(services.view.toolCount)
      expect(tools.length).toBe(services.view.directNames.length + 5)

      const directNames = new Set<string>(services.view.directNames)

      for (const tool of tools) {
        const name = stringOf(fieldOf(tool, "name"))

        if (directNames.has(name)) {
          const annotations = asObject(fieldOf(tool, "annotations"))

          expect(Predicate.isBoolean(annotations.readOnlyHint ?? null)).toBe(true)
          expect(Predicate.isBoolean(annotations.destructiveHint ?? null)).toBe(true)
          expect(Predicate.isBoolean(annotations.idempotentHint ?? null)).toBe(true)
          expect(Predicate.isBoolean(annotations.openWorldHint ?? null)).toBe(true)
        }

        stringOf(fieldOf(tool, "description"))
        asObject(fieldOf(tool, "inputSchema"))
      }
    } finally {
      await services.close()
    }
  })

  it("full view advertises every installed operation and no dispatch tools", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice", PEER, "full"))

      const reply = await receive(endpoint, request(2, "tools/list"))
      const tools = asArray(fieldOf(resultPayload(reply), "tools"))
      const names = tools.map((tool) => stringOf(fieldOf(tool, "name")))

      expect(names).toContain("session_create")
      expect(names).toContain("session_fork")
      expect(names).not.toContain("tools_search")
      expect(names).not.toContain("tool_call")
    } finally {
      await services.close()
    }
  })

  it("meta-tools are unreachable in the full profile", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice", PEER, "full"))

      const reply = await callTool(endpoint, "tools_search", { query: "session" })

      expect(reply.kind).toBe("error")
      expect(errorData(reply).code).toBe("unknown_tool")
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Guidance gate acknowledgment
// ---------------------------------------------------------------------------

describe("mcp: guidance acknowledgment", () => {
  it("skill_read acknowledges the guidance gate only on successful root delivery", async () => {
    const services = buildHarness()

    try {
      const { endpoint, conversation } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect(hasReceipt(services, conversation)).toBe(false)

      const reply = await callTool(endpoint, "skill_read", {})

      expect(reply.kind).toBe("result")

      const payload = asObject(toolResult(reply))

      expect(stringOf(payload.uri ?? "")).toBe("skill://droid/SKILL.md")
      expect(stringOf(payload.markdown ?? "").length).toBeGreaterThan(100)

      expect(hasReceipt(services, conversation)).toBe(true)
    } finally {
      await services.close()
    }
  })

  it("reading skill://droid/SKILL.md acknowledges the gate", async () => {
    const services = buildHarness()

    try {
      const { endpoint, conversation } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect(hasReceipt(services, conversation)).toBe(false)

      const reply = await receive(
        endpoint,
        request(3, "resources/read", { uri: "skill://droid/SKILL.md" }),
      )

      expect(reply.kind).toBe("result")
      expect(textOfResource(reply).length).toBeGreaterThan(100)
      expect(hasReceipt(services, conversation)).toBe(true)
    } finally {
      await services.close()
    }
  })

  it("reference reads deliver content but leave the gate closed", async () => {
    const services = buildHarness()

    try {
      const { endpoint, conversation } = await Effect.runPromise(bindEndpoint(services, "alice"))

      for (const part of [
        "references/session-loop.md",
        "references/prompts.md",
        "references/delegation.md",
        "references/tool-families.md",
      ]) {
        const reply = await receive(
          endpoint,
          request(3, "resources/read", { uri: "skill://droid/" + part }),
        )

        expect(reply.kind).toBe("result")
        expect(textOfResource(reply).length).toBeGreaterThan(50)
        expect(hasReceipt(services, conversation)).toBe(false)
      }
    } finally {
      await services.close()
    }
  })

  it("prompts/get of droid acknowledges the gate on delivery", async () => {
    const services = buildHarness()

    try {
      const { endpoint, conversation } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect(hasReceipt(services, conversation)).toBe(false)

      const reply = await receive(endpoint, request(4, "prompts/get", { name: "droid" }))

      expect(reply.kind).toBe("result")

      const messages = asArray(fieldOf(resultPayload(reply), "messages"))

      expect(messages.length).toBe(1)
      expect(hasReceipt(services, conversation)).toBe(true)
    } finally {
      await services.close()
    }
  })

  it("skills/get of the root URI acknowledges the gate; other URIs do not", async () => {
    const services = buildHarness()

    try {
      const { endpoint, conversation } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect(hasReceipt(services, conversation)).toBe(false)

      const missing = await receive(
        endpoint,
        request(5, "skills/get", { uri: "skill://droid/other.md" }),
      )

      expect(missing.kind).toBe("error")
      expect(hasReceipt(services, conversation)).toBe(false)

      const reply = await receive(
        endpoint,
        request(6, "skills/get", { uri: "skill://droid/SKILL.md" }),
      )

      expect(reply.kind).toBe("result")
      expect(stringOf(fieldOf(resultPayload(reply), "content")).length).toBeGreaterThan(100)
      expect(hasReceipt(services, conversation)).toBe(true)
    } finally {
      await services.close()
    }
  })

  it("the guidance gate blocks session_create before any root delivery", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const reply = await callTool(endpoint, "session_create", {
        cwd: sandbox,
        autonomyLevel: "medium",
      })

      expect(reply.kind).toBe("result")
      expect(toolFailure(reply).code).toBe("guidance_required")
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Compact tools/call end-to-end
// ---------------------------------------------------------------------------

describe("mcp: compact dispatch end-to-end", () => {
  it("tools_search finds operations and tools_describe returns their schemas", async () => {
    const services = buildHarness()

    try {
      const { endpoint, conversation } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect(hasReceipt(services, conversation)).toBe(false)

      const search = await callTool(endpoint, "tools_search", { query: "session events" })

      expect(search.kind).toBe("result")

      const searchPayload = asObject(toolResult(search))
      const entries = asArray(searchPayload.tools ?? [])

      expect(entries.length).toBeGreaterThan(0)
      expect(numberOf(searchPayload.total ?? 0)).toBeGreaterThan(0)

      const names = entries.map((entry) => stringOf(fieldOf(entry, "name")))

      expect(names).toContain("session_events")

      // Discovery never opens the guidance gate.
      expect(hasReceipt(services, conversation)).toBe(false)

      const describe = await callTool(endpoint, "tools_describe", { names: ["session_events"] })

      expect(describe.kind).toBe("result")

      const describePayload = asObject(toolResult(describe))
      const described = asArray(describePayload.tools ?? [])

      expect(described.length).toBe(1)
      const firstDescribed = described[0]

      if (firstDescribed === undefined) throw new Error("expected one described tool")

      expect(stringOf(fieldOf(firstDescribed, "name"))).toBe("session_events")
      expect(asArray(describePayload.unknown ?? []).length).toBe(0)
    } finally {
      await services.close()
    }
  })

  it("tool_call runs an operation through the same pipeline with validation", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const unknown = await callTool(endpoint, "tool_call", {
        name: "no_such_operation",
        arguments: {},
      })

      expect(unknown.kind).toBe("result")
      expect(toolFailure(unknown).code).toBe("unknown_operation")

      const invalid = await callTool(endpoint, "tool_call", {
        name: "session_events",
        arguments: { sessionId: "", cursor: -1 },
      })

      expect(invalid.kind).toBe("result")
      expect(toolFailure(invalid).code).toBe("invalid_arguments")
    } finally {
      await services.close()
    }
  })

  it("batch runs steps in order and reports per-step outcomes", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect((await callTool(endpoint, "skill_read", {})).kind).toBe("result")

      const reply = await callTool(endpoint, "batch", {
        steps: [
          {
            id: "create",
            name: "session_create",
            arguments: { cwd: sandbox, autonomyLevel: "medium" },
          },
          {
            id: "list",
            name: "session_list",
            arguments: {},
          },
        ],
      })

      expect(reply.kind).toBe("result")

      const payload = asObject(toolResult(reply))

      expect(numberOf(payload.completed ?? 0)).toBe(2)
      expect(numberOf(payload.failed ?? 0)).toBe(0)

      const steps = asArray(payload.steps ?? [])

      expect(steps.length).toBe(2)
      expect(stringOf(fieldOf(steps[0] ?? null, "status"))).toBe("ok")
      expect(stringOf(fieldOf(steps[1] ?? null, "status"))).toBe("ok")

      const firstResult = asObject(fieldOf(steps[0] ?? null, "result"))
      const sessionId = stringOf(firstResult.sessionId ?? "")

      expect(sessionId.startsWith("sess-")).toBe(true)
    } finally {
      await services.close()
    }
  })

  it("rejects a malformed batch before executing any step", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))
      await readSkill(endpoint)

      const reply = await callTool(endpoint, "batch", {
        steps: [
          { name: "session_create", arguments: { cwd: sandbox, autonomyLevel: "medium" } },
          { name: "session_list", select: 42 },
        ],
        stopOnError: false,
      })

      expect(reply.kind).toBe("result")
      expect(toolFailure(reply).code).toBe("invalid_arguments")

      const listed = await callTool(endpoint, "session_list", {})
      expect(fieldOf(toolResult(listed), "sessions")).toEqual([])
    } finally {
      await services.close()
    }
  })

  it("large results return a continuation and result_read pages exact UTF-8 bytes", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect((await callTool(endpoint, "skill_read", {})).kind).toBe("result")

      const created = await callTool(endpoint, "session_create", {
        cwd: sandbox,
        autonomyLevel: "medium",
      })

      const sessionId = stringOf(fieldOf(toolResult(created), "sessionId"))

      // bulk:40 produces a large event payload well over maxBytes
      const streamed = await callTool(endpoint, "tool_call", {
        name: "session_stream",
        arguments: { sessionId, prompt: "bulk:40", waitMs: 5_000 },
        maxBytes: 1_024,
      })

      expect(streamed.kind).toBe("result")

      const envelope = asObject(toolResult(streamed))

      if (envelope.truncated !== true) {
        throw new Error("expected a truncated continuation envelope, got inline")
      }

      const ref = stringOf(envelope.ref ?? "")
      const totalBytes = numberOf(envelope.totalBytes ?? 0)

      expect(totalBytes).toBeGreaterThan(1_024)
      expect(stringOf(envelope.preview ?? "").length).toBeGreaterThan(0)

      // Page through the whole artifact; concatenation reproduces exact bytes.
      let offset = 0
      let assembled = ""

      for (let round = 0; round < 200; round += 1) {
        const page = await callTool(endpoint, "result_read", { ref, offset, length: 4_333 })

        expect(page.kind).toBe("result")

        const pagePayload = asObject(toolResult(page))

        assembled += stringOf(pagePayload.chunk ?? "")

        const next = pagePayload.nextOffset

        if (next === undefined || next === null) break

        offset = numberOf(next)
      }

      expect(assembled.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(assembled, "utf8")).toBe(totalBytes)

      // UTF-8 boundary discipline: an offset inside a multi-byte character
      // fails invalid_offset rather than corrupting output.
      const multiByte = await callTool(endpoint, "tool_call", {
        name: "session_stream",
        arguments: {
          sessionId,
          prompt: "echo:😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀",
          waitMs: 5_000,
        },
        maxBytes: 1_024,
      })

      void multiByte

      // caller isolation: a second endpoint for another caller cannot read ref
      const other = await Effect.runPromise(bindEndpoint(services, "bob"))

      expect((await callTool(other.endpoint, "skill_read", {})).kind).toBe("result")

      const foreign = await callTool(other.endpoint, "result_read", { ref, offset: 0 })

      expect(foreign.kind).toBe("result")
      expect(toolFailure(foreign).code).toBe("artifact_unavailable")

      // malformed refs are artifact_unavailable too
      const malformed = await callTool(endpoint, "result_read", { ref: "not-a-ref", offset: 0 })

      expect(malformed.kind).toBe("result")
      expect(toolFailure(malformed).code).toBe("artifact_unavailable")
    } finally {
      await services.close()
    }
  })

  it("an invalid select on a completed write returns invalid_select with a recovery ref", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect((await callTool(endpoint, "skill_read", {})).kind).toBe("result")

      const reply = await callTool(endpoint, "tool_call", {
        name: "session_create",
        arguments: { cwd: sandbox, autonomyLevel: "medium" },
        select: "/does/not/exist",
      })

      expect(reply.kind).toBe("result")

      const failure = toolFailure(reply)

      expect(failure.code).toBe("invalid_select")

      const recoveryRef = failure.ref

      if (recoveryRef === undefined) throw new Error("invalid_select carries no recovery ref")

      // The recovery ref reads the full finished result — the write ran
      // exactly once and must never be repeated.
      const recovered = await callTool(endpoint, "result_read", {
        ref: recoveryRef,
        offset: 0,
      })

      expect(recovered.kind).toBe("result")

      const chunk = stringOf(fieldOf(toolResult(recovered), "chunk"))

      expect(chunk).toContain("sess-")
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle over MCP frames
// ---------------------------------------------------------------------------

const readSkill = async (endpoint: McpEndpoint): Promise<void> => {
  const reply = await callTool(endpoint, "skill_read", {})

  if (reply.kind !== "result") throw new Error("skill_read failed")
}

const createSession = async (endpoint: McpEndpoint, autonomy: string): Promise<string> => {
  const reply = await callTool(endpoint, "session_create", {
    cwd: sandbox,
    autonomyLevel: autonomy,
  })

  if (reply.kind !== "result") throw new Error("session_create failed: " + JSON.stringify(reply))

  return stringOf(fieldOf(toolResult(reply), "sessionId"))
}

describe("mcp: session lifecycle over frames", () => {
  it("session_create, session_stream, session_events and session_close flow end-to-end", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      await readSkill(endpoint)

      const sessionId = await createSession(endpoint, "medium")

      expect(sessionId.startsWith("sess-")).toBe(true)

      const streamed = await callTool(endpoint, "session_stream", {
        sessionId,
        prompt: "hello",
        waitMs: 5_000,
      })

      expect(streamed.kind).toBe("result")

      const streamPayload = asObject(toolResult(streamed))

      expect(stringOf(streamPayload.status ?? "")).toBe("completed")

      const cursor = numberOf(streamPayload.cursor ?? -1)

      expect(cursor).toBeGreaterThan(0)

      // URI attached to the delivery
      expect(stringOf(streamPayload.uri ?? "")).toBe("droid://sessions/" + sessionId)

      // initial cursor 0 reads all events; reading at the returned cursor
      // produces no duplicates.
      const initial = await callTool(endpoint, "session_events", {
        sessionId,
        cursor: 0,
        waitMs: 0,
      })

      const initialPayload = asObject(toolResult(initial))
      const initialEvents = asArray(initialPayload.events ?? [])

      expect(initialEvents.length).toBeGreaterThan(0)

      const nextCursor = numberOf(initialPayload.cursor ?? -1)

      const drained = await callTool(endpoint, "session_events", {
        sessionId,
        cursor: nextCursor,
        waitMs: 0,
      })

      const drainedEvents = asArray(fieldOf(toolResult(drained), "events"))

      expect(drainedEvents.length).toBe(0)

      // invalid negative or non-integer cursors fail invalid_arguments
      const negative = await callTool(endpoint, "session_events", {
        sessionId,
        cursor: -1,
        waitMs: 0,
      })

      expect(negative.kind).toBe("result")
      expect(toolFailure(negative).code).toBe("invalid_arguments")

      const fractional = await callTool(endpoint, "session_events", {
        sessionId,
        cursor: 1.5,
        waitMs: 0,
      })

      expect(fractional.kind).toBe("result")
      expect(toolFailure(fractional).code).toBe("invalid_arguments")

      // a foreign/missing session is indistinguishable
      const missing = await callTool(endpoint, "session_events", {
        sessionId: "sess-does-not-exist",
        cursor: 0,
        waitMs: 0,
      })

      expect(missing.kind).toBe("result")
      expect(toolFailure(missing).code).toBe("not_visible")

      const closed = await callTool(endpoint, "session_close", { sessionId })

      expect(closed.kind).toBe("result")
      expect(fieldOf(toolResult(closed), "closed")).toBe(true)
    } finally {
      await services.close()
    }
  })

  it("an evicted cursor range reports truncated plus eventsOmitted honestly", async () => {
    const services = buildHarness({ maxEvents: 2 })

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      await readSkill(endpoint)

      const sessionId = await createSession(endpoint, "medium")

      // bulk:10 produces well over the 2-event retention limit while keeping
      // the retained window small enough to return inline.
      const streamed = await callTool(endpoint, "session_stream", {
        sessionId,
        prompt: "bulk:10",
        waitMs: 10_000,
      })

      expect(streamed.kind).toBe("result")

      const events = await callTool(endpoint, "session_events", {
        sessionId,
        cursor: 0,
        waitMs: 0,
      })

      const eventsPayload = asObject(toolResult(events))

      expect(eventsPayload.truncated).toBe(true)
      expect(numberOf(eventsPayload.omittedCount ?? 0)).toBeGreaterThan(0)
      expect(eventsPayload.eventsOmitted).toBe(true)

      // the events resource reports the same honest eviction
      const resource = await receive(
        endpoint,
        request(9, "resources/read", { uri: "droid://sessions/" + sessionId + "/events/0" }),
      )

      const resourceText = textOfResource(resource)
      const resourceBody = asObject(parseJson(resourceText))

      expect(resourceBody.truncated).toBe(true)
      expect(resourceBody.eventsOmitted).toBe(true)

      await callTool(endpoint, "session_close", { sessionId })
    } finally {
      await services.close()
    }
  })

  it("session events resource validates cursors and translates numeric positions", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      await readSkill(endpoint)

      const sessionId = await createSession(endpoint, "medium")

      await callTool(endpoint, "session_stream", { sessionId, prompt: "hello", waitMs: 5_000 })

      // invalid cursor text: negative or non-integer
      for (const badCursor of ["-1", "abc", "1.5"]) {
        const bad = await receive(
          endpoint,
          request(9, "resources/read", {
            uri: "droid://sessions/" + sessionId + "/events/" + badCursor,
          }),
        )

        expect(bad.kind).toBe("result")

        const body = asObject(parseJson(textOfResource(bad)))

        expect(body.error).toBe("invalid_cursor")
      }

      // valid cursor 0 returns events and the next cursor without duplicates
      const first = await receive(
        endpoint,
        request(9, "resources/read", { uri: "droid://sessions/" + sessionId + "/events/0" }),
      )

      const firstBody = asObject(parseJson(textOfResource(first)))
      const firstEvents = asArray(firstBody.events ?? [])

      expect(firstEvents.length).toBeGreaterThan(0)

      const nextCursor = numberOf(firstBody.cursor ?? -1)

      const second = await receive(
        endpoint,
        request(9, "resources/read", {
          uri: "droid://sessions/" + sessionId + "/events/" + String(nextCursor),
        }),
      )

      const secondBody = asObject(parseJson(textOfResource(second)))

      expect(asArray(secondBody.events ?? []).length).toBe(0)

      // a future cursor is handled cleanly
      const future = await receive(
        endpoint,
        request(9, "resources/read", {
          uri: "droid://sessions/" + sessionId + "/events/999999",
        }),
      )

      const futureBody = asObject(parseJson(textOfResource(future)))

      expect(asArray(futureBody.events ?? []).length).toBe(0)

      await callTool(endpoint, "session_close", { sessionId })
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Per-caller isolation
// ---------------------------------------------------------------------------

describe("mcp: per-caller isolation", () => {
  it("caller B sees none of caller A's sessions through resources or tools", async () => {
    const services = buildHarness()

    try {
      const alice = await Effect.runPromise(bindEndpoint(services, "alice"))
      const bob = await Effect.runPromise(bindEndpoint(services, "bob"))

      await readSkill(alice.endpoint)
      await readSkill(bob.endpoint)

      const sessionId = await createSession(alice.endpoint, "medium")

      // droid://sessions list: Bob sees zero sessions
      const bobList = await receive(
        bob.endpoint,
        request(3, "resources/read", { uri: "droid://sessions" }),
      )

      const bobListBody = asObject(parseJson(textOfResource(bobList)))

      expect(asArray(bobListBody.sessions ?? []).length).toBe(0)

      // Alice sees exactly one
      const aliceList = await receive(
        alice.endpoint,
        request(3, "resources/read", { uri: "droid://sessions" }),
      )

      const aliceListBody = asObject(parseJson(textOfResource(aliceList)))

      expect(asArray(aliceListBody.sessions ?? []).length).toBe(1)

      // Bob reading Alice's session detail gets session_not_found
      const foreign = await receive(
        bob.endpoint,
        request(3, "resources/read", { uri: "droid://sessions/" + sessionId }),
      )

      const foreignBody = asObject(parseJson(textOfResource(foreign)))

      expect(foreignBody.error).toBe("session_not_found")

      // identical shape for a missing id
      const missing = await receive(
        bob.endpoint,
        request(3, "resources/read", { uri: "droid://sessions/sess-missing" }),
      )

      const missingBody = asObject(parseJson(textOfResource(missing)))

      expect(missingBody.error).toBe(foreignBody.error)

      // Bob reading Alice's events gets session_not_found too
      const foreignEvents = await receive(
        bob.endpoint,
        request(3, "resources/read", { uri: "droid://sessions/" + sessionId + "/events/0" }),
      )

      const foreignEventsBody = asObject(parseJson(textOfResource(foreignEvents)))

      expect(foreignEventsBody.error).toBe("session_not_found")

      // Bob calling session_events on Alice's id fails identically to missing
      const foreignCall = await callTool(bob.endpoint, "session_events", {
        sessionId,
        cursor: 0,
        waitMs: 0,
      })

      expect(foreignCall.kind).toBe("result")
      expect(toolFailure(foreignCall).code).toBe("not_visible")

      await callTool(alice.endpoint, "session_close", { sessionId })
    } finally {
      await services.close()
    }
  })

  it("caller B's notifications receive nothing when caller A creates/updates/closes", async () => {
    const services = buildHarness()

    try {
      const alice = await Effect.runPromise(bindEndpoint(services, "alice"))
      const bob = await Effect.runPromise(bindEndpoint(services, "bob"))

      await readSkill(alice.endpoint)

      const aliceNotices: Array<Schema.Json> = []
      const bobNotices: Array<Schema.Json> = []

      const aliceWatcher = Effect.runSync(
        Effect.forkDetach(
          alice.endpoint.notifications().pipe(
            Stream.runForEach((notice) =>
              Effect.sync(() => {
                aliceNotices.push(notice.params)
              }),
            ),
          ),
        ),
      )

      const bobWatcher = Effect.runSync(
        Effect.forkDetach(
          bob.endpoint.notifications().pipe(
            Stream.runForEach((notice) =>
              Effect.sync(() => {
                bobNotices.push(notice.params)
              }),
            ),
          ),
        ),
      )

      // let the PubSub subscriptions attach
      await new Promise((resolve) => setTimeout(resolve, 50))

      const sessionId = await createSession(alice.endpoint, "medium")

      await callTool(alice.endpoint, "session_stream", {
        sessionId,
        prompt: "hello",
        waitMs: 5_000,
      })
      await callTool(alice.endpoint, "session_close", { sessionId })

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(bobNotices.length).toBe(0)
      expect(aliceNotices.length).toBeGreaterThan(0)

      const aliceUris = aliceNotices.map((params) => stringOf(asObject(params).uri ?? ""))

      expect(aliceUris.some((uri) => uri.includes(sessionId))).toBe(true)

      await Effect.runPromise(Fiber.interrupt(aliceWatcher))
      await Effect.runPromise(Fiber.interrupt(bobWatcher))
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Resource subscriptions
// ---------------------------------------------------------------------------

describe("mcp: resource subscriptions", () => {
  it("refuses subscribe on a transport that cannot deliver notifications", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const refusal = await receive(
        endpoint,
        request(5, "resources/subscribe", { uri: "droid://sessions" }),
      )

      expect(refusal.kind).toBe("error")

      if (refusal.kind === "error") {
        // JSON-RPC method not found: the capability is absent, not broken.
        expect(refusal.code).toBe(-32_601)
        expect(refusal.message).toContain("subscriptions")
      }

      const unsubscribe = await receive(
        endpoint,
        request(6, "resources/unsubscribe", { uri: "droid://sessions" }),
      )

      expect(unsubscribe.kind).toBe("result")
    } finally {
      await services.close()
    }
  })

  it("accepts subscribe on a subscription-capable transport", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(
        bindEndpoint(services, "alice", { supportsForms: false, supportsSubscriptions: true }),
      )

      const accepted = await receive(
        endpoint,
        request(5, "resources/subscribe", { uri: "droid://sessions" }),
      )

      expect(accepted.kind).toBe("result")

      const unsubscribe = await receive(
        endpoint,
        request(6, "resources/unsubscribe", { uri: "droid://sessions" }),
      )

      expect(unsubscribe.kind).toBe("result")
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Form elicitation
// ---------------------------------------------------------------------------

describe("mcp: form elicitation on blocking deliveries", () => {
  it("does not advertise forms when the peer has no elicit callback", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(
        bindEndpoint(services, "alice", { protocolRevision: "2025-11-25", supportsForms: true }),
      )

      const init = await initialize(endpoint, "2025-11-25")

      expect(init.kind).toBe("result")

      if (init.kind !== "result") throw new Error("expected initialize result")
      expect(asObject(fieldOf(init.result, "capabilities")).elicitation).toBeUndefined()

      await readSkill(endpoint)
      const sessionId = await createSession(endpoint, "medium")

      const streamed = await callTool(endpoint, "session_stream", {
        sessionId,
        prompt: "permission",
        delivery: "block",
        waitMs: 5_000,
      })

      const payload = asObject(toolResult(streamed))
      expect(payload.status).toBe("running")
      expect(asArray(payload.outstandingDecisions ?? [])).toHaveLength(1)

      await callTool(endpoint, "session_close", { sessionId })
    } finally {
      await services.close()
    }
  })

  it("forms-capable peer on 2025-11-25 answers a permission form and the turn completes", async () => {
    const services = buildHarness()

    try {
      const elicitCalls: Array<string> = []

      const peer: PeerAbilities = {
        protocolRevision: "2025-11-25",
        supportsForms: true,
        elicit: (request) =>
          Effect.sync(() => {
            elicitCalls.push(request.kind)

            return { kind: "permission", outcome: "proceed_once" } as const
          }),
      }

      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice", peer))

      await readSkill(endpoint)

      const sessionId = await createSession(endpoint, "medium")

      const streamed = await callTool(endpoint, "session_stream", {
        sessionId,
        prompt: "permission",
        delivery: "block",
        waitMs: 5_000,
      })

      expect(streamed.kind).toBe("result")

      const payload = asObject(toolResult(streamed))

      expect(elicitCalls.length).toBeGreaterThan(0)
      expect(stringOf(payload.status ?? "")).toBe("completed")

      await callTool(endpoint, "session_close", { sessionId })
    } finally {
      await services.close()
    }
  })

  it("sessionless 2026-07-28 never invokes elicit and returns the open decision honestly", async () => {
    const services = buildHarness()

    try {
      let elicitCount = 0

      const peer: PeerAbilities = {
        protocolRevision: SESSIONLESS_PROTOCOL_REVISION,
        supportsForms: true,
        elicit: () =>
          Effect.sync(() => {
            elicitCount += 1

            return { kind: "permission", outcome: "proceed_once" } as const
          }),
      }

      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice", peer))

      // sessionless revision: capabilities advertise no elicitation
      const init = await initialize(endpoint, SESSIONLESS_PROTOCOL_REVISION)

      if (init.kind === "result") {
        const capabilities = asObject(fieldOf(init.result, "capabilities"))

        expect(capabilities.elicitation).toBeUndefined()
      }

      await readSkill(endpoint)

      const sessionId = await createSession(endpoint, "medium")

      const streamed = await callTool(endpoint, "session_stream", {
        sessionId,
        prompt: "permission",
        delivery: "block",
        waitMs: 5_000,
      })

      expect(streamed.kind).toBe("result")

      const payload = asObject(toolResult(streamed))

      expect(elicitCount).toBe(0)
      expect(stringOf(payload.status ?? "")).toBe("running")

      const pending = asArray(payload.outstandingDecisions ?? [])

      expect(pending.length).toBe(1)

      // honestly open: the caller answers through session_respond_permission
      const requestId = stringOf(fieldOf(pending[0] ?? null, "requestId"))

      const answered = await callTool(endpoint, "session_respond_permission", {
        sessionId,
        requestId,
        outcome: "proceed_once",
      })

      expect(answered.kind).toBe("result")

      await callTool(endpoint, "session_close", { sessionId })
    } finally {
      await services.close()
    }
  })

  it("supportsForms false never invokes elicit even on a forms revision", async () => {
    const services = buildHarness()

    try {
      let elicitCount = 0

      const peer: PeerAbilities = {
        protocolRevision: "2025-11-25",
        supportsForms: false,
        elicit: () =>
          Effect.sync(() => {
            elicitCount += 1

            return { kind: "permission", outcome: "proceed_once" } as const
          }),
      }

      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice", peer))

      await readSkill(endpoint)

      const sessionId = await createSession(endpoint, "medium")

      const streamed = await callTool(endpoint, "session_stream", {
        sessionId,
        prompt: "permission",
        delivery: "block",
        waitMs: 5_000,
      })

      const payload = asObject(toolResult(streamed))

      expect(elicitCount).toBe(0)
      expect(stringOf(payload.status ?? "")).toBe("running")

      await callTool(endpoint, "session_close", { sessionId })
    } finally {
      await services.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Endpoint lifecycle
// ---------------------------------------------------------------------------

describe("mcp: endpoint lifecycle", () => {
  it("close stops notifications and receive fails EndpointClosed afterwards", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const notices: Array<Schema.Json> = []

      const watcher = Effect.runSync(
        Effect.forkDetach(
          endpoint.notifications().pipe(
            Stream.runForEach((notice) =>
              Effect.sync(() => {
                notices.push(notice.params)
              }),
            ),
          ),
        ),
      )

      await new Promise((resolve) => setTimeout(resolve, 20))

      expect((await receive(endpoint, request(1, "ping"))).kind).toBe("result")

      await Effect.runPromise(endpoint.close())

      const failure = await Effect.runPromise(Effect.flip(endpoint.receive(request(2, "ping"))))

      expect(failure).toBeInstanceOf(EndpointClosed)

      // the notifications stream ends cleanly after close
      await new Promise((resolve) => setTimeout(resolve, 50))

      await Effect.runPromise(Fiber.interrupt(watcher))
    } finally {
      await services.close()
    }
  })

  it("notifications/initialized and unknown notifications are accepted silently", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      expect((await receive(endpoint, notification("notifications/initialized"))).kind).toBe("ack")
      expect((await receive(endpoint, notification("notifications/cancelled"))).kind).toBe("ack")
    } finally {
      await services.close()
    }
  })

  it("returns a method-not-found error for an unknown request method", async () => {
    const services = buildHarness()

    try {
      const { endpoint } = await Effect.runPromise(bindEndpoint(services, "alice"))

      const unknown = await receive(endpoint, request(7, "no/such/method"))

      expect(unknown.kind).toBe("error")

      if (unknown.kind === "error") {
        expect(unknown.message).toContain("method not found")
      }
    } finally {
      await services.close()
    }
  })
})
