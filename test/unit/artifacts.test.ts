import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import {
  Artifacts,
  type ArtifactRef,
  type ArtifactsApi,
  artifactsLayer,
  Delivery,
  parseArtifactRef,
} from "../../src/artifacts/index.ts"
import type { Caller } from "../../src/caller/index.ts"
import {
  Disclosure,
  type DisclosureApi,
  disclosureLayer,
  ReleasePayload,
  type Released,
  releasedJson,
} from "../../src/disclosure/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeServices = (options?: {
  readonly aggregateByteLimit?: number
  readonly singleValueByteLimit?: number
  readonly ttlMs?: number
  readonly now?: () => number
  readonly protectedValues?: ReadonlyArray<string>
}) => {
  // The artifacts layer must see the same disclosure instance the test
  // drives, so both are built from one composition.
  const disclosureLive = disclosureLayer({ protectedValues: options?.protectedValues })
  const artifactsLive = Layer.provideMerge(artifactsLayer(options), disclosureLive)
  const merged = Layer.merge(artifactsLive, disclosureLive)

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts
        const disclosure = yield* Disclosure

        return { artifacts, disclosure }
      }),
      merged,
    ),
  )
}

const trustedCaller = (name: string): Caller =>
  // SAFETY: test callers only need a stable identity for sameCaller
  // comparisons; the brand is compile-time-only and admission semantics are
  // covered by the caller module's own tests.
  ({
    id: ("trusted:" + name) as Caller["id"],
    kind: "trusted",
    displayLabel: name,
  }) as Caller

const releaseJson = (
  disclosure: DisclosureApi,
  value: Schema.Json,
  recipientId = "client-1",
): Promise<Released<"client">> =>
  Effect.runPromise(
    Effect.flatMap(disclosure.audience("client", recipientId), (audience) =>
      disclosure.release({ payload: ReleasePayload.JsonValue({ value }) }, audience),
    ),
  )

const encodeLength = (text: string): number => new TextEncoder().encode(text).length

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

const runEffect = <A, E>(program: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(program)

const isPreview = Delivery.$is("Preview")
const isInline = Delivery.$is("Inline")

type PreviewDelivery = Extract<Delivery, { readonly _tag: "Preview" }>

/** Narrows a delivery to its Preview variant or throws. */
const expectPreview = (delivery: Delivery): PreviewDelivery => {
  if (!isPreview(delivery)) throw new Error("expected preview, got " + delivery._tag)

  return delivery
}

/** Pages the entire artifact starting at offset 0 and concatenates chunks. */
const readAll = async (
  artifacts: ArtifactsApi,
  caller: Caller,
  ref: ArtifactRef,
  length: number,
): Promise<string> => {
  let offset = 0
  let assembled = ""

  for (;;) {
    const page = await runEffect(artifacts.read(caller, ref, { offset, length }))

    assembled += page.chunk

    if (page.done || page.nextOffset === null) return assembled

    expect(page.nextOffset).toBeGreaterThan(offset)
    offset = page.nextOffset
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseArtifactRef", () => {
  it("accepts the minted shape", () => {
    expect(Option.isSome(parseArtifactRef("res_abcdefghijklmnop"))).toBe(true)
  })

  it("rejects malformed refs", () => {
    expect(Option.isNone(parseArtifactRef(""))).toBe(true)
    expect(Option.isNone(parseArtifactRef("res_"))).toBe(true)
    expect(Option.isNone(parseArtifactRef("res_short"))).toBe(true)
    expect(Option.isNone(parseArtifactRef("other_abcdefghijklmnop"))).toBe(true)
    expect(Option.isNone(parseArtifactRef("res_abcdefghijklmnop!"))).toBe(true)
  })
})

describe("present", () => {
  it("delivers inline when within the byte budget", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("inline-user")
    const released = await releaseJson(disclosure, { note: "small" })

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 16_384 }))

    expect(isInline(delivery)).toBe(true)

    if (isInline(delivery)) {
      expect(delivery.bytes).toBe(encodeLength(JSON.stringify({ note: "small" })))
      expect(delivery.value).toBe(released)
    }
  })

  it("delivers a preview plus ref when over the byte budget", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("preview-user")
    const big = { data: "x".repeat(20_000) }
    const released = await releaseJson(disclosure, big)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))

    expect(isPreview(delivery)).toBe(true)

    if (isPreview(delivery)) {
      expect(delivery.truncated).toBe(true)
      expect(delivery.totalBytes).toBe(encodeLength(JSON.stringify(big)))
      expect(Option.isSome(parseArtifactRef(delivery.ref))).toBe(true)
      expect(encodeLength(delivery.preview)).toBeLessThanOrEqual(1_024)
    }
  })

  it("clamps the inline budget to the minimum when a smaller maxBytes is given", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("clamp-user")
    // 500 bytes of JSON: under MIN_INLINE_BYTES (1024), so it stays inline
    // even though maxBytes 100 asks for less.
    const value = { data: "y".repeat(450) }
    const released = await releaseJson(disclosure, value)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 100 }))

    expect(isInline(delivery)).toBe(true)
  })

  it("fails with SelectionFailed when the value is not a JSON payload", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("empty-user")
    const audience = await Effect.runPromise(disclosure.audience("client", "client-1"))

    const empty = await Effect.runPromise(
      disclosure.release({ payload: ReleasePayload.Empty() }, audience),
    )

    const outcome = Effect.runSyncExit(artifacts.present(caller, empty, {}))

    const error = expectFailure(outcome)

    expect(Predicate.isTagged("SelectionFailed")(error)).toBe(true)
  })
})

