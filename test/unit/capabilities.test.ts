import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import { Authority, authorityLayer, Evidence } from "../../src/authority/index.ts"
import type { Demand } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { CallersApi, Conversation, TargetRef } from "../../src/caller/index.ts"
import {
  Capabilities,
  capabilitiesLayer,
  type Definition,
  DeniedFailure,
  DuplicateIdentity,
  InvalidEntry,
  InvalidInput,
  OperationConflict,
  PeerFailure,
  withReplacedDescription,
} from "../../src/capabilities/index.ts"
import type { Invocation } from "../../src/capabilities/index.ts"
import {
  Disclosure,
  disclosureLayer,
  ReleasePayload,
  releasedJson,
  releasedPayload,
} from "../../src/disclosure/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import type { GuidanceApi } from "../../src/guidance/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeServices = (options?: {
  readonly maxAutonomy?: "off" | "low" | "medium" | "high"
  readonly allowUnverifiedDaemonAuthority?: boolean
  readonly guidanceRequired?: boolean
  readonly protectedValues?: ReadonlyArray<string>
  readonly allowedTargets?: ReadonlyArray<
    "local" | "daemon" | "hosted" | "context" | "session" | "system"
  >
}) => {
  const disclosureLive = disclosureLayer({ protectedValues: options?.protectedValues })
  const callersLive = callersLayer({ allowedTargets: options?.allowedTargets })

  const authorityLive = authorityLayer({
    maxAutonomy: options?.maxAutonomy ?? "high",
    allowUnverifiedDaemonAuthority: options?.allowUnverifiedDaemonAuthority,
  })

  const guidanceLive = guidanceLayer({ required: options?.guidanceRequired })

  const capabilitiesLive = Layer.provideMerge(
    capabilitiesLayer,
    Layer.merge(Layer.merge(callersLive, authorityLive), Layer.merge(guidanceLive, disclosureLive)),
  )

  const merged = Layer.mergeAll(
    capabilitiesLive,
    callersLive,
    authorityLive,
    guidanceLive,
    disclosureLive,
  )

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const capabilities = yield* Capabilities
        const callers = yield* Callers
        const authority = yield* Authority
        const guidance = yield* Guidance
        const disclosure = yield* Disclosure

        return { capabilities, callers, authority, guidance, disclosure }
      }),
      merged,
    ),
  )
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

const runEffect = <A, E>(program: Effect.Effect<A, E, never>): Exit.Exit<A, E> =>
  Effect.runSyncExit(program)

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

interface ReadInput {
  readonly path: string
}

interface ReadOutput {
  readonly contents: string
}

interface WriteInput {
  readonly path: string
  readonly contents: string
  readonly token?: string
}

interface WriteOutput {
  readonly bytesWritten: number
}

const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

const readAnnotations = { ...annotations, readOnlyHint: true }

const daemonTarget: TargetRef = { kind: "daemon", id: "daemon-1" }

const ReadInputSchema = Schema.Struct({ path: Schema.String })

const WriteInputSchema = Schema.Struct({
  path: Schema.String,
  contents: Schema.String,
  token: Schema.optional(Schema.String),
})

const decodeWith = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: Schema.Json,
  invalidMessage: string,
): Effect.Effect<S["Type"], InvalidInput> => {
  const decoded = Schema.decodeUnknownOption(schema)(input)

  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new InvalidInput({ message: invalidMessage }))
}

const readDefinition = (
  perform: Definition<ReadInput, ReadOutput>["perform"],
): Definition<ReadInput, ReadOutput> => ({
  facts: {
    id: "read_file",
    aliases: ["read", "get_file"],
    family: "daemon",
    description: "Read a file from disk",
    inputSchema: { type: "object" },
    effect: "read",
    replay: "safe_read",
    annotations: readAnnotations,
  },
  decode: (input) =>
    decodeWith(ReadInputSchema, input, "input must be an object with a string path"),
  target: () => daemonTarget,
  demand: (): Demand => ({ effect: "read" }),
  perform,
  classify: (_input, output) => ({
    payload: ReleasePayload.JsonValue({ value: { contents: output.contents } }),
  }),
})

