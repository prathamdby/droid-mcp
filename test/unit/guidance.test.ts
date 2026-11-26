import { Cause, Effect, Exit, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"

import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { Conversation } from "../../src/caller/index.ts"
import {
  CURRENT_GUIDE_EDITION,
  Guidance,
  guidanceLayer,
  GuidanceRequired,
  GuideMissing,
  ReceiptRejected,
} from "../../src/guidance/index.ts"
import type { GuidanceOptions } from "../../src/guidance/index.ts"

const REFERENCE_PARTS = [
  "references/session-loop.md",
  "references/prompts.md",
  "references/delegation.md",
  "references/tool-families.md",
] as const

const layerFor = (options?: GuidanceOptions) => Layer.merge(callersLayer(), guidanceLayer(options))

const run = <A, E>(effect: Effect.Effect<A, E, Guidance | Callers>, options?: GuidanceOptions) =>
  Effect.runPromise(Effect.provide(effect, layerFor(options)))

const runExit = <A, E>(
  effect: Effect.Effect<A, E, Guidance | Callers>,
  options?: GuidanceOptions,
) => Effect.runSyncExit(Effect.provide(effect, layerFor(options)))

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

const admitConversation = (principal: string, bindingId?: string) =>
  Effect.gen(function* () {
    const callers = yield* Callers
    const caller = yield* callers.admit(Option.getOrThrow(trustedEvidence(principal)))
    const binding = bindingId === undefined ? undefined : { bindingId }

    return yield* callers.conversation(caller, binding)
  })

const deliverRoot = (scope: Conversation) =>
  Effect.gen(function* () {
    const guidance = yield* Guidance
    const doc = yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
    const delivered = yield* guidance.confirmRootDelivery(doc)

    yield* guidance.acknowledge(scope, delivered)
  })

const prerequisite = { edition: CURRENT_GUIDE_EDITION }

describe("document retrieval", () => {
  it("returns the root document marked isRoot with real content", async () => {
    const doc = await run(
      Effect.flatMap(Guidance, (api) => api.document(CURRENT_GUIDE_EDITION, "SKILL.md")),
    )

    expect(doc.edition).toBe("droid-v1")
    expect(doc.part).toBe("SKILL.md")
    expect(doc.isRoot).toBe(true)
    expect(doc.content).toContain("# Droid")
    expect(doc.content).toContain("## Route once")
    expect(doc.content.length).toBeGreaterThan(1000)
  })

  it("returns all four reference documents marked non-root", async () => {
    for (const part of REFERENCE_PARTS) {
      const doc = await run(
        Effect.flatMap(Guidance, (api) => api.document(CURRENT_GUIDE_EDITION, part)),
      )

      expect(doc.part).toBe(part)
      expect(doc.isRoot).toBe(false)
      expect(doc.content.length).toBeGreaterThan(500)
    }
  })

  it("reference documents carry their distinct content", async () => {
    const loop = await run(
      Effect.flatMap(Guidance, (api) =>
        api.document(CURRENT_GUIDE_EDITION, "references/session-loop.md"),
      ),
    )

    const prompts = await run(
      Effect.flatMap(Guidance, (api) =>
        api.document(CURRENT_GUIDE_EDITION, "references/prompts.md"),
      ),
    )

    expect(loop.content).toContain("# Session loop")
    expect(prompts.content).toContain("# Prompts")
  })

  it("fails with GuideMissing for an unknown part", () => {
    const exit = runExit(
      Effect.flatMap(Guidance, (api) => api.document(CURRENT_GUIDE_EDITION, "references/nope.md")),
    )

    const error = failureOf(exit)

    expect(error).toBeInstanceOf(GuideMissing)

    if (error instanceof GuideMissing) {
      expect(error.part).toBe("references/nope.md")
      expect(error.edition).toBe("droid-v1")
    }
  })

  it("fails with GuideMissing for an unknown edition", () => {
    const exit = runExit(
      Effect.flatMap(Guidance, (api) =>
        // SAFETY: the test intentionally passes an out-of-range edition to
        // exercise the typed failure path.
        api.document("droid-v99" as typeof CURRENT_GUIDE_EDITION, "SKILL.md"),
      ),
    )

    const error = failureOf(exit)

    expect(error._tag).toBe("GuideMissing")
  })

  it("fails with GuideMissing when listing an unknown edition", () => {
    const exit = runExit(
      Effect.flatMap(Guidance, (api) =>
        // SAFETY: same intentional out-of-range probe as above.
        api.listParts("droid-v99" as typeof CURRENT_GUIDE_EDITION),
      ),
    )

    expect(failureOf(exit)._tag).toBe("GuideMissing")
  })
})

describe("listParts", () => {
  it("lists the root plus all four references in stable order", async () => {
    const parts = await run(Effect.flatMap(Guidance, (api) => api.listParts(CURRENT_GUIDE_EDITION)))

    expect(parts).toEqual(["SKILL.md", ...REFERENCE_PARTS])
  })
})

describe("reading alone never acknowledges", () => {
  it("reading SKILL.md does not satisfy check", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("reader")

        yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")

        return yield* guidance.check(scope, prerequisite)
      }),
    )

    const error = failureOf(exit)

    expect(error).toBeInstanceOf(GuidanceRequired)

    if (error instanceof GuidanceRequired) {
      expect(error.edition).toBe("droid-v1")
    }
  })

  it("listParts does not satisfy check", () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("lister")

        yield* guidance.listParts(CURRENT_GUIDE_EDITION)

        return yield* guidance.check(scope, prerequisite)
      }),
    )

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })

  it("hasReceipt is false after reads without acknowledgement", async () => {
    const result = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("passive")

        yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")

        return yield* guidance.hasReceipt(scope, prerequisite)
      }),
    )

    expect(result).toBe(false)
  })
})