describe("read paging", () => {
  it("advances by one complete UTF-8 character when the requested page is too short", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("short-page-user")
    const value = "😀" + "x".repeat(2_000)
    const released = await releaseJson(disclosure, value)

    const { ref } = expectPreview(
      await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 })),
    )

    // Skip the opening quote in the encoded JSON string.
    const page = await runEffect(artifacts.read(caller, ref, { offset: 1, length: 1 }))

    expect(page).toMatchObject({ chunk: "😀", offset: 1, nextOffset: 5, done: false })
    expect(await readAll(artifacts, caller, ref, 1)).toBe(JSON.stringify(value))
  })

  it("reassembles multi-page ASCII text byte-for-byte", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("page-user")
    const big = { data: "abcdef".repeat(4_000) }
    const released = await releaseJson(disclosure, big)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)
    const assembled = await readAll(artifacts, caller, preview.ref, 997)

    expect(assembled).toBe(JSON.stringify(big))
    expect(encodeLength(assembled)).toBe(preview.totalBytes)
  })

  it("reassembles multi-byte UTF-8 across page splits byte-for-byte", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("utf8-user")
    // Mix of 4-byte emoji characters guarantees page splits land inside
    // multi-byte characters at some offsets.
    const text = "🚀✨😀".repeat(600)
    const big = { data: text }
    const released = await releaseJson(disclosure, big)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)
    const expected = JSON.stringify(big)
    const totalBytes = encodeLength(expected)

    // Page with a length that does not align to any character boundary.
    const assembled = await readAll(artifacts, caller, preview.ref, 1_000)

    expect(assembled).toBe(expected)
    expect(encodeLength(assembled)).toBe(totalBytes)
  })

  it("rejects a mid-character offset with InvalidRange", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("midchar-user")
    // Pad past the inline budget so the value is retained, with a 4-byte
    // emoji at a known position.
    const big = { pad: "w".repeat(2_000), data: "😀" }
    const released = await releaseJson(disclosure, big)
    const text = JSON.stringify(big)
    const bytes = new TextEncoder().encode(text)
    // Find the first continuation byte of the emoji inside the JSON text.
    const emojiStart = text.indexOf("😀")
    const prefixBytes = encodeLength(text.slice(0, emojiStart))
    const midOffset = prefixBytes + 1

    expect(bytes[midOffset] & 0xc0).toBe(0x80)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    const exit = Effect.runSyncExit(artifacts.read(caller, preview.ref, { offset: midOffset }))
    const error = expectFailure(exit)

    expect(Predicate.isTagged("InvalidRange")(error)).toBe(true)

    if (Predicate.isTagged("InvalidRange")(error)) {
      expect(error.reason).toBe("offset_mid_character")
    }
  })

  it("rejects negative and out-of-bounds offsets", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("bounds-user")
    const released = await releaseJson(disclosure, { data: "z".repeat(2_000) })

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    const negative = Effect.runSyncExit(artifacts.read(caller, preview.ref, { offset: -1 }))

    expect(Predicate.isTagged("InvalidRange")(expectFailure(negative))).toBe(true)

    const beyond = Effect.runSyncExit(
      artifacts.read(caller, preview.ref, { offset: preview.totalBytes + 1 }),
    )

    expect(Predicate.isTagged("InvalidRange")(expectFailure(beyond))).toBe(true)
  })

  it("allows an exact end offset and reports done with an empty chunk", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("end-user")
    const released = await releaseJson(disclosure, { data: "q".repeat(2_000) })

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    const page = await runEffect(
      artifacts.read(caller, preview.ref, { offset: preview.totalBytes }),
    )

    expect(page.done).toBe(true)
    expect(page.nextOffset).toBeNull()
    expect(page.chunk).toBe("")
  })

  it("pages a selected member from the requested offset", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("select-page-user")
    const big = { data: "abcdef".repeat(1_000) }
    const released = await releaseJson(disclosure, big)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    const expected = JSON.stringify(big.data)
    const totalBytes = encodeLength(expected)

    let offset = 1
    let assembled = ""

    for (;;) {
      const page = await runEffect(
        artifacts.read(caller, preview.ref, { select: "/data", offset, length: 997 }),
      )

      expect(page.offset).toBe(offset)
      assembled += page.chunk

      if (page.done || page.nextOffset === null) {
        expect(page.totalBytes).toBe(totalBytes)
        break
      }

      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }

    expect(assembled).toBe(expected.slice(1))
  })

  it("rejects out-of-bounds and mid-character offsets inside a selected member", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("select-bounds-user")
    const big = { pad: "w".repeat(2_000), data: "😀" }
    const released = await releaseJson(disclosure, big)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    // The selected member's exact encoding is "😀": quote, 4 emoji bytes,
    // quote — 6 bytes total.
    expect(encodeLength(JSON.stringify(big.data))).toBe(6)

    const beyond = Effect.runSyncExit(
      artifacts.read(caller, preview.ref, { select: "/data", offset: 7, length: 10 }),
    )

    const beyondError = expectFailure(beyond)

    expect(Predicate.isTagged("InvalidRange")(beyondError)).toBe(true)

    if (Predicate.isTagged("InvalidRange")(beyondError)) {
      expect(beyondError.reason).toBe("offset_out_of_bounds")
      expect(beyondError.totalBytes).toBe(6)
    }

    const mid = Effect.runSyncExit(
      artifacts.read(caller, preview.ref, { select: "/data", offset: 2, length: 10 }),
    )

    const midError = expectFailure(mid)

    expect(Predicate.isTagged("InvalidRange")(midError)).toBe(true)

    if (Predicate.isTagged("InvalidRange")(midError)) {
      expect(midError.reason).toBe("offset_mid_character")
      expect(midError.offset).toBe(2)
    }
  })

  it("keeps the first and last pages consistent with nextOffset chaining", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("chain-user")
    const big = { items: [1, 2, 3, "four", { five: "5".repeat(3_000) }] }
    const released = await releaseJson(disclosure, big)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    const first = await runEffect(artifacts.read(caller, preview.ref, { offset: 0, length: 512 }))

    expect(first.offset).toBe(0)
    expect(first.done).toBe(false)
    expect(first.nextOffset).not.toBeNull()
    expect(first.nextOffset).toBeLessThanOrEqual(512)

    const last = await runEffect(
      artifacts.read(caller, preview.ref, {
        offset: preview.totalBytes - 10,
        length: 512,
      }),
    )

    expect(last.done).toBe(true)
    expect(last.nextOffset).toBeNull()
    expect(last.chunk).toBe(JSON.stringify(big).slice(-10))
  })
})