const writeDefinition = (
  perform: Definition<WriteInput, WriteOutput>["perform"],
  options?: {
    readonly prerequisite?: { readonly edition: "droid-v1" }
    readonly sensitiveValues?: ReadonlyArray<string>
    readonly demand?: (input: WriteInput) => Demand
  },
): Definition<WriteInput, WriteOutput> => {
  const baseFacts = {
    id: "write_file",
    family: "daemon" as const,
    description: "Write a file to disk",
    inputSchema: { type: "object" },
    effect: "write" as const,
    replay: "no_retry" as const,
    annotations,
  }

  const facts =
    options?.prerequisite !== undefined
      ? { ...baseFacts, prerequisite: options.prerequisite }
      : baseFacts

  return {
    facts,
    decode: (input) =>
      decodeWith(WriteInputSchema, input, "input must be an object with string path and contents"),
    target: () => daemonTarget,
    demand: options?.demand ?? ((): Demand => ({ effect: "write" })),
    perform,
    classify: (input, output) => ({
      payload: ReleasePayload.JsonValue({ value: { bytesWritten: output.bytesWritten } }),
      sensitiveValues: options?.sensitiveValues ?? (input.token !== undefined ? [input.token] : []),
    }),
  }
}

const succeedRead =
  (contents: string): Definition<ReadInput, ReadOutput>["perform"] =>
  () =>
    Effect.succeed({ contents })

const succeedWrite: Definition<WriteInput, WriteOutput>["perform"] = (_grant, input) =>
  Effect.succeed({ bytesWritten: input.contents.length })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("binding and assembly", () => {
  it("binds a read op and a write op with incompatible types into one catalog without casts", () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("hello")))
    const write = services.capabilities.bind(writeDefinition(succeedWrite))

    const catalog = Effect.runSync(services.capabilities.assemble([read, write]))

    expect(catalog.size).toBe(2)
  })

  it("rejects a duplicate canonical id with DuplicateIdentity", () => {
    const services = makeServices()
    const first = services.capabilities.bind(readDefinition(succeedRead("a")))
    const second = services.capabilities.bind(readDefinition(succeedRead("b")))

    const exit = runEffect(services.capabilities.assemble([first, second]))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(DuplicateIdentity)

    if (error instanceof DuplicateIdentity) {
      expect(error.id).toBe("read_file")
    }
  })

  it.each([
    { aliases: ["dup", "dup"], key: "dup" },
    { aliases: ["write_file"], key: "write_file" },
  ])("rejects duplicate key $key within a single entry", ({ aliases, key }) => {
    const { capabilities } = makeServices()
    const definition = writeDefinition(succeedWrite)
    const entry = capabilities.bind({ ...definition, facts: { ...definition.facts, aliases } })

    const error = expectFailure(runEffect(capabilities.assemble([entry])))

    expect(error).toBeInstanceOf(DuplicateIdentity)
    expect(error).toMatchObject({ id: key })
  })

  it("rejects a colliding alias with DuplicateIdentity", () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("a")))

    // write_file has no aliases, so craft a definition whose alias collides
    // with read_file's canonical id.
    const colliding = services.capabilities.bind({
      ...writeDefinition(succeedWrite),
      facts: { ...writeDefinition(succeedWrite).facts, aliases: ["read_file"] },
    })

    const exit = runEffect(services.capabilities.assemble([read, colliding]))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(DuplicateIdentity)

    if (error instanceof DuplicateIdentity) {
      expect(error.id).toBe("read_file")
    }
  })

  it("rejects two operations sharing one alias", () => {
    const services = makeServices()

    const makeAliased = (id: string) =>
      services.capabilities.bind({
        ...writeDefinition(succeedWrite),
        facts: { ...writeDefinition(succeedWrite).facts, id, aliases: ["shared_alias"] },
      })

    const exit = runEffect(
      services.capabilities.assemble([makeAliased("op_a"), makeAliased("op_b")]),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(DuplicateIdentity)

    if (error instanceof DuplicateIdentity) {
      expect(error.id).toBe("shared_alias")
    }
  })

  it("rejects a blank id with InvalidEntry", () => {
    const services = makeServices()

    const blank = services.capabilities.bind({
      ...writeDefinition(succeedWrite),
      facts: { ...writeDefinition(succeedWrite).facts, id: "   " },
    })

    const exit = runEffect(services.capabilities.assemble([blank]))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(InvalidEntry)

    if (error instanceof InvalidEntry) {
      expect(error.reason).toBe("blank-id")
    }
  })

  it("rejects a blank alias with InvalidEntry", () => {
    const services = makeServices()

    const blankAlias = services.capabilities.bind({
      ...writeDefinition(succeedWrite),
      facts: { ...writeDefinition(succeedWrite).facts, aliases: ["  "] },
    })

    const exit = runEffect(services.capabilities.assemble([blankAlias]))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(InvalidEntry)

    if (error instanceof InvalidEntry) {
      expect(error.reason).toBe("blank-alias")
    }
  })
})

