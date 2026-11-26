/**
 * Level 1 `observations` module: observation storage, retention, wakeup and
 * backpressure.
 *
 * A `History` is a scoped feed of released events in causal order; a
 * `Position` is an opaque, feed-bound cursor. Reading returns an
 * `ObservationPage` with the retained events after a position, the next
 * resume position, and an explicit `gap` marker when eviction or disclosure
 * leaves events out of a page. Clipped history is reported, never silently
 * replayed: advancing a position returns no duplicate retained events.
 *
 * Every event leaving the module is revalidated against the current
 * disclosure policy before delivery, so tightening the policy re-scrubs
 * retained history. Nothing here names a ring buffer, a global counter, a
 * resource URI or a turn boundary: the module deals in feeds, positions and
 * pages only.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import {
  type Audience,
  Disclosure,
  type DisclosureApi,
  type Released,
} from "../disclosure/index.ts"
import { createStore, type ObservationStore } from "./private/store.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default retained-event count bound per feed. */
export const DEFAULT_MAX_EVENTS = 500

/** Default retained byte bound per feed. */
export const DEFAULT_MAX_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// History and Position
// ---------------------------------------------------------------------------

/**
 * Brand key for the opaque `History` handle. The symbol is module-private,
 * so outside code cannot construct or mutate a feed.
 */
const historyBrand: unique symbol = Symbol("droid-mcp-v2/observations/History")

/**
 * Brand key for the opaque `Position` cursor. The symbol is module-private,
 * so outside code cannot forge or offset a cursor.
 */
const positionBrand: unique symbol = Symbol("droid-mcp-v2/observations/Position")

/**
 * A scoped observation feed bound to one audience. Only `open` mints one;
 * `close` seals it so late readers can drain what remains and late writers
 * fail with `HistoryClosed`.
 */
export interface History {
  readonly [historyBrand]: "History"
}

/**
 * An opaque cursor into exactly one feed. The only meaningful operation a
 * consumer can perform on it is handing it back to `observe` or `follow`;
 * the offset is exposed read-only through `positionOffset` for persistence
 * and resume bookkeeping.
 */
export interface Position {
  readonly [positionBrand]: "Position"
}

/** Hidden bodies carried behind the opaque public handles. */
interface HistoryBody {
  readonly [historyBrand]: "History"
  readonly audience: Audience<"event">
  readonly store: ObservationStore
}

interface PositionBody {
  readonly [positionBrand]: "Position"
  readonly history: History
  readonly offset: number
}

const readFeed = (feed: History): HistoryBody =>
  // SAFETY: the brand is module-private, so every `History` in existence was
  // constructed by `open` below with exactly this body.
  feed as HistoryBody

const readCursor = (position: Position): PositionBody =>
  // SAFETY: the brand is module-private, so every `Position` in existence was
  // constructed by `mintPosition` below with exactly this body.
  position as PositionBody

/**
 * The store sequence a position names: the next event a reader would see.
 * Useful only for persistence or equality bookkeeping; arithmetic on it does
 * not produce valid positions.
 */
export const positionOffset = (position: Position): number => readCursor(position).offset

