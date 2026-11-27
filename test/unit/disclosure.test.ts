import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import { describe, expect, it } from "vitest"

import {
  Disclosure,
  type DisclosureApi,
  disclosureLayer,
  ProtectedBytes,
  REDACTED,
  ReleasePayload,
  releasedJson,
  releasedMedia,
  releasedPayload,
  releasedRecords,
} from "../../src/disclosure/index.ts"

const run = <A, E>(program: Effect.Effect<A, E, Disclosure>): Exit.Exit<A, E> =>
  Effect.runSyncExit(Effect.provide(program, disclosureLayer()))

const runWith = <A, E>(
  program: Effect.Effect<A, E, Disclosure>,
  layer: ReturnType<typeof disclosureLayer>,
): Exit.Exit<A, E> => Effect.runSyncExit(Effect.provide(program, layer))

const withDisclosure = <A, E>(use: (api: DisclosureApi) => Effect.Effect<A, E>) =>
  Effect.flatMap(Disclosure, use)

const expectSuccess = <A, E>(exit: Exit.Exit<A, E>): A => {
  expect(Exit.isSuccess(exit)).toBe(true)

  if (!Exit.isSuccess(exit)) throw new Error("expected success")

  return exit.value
}

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true)

  if (!Exit.isFailure(exit)) throw new Error("expected failure")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