describe("invocation order and gates", () => {
  it("fails with InvalidInput before the guidance gate and never calls perform", () => {
    const services = makeServices({ guidanceRequired: true })
    let performed = false

    const gated = services.capabilities.bind(
      writeDefinition(
        () => {
          performed = true

          return Effect.succeed({ bytesWritten: 0 })
        },
        { prerequisite: { edition: CURRENT_GUIDE_EDITION } },
      ),
    )

    const catalog = Effect.runSync(services.capabilities.assemble([gated]))
    const who = makeInvocation(services.callers, "operator")

    // Invalid input: contents missing. Guidance is NOT acknowledged. If the
    // order were wrong this would fail with GuidanceRequired instead.
    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/tmp/x" }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(InvalidInput)
    expect(performed).toBe(false)
  })

  it("blocks valid input at the guidance gate until acknowledge succeeds for that conversation", () => {
    const services = makeServices({ guidanceRequired: true })
    let performed = false

    const gated = services.capabilities.bind(
      writeDefinition(
        (_grant, input) => {
          performed = true

          return Effect.succeed({ bytesWritten: input.contents.length })
        },
        { prerequisite: { edition: CURRENT_GUIDE_EDITION } },
      ),
    )

    const catalog = Effect.runSync(services.capabilities.assemble([gated]))
    const who = makeInvocation(services.callers, "operator")
    const input = { path: "/tmp/x", contents: "data" }

    const blocked = runEffect(services.capabilities.invoke(catalog, who, "write_file", input))
    const gateError = expectFailure(blocked)

    expect(gateError._tag).toBe("GuidanceRequired")
    expect(performed).toBe(false)

    deliverRoot(services.guidance, who.conversation)

    const allowed = runEffect(services.capabilities.invoke(catalog, who, "write_file", input))

    expect(Exit.isSuccess(allowed)).toBe(true)
    expect(performed).toBe(true)
  })

  it("a guidance receipt in one conversation does not leak into another", () => {
    const services = makeServices({ guidanceRequired: true })

    const gated = services.capabilities.bind(
      writeDefinition(succeedWrite, { prerequisite: { edition: CURRENT_GUIDE_EDITION } }),
    )

    const catalog = Effect.runSync(services.capabilities.assemble([gated]))

    const first = makeInvocation(services.callers, "operator")

    const second = Effect.runSync(
      Effect.gen(function* () {
        const caller = yield* services.callers.admit(Option.getOrThrow(trustedEvidence("operator")))

        return {
          caller,
          conversation: yield* services.callers.conversation(caller, { bindingId: "other" }),
        }
      }),
    )

    deliverRoot(services.guidance, first.conversation)

    const input = { path: "/tmp/x", contents: "data" }
    const firstExit = runEffect(services.capabilities.invoke(catalog, first, "write_file", input))

    expect(Exit.isSuccess(firstExit)).toBe(true)

    const secondExit = runEffect(services.capabilities.invoke(catalog, second, "write_file", input))
    const error = expectFailure(secondExit)

    expect(error._tag).toBe("GuidanceRequired")
  })

  it("authority denial precedes perform entirely", () => {
    const services = makeServices({ maxAutonomy: "low" })
    let performed = false

    const write = services.capabilities.bind(
      writeDefinition(
        () => {
          performed = true

          return Effect.succeed({ bytesWritten: 0 })
        },
        { demand: () => ({ effect: "write", skipPermissionsUnsafe: true }) },
      ),
    )

    const catalog = Effect.runSync(services.capabilities.assemble([write]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/tmp/x", contents: "d" }),
    )

    const error = expectFailure(exit)

    expect(error._tag).toBe("Denied")
    expect(performed).toBe(false)
  })

  it("requested level above the ceiling is denied before perform", () => {
    const services = makeServices({ maxAutonomy: "medium" })
    let performed = false

    const write = services.capabilities.bind(
      writeDefinition(
        () => {
          performed = true

          return Effect.succeed({ bytesWritten: 0 })
        },
        { demand: () => ({ effect: "write", requestedLevel: "high" }) },
      ),
    )

    const catalog = Effect.runSync(services.capabilities.assemble([write]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/tmp/x", contents: "d" }),
    )

    const error = expectFailure(exit)

    expect(error._tag).toBe("Denied")
    expect(performed).toBe(false)
  })

  it("authority_unverifiable precedes perform for unprovable evidence", () => {
    const services = makeServices({ allowUnverifiedDaemonAuthority: false })
    let performed = false

    const unprovable: Definition<WriteInput, WriteOutput> = {
      ...writeDefinition(() => {
        performed = true

        return Effect.succeed({ bytesWritten: 0 })
      }),
      evidence: () =>
        Effect.succeed(
          Evidence.Unprovable({
            ceiling: "high",
            reason: "load_session state cannot be proven",
            operationKind: "load_session",
          }),
        ),
    }

    const write = services.capabilities.bind(unprovable)
    const catalog = Effect.runSync(services.capabilities.assemble([write]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/tmp/x", contents: "d" }),
    )

    const error = expectFailure(exit)

    expect(error._tag).toBe("authority_unverifiable")
    expect(performed).toBe(false)
  })

  it("an unknown id fails with OperationNotFound before decoding", () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("x")))
    const catalog = Effect.runSync(services.capabilities.assemble([read]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(services.capabilities.invoke(catalog, who, "nope", {}))
    const error = expectFailure(exit)

    expect(error._tag).toBe("OperationNotFound")
  })
})

describe("aliases and discovery", () => {
  it("invoking through an alias resolves to the same operation", () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("via-alias")))
    const catalog = Effect.runSync(services.capabilities.assemble([read]))
    const who = makeInvocation(services.callers, "operator")

    const byCanonical = runEffect(
      services.capabilities.invoke(catalog, who, "read_file", { path: "/a" }),
    )

    const byAlias = runEffect(services.capabilities.invoke(catalog, who, "read", { path: "/a" }))

    expect(Exit.isSuccess(byCanonical)).toBe(true)
    expect(Exit.isSuccess(byAlias)).toBe(true)

    if (Exit.isSuccess(byCanonical) && Exit.isSuccess(byAlias)) {
      expect(releasedJson(byCanonical.value)).toEqual(releasedJson(byAlias.value))
      expect(releasedJson(byAlias.value)).toEqual(Option.some({ contents: "via-alias" }))
    }
  })

  it("available lists each canonical operation exactly once, not once per alias", async () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("x")))
    const write = services.capabilities.bind(writeDefinition(succeedWrite))
    const catalog = Effect.runSync(services.capabilities.assemble([read, write]))
    const who = makeInvocation(services.callers, "operator")

    const listed = await Effect.runPromise(services.capabilities.available(catalog, who))

    expect(listed.length).toBe(2)
    expect(listed.map((entry) => entry.id).sort()).toEqual(["read_file", "write_file"])

    const readEntry = listed.find((entry) => entry.id === "read_file")

    expect(readEntry?.aliases).toEqual(["read", "get_file"])
  })

  it("describe resolves both the canonical id and any alias", async () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("x")))
    const catalog = Effect.runSync(services.capabilities.assemble([read]))
    const who = makeInvocation(services.callers, "operator")

    const canonical = await Effect.runPromise(
      services.capabilities.describe(catalog, who, "read_file"),
    )

    const aliased = await Effect.runPromise(
      services.capabilities.describe(catalog, who, "get_file"),
    )

    expect(canonical.id).toBe("read_file")
    expect(aliased.id).toBe("read_file")
    expect(canonical).toEqual(aliased)
  })

  it("describe fails with NotVisible for an unknown id", () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("x")))
    const catalog = Effect.runSync(services.capabilities.assemble([read]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(services.capabilities.describe(catalog, who, "missing"))
    const error = expectFailure(exit)

    expect(error._tag).toBe("NotVisible")
  })

  it("describe marks requiresGuidance only for gated operations", async () => {
    const services = makeServices()
    const read = services.capabilities.bind(readDefinition(succeedRead("x")))

    const gated = services.capabilities.bind(
      writeDefinition(succeedWrite, { prerequisite: { edition: CURRENT_GUIDE_EDITION } }),
    )

    const catalog = Effect.runSync(services.capabilities.assemble([read, gated]))
    const who = makeInvocation(services.callers, "operator")

    const plain = await Effect.runPromise(services.capabilities.describe(catalog, who, "read_file"))

    const gatedView = await Effect.runPromise(
      services.capabilities.describe(catalog, who, "write_file"),
    )

    expect(plain.requiresGuidance).toBe(false)
    expect(gatedView.requiresGuidance).toBe(true)
  })
})