describe("confirmRootDelivery", () => {
  it("rejects delivery confirmation of a reference document", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const doc = yield* guidance.document(CURRENT_GUIDE_EDITION, "references/prompts.md")

        return yield* guidance.confirmRootDelivery(doc)
      }),
    )

    const error = failureOf(exit)

    expect(error).toBeInstanceOf(ReceiptRejected)

    if (error instanceof ReceiptRejected) {
      expect(error.reason).toBe("not-root-delivery")
    }
  })

  it("rejects a forged root-shaped document with altered content", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const genuine = yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
        const forged = { ...genuine, content: genuine.content + "tampered" }

        return yield* guidance.confirmRootDelivery(forged)
      }),
    )

    expect(failureOf(exit)._tag).toBe("ReceiptRejected")
  })

  it("rejects a root document whose isRoot flag was forged", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance

        const reference = yield* guidance.document(
          CURRENT_GUIDE_EDITION,
          "references/delegation.md",
        )

        const forged = { ...reference, isRoot: true }

        return yield* guidance.confirmRootDelivery(forged)
      }),
    )

    expect(failureOf(exit)._tag).toBe("ReceiptRejected")
  })

  it("mints a proof for the genuine root document", async () => {
    const delivered = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const doc = yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")

        return yield* guidance.confirmRootDelivery(doc)
      }),
    )

    expect(delivered).toBeDefined()
  })

  it("confirming delivery without acknowledge does not satisfy check", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("confirmer")
        const doc = yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")

        yield* guidance.confirmRootDelivery(doc)

        return yield* guidance.check(scope, prerequisite)
      }),
    )

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })
})

describe("acknowledge and check scoping", () => {
  it("satisfies check for the exact acknowledged conversation", async () => {
    const result = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("primary", "binding-1")

        yield* deliverRoot(scope)
        yield* guidance.check(scope, prerequisite)

        return yield* guidance.hasReceipt(scope, prerequisite)
      }),
    )

    expect(result).toBe(true)
  })

  it("a different conversation of the same caller still fails check", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const callers = yield* Callers
        const caller = yield* callers.admit(Option.getOrThrow(trustedEvidence("multi")))
        const first = yield* callers.conversation(caller, { bindingId: "conv-1" })
        const second = yield* callers.conversation(caller, { bindingId: "conv-2" })

        yield* deliverRoot(first)

        return yield* guidance.check(second, prerequisite)
      }),
    )

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })

  it("a sessionless conversation of the same caller still fails check", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const callers = yield* Callers
        const caller = yield* callers.admit(Option.getOrThrow(trustedEvidence("mixed")))
        const bound = yield* callers.conversation(caller, { bindingId: "conv-x" })
        const sessionless = yield* callers.conversation(caller)

        yield* deliverRoot(bound)

        return yield* guidance.check(sessionless, prerequisite)
      }),
    )

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })

  it("a different caller with the same binding id still fails check", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const first = yield* admitConversation("caller-one", "shared-binding")
        const second = yield* admitConversation("caller-two", "shared-binding")

        yield* deliverRoot(first)

        return yield* guidance.check(second, prerequisite)
      }),
    )

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })

  it("each conversation can acknowledge independently", async () => {
    const result = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const first = yield* admitConversation("independent-1", "b-1")
        const second = yield* admitConversation("independent-2", "b-2")

        yield* deliverRoot(first)
        yield* deliverRoot(second)

        const a = yield* guidance.hasReceipt(first, prerequisite)
        const b = yield* guidance.hasReceipt(second, prerequisite)

        return { a, b }
      }),
    )

    expect(result).toEqual({ a: true, b: true })
  })
})