describe("single-value retention bound", () => {
  it("exact fit is retained and one byte over fails with ArtifactTooLarge carrying no ref", async () => {
    // The single-value limit sits just above the max inline budget so values
    // at this scale take the retention path. The exact-fit versus
    // one-byte-over arithmetic is the spec case.
    const singleLimit = 262_144 + 100
    const { artifacts, disclosure } = makeServices({ singleValueByteLimit: singleLimit })
    const caller = trustedCaller("bound-user")

    // Exact fit at the single-value limit succeeds.
    const exactJson = { b: "y".repeat(singleLimit - encodeLength(JSON.stringify({ b: "" }))) }

    expect(encodeLength(JSON.stringify(exactJson))).toBe(singleLimit)

    const exact = await releaseJson(disclosure, exactJson)
    const exactDelivery = await runEffect(artifacts.present(caller, exact, { maxBytes: 262_144 }))

    expect(isPreview(exactDelivery)).toBe(true)

    // One byte over the limit fails with ArtifactTooLarge carrying no ref.
    const overJson = { c: "z".repeat(singleLimit + 1 - encodeLength(JSON.stringify({ c: "" }))) }

    expect(encodeLength(JSON.stringify(overJson))).toBe(singleLimit + 1)

    const over = await releaseJson(disclosure, overJson)
    const exit = Effect.runSyncExit(artifacts.present(caller, over, { maxBytes: 262_144 }))
    const error = expectFailure(exit)

    expect(Predicate.isTagged("ArtifactTooLarge")(error)).toBe(true)

    if (Predicate.isTagged("ArtifactTooLarge")(error)) {
      expect(error.bytes).toBe(singleLimit + 1)
      expect(error.limit).toBe(singleLimit)
    }

    // The failure shape carries no ref at all.
    expect("ref" in Object(error)).toBe(false)
  })

  it("a failed over-limit insertion never evicts an existing entry", async () => {
    const singleLimit = 262_144 + 1_000
    const { artifacts, disclosure } = makeServices({ singleValueByteLimit: singleLimit })
    const caller = trustedCaller("noevict-user")

    // A 262_145-byte value (1 byte over the max inline budget) is retained.
    const skeleton = JSON.stringify({ e: "" })
    const keptJson = { e: "k".repeat(262_145 - encodeLength(skeleton)) }

    expect(encodeLength(JSON.stringify(keptJson))).toBe(262_145)

    const kept = await releaseJson(disclosure, keptJson)
    const keptDelivery = await runEffect(artifacts.present(caller, kept, { maxBytes: 262_144 }))
    const keptPreview = expectPreview(keptDelivery)

    // Now present a value 1 byte over the single-value limit.
    const overJson = { f: "o".repeat(singleLimit + 1 - encodeLength(JSON.stringify({ f: "" }))) }

    expect(encodeLength(JSON.stringify(overJson))).toBe(singleLimit + 1)

    const over = await releaseJson(disclosure, overJson)
    const exit = Effect.runSyncExit(artifacts.present(caller, over, { maxBytes: 262_144 }))

    expect(Predicate.isTagged("ArtifactTooLarge")(expectFailure(exit))).toBe(true)

    // The pre-existing entry must still be fully readable.
    const assembled = await readAll(artifacts, caller, keptPreview.ref, 16_384)

    expect(assembled).toBe(JSON.stringify(keptJson))
  })
})