describe("delegation gate", () => {
  it("an unavailable target kind fails as OperationNotVisible before perform", () => {
    const services = makeServices({ allowedTargets: ["local"] })
    let performed = false

    const write = services.capabilities.bind(
      writeDefinition(() => {
        performed = true

        return Effect.succeed({ bytesWritten: 0 })
      }),
    )

    const catalog = Effect.runSync(services.capabilities.assemble([write]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/x", contents: "d" }),
    )

    const error = expectFailure(exit)

    expect(error._tag).toBe("OperationNotVisible")
    expect(performed).toBe(false)
  })
})

describe("disclosure integration", () => {
  it("classify-declared sensitive values are scrubbed from the success payload", () => {
    const services = makeServices()

    const echo: Definition<WriteInput, WriteOutput> = {
      ...writeDefinition(succeedWrite),
      perform: (_grant, input) => Effect.succeed({ bytesWritten: input.contents.length }),
      classify: (input) => ({
        payload: ReleasePayload.JsonValue({
          value: { echo: "wrote with token " + (input.token ?? "none") },
        }),
        sensitiveValues: input.token !== undefined ? [input.token] : [],
      }),
    }

    const bound = services.capabilities.bind(echo)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", {
        path: "/x",
        contents: "d",
        token: "tok-secret-123",
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)

    if (Exit.isSuccess(exit)) {
      const json = releasedJson(exit.value)

      expect(Option.isSome(json)).toBe(true)

      if (Option.isSome(json)) {
        expect(JSON.stringify(json.value)).not.toContain("tok-secret-123")
        expect(JSON.stringify(json.value)).toContain("[REDACTED]")
      }
    }
  })

  it("error messages are scrubbed through the error audience before surfacing", () => {
    const services = makeServices({ protectedValues: ["supersecret"] })
    let performed = false

    const failing: Definition<WriteInput, WriteOutput> = {
      ...writeDefinition(() => {
        performed = true

        return Effect.fail(
          new PeerFailure({
            code: "PEER_ERR",
            message: "peer rejected the write with key supersecret embedded",
            detail: "the token supersecret must never cross",
          }),
        )
      }),
    }

    const bound = services.capabilities.bind(failing)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/x", contents: "d" }),
    )

    const error = expectFailure(exit)

    expect(performed).toBe(true)
    expect(error).toBeInstanceOf(PeerFailure)

    if (error instanceof PeerFailure) {
      expect(error.message).not.toContain("supersecret")
      expect(error.message).toContain("[REDACTED]")
      expect(error.detail ?? "").not.toContain("supersecret")
    }
  })

  it("protected binary output fails with ProtectedBytes and never crosses", () => {
    const services = makeServices()

    const mediaOp: Definition<ReadInput, ReadOutput> = {
      ...readDefinition(succeedRead("binary")),
      classify: () => ({
        payload: ReleasePayload.Media({
          media: {
            contentType: "application/octet-stream",
            bytes: new Uint8Array([1, 2]),
            protected: true,
          },
        }),
      }),
    }

    const bound = services.capabilities.bind(mediaOp)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(services.capabilities.invoke(catalog, who, "read_file", { path: "/x" }))
    const error = expectFailure(exit)

    expect(error._tag).toBe("ProtectedBytes")
  })

  it("an empty payload stays Empty and is never coerced to JSON null", () => {
    const services = makeServices()

    const emptyOp: Definition<ReadInput, ReadOutput> = {
      ...readDefinition(succeedRead("")),
      classify: () => ({ payload: ReleasePayload.Empty() }),
    }

    const bound = services.capabilities.bind(emptyOp)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(services.capabilities.invoke(catalog, who, "read_file", { path: "/x" }))

    expect(Exit.isSuccess(exit)).toBe(true)

    if (Exit.isSuccess(exit)) {
      expect(releasedPayload(exit.value)._tag).toBe("Empty")
      expect(releasedJson(exit.value)).toEqual(Option.none())
    }
  })

  it("an explicit JSON null payload stays null and is not coerced to Empty", () => {
    const services = makeServices()

    const nullOp: Definition<ReadInput, ReadOutput> = {
      ...readDefinition(succeedRead("")),
      classify: () => ({ payload: ReleasePayload.JsonValue({ value: null }) }),
    }

    const bound = services.capabilities.bind(nullOp)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(services.capabilities.invoke(catalog, who, "read_file", { path: "/x" }))

    expect(Exit.isSuccess(exit)).toBe(true)

    if (Exit.isSuccess(exit)) {
      expect(releasedPayload(exit.value)._tag).toBe("JsonValue")
      expect(releasedJson(exit.value)).toEqual(Option.some(null))
    }
  })

  it("conflict failures preserve their safe conflict fields while scrubbing the message", () => {
    const services = makeServices({ protectedValues: ["hidden-key"] })

    const conflicting: Definition<WriteInput, WriteOutput> = {
      ...writeDefinition(() =>
        Effect.fail(
          new OperationConflict({
            message: "write conflicted; hidden-key was present",
            currentVersion: "v7",
            currentSequence: "42",
          }),
        ),
      ),
    }

    const bound = services.capabilities.bind(conflicting)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/x", contents: "d" }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(OperationConflict)

    if (error instanceof OperationConflict) {
      expect(error.currentVersion).toBe("v7")
      expect(error.currentSequence).toBe("42")
      expect(error.message).not.toContain("hidden-key")
    }
  })
})

