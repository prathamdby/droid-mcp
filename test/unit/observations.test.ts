import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { describe, expect, it } from "vitest"

import {
  Disclosure,
  type DisclosureApi,
  disclosureLayer,
  REDACTED,
  ReleasePayload,
  type Released,
  releasedJson,
} from "../../src/disclosure/index.ts"
import {
  EventTooLarge,
  HistoryClosed,
  type HistoryOptions,
  InvalidPosition,
  Observations,
  observationsLayer,
  positionOffset,
} from "../../src/observations/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeServices = (protectedValues?: ReadonlyArray<string>) => {
  // The observations layer and the disclosure layer must be the same
  // instance: build both from one merged layer memoized together.
  const disclosureLive = disclosureLayer({ protectedValues })
  const observationsLive = Layer.provideMerge(observationsLayer, disclosureLive)
  const merged = Layer.merge(observationsLive, disclosureLive)

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const observations = yield* Observations
        const disclosure = yield* Disclosure

        return { observations, disclosure }
      }),
      merged,
    ),
  )
}

type Services = ReturnType<typeof makeServices>

const openFeed = async (
  services: Services,
  options?: Partial<Omit<HistoryOptions, "audience">>,
  recipientId = "session-1",
) => {
  const audience = await Effect.runPromise(services.disclosure.audience("event", recipientId))

  return Effect.runPromise(services.observations.open({ audience, ...options }))
}

const releaseEvent = async (
  disclosure: DisclosureApi,
  value: Schema.Json,
  recipientId = "session-1",
): Promise<Released<"event">> => {
  const audience = await Effect.runPromise(disclosure.audience("event", recipientId))

  return Effect.runPromise(
    disclosure.release({ payload: ReleasePayload.JsonValue({ value }) }, audience),
  )
}

const jsonOf = (event: Released<"event">): Schema.Json => Option.getOrThrow(releasedJson(event))

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("causal ordering", () => {
  it("returns events in append order and never duplicates them across pages", async () => {
    const services = makeServices()
    const feed = await openFeed(services)

    const events = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => releaseEvent(services.disclosure, { n })),
    )

    for (const event of events) {
      await Effect.runPromise(services.observations.append(feed, event))
    }

    const first = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(first.items.map(jsonOf)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }])
    expect(first.gap).toBe(false)
    expect(first.omittedCount).toBe(0)

    const second = await Effect.runPromise(services.observations.observe(feed, first.resume, 0))

    expect(second.items).toEqual([])

    // Walk the whole feed page by page from a mid-point position: no event
    // already delivered may reappear on a later page.
    const mid = await Effect.runPromise(services.observations.positionFromOffset(feed, 3))
    const tail = await Effect.runPromise(services.observations.observe(feed, mid, 0))

    expect(tail.items.map(jsonOf)).toEqual([{ n: 4 }, { n: 5 }])

    const again = await Effect.runPromise(services.observations.observe(feed, tail.resume, 0))

    expect(again.items).toEqual([])
    expect(positionOffset(tail.resume)).toBe(5)
  })

  it("append returns the position just past the appended event", async () => {
    const services = makeServices()
    const feed = await openFeed(services)
    const event = await releaseEvent(services.disclosure, { a: 1 })
    const position = await Effect.runPromise(services.observations.append(feed, event))

    expect(positionOffset(position)).toBe(1)

    const page = await Effect.runPromise(services.observations.observe(feed, position, 0))

    expect(page.items).toEqual([])
  })
})

describe("wait and wakeup", () => {
  it("wakes a waiter at the head when an event is appended", async () => {
    const services = makeServices()
    const feed = await openFeed(services)

    const waiter = Effect.runPromise(services.observations.observe(feed, null, 5_000))

    await new Promise((resolve) => setTimeout(resolve, 30))

    const event = await releaseEvent(services.disclosure, { late: true })
    const started = Date.now()

    await Effect.runPromise(services.observations.append(feed, event))

    const page = await waiter

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(page.items.map(jsonOf)).toEqual([{ late: true }])
  })

  it("returns an empty page after waitMs elapses with no append", async () => {
    const services = makeServices()
    const feed = await openFeed(services)
    const started = Date.now()
    const page = await Effect.runPromise(services.observations.observe(feed, null, 100))

    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(page.items).toEqual([])
    expect(page.gap).toBe(false)
  })

  it("supports concurrent waiters all woken by one append", async () => {
    const services = makeServices()
    const feed = await openFeed(services)

    const waiters = [
      Effect.runPromise(services.observations.observe(feed, null, 5_000)),
      Effect.runPromise(services.observations.observe(feed, null, 5_000)),
      Effect.runPromise(services.observations.observe(feed, null, 5_000)),
    ]

    await new Promise((resolve) => setTimeout(resolve, 30))

    const event = await releaseEvent(services.disclosure, { broadcast: 1 })

    await Effect.runPromise(services.observations.append(feed, event))

    const pages = await Promise.all(waiters)

    for (const page of pages) {
      expect(page.items.map(jsonOf)).toEqual([{ broadcast: 1 }])
    }
  })
})