describe("aggregate eviction", () => {
  it("refuses oversized entries and recovery refs without evicting entries that fit", async () => {
    const { artifacts, disclosure } = makeServices({
      aggregateByteLimit: 1_200,
      singleValueByteLimit: 2_000,
    })

    const caller = trustedCaller("aggregate-limit-user")
    const exact = await releaseJson(disclosure, "é".repeat(599))
    const oversized = await releaseJson(disclosure, "é".repeat(599) + "x")

    const present = () => artifacts.present(caller, oversized, { maxBytes: 1_024 })

    const failure = expectFailure(Effect.runSyncExit(present()))

    expect(failure._tag).toBe("ArtifactTooLarge")
    expect(failure).toMatchObject({
      bytes: 1_201,
      limit: 1_200,
    })

    const kept = expectPreview(
      await runEffect(artifacts.present(caller, exact, { maxBytes: 1_024 })),
    )

    expect(kept.totalBytes).toBe(1_200)
    expect(expectFailure(Effect.runSyncExit(present()))._tag).toBe("ArtifactTooLarge")

    const failedSelection = expectFailure(
      Effect.runSyncExit(artifacts.present(caller, oversized, { select: "/missing" })),
    )

    expect(failedSelection._tag).toBe("SelectionFailed")
    expect(failedSelection).not.toHaveProperty("recoveryRef", expect.any(String))
    expect(await readAll(artifacts, caller, kept.ref, 1_024)).toBe(JSON.stringify("é".repeat(599)))
  })

  it("evicts the oldest entry when the total exceeds the aggregate limit", async () => {
    const aggregate = 300_000

    const { artifacts, disclosure } = makeServices({
      aggregateByteLimit: aggregate,
      singleValueByteLimit: aggregate,
    })

    const caller = trustedCaller("evict-user")

    const makeSized = async (key: string, bytes: number): Promise<PreviewDelivery> => {
      const skeleton = JSON.stringify({ [key]: "" })
      const json = { [key]: "v".repeat(bytes - encodeLength(skeleton)) }

      expect(encodeLength(JSON.stringify(json))).toBe(bytes)

      const released = await releaseJson(disclosure, json)
      const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))

      return expectPreview(delivery)
    }

    const first = await makeSized("g", 150_000)
    const second = await makeSized("h", 150_000)

    // Both fit exactly at the aggregate limit.
    const firstPage = await runEffect(artifacts.read(caller, first.ref, { offset: 0, length: 10 }))

    expect(firstPage.totalBytes).toBe(150_000)

    // Inserting a third 150k entry must evict the first (oldest).
    const third = await makeSized("i", 150_000)

    const evicted = Effect.runSyncExit(artifacts.read(caller, first.ref, { offset: 0 }))

    expect(Predicate.isTagged("ArtifactUnavailable")(expectFailure(evicted))).toBe(true)

    // Second and third survive.
    const secondPage = await runEffect(
      artifacts.read(caller, second.ref, { offset: 0, length: 10 }),
    )

    expect(secondPage.totalBytes).toBe(150_000)

    const thirdPage = await runEffect(artifacts.read(caller, third.ref, { offset: 0, length: 10 }))

    expect(thirdPage.totalBytes).toBe(150_000)
  })
})