describe("structural proof: description replacement", () => {
  it("withReplacedDescription changes only the description, never facts or behavior", async () => {
    const services = makeServices({ guidanceRequired: true })

    const original = services.capabilities.bind(
      writeDefinition(succeedWrite, { prerequisite: { edition: CURRENT_GUIDE_EDITION } }),
    )

    const replaced = withReplacedDescription(original, "COMPLETELY UNRELATED TEXT")

    expect(replaced.facts.description).toBe("COMPLETELY UNRELATED TEXT")
    expect(replaced.facts.id).toBe(original.facts.id)
    expect(replaced.facts.effect).toBe(original.facts.effect)
    expect(replaced.facts.replay).toBe(original.facts.replay)
    expect(replaced.facts.annotations).toEqual(original.facts.annotations)
    expect(replaced.facts.prerequisite).toEqual(original.facts.prerequisite)
    expect(replaced.facts.inputSchema).toEqual(original.facts.inputSchema)

    // Grants, denials and gates behave identically for the same input matrix.
    const catalogA = Effect.runSync(services.capabilities.assemble([original]))
    const who = makeInvocation(services.callers, "operator")
    const input = { path: "/x", contents: "d" }

    const blockedA = runEffect(services.capabilities.invoke(catalogA, who, "write_file", input))

    expect(expectFailure(blockedA)._tag).toBe("GuidanceRequired")

    const catalogB = Effect.runSync(services.capabilities.assemble([replaced]))
    const blockedB = runEffect(services.capabilities.invoke(catalogB, who, "write_file", input))

    expect(expectFailure(blockedB)._tag).toBe("GuidanceRequired")

    deliverRoot(services.guidance, who.conversation)

    const allowedA = runEffect(services.capabilities.invoke(catalogA, who, "write_file", input))
    const allowedB = runEffect(services.capabilities.invoke(catalogB, who, "write_file", input))

    expect(Exit.isSuccess(allowedA)).toBe(true)
    expect(Exit.isSuccess(allowedB)).toBe(true)

    // Discovery reflects only the new description; all other fields equal.
    const describedA = await Effect.runPromise(
      services.capabilities.describe(catalogA, who, "write_file"),
    )

    const describedB = await Effect.runPromise(
      services.capabilities.describe(catalogB, who, "write_file"),
    )

    expect(describedB.description).toBe("COMPLETELY UNRELATED TEXT")
    expect(describedA.description).not.toBe(describedB.description)
    expect({ ...describedA, description: "" }).toEqual({ ...describedB, description: "" })
  })

  it("denial outcomes are unchanged when every description is replaced", () => {
    const services = makeServices({ maxAutonomy: "low" })

    const original = services.capabilities.bind(
      writeDefinition(succeedWrite, {
        demand: () => ({ effect: "write", skipPermissionsUnsafe: true }),
      }),
    )

    const replaced = withReplacedDescription(original, "rewritten")

    const input = { path: "/x", contents: "d" }
    const who = makeInvocation(services.callers, "operator")

    const catalogA = Effect.runSync(services.capabilities.assemble([original]))
    const catalogB = Effect.runSync(services.capabilities.assemble([replaced]))

    const denialA = expectFailure(
      runEffect(services.capabilities.invoke(catalogA, who, "write_file", input)),
    )

    const denialB = expectFailure(
      runEffect(services.capabilities.invoke(catalogB, who, "write_file", input)),
    )

    expect(denialA).toBeInstanceOf(DeniedFailure)
    expect(denialB).toBeInstanceOf(DeniedFailure)

    if (denialA instanceof DeniedFailure && denialB instanceof DeniedFailure) {
      expect(denialA.reason).toBe(denialB.reason)
      expect(denialA.ceiling).toBe(denialB.ceiling)
    }
  })
})