const mintPosition = (history: History, offset: number): Position => {
  const body: PositionBody = {
    [positionBrand]: "Position",
    history,
    offset,
  }

  // SAFETY: the body carries the module-private brand and is constructed only
  // here, with store-derived offsets for this exact feed.
  return body as Position
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One page of retained events in causal order. `resume` is the position the
 * next read should pass; it never re-delivers events from this page. `gap`
 * is true and `omittedCount` positive when events between the requested and
 * resume positions were evicted or refused by disclosure revalidation.
 */
export interface ObservationPage {
  readonly items: ReadonlyArray<Released<"event">>
  readonly resume: Position
  readonly gap: boolean
  readonly omittedCount: number
}

/** Retention and audience options for a new feed. */
export interface HistoryOptions {
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly audience: Audience<"event">
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class HistoryClosed extends Schema.TaggedError<HistoryClosed>()("HistoryClosed", {
  message: Schema.String,
}) {}

export class InvalidPosition extends Schema.TaggedError<InvalidPosition>()("InvalidPosition", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ObservationsApi {
  readonly open: (options: HistoryOptions) => Effect.Effect<History>
  readonly close: (feed: History) => Effect.Effect<void>
  readonly append: (
    feed: History,
    event: Released<"event">,
  ) => Effect.Effect<Position, HistoryClosed>
  readonly observe: (
    feed: History,
    after: Position | null,
    waitMs: number,
  ) => Effect.Effect<ObservationPage, InvalidPosition>
  readonly follow: (
    feed: History,
    after: Position | null,
  ) => Stream.Stream<ObservationPage, InvalidPosition>
  readonly positionFromOffset: (
    feed: History,
    offset: number,
  ) => Effect.Effect<Position, InvalidPosition>
}

export class Observations extends Context.Service<Observations, ObservationsApi>()(
  "droid-mcp-v2/Observations",
) {}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const resolveAfter = (
  feed: History,
  after: Position | null,
): Effect.Effect<number, InvalidPosition> =>
  Effect.suspend(() => {
    if (after === null) return Effect.succeed(0)

    const cursor = readCursor(after)

    if (cursor.history !== feed) {
      return Effect.fail(
        new InvalidPosition({
          message: "position belongs to a different observation feed",
        }),
      )
    }

    return Effect.succeed(cursor.offset)
  })

const makePageReader = (feed: History, disclosure: DisclosureApi) => {
  const readPage = (fromSeq: number): Effect.Effect<ObservationPage, never> =>
    Effect.gen(function* () {
      const store = readFeed(feed).store
      const snapshot = store.snapshot()
      let omittedCount = Math.max(0, snapshot.firstRetainedSeq - fromSeq)
      const entries = store.entriesFrom(fromSeq)
      const audience = yield* disclosure.audience("event", readFeed(feed).audience.recipientId)

      const items: Array<Released<"event">> = []

      for (const entry of entries) {
        const revalidated = yield* Effect.result(disclosure.revalidate(entry.event, audience))

        if (Result.isSuccess(revalidated)) items.push(revalidated.success)
        else omittedCount += 1
      }

      const lastEntry = entries[entries.length - 1]
      const endSeq = lastEntry === undefined ? snapshot.head : lastEntry.seq + 1

      return {
        items,
        resume: mintPosition(feed, endSeq),
        gap: omittedCount > 0,
        omittedCount,
      }
    })

  return readPage
}

/**
 * Builds the per-layer `Observations` service. All store state is local to
 * the feeds this instance opens, so independent assemblies never share
 * observation history.
 */
export const observationsLayer: Layer.Layer<Observations, never, Disclosure> = Layer.effect(
  Observations,
  Effect.gen(function* () {
    const disclosure = yield* Disclosure

    const open: ObservationsApi["open"] = (options) =>
      Effect.sync(() => {
        const store = createStore({
          maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
          maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        })

        const body: HistoryBody = {
          [historyBrand]: "History",
          audience: options.audience,
          store,
        }

        // SAFETY: the body carries the module-private brand and is
        // constructed only here.
        return body as History
      })

    const close: ObservationsApi["close"] = (feed) =>
      Effect.sync(() => {
        readFeed(feed).store.seal()
      })

    const append: ObservationsApi["append"] = (feed, event) =>
      Effect.suspend(() => {
        const store = readFeed(feed).store

        if (store.sealed) {
          return Effect.fail(
            new HistoryClosed({ message: "cannot append to a closed observation feed" }),
          )
        }

        const seq = store.append(event)

        return Effect.succeed(mintPosition(feed, seq + 1))
      })

    const observe: ObservationsApi["observe"] = (feed, after, waitMs) =>
      Effect.gen(function* () {
        const fromSeq = yield* resolveAfter(feed, after)
        const store = readFeed(feed).store
        const readPage = makePageReader(feed, disclosure)

        if (fromSeq >= store.snapshot().head && waitMs > 0 && !store.sealed) {
          yield* Effect.raceFirst(store.awaitSignal(), Effect.sleep(waitMs))
        }

        return yield* readPage(fromSeq)
      })

    const follow: ObservationsApi["follow"] = (feed, after) =>
      Stream.unwrap(
        Effect.map(resolveAfter(feed, after), (startSeq) => {
          const readPage = makePageReader(feed, disclosure)

          return Stream.unfold(startSeq, (cursor) =>
            Effect.gen(function* () {
              const store = readFeed(feed).store

              for (;;) {
                const snapshot = store.snapshot()

                if (cursor < snapshot.head) {
                  const page = yield* readPage(cursor)

                  return [page, positionOffset(page.resume)] as const
                }

                if (store.sealed) return undefined

                yield* store.awaitSignal()
              }
            }),
          )
        }),
      )

    const positionFromOffset: ObservationsApi["positionFromOffset"] = (feed, offset) =>
      Effect.suspend(() => {
        if (
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset > readFeed(feed).store.snapshot().head
        ) {
          return Effect.fail(
            new InvalidPosition({
              message:
                "offset " + String(offset) + " is not a position this feed has issued or can issue",
            }),
          )
        }

        return Effect.succeed(mintPosition(feed, offset))
      })

    return { open, close, append, observe, follow, positionFromOffset }
  }),
)
