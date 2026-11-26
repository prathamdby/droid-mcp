import { createHash } from "node:crypto"

import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"

import {
  Callers,
  callersLayer,
  createBearerVerifier,
  sameCaller,
  trustedEvidence,
} from "../../src/caller/index.ts"
import type { ConversationBinding, ResourceRef, TargetRef } from "../../src/caller/index.ts"
import { DelegationUnavailable, NotVisible, OwnershipConflict } from "../../src/caller/index.ts"

const keyA = "test-key-96528"
const keyB = "test-key-133576"

// These two keys share the same first 8 hex digest characters (`eee04fd0`).
const digestA = createHash("sha256").update(keyA).digest("hex")
const digestB = createHash("sha256").update(keyB).digest("hex")

const verifier = createBearerVerifier([keyA, keyB])

const run = <A, E>(
  effect: Effect.Effect<A, E, Callers>,
  options?: Parameters<typeof callersLayer>[0],
) => Effect.runPromise(Effect.provide(effect, callersLayer(options)))

describe("bearer verifier", () => {
  it("accepts Bearer, bearer and BEARER case-insensitively", () => {
    expect(Option.isSome(verifier.verify("Bearer " + keyA))).toBe(true)
    expect(Option.isSome(verifier.verify("bearer " + keyA))).toBe(true)
    expect(Option.isSome(verifier.verify("BEARER " + keyA))).toBe(true)
  })

  it("trims whitespace around the presented key", () => {
    expect(Option.isSome(verifier.verify("Bearer   " + keyA + "   "))).toBe(true)
  })

  it("ignores blank keys in the key list", () => {
    const ring = createBearerVerifier(["", "   ", keyA])

    expect(ring.size).toBe(1)
    expect(Option.isSome(ring.verify("Bearer " + keyA))).toBe(true)
  })

  it("rejects a missing or malformed header", () => {
    expect(Option.isNone(verifier.verify(undefined))).toBe(true)
    expect(Option.isNone(verifier.verify(""))).toBe(true)
    expect(Option.isNone(verifier.verify("Basic " + keyA))).toBe(true)
    expect(Option.isNone(verifier.verify("Bearer"))).toBe(true)
    expect(Option.isNone(verifier.verify("Bearer   "))).toBe(true)
  })

  it("rejects a wrong key", () => {
    expect(Option.isNone(verifier.verify("Bearer wrong-key"))).toBe(true)
  })
})

describe("trusted evidence", () => {
  it("admits a non-blank principal", () => {
    expect(Option.isSome(trustedEvidence("stdio-user"))).toBe(true)
  })

  it("rejects empty and whitespace-only names", () => {
    expect(Option.isNone(trustedEvidence(""))).toBe(true)
    expect(Option.isNone(trustedEvidence("   "))).toBe(true)
  })
})

describe("admission", () => {
  it("distinguishes two keys with the same 8-hex digest prefix", async () => {
    expect(digestA.slice(0, 8)).toBe(digestB.slice(0, 8))
    expect(digestA).not.toBe(digestB)

    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))

      return { a, b }
    })

    const { a, b } = await run(program)

    expect(sameCaller(a, b)).toBe(false)
    expect(sameCaller(a, a)).toBe(true)
  })

  it("displayLabel never exposes raw key or digest hex", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const bearer = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const trusted = yield* svc.admit(Option.getOrThrow(trustedEvidence("operator")))

      return { bearer, trusted }
    })

    const { bearer, trusted } = await run(program)

    expect(bearer.displayLabel).not.toContain(keyA)
    expect(bearer.displayLabel).not.toContain(digestA)
    expect(bearer.displayLabel).not.toContain(digestA.slice(0, 8))
    expect(trusted.displayLabel).not.toContain("operator")
  })
})

describe("conversation binding", () => {
  it.each([":", " "])(
    "keeps principal and binding boundaries distinct for %j",
    async (separator) => {
      const [first, second] = await run(
        Effect.gen(function* () {
          const svc = yield* Callers
          const a = yield* svc.admit(Option.getOrThrow(trustedEvidence(`a${separator}b`)))
          const b = yield* svc.admit(Option.getOrThrow(trustedEvidence("a")))
          const first = yield* svc.conversation(a, { bindingId: "c" })
          const second = yield* svc.conversation(b, { bindingId: `b${separator}c` })

          return [first, second]
        }),
      )

      expect(first.id).not.toBe(second.id)
    },
  )

  it("no binding returns an explicit sessionless scope unique to the caller", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))
      const ca = yield* svc.conversation(a)
      const cb = yield* svc.conversation(b)

      return { ca, cb }
    })

    const { ca, cb } = await run(program)

    expect(ca.sessionless).toBe(true)
    expect(cb.sessionless).toBe(true)
    expect(String(ca.id)).not.toBe(String(cb.id))
  })

  it("same bindingId yields distinct conversations for distinct callers", async () => {
    const binding: ConversationBinding = { bindingId: "shared-binding" }

    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))
      const ca = yield* svc.conversation(a, binding)
      const cb = yield* svc.conversation(b, binding)

      return { ca, cb }
    })

    const { ca, cb } = await run(program)

    expect(ca.sessionless).toBe(false)
    expect(String(ca.id)).not.toBe(String(cb.id))
  })
})