describe("heterogeneous typing", () => {
  it("decode output types stay distinct per operation inside one catalog", () => {
    const services = makeServices()

    const read = services.capabilities.bind(readDefinition(succeedRead("read-result")))
    const write = services.capabilities.bind(writeDefinition(succeedWrite))
    const catalog = Effect.runSync(services.capabilities.assemble([read, write]))
    const who = makeInvocation(services.callers, "operator")

    // The read input has only `path`; the write input requires `contents` too.
    // Passing the write shape to the read op must decode by the read op's own
    // codec, proving the entries never share a handler signature.
    const readExit = runEffect(
      services.capabilities.invoke(catalog, who, "read_file", { path: "/a" }),
    )

    const writeExit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/a", contents: "zz" }),
    )

    expect(Exit.isSuccess(readExit)).toBe(true)
    expect(Exit.isSuccess(writeExit)).toBe(true)

    if (Exit.isSuccess(writeExit)) {
      expect(releasedJson(writeExit.value)).toEqual(Option.some({ bytesWritten: 2 }))
    }

    // The read codec rejects a missing path even when other fields are valid
    // for the write op.
    const badRead = runEffect(
      services.capabilities.invoke(catalog, who, "read_file", { contents: "x" }),
    )

    const error = expectFailure(badRead)

    expect(error).toBeInstanceOf(InvalidInput)
  })

  it("grant reaches perform with the decided level and verified bit", () => {
    const services = makeServices({ maxAutonomy: "high" })
    let observed: { level: string; verified: boolean } | undefined

    const observing: Definition<WriteInput, WriteOutput> = {
      ...writeDefinition((grant) => {
        observed = { level: grant.effectiveLevel, verified: grant.verified }

        return Effect.succeed({ bytesWritten: 1 })
      }),
      demand: () => ({ effect: "write", requestedLevel: "medium" }),
    }

    const bound = services.capabilities.bind(observing)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/x", contents: "d" }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(observed).toEqual({ level: "medium", verified: true })
  })

  it("custom evidence is used when the definition supplies it", () => {
    const services = makeServices({ maxAutonomy: "high" })
    let evidenceUsed = false

    const custom: Definition<WriteInput, WriteOutput> = {
      ...writeDefinition(succeedWrite),
      evidence: () => {
        evidenceUsed = true

        return Effect.succeed(Evidence.Explicit({ ceiling: "medium" }))
      },
      demand: () => ({ effect: "write", requestedLevel: "high" }),
    }

    const bound = services.capabilities.bind(custom)
    const catalog = Effect.runSync(services.capabilities.assemble([bound]))
    const who = makeInvocation(services.callers, "operator")

    const exit = runEffect(
      services.capabilities.invoke(catalog, who, "write_file", { path: "/x", contents: "d" }),
    )

    const error = expectFailure(exit)

    // The custom evidence ceiling of medium denies the requested high level,
    // proving the custom evidence — not the default — reached the decision.
    expect(evidenceUsed).toBe(true)
    expect(error._tag).toBe("Denied")
  })
})