describe("disclosure", () => {
  describe("release across all sinks", () => {
    for (const sink of ["client", "event", "error", "log"] as const) {
      it(`releases a plain JSON value to the "${sink}" sink`, () => {
        const exit = run(
          withDisclosure((api) =>
            Effect.gen(function* () {
              const audience = yield* api.audience(sink, "recipient-1")

              return yield* api.release(
                { payload: ReleasePayload.JsonValue({ value: { note: "hello" } }) },
                audience,
              )
            }),
          ),
        )

        const released = expectSuccess(exit)

        expect(released.sink).toBe(sink)
        expect(released.recipientId).toBe("recipient-1")
        expect(releasedJson(released)).toEqual(Option.some({ note: "hello" }))
      })
    }
  })

  describe("sink isolation", () => {
    it("rejects revalidation against a different sink", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const clientAudience = yield* api.audience("client", "recipient-1")
            const logAudience = yield* api.audience("log", "recipient-1")

            const released = yield* api.release(
              { payload: ReleasePayload.JsonValue({ value: { note: "hi" } }) },
              clientAudience,
            )

            return yield* api.revalidate(released, logAudience)
          }),
        ),
      )

      const error = expectFailure(exit)

      expect(error._tag).toBe("DisclosureRefused")
    })

    it("rejects revalidation against a different recipient", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const owner = yield* api.audience("client", "recipient-1")
            const intruder = yield* api.audience("client", "recipient-2")

            const released = yield* api.release(
              { payload: ReleasePayload.JsonValue({ value: { note: "hi" } }) },
              owner,
            )

            return yield* api.revalidate(released, intruder)
          }),
        ),
      )

      const error = expectFailure(exit)

      expect(error._tag).toBe("DisclosureRefused")
    })

    it("accepts revalidation for the same sink and recipient", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("event", "recipient-1")

            const released = yield* api.release(
              { payload: ReleasePayload.JsonValue({ value: { note: "hi" } }) },
              audience,
            )

            return yield* api.revalidate(released, audience)
          }),
        ),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  describe("credential key stripping", () => {
    it("drops credential keys and scrubs minted values echoed in sibling fields", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.JsonValue({
                  value: {
                    apiKey: { value: "fk-minted-999" },
                    note: "use fk-minted-999 here",
                    token: "tok-123",
                    nested: { authorization: "Bearer abc" },
                  },
                }),
              },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)
      const json = releasedJson(released)

      expect(json).toEqual(
        Option.some({
          note: `use ${REDACTED} here`,
          nested: {},
        }),
      )
    })

    it("scrubs minted values that appear in object property names", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.JsonValue({
                  value: {
                    credentials: { apiKey: { value: "minted-abc-123" } },
                    "key minted-abc-123 metadata": "visible",
                  },
                }),
              },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(releasedJson(released)).toEqual(
        Option.some({
          credentials: {},
          [`key ${REDACTED} metadata`]: "visible",
        }),
      )
    })

    it("drops secrets maps and upsert secret entries entirely", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.JsonValue({
                  value: {
                    secrets: { API_TOKEN: "sensitive-value-1" },
                    upsert: [{ name: "KEY", value: "sensitive-value-2" }],
                    summary: "updated",
                  },
                }),
              },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(releasedJson(released)).toEqual(Option.some({ summary: "updated" }))
    })

    it("drops caller-supplied sensitive keys and scrubs supplied sensitive values", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.JsonValue({
                  value: {
                    sessionCookie: "cookie-content-xyz",
                    note: "the cookie is cookie-content-xyz",
                    visible: true,
                  },
                }),
                sensitiveKeys: ["sessionCookie"],
                sensitiveValues: ["cookie-content-xyz"],
              },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(releasedJson(released)).toEqual(
        Option.some({
          note: `the cookie is ${REDACTED}`,
          visible: true,
        }),
      )
    })

    it("scrubs globally registered protected values from values and key names", () => {
      const exit = runWith(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.JsonValue({
                  value: {
                    note: "contains global-secret-abc inside",
                    "field global-secret-abc": 1,
                  },
                }),
              },
              audience,
            )
          }),
        ),
        disclosureLayer({ protectedValues: ["global-secret-abc"] }),
      )

      const released = expectSuccess(exit)

      expect(releasedJson(released)).toEqual(
        Option.some({
          note: `contains ${REDACTED} inside`,
          [`field ${REDACTED}`]: 1,
        }),
      )
    })
  })

  describe("records", () => {
    it("scrubs every record including cross-record minted secrets", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.Records({
                  items: [
                    { apiKey: { value: "minted-cross-777" }, step: 1 },
                    { step: 2, note: "echoes minted-cross-777" },
                    { step: 3, token: "should-drop" },
                  ],
                }),
              },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(releasedRecords(released)).toEqual(
        Option.some([{ step: 1 }, { step: 2, note: `echoes ${REDACTED}` }, { step: 3 }]),
      )
    })

    it("scrubs record key names containing secrets", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.Records({
                  items: [{ "field with seed-value-xyz": 1, plain: 2 }],
                }),
                sensitiveValues: ["seed-value-xyz"],
              },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(releasedRecords(released)).toEqual(
        Option.some([{ [`field with ${REDACTED}`]: 1, plain: 2 }]),
      )
    })
  })

  describe("media", () => {
    it("releases a byte snapshot independent of the source buffer", () => {
      const bytes = new TextEncoder().encode("safe")

      const released = expectSuccess(
        run(
          withDisclosure((api) =>
            Effect.gen(function* () {
              const audience = yield* api.audience("client", "recipient-1")

              return yield* api.release(
                { payload: ReleasePayload.Media({ media: { contentType: "image/png", bytes } }) },
                audience,
              )
            }),
          ),
        ),
      )

      bytes.fill(0)

      expect(Option.getOrThrow(releasedMedia(released)).bytes).toEqual(
        new TextEncoder().encode("safe"),
      )
    })

    it("scrubs media metadata on release and again after tightening the policy", () => {
      const media = {
        contentType: "image/png; name=private-type",
        filename: "private-name.png",
        bytes: new Uint8Array([1, 2]),
      }

      const { released, revalidated } = expectSuccess(
        run(
          withDisclosure((api) =>
            Effect.gen(function* () {
              const audience = yield* api.audience("event", "recipient-1")

              const released = yield* api.release(
                { payload: ReleasePayload.Media({ media }), sensitiveValues: ["private-type"] },
                audience,
              )

              yield* api.tightenPolicy(["private-name"])
              const current = yield* api.audience("event", "recipient-1")
              const revalidated = yield* api.revalidate(released, current)

              return { released, revalidated }
            }),
          ),
        ),
      )

      expect(Option.getOrThrow(releasedMedia(released))).toMatchObject({
        contentType: `image/png; name=${REDACTED}`,
        filename: media.filename,
      })
      expect(Option.getOrThrow(releasedMedia(revalidated))).toMatchObject({
        contentType: `image/png; name=${REDACTED}`,
        filename: `${REDACTED}.png`,
      })
    })

    it("releases safe binary untouched", () => {
      const bytes = new TextEncoder().encode("plain binary content")

      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.Media({
                  media: { contentType: "application/octet-stream", bytes },
                }),
              },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)
      const media = releasedMedia(released)

      expect(Option.isSome(media)).toBe(true)

      if (Option.isSome(media)) {
        expect([...media.value.bytes]).toEqual([...bytes])
        expect(media.value.contentType).toBe("application/octet-stream")
      }
    })

    it("refuses media flagged as protected", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.Media({
                  media: {
                    contentType: "image/png",
                    bytes: new TextEncoder().encode("image-bytes"),
                    protected: true,
                  },
                }),
              },
              audience,
            )
          }),
        ),
      )

      const error = expectFailure(exit)

      expect(Predicate.isTagged("ProtectedBytes")(error)).toBe(true)
      expect(error).toBeInstanceOf(ProtectedBytes)

      if (error instanceof ProtectedBytes) {
        expect(error.contentType).toBe("image/png")
      }
    })

    it("refuses binary containing a protected secret byte sequence without mangling", () => {
      const secret = "embedded-secret-abc"
      const bytes = new TextEncoder().encode(`prefix ${secret} suffix`)

      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              {
                payload: ReleasePayload.Media({
                  media: { contentType: "application/pdf", bytes },
                }),
                sensitiveValues: [secret],
              },
              audience,
            )
          }),
        ),
      )

      const error = expectFailure(exit)

      expect(error._tag).toBe("ProtectedBytes")
    })
  })

  describe("policy tightening", () => {
    it("hides newly protected values when revalidating previously released JSON", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            const released = yield* api.release(
              {
                payload: ReleasePayload.JsonValue({
                  value: { note: "remember fresh-secret-555", other: 1 },
                }),
              },
              audience,
            )

            expect(releasedJson(released)).toEqual(
              Option.some({ note: "remember fresh-secret-555", other: 1 }),
            )

            yield* api.tightenPolicy(["fresh-secret-555"])

            const audienceAfter = yield* api.audience("client", "recipient-1")
            const revalidated = yield* api.revalidate(released, audienceAfter)
            const revision = yield* api.policyRevision()

            return { revalidated, revision }
          }),
        ),
      )

      const { revalidated, revision } = expectSuccess(exit)

      expect(revision).toBe(1)
      expect(revalidated.policyRevision).toBe(1)
      expect(releasedJson(revalidated)).toEqual(
        Option.some({ note: `remember ${REDACTED}`, other: 1 }),
      )
    })

    it("refuses previously released media that matches a tightened policy", () => {
      const secret = "binary-secret-000"
      const bytes = new TextEncoder().encode(`data ${secret} end`)

      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            const released = yield* api.release(
              {
                payload: ReleasePayload.Media({
                  media: { contentType: "application/octet-stream", bytes },
                }),
              },
              audience,
            )

            yield* api.tightenPolicy([secret])

            const audienceAfter = yield* api.audience("client", "recipient-1")

            return yield* api.revalidate(released, audienceAfter)
          }),
        ),
      )

      const error = expectFailure(exit)

      expect(error._tag).toBe("ProtectedBytes")
    })

    it("revalidation at the current revision succeeds when nothing new is protected", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            const released = yield* api.release(
              { payload: ReleasePayload.JsonValue({ value: { plain: "data" } }) },
              audience,
            )

            return yield* api.revalidate(released, audience)
          }),
        ),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  describe("payload shape preservation", () => {
    it("preserves empty payloads as Empty", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release({ payload: ReleasePayload.Empty() }, audience)
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(releasedPayload(released)._tag).toBe("Empty")
    })

    it("preserves null as JsonValue(null)", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("client", "recipient-1")

            return yield* api.release(
              { payload: ReleasePayload.JsonValue({ value: null }) },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(releasedPayload(released)._tag).toBe("JsonValue")
      expect(releasedJson(released)).toEqual(Option.some(null))
    })
  })

  describe("opaque handle", () => {
    it("exposes sink, recipient and revision for its audience", () => {
      const exit = run(
        withDisclosure((api) =>
          Effect.gen(function* () {
            const audience = yield* api.audience("event", "recipient-9")

            return yield* api.release(
              { payload: ReleasePayload.JsonValue({ value: "text" }) },
              audience,
            )
          }),
        ),
      )

      const released = expectSuccess(exit)

      expect(released.sink).toBe("event")
      expect(released.recipientId).toBe("recipient-9")
      expect(released.policyRevision).toBe(0)
    })
  })
})

