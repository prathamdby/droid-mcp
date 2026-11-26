import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"

import { type Released, releasedPayload } from "../../disclosure/index.ts"

/**
 * One retained event with its assigned sequence and UTF-8 JSON byte cost.
 *
 * Byte cost is measured as the UTF-8 length of the serialized released
 * payload, never of the wrapper handle: the wrapper's brand symbol is not
 * enumerable and does not exist on the wire.
 */
export interface StoreEntry {
  readonly seq: number
  readonly event: Released<"event">
  readonly bytes: number
}

/**
 * A point-in-time read of the store. Sequences are monotonic per store;
 * `head` is the next unassigned sequence, and `firstRetainedSeq` is the
 * sequence of the oldest retained entry (equalling `head` when empty).
 */
export interface StoreSnapshot {
  readonly firstRetainedSeq: number
  readonly head: number
}

/**
 * Internal event retention interface. The public module treats this as the
 * sole seam for storage: replacing this file alone with a different backing
 * structure (array ring, linked segments) requires no change to `index.ts`
 * or any consumer.
 *
 * All mutation returns its outcome synchronously because the runtime is
 * single-threaded per store and waiters only need to be released, never
 * ordered, by the caller.
 */
export interface ObservationStore {
  /**
   * Appends an event, assigning it the current head sequence, evicting the
   * oldest entries while either budget is exceeded, and waking every waiter.
   * Returns the assigned sequence.
   */
  append(event: Released<"event">): number
  /**
   * Entries with `seq >= fromSeq` in causal order. Does not re-add evicted
   * history; readers resolve gaps through the snapshot watermark.
   */
  entriesFrom(fromSeq: number): ReadonlyArray<StoreEntry>
  /** Current watermark snapshot. */
  snapshot(): StoreSnapshot
  /**
   * Whether a sequence is a position this store could ever have issued or
   * could still issue: a non-negative integer strictly below the head.
   */
  owns(seq: number): boolean
  /** Number of entries dropped by eviction since the store opened. */
  evictedCount(): number
  /** Await the next append or close. Resolves with no payload. */
  awaitSignal(): Effect.Effect<void>
  /**
   * Wake every current and future waiter permanently. Entries are kept so
   * late readers can still drain what remains.
   */
  seal(): void
  readonly sealed: boolean
}

/** UTF-8 length accounting uses the platform encoder exactly. */
const utf8 = new TextEncoder()

/** Cost of one entry: the UTF-8 length of the released payload's serialized JSON. */
const entryBytes = (event: Released<"event">): number =>
  utf8.encode(JSON.stringify(releasedPayload(event))).length

export interface StoreOptions {
  readonly maxEvents: number
  readonly maxBytes: number
}

/**
 * Internal factory seam: the public module delegates store construction to
 * this helper alone, so swapping the backing structure is a one-line change
 * confined to this file.
 */
export const createStore = (options: StoreOptions): ObservationStore => arrayRingStore(options)

/**
 * Array-ring backing store. Retention is bounded by both `maxEvents` and
 * `maxBytes`; either budget alone can force eviction of the oldest entries.
 */
export const arrayRingStore = (options: StoreOptions): ObservationStore => {
  const entries: Array<StoreEntry> = []
  let bytes = 0
  let head = 0
  let dropped = 0
  let signal = Deferred.makeUnsafe<void>()
  let closed = false

  const wake = (): void => {
    const pending = signal
    signal = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(pending, Effect.void)
  }

  return {
    append: (event) => {
      const seq = head
      head += 1
      const cost = entryBytes(event)
      entries.push({ seq, event, bytes: cost })
      bytes += cost

      while (
        entries.length > 0 &&
        (entries.length > options.maxEvents || bytes > options.maxBytes)
      ) {
        const removed = entries.shift()

        if (removed === undefined) break

        bytes -= removed.bytes
        dropped += 1
      }

      wake()

      return seq
    },

    entriesFrom: (fromSeq) => entries.filter((entry) => entry.seq >= fromSeq),

    snapshot: () => ({
      firstRetainedSeq: head - entries.length,
      head,
    }),

    owns: (seq) => Number.isInteger(seq) && seq >= 0 && seq < head,

    evictedCount: () => dropped,

    awaitSignal: () => Deferred.await(signal),

    seal: () => {
      closed = true
      wake()
    },

    get sealed() {
      return closed
    },
  }
}