describe("ttl expiry", () => {
  it("drops stale entries after the ttl passes", async () => {
    let clock = 1_000_000

    const { artifacts, disclosure } = makeServices({
      ttlMs: 60_000,
      now: () => clock,
    })

    const caller = trustedCaller("ttl-user")
    const released = await releaseJson(disclosure, { data: "t".repeat(2_000) })

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    const alive = await runEffect(artifacts.read(caller, preview.ref, { offset: 0, length: 10 }))

    expect(alive.chunk.length).toBeGreaterThan(0)

    clock += 61_000

    const expired = Effect.runSyncExit(artifacts.read(caller, preview.ref, { offset: 0 }))

    expect(Predicate.isTagged("ArtifactUnavailable")(expectFailure(expired))).toBe(true)
  })

  it("renews expiry on each successful read", async () => {
    let clock = 1_000_000

    const { artifacts, disclosure } = makeServices({
      ttlMs: 60_000,
      now: () => clock,
    })

    const caller = trustedCaller("renew-user")
    const released = await releaseJson(disclosure, { data: "u".repeat(2_000) })

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    // Read just before expiry repeatedly; each read extends the lifetime.
    for (let step = 0; step < 3; step++) {
      clock += 59_000

      const page = await runEffect(artifacts.read(caller, preview.ref, { offset: 0, length: 5 }))

      expect(page.chunk.length).toBeGreaterThan(0)
    }

    // Without a further read, the last touch expires.
    clock += 61_000

    const expired = Effect.runSyncExit(artifacts.read(caller, preview.ref, { offset: 0 }))

    expect(Predicate.isTagged("ArtifactUnavailable")(expectFailure(expired))).toBe(true)
  })
})