describe("scrubStream", () => {
  const streamOf = (secrets: ReadonlyArray<string>) => {
    const exit = runWith(
      withDisclosure((api) => Effect.succeed(api.scrubStream())),
      disclosureLayer({ protectedValues: secrets }),
    )

    return expectSuccess(exit)
  }

  it("releases unprotected text without lag", () => {
    const stream = streamOf(["secret-key"])

    expect(stream.push("hello ")).toBe("hello ")
    expect(stream.push("world")).toBe("world")
    expect(stream.flush()).toBe("")
  })

  it("redacts a whole secret inside one push immediately", () => {
    const stream = streamOf(["secret-key"])

    expect(stream.push("the secret-key here")).toBe("the [REDACTED] here")
  })

  it("withholds a split secret so its fragments never reassemble", () => {
    const stream = streamOf(["secret-key"])
    const emitted: Array<string> = []

    emitted.push(stream.push("the secret-"))
    emitted.push(stream.push("key is out"))
    emitted.push(stream.flush())

    const joined = emitted.join("")

    expect(joined).not.toContain("secret-key")
    expect(joined).toContain("[REDACTED]")
    expect(joined).toBe("the [REDACTED] is out")
  })

  it("survives per-character fragmentation of the secret", () => {
    const secret = "abc123xyz"
    const stream = streamOf([secret])
    const emitted: Array<string> = []

    for (const char of "pre " + secret + " post") {
      emitted.push(stream.push(char))
    }

    emitted.push(stream.flush())

    const joined = emitted.join("")

    expect(joined).not.toContain(secret)
    expect(joined).toBe("pre [REDACTED] post")
  })

  it("never releases half of a self-overlapping secret", () => {
    const stream = streamOf(["abab"])
    const emitted: Array<string> = []

    for (const char of "ababx") {
      emitted.push(stream.push(char))
    }

    emitted.push(stream.flush())

    const joined = emitted.join("")

    expect(joined).not.toContain("abab")
    expect(joined).toBe("[REDACTED]x")
  })

  it("never releases halves of a two-character secret", () => {
    const stream = streamOf(["aa"])
    const emitted: Array<string> = []

    emitted.push(stream.push("a"))
    emitted.push(stream.push("a"))
    emitted.push(stream.push("a"))
    emitted.push(stream.flush())

    const joined = emitted.join("")

    expect(joined).not.toContain("aa")
    expect(joined).toBe("[REDACTED]a")
  })

  it("releases an innocent partial prefix at flush", () => {
    const stream = streamOf(["secret-key"])

    expect(stream.push("use secret-")).toBe("use ")
    expect(stream.flush()).toBe("secret-")
  })

  it("redacts overlapping occurrences across pushes", () => {
    const stream = streamOf(["aa"])
    const emitted: Array<string> = []

    for (const char of "aaa") {
      emitted.push(stream.push(char))
    }

    emitted.push(stream.flush())

    const joined = emitted.join("")

    expect(joined).not.toContain("aa")
    expect(joined).toBe("[REDACTED]a")
  })

  it("tracks values protected after the stream was created", () => {
    const exit = run(
      withDisclosure((api) =>
        Effect.gen(function* () {
          const stream = api.scrubStream()
          yield* api.tightenPolicy(["late-secret"])
          const first = stream.push("late-")
          const second = stream.push("secret!")
          const tail = stream.flush()

          return [first, second, tail] as const
        }),
      ),
    )

    const [first, second, tail] = expectSuccess(exit)
    const joined = [first, second, tail].join("")

    expect(joined).not.toContain("late-secret")
    expect(joined).toBe("[REDACTED]!")
  })
})