describe("retention eviction", () => {
  it("evicts oldest events beyond maxEvents and reports the gap", async () => {
    const services = makeServices()
    const feed = await openFeed(services, { maxEvents: 3 })

    for (const n of [1, 2, 3, 4, 5]) {
      const event = await releaseEvent(services.disclosure, { n })

      await Effect.runPromise(services.observations.append(feed, event))
    }

    const page = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(page.items.map(jsonOf)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }])
    expect(page.gap).toBe(true)
    expect(page.omittedCount).toBe(2)
  })

  it("evicts oldest events beyond maxBytes and reports the gap", async () => {
    const services = makeServices()
    // Each entry costs roughly `data` length plus the payload envelope, so a
    // 600-byte budget retains at most two ~250-byte entries.
    const feed = await openFeed(services, { maxBytes: 600 })

    for (const n of [1, 2, 3, 4]) {
      const event = await releaseEvent(services.disclosure, { n, data: "x".repeat(200) })

      await Effect.runPromise(services.observations.append(feed, event))
    }

    const page = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(page.gap).toBe(true)
    expect(page.omittedCount).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(4)

    // SAFETY: every test event was released with a numeric `n` member, so
    // each retained payload still carries one after revalidation.
    const values = page.items.map((item) => (jsonOf(item) as { readonly n: number }).n)

    // Whatever survived is the causal tail, in order.
    expect(values).toEqual([...values].sort((a, b) => a - b))
    expect(values[values.length - 1]).toBe(4)
  })

  it("refuses one event over the byte budget without evicting retained history", async () => {
    const services = makeServices()
    // A 600-byte budget retains the two ~250-byte events below; the refused
    // event alone is larger than the whole budget.
    const feed = await openFeed(services, { maxBytes: 600 })

    for (const n of [1, 2]) {
      const event = await releaseEvent(services.disclosure, { n, data: "x".repeat(200) })

      await Effect.runPromise(services.observations.append(feed, event))
    }

    const before = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(before.gap).toBe(false)
    expect(before.omittedCount).toBe(0)

    const oversize = await releaseEvent(services.disclosure, {
      n: 3,
      data: "y".repeat(2_000),
    })

    const refusal = Effect.runSyncExit(services.observations.append(feed, oversize))
    const error = expectFailure(refusal)

    expect(error).toBeInstanceOf(EventTooLarge)

    if (error instanceof EventTooLarge) {
      expect(error.limit).toBe(600)
    }

    // Retained history is untouched: no eviction, no gap, no head advance,
    // and a subsequent normal append resumes from the unchanged sequence.
    const after = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(after.gap).toBe(false)
    expect(after.omittedCount).toBe(0)
    expect(after.items.map(jsonOf)).toEqual(before.items.map(jsonOf))

    const resumed = await releaseEvent(services.disclosure, { n: 4, data: "z".repeat(100) })
    const position = await Effect.runPromise(services.observations.append(feed, resumed))

    expect(positionOffset(position)).toBe(3)
  })

  it("reports no gap when reading from a position at or past the retained watermark", async () => {
    const services = makeServices()
    const feed = await openFeed(services, { maxEvents: 2 })

    for (const n of [1, 2, 3]) {
      const event = await releaseEvent(services.disclosure, { n })

      await Effect.runPromise(services.observations.append(feed, event))
    }

    const watermark = await Effect.runPromise(services.observations.positionFromOffset(feed, 1))
    const page = await Effect.runPromise(services.observations.observe(feed, watermark, 0))

    expect(page.items.map(jsonOf)).toEqual([{ n: 2 }, { n: 3 }])
    expect(page.gap).toBe(false)
    expect(page.omittedCount).toBe(0)
  })
})

describe("positions", () => {
  it("rejects a foreign position with InvalidPosition", async () => {
    const services = makeServices()
    const first = await openFeed(services)
    const second = await openFeed(services)
    const event = await releaseEvent(services.disclosure, { mine: true })
    const foreign = await Effect.runPromise(services.observations.append(first, event))

    const exit = Effect.runSyncExit(
      services.observations.observe(second, foreign, 0).pipe(Effect.asVoid),
    )

    expect(expectFailure(exit)).toBeInstanceOf(InvalidPosition)
  })

  it("rejects out-of-range offsets in positionFromOffset", async () => {
    const services = makeServices()
    const feed = await openFeed(services)
    const event = await releaseEvent(services.disclosure, { one: 1 })

    await Effect.runPromise(services.observations.append(feed, event))

    for (const offset of [-1, 2, 100, 1.5]) {
      const exit = Effect.runSyncExit(
        services.observations.positionFromOffset(feed, offset).pipe(Effect.asVoid),
      )

      expect(expectFailure(exit)).toBeInstanceOf(InvalidPosition)
    }

    // The head itself is a valid read position (everything seen so far).
    const head = await Effect.runPromise(services.observations.positionFromOffset(feed, 1))

    expect(positionOffset(head)).toBe(1)
  })
})