describe("caller ownership", () => {
  it("a foreign caller gets ArtifactUnavailable indistinguishable from missing", async () => {
    const { artifacts, disclosure } = makeServices()
    const owner = trustedCaller("owner-user")
    const intruder = trustedCaller("intruder-user")
    const released = await releaseJson(disclosure, { data: "s".repeat(2_000) })

    const delivery = await runEffect(artifacts.present(owner, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    const foreign = Effect.runSyncExit(artifacts.read(intruder, preview.ref, { offset: 0 }))
    const foreignError = expectFailure(foreign)

    expect(Predicate.isTagged("ArtifactUnavailable")(foreignError)).toBe(true)

    // A never-existent ref produces the identical shape.
    const missingRef = Option.getOrThrow(parseArtifactRef("res_zzzzzzzzzzzzzzzz"))
    const missing = Effect.runSyncExit(artifacts.read(intruder, missingRef, { offset: 0 }))
    const missingError = expectFailure(missing)

    expect(Predicate.isTagged("ArtifactUnavailable")(missingError)).toBe(true)

    if (
      Predicate.isTagged("ArtifactUnavailable")(foreignError) &&
      Predicate.isTagged("ArtifactUnavailable")(missingError)
    ) {
      expect(foreignError.message).toBe(missingError.message)
    }
  })
})

describe("policy tightening", () => {
  it("revalidation re-scrubs newly protected secrets on read", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("policy-user")
    const secret = "sk-live-abcdef123456"
    const big = { data: secret + "-" + "p".repeat(2_000) }
    const released = await releaseJson(disclosure, big)

    const delivery = await runEffect(artifacts.present(caller, released, { maxBytes: 1_024 }))
    const preview = expectPreview(delivery)

    // Before tightening, the stored bytes carry the (then unprotected) value.
    const before = await readAll(artifacts, caller, preview.ref, 16_384)

    expect(before).toContain(secret)

    // Tighten the policy: the secret is now protected.
    await Effect.runPromise(disclosure.tightenPolicy([secret]))

    const after = await readAll(artifacts, caller, preview.ref, 16_384)

    expect(after).not.toContain(secret)
    expect(after).toContain("[REDACTED]")
  })
})

describe("RFC 6901 pointer selection", () => {
  it("selects the whole value with the empty pointer", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-user")
    const json = { a: { b: [1, 2, { c: "deep" }] } }
    const released = await releaseJson(disclosure, json)

    const part = await runEffect(artifacts.part(caller, released, ""))

    expect(part).toBe(released)
  })

  it("selects nested object members", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-nested")
    const json = { a: { b: [1, 2, { c: "deep" }] } }
    const released = await releaseJson(disclosure, json)

    const part = await runEffect(artifacts.part(caller, released, "/a/b/2/c"))

    expect(Option.getOrThrow(releasedJson(part))).toBe("deep")
  })

  it("selects array indices", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-array")
    const released = await releaseJson(disclosure, { items: ["zero", "one", "two"] })

    const part = await runEffect(artifacts.part(caller, released, "/items/2"))

    expect(Option.getOrThrow(releasedJson(part))).toBe("two")
  })

  it("decodes ~1 as / and ~0 as ~", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-escape")
    const json = { "a/b": { "~key": 42 } }
    const released = await releaseJson(disclosure, json)

    const part = await runEffect(artifacts.part(caller, released, "/a~1b/~0key"))

    expect(Option.getOrThrow(releasedJson(part))).toBe(42)
  })

  it("fails for a missing leading slash", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-bad")
    const released = await releaseJson(disclosure, { a: 1 })

    const exit = Effect.runSyncExit(artifacts.part(caller, released, "a"))

    expect(Predicate.isTagged("SelectionFailed")(expectFailure(exit))).toBe(true)
  })

  it("fails for a missing path segment", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-missing")
    const released = await releaseJson(disclosure, { a: { b: 1 } })

    const exit = Effect.runSyncExit(artifacts.part(caller, released, "/a/nonexistent"))

    expect(Predicate.isTagged("SelectionFailed")(expectFailure(exit))).toBe(true)
  })

  it("present applies select before budgeting", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-budget")
    const json = { big: "m".repeat(5_000), small: "ok" }
    const released = await releaseJson(disclosure, json)

    // Selecting the small member yields inline delivery even though the whole
    // value exceeds the budget.
    const delivery = await runEffect(
      artifacts.present(caller, released, { maxBytes: 1_024, select: "/small" }),
    )

    expect(isInline(delivery)).toBe(true)

    if (isInline(delivery)) {
      expect(delivery.bytes).toBe(encodeLength(JSON.stringify("ok")))
    }
  })

  it("present with an invalid select fails with a usable recoveryRef", async () => {
    const { artifacts, disclosure } = makeServices()
    const caller = trustedCaller("ptr-recovery")
    const json = { data: "r".repeat(2_000) }
    const released = await releaseJson(disclosure, json)

    const exit = Effect.runSyncExit(
      artifacts.present(caller, released, { maxBytes: 1_024, select: "/missing" }),
    )

    const error = expectFailure(exit)

    expect(Predicate.isTagged("SelectionFailed")(error)).toBe(true)

    if (!Predicate.isTagged("SelectionFailed")(error)) return

    expect(error.recoveryRef).toBeDefined()

    const recoveryRef = Option.getOrThrow(parseArtifactRef(error.recoveryRef ?? ""))

    // The recovery ref pages the full original value.
    const assembled = await readAll(artifacts, caller, recoveryRef, 512)

    expect(assembled).toBe(JSON.stringify(json))
  })

  it("present with an invalid select omits recoveryRef when the full value exceeds the single-value limit", async () => {
    const { artifacts, disclosure } = makeServices({ singleValueByteLimit: 300_000 })
    const caller = trustedCaller("ptr-norecovery")
    const json = { data: "n".repeat(400_000) }
    const released = await releaseJson(disclosure, json)

    const exit = Effect.runSyncExit(
      artifacts.present(caller, released, { maxBytes: 1_024, select: "/missing" }),
    )

    const error = expectFailure(exit)

    expect(Predicate.isTagged("SelectionFailed")(error)).toBe(true)

    if (Predicate.isTagged("SelectionFailed")(error)) {
      expect(error.recoveryRef).toBeUndefined()
    }
  })
})