describe("LRU eviction", () => {
  it("evicts the least recently used receipt past the cap", async () => {
    const result = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const first = yield* admitConversation("lru-1", "lru-b1")
        const second = yield* admitConversation("lru-2", "lru-b2")
        const third = yield* admitConversation("lru-3", "lru-b3")

        yield* deliverRoot(first)
        yield* deliverRoot(second)
        yield* deliverRoot(third)

        const firstEvicted = !(yield* guidance.hasReceipt(first, prerequisite))
        const secondKept = yield* guidance.hasReceipt(second, prerequisite)
        const thirdKept = yield* guidance.hasReceipt(third, prerequisite)

        return { firstEvicted, secondKept, thirdKept }
      }),
      { maxReceipts: 2 },
    )

    expect(result).toEqual({ firstEvicted: true, secondKept: true, thirdKept: true })
  })

  it("an evicted conversation fails check with GuidanceRequired", async () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const first = yield* admitConversation("evicted", "ev-b1")
        const second = yield* admitConversation("holder-2", "ev-b2")
        const third = yield* admitConversation("holder-3", "ev-b3")

        yield* deliverRoot(first)
        yield* deliverRoot(second)
        yield* deliverRoot(third)

        return yield* guidance.check(first, prerequisite)
      }),
      { maxReceipts: 2 },
    )

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })

  it("rechecking refreshes recency so a newer receipt is evicted instead", async () => {
    const result = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const first = yield* admitConversation("refreshed", "re-b1")
        const second = yield* admitConversation("stale", "re-b2")
        const third = yield* admitConversation("newcomer", "re-b3")

        yield* deliverRoot(first)
        yield* deliverRoot(second)

        // Refresh `first` so `second` becomes the least recently used.
        yield* guidance.check(first, prerequisite)
        yield* deliverRoot(third)

        const firstKept = yield* guidance.hasReceipt(first, prerequisite)
        const secondEvicted = !(yield* guidance.hasReceipt(second, prerequisite))
        const thirdKept = yield* guidance.hasReceipt(third, prerequisite)

        return { firstKept, secondEvicted, thirdKept }
      }),
      { maxReceipts: 2 },
    )

    expect(result).toEqual({ firstKept: true, secondEvicted: true, thirdKept: true })
  })

  it("repeated acknowledgement of one conversation counts once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const repeated = yield* admitConversation("repeat", "rep-b1")
        const other = yield* admitConversation("other", "rep-b2")

        yield* deliverRoot(repeated)
        yield* deliverRoot(repeated)
        yield* deliverRoot(other)

        const repeatedKept = yield* guidance.hasReceipt(repeated, prerequisite)
        const otherKept = yield* guidance.hasReceipt(other, prerequisite)

        return { repeatedKept, otherKept }
      }),
      { maxReceipts: 2 },
    )

    expect(result).toEqual({ repeatedKept: true, otherKept: true })
  })
})

describe("required option", () => {
  it("required: false lets check pass without any receipt", async () => {
    await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("ungated")

        yield* guidance.check(scope, prerequisite)
      }),
      { required: false },
    )
  })

  it("required: false does not create receipts implicitly", async () => {
    const result = await run(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("ungated-probe")

        yield* guidance.check(scope, prerequisite)

        return yield* guidance.hasReceipt(scope, prerequisite)
      }),
      { required: false },
    )

    expect(result).toBe(false)
  })

  it("default options keep the gate closed without acknowledgement", () => {
    const exit = runExit(
      Effect.gen(function* () {
        const guidance = yield* Guidance
        const scope = yield* admitConversation("default-gated")

        return yield* guidance.check(scope, prerequisite)
      }),
    )

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })
})

describe("layer isolation", () => {
  it("independent layer instances never share receipts", async () => {
    const establish = Effect.gen(function* () {
      const scope = yield* admitConversation("isolated")

      yield* deliverRoot(scope)

      return scope
    })

    const scope = await Effect.runPromise(Effect.provide(establish, layerFor()))

    const probe = Effect.gen(function* () {
      const guidance = yield* Guidance
      const callers = yield* Callers
      const caller = yield* callers.admit(Option.getOrThrow(trustedEvidence("isolated")))

      const rebound = yield* callers.conversation(caller)

      expect(String(rebound.id)).toBe(String(scope.id))

      return yield* guidance.check(rebound, prerequisite)
    })

    const exit = Effect.runSyncExit(Effect.provide(probe, layerFor()))

    expect(failureOf(exit)._tag).toBe("GuidanceRequired")
  })
})