describe("policy tightening", () => {
  it.each([0, 1])("counts refused events in addition to %i evicted events", async (evicted) => {
    const services = makeServices()
    const { disclosure, observations } = services
    const feed = await openFeed(services, { maxEvents: 2 })
    const audience = await Effect.runPromise(disclosure.audience("event", "session-1"))
    const secret = "newly-protected-media"

    const media = await Effect.runPromise(
      disclosure.release(
        {
          payload: ReleasePayload.Media({
            media: { contentType: "image/png", bytes: new TextEncoder().encode(secret) },
          }),
        },
        audience,
      ),
    )

    const safe = await releaseEvent(disclosure, { safe: true })

    if (evicted > 0) await Effect.runPromise(observations.append(feed, safe))
    await Effect.runPromise(observations.append(feed, media))
    await Effect.runPromise(observations.append(feed, safe))

    const before = await Effect.runPromise(observations.observe(feed, null, 0))

    expect(before.items).toHaveLength(2)
    expect(before.omittedCount).toBe(evicted)

    await Effect.runPromise(disclosure.tightenPolicy([secret]))

    const after = await Effect.runPromise(observations.observe(feed, null, 0))

    expect(after.items.map(jsonOf)).toEqual([{ safe: true }])
    expect(after.gap).toBe(true)
    expect(after.omittedCount).toBe(evicted + 1)
    expect(positionOffset(after.resume)).toBe(evicted + 2)

    const resumed = await Effect.runPromise(observations.observe(feed, after.resume, 0))

    expect(resumed).toMatchObject({ items: [], gap: false, omittedCount: 0 })
  })

  it("re-scrubs retained events against the tightened policy on read", async () => {
    const services = makeServices()
    const feed = await openFeed(services)
    const event = await releaseEvent(services.disclosure, { note: "alpha-secret" })

    await Effect.runPromise(services.observations.append(feed, event))

    const before = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(before.items.map(jsonOf)).toEqual([{ note: "alpha-secret" }])

    await Effect.runPromise(services.disclosure.tightenPolicy(["alpha-secret"]))

    const after = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(after.items.map(jsonOf)).toEqual([{ note: REDACTED }])
  })
})

describe("close", () => {
  it("fails append with HistoryClosed after close", async () => {
    const services = makeServices()
    const feed = await openFeed(services)

    await Effect.runPromise(services.observations.close(feed))

    const event = await releaseEvent(services.disclosure, { too: "late" })
    const exit = Effect.runSyncExit(services.observations.append(feed, event).pipe(Effect.asVoid))

    expect(expectFailure(exit)).toBeInstanceOf(HistoryClosed)
  })

  it("still lets late readers drain retained events after close", async () => {
    const services = makeServices()
    const feed = await openFeed(services)
    const event = await releaseEvent(services.disclosure, { kept: 1 })

    await Effect.runPromise(services.observations.append(feed, event))
    await Effect.runPromise(services.observations.close(feed))

    const page = await Effect.runPromise(services.observations.observe(feed, null, 0))

    expect(page.items.map(jsonOf)).toEqual([{ kept: 1 }])
  })
})

describe("follow", () => {
  it("yields pages as events arrive and terminates cleanly when sealed and drained", async () => {
    const services = makeServices()
    const feed = await openFeed(services)

    const collected = Effect.runPromise(Stream.runCollect(services.observations.follow(feed, null)))

    await new Promise((resolve) => setTimeout(resolve, 30))

    for (const n of [1, 2, 3]) {
      const event = await releaseEvent(services.disclosure, { n })

      await Effect.runPromise(services.observations.append(feed, event))
    }

    await Effect.runPromise(services.observations.close(feed))

    const pages = await collected
    const seen = pages.flatMap((page) => page.items.map(jsonOf))

    expect(pages.length).toBeGreaterThan(0)
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it("terminates immediately for a sealed, fully drained feed", async () => {
    const services = makeServices()
    const feed = await openFeed(services)
    const event = await releaseEvent(services.disclosure, { early: 1 })

    await Effect.runPromise(services.observations.append(feed, event))
    await Effect.runPromise(services.observations.close(feed))

    const pages = await Effect.runPromise(
      Stream.runCollect(services.observations.follow(feed, null)),
    )

    expect(pages.flatMap((page) => page.items.map(jsonOf))).toEqual([{ early: 1 }])
  })

  it("fails with InvalidPosition for a foreign starting position", async () => {
    const services = makeServices()
    const first = await openFeed(services)
    const second = await openFeed(services)
    const event = await releaseEvent(services.disclosure, { x: 1 })
    const foreign = await Effect.runPromise(services.observations.append(first, event))

    const exit = await Effect.runPromiseExit(
      Stream.runCollect(services.observations.follow(second, foreign)),
    )

    expect(expectFailure(exit)).toBeInstanceOf(InvalidPosition)
  })
})