describe("ownership in default mode", () => {
  const artifact: ResourceRef = { kind: "artifact", id: "art-1" }

  it("a foreign resource is indistinguishable from an absent one", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))
      const ownership = yield* svc.own(a, artifact)
      const foreignAccess = yield* Effect.flip(svc.access(b, artifact, "read"))

      const absentAccess = yield* Effect.flip(
        svc.access(b, { kind: "artifact", id: "nope" }, "read"),
      )

      return { ownership, foreignAccess, absentAccess }
    })

    const { foreignAccess, absentAccess } = await run(program)

    expect(foreignAccess).toBeInstanceOf(NotVisible)
    expect(absentAccess).toBeInstanceOf(NotVisible)
    expect(foreignAccess.resourceKind).toBe(absentAccess.resourceKind)
    expect(foreignAccess._tag).toBe(absentAccess._tag)
  })

  it("owner can access, foreign caller cannot", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))
      yield* svc.own(a, artifact)
      const ownAccess = yield* svc.access(a, artifact, "read")
      const foreign = yield* Effect.flip(svc.access(b, artifact, "read"))

      return { ownAccess, foreign }
    })

    const { ownAccess, foreign } = await run(program)

    expect(ownAccess.resource).toEqual(artifact)
    expect(foreign).toBeInstanceOf(NotVisible)
  })

  it("double own fails with OwnershipConflict", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      yield* svc.own(a, artifact)

      return yield* Effect.flip(svc.own(a, artifact))
    })

    const conflict = await run(program)

    expect(conflict).toBeInstanceOf(OwnershipConflict)
    expect(conflict.resourceId).toBe("art-1")
  })

  it("revoke removes access for the owner", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      yield* svc.own(a, artifact)
      yield* svc.revoke(a, artifact)

      return yield* Effect.flip(svc.access(a, artifact, "read"))
    })

    const failure = await run(program)

    expect(failure).toBeInstanceOf(NotVisible)
  })

  it("foreign caller cannot revoke", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))
      yield* svc.own(a, artifact)

      return yield* Effect.flip(svc.revoke(b, artifact))
    })

    const failure = await run(program)

    expect(failure).toBeInstanceOf(NotVisible)
  })
})

describe("sharedSessions mode", () => {
  const session: ResourceRef = { kind: "session", id: "sess-1" }
  const artifact: ResourceRef = { kind: "artifact", id: "art-1" }
  const workspace: ResourceRef = { kind: "workspace", id: "ws-1" }

  it("foreign caller can access a session but not artifact or workspace", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))
      yield* svc.own(a, session)
      yield* svc.own(a, artifact)
      yield* svc.own(a, workspace)

      const sessionAccess = yield* svc.access(b, session, "read")
      const artifactFail = yield* Effect.flip(svc.access(b, artifact, "read"))
      const workspaceFail = yield* Effect.flip(svc.access(b, workspace, "read"))

      return { sessionAccess, artifactFail, workspaceFail }
    })

    const { sessionAccess, artifactFail, workspaceFail } = await run(program, {
      sharedSessions: true,
    })

    expect(sessionAccess.resource).toEqual(session)
    expect(artifactFail).toBeInstanceOf(NotVisible)
    expect(workspaceFail).toBeInstanceOf(NotVisible)
  })

  it("default mode keeps sessions strictly per-caller", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))
      const b = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyB)))
      yield* svc.own(a, session)

      return yield* Effect.flip(svc.access(b, session, "read"))
    })

    const failure = await run(program)

    expect(failure).toBeInstanceOf(NotVisible)
  })
})

describe("delegation", () => {
  it("grants scoped rights for allowed targets", async () => {
    const target: TargetRef = { kind: "daemon", id: "daemon-1" }

    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))

      return yield* svc.delegate(a, target)
    })

    const delegation = await run(program)

    expect(delegation.target).toEqual(target)
    expect(delegation.rights.has("invoke")).toBe(true)
  })

  it("returns DelegationUnavailable for disallowed targets", async () => {
    const target: TargetRef = { kind: "system", id: "sys-1" }

    const program = Effect.gen(function* () {
      const svc = yield* Callers
      const a = yield* svc.admit(Option.getOrThrow(verifier.verify("Bearer " + keyA)))

      return yield* Effect.flip(svc.delegate(a, target))
    })

    const failure = await run(program, { allowedTargets: ["local", "daemon"] })

    expect(failure).toBeInstanceOf(DelegationUnavailable)
    expect(failure.targetKind).toBe("system")
  })
})
