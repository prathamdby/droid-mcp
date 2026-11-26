import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"

import { describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Structural proof 1: replace observation storage alone.
//
// Copy the whole `src/` tree into an isolated temp directory, overwrite
// ONLY `observations/private/store.ts` with a genuinely different backing
// structure (a segmented doubly-linked node list, never an array ring), then
// run a real child Node process importing the unmodified public modules
// against `test/support/fake-droid-exec.mjs`. The child exercises append,
// blocking wakeup, position resume without duplicates, retention gaps,
// slow-reader recovery, and the full `permission:flood` eviction-independence
// scenario. Every other file in the copy is asserted byte-for-byte identical
// to the repo original, proving no consumer edit was needed.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "../..")
const SRC_DIR = join(REPO_ROOT, "src")
const FAKE_EXEC = join(REPO_ROOT, "test/support/fake-droid-exec.mjs")
const STORE_RELATIVE = join("observations", "private", "store.ts")

// ---------------------------------------------------------------------------
// Replacement store: segmented doubly-linked node list.
//
// Entries live in fixed-capacity segments chained in both directions. There
// is no array ring anywhere: appending links a fresh node onto the tail
// segment, eviction unlinks nodes from the head segment, and reads walk the
// chain node by node. The public seam (`createStore` returning an
// `ObservationStore`) is the only surface this file shares with the
// original.
// ---------------------------------------------------------------------------

const REPLACEMENT_STORE = `import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"

import { type Released, releasedPayload } from "../../disclosure/index.ts"

export interface StoreEntry {
  readonly seq: number
  readonly event: Released<"event">
  readonly bytes: number
}

export interface StoreSnapshot {
  readonly firstRetainedSeq: number
  readonly head: number
}

export interface ObservationStore {
  append(event: Released<"event">): number
  entriesFrom(fromSeq: number): ReadonlyArray<StoreEntry>
  snapshot(): StoreSnapshot
  owns(seq: number): boolean
  evictedCount(): number
  awaitSignal(): Effect.Effect<void>
  seal(): void
  readonly sealed: boolean
}

const utf8 = new TextEncoder()

const entryBytes = (event: Released<"event">): number =>
  utf8.encode(JSON.stringify(releasedPayload(event))).length

export interface StoreOptions {
  readonly maxEvents: number
  readonly maxBytes: number
}

/**
 * Internal factory seam: the public module delegates store construction to
 * this helper alone, so swapping the backing structure is a one-line change
 * confined to this file. This replacement binds a segmented doubly-linked
 * node list instead of the array ring.
 */
export const createStore = (options: StoreOptions): ObservationStore =>
  segmentedLinkedStore(options)

interface StoreNode {
  readonly entry: StoreEntry
  prev: StoreNode | null
  next: StoreNode | null
}

interface Segment {
  readonly capacity: number
  count: number
  first: StoreNode | null
  last: StoreNode | null
  newer: Segment | null
  older: Segment | null
}

const SEGMENT_CAPACITY = 8

/**
 * Segmented doubly-linked backing store. Nodes chain in both directions
 * inside fixed-capacity segments; segments chain in causal order. Appends
 * link fresh nodes at the tail; eviction unlinks nodes one at a time from
 * the head, retiring empty segments. No array ever holds live entries.
 */
export const segmentedLinkedStore = (options: StoreOptions): ObservationStore => {
  let headSegment: Segment | null = null
  let tailSegment: Segment | null = null
  let length = 0
  let bytes = 0
  let headSeq = 0
  let firstRetained = 0
  let dropped = 0
  let closed = false
  let signal = Deferred.makeUnsafe<void>()

  const wake = (): void => {
    const pending = signal
    signal = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(pending, Effect.void)
  }

  const makeSegment = (): Segment => ({
    capacity: SEGMENT_CAPACITY,
    count: 0,
    first: null,
    last: null,
    newer: null,
    older: null,
  })

  const linkTail = (entry: StoreEntry): void => {
    const node: StoreNode = { entry, prev: null, next: null }

    if (tailSegment === null || tailSegment.count >= tailSegment.capacity) {
      const fresh = makeSegment()

      if (tailSegment !== null) {
        tailSegment.newer = fresh
        fresh.older = tailSegment
      }

      tailSegment = fresh
      if (headSegment === null) headSegment = fresh
    }

    const segment = tailSegment
    node.prev = segment.last
    if (segment.last !== null) segment.last.next = node
    segment.last = node
    if (segment.first === null) segment.first = node
    segment.count += 1
    length += 1
  }

  const unlinkHead = (): StoreEntry | undefined => {
    const segment = headSegment
    if (segment === null) return undefined
    const node = segment.first
    if (node === null) return undefined

    segment.first = node.next
    if (node.next !== null) {
      node.next.prev = null
    } else {
      segment.last = null
    }

    node.next = null
    node.prev = null
    segment.count -= 1
    length -= 1

    if (segment.count === 0 && segment.newer !== null) {
      headSegment = segment.newer
      segment.newer.older = null
      segment.newer = null
    }

    firstRetained = node.entry.seq + 1

    return node.entry
  }

  const evictWhileOverBudget = (): void => {
    for (;;) {
      if (length === 0) return
      if (length <= options.maxEvents && bytes <= options.maxBytes) return

      const removed = unlinkHead()
      if (removed === undefined) return

      bytes -= removed.bytes
      dropped += 1
    }
  }

  return {
    append: (event) => {
      const seq = headSeq
      headSeq += 1
      const cost = entryBytes(event)
      linkTail({ seq, event, bytes: cost })
      bytes += cost

      evictWhileOverBudget()
      wake()

      return seq
    },

    entriesFrom: (fromSeq) => {
      const entries: Array<StoreEntry> = []
      let segment = headSegment

      while (segment !== null) {
        let node = segment.first

        while (node !== null) {
          if (node.entry.seq >= fromSeq) entries.push(node.entry)
          node = node.next
        }

        segment = segment.newer
      }

      return entries
    },

    snapshot: () => ({
      firstRetainedSeq: length === 0 ? headSeq : firstRetained,
      head: headSeq,
    }),

    owns: (seq) => Number.isInteger(seq) && seq >= 0 && seq < headSeq,

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
`

// ---------------------------------------------------------------------------
// Child-process harness: plain JavaScript (no type syntax) written into the
// temp tree so it can import the copied `.ts` modules with relative paths.
// It wires the full unmodified layer assembly exactly as the unit tests do,
// runs each proof case, and prints one JSON verdict line.
// ---------------------------------------------------------------------------

const HARNESS = `import { Effect, Exit, Layer, Option, Schema, Scope } from "effect"

import { Authority, authorityLayer, Evidence } from "./src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "./src/caller/index.ts"
import { Custody, custodyLayer } from "./src/custody/index.ts"
import { Decisions, decisionsLayer, HumanChoice } from "./src/decisions/index.ts"
import { Disclosure, disclosureLayer, ReleasePayload, releasedJson } from "./src/disclosure/index.ts"
import { dialectLayer } from "./src/factory-dialect/index.ts"
import { localExecLayer } from "./src/local-exec/index.ts"
import { Observations, observationsLayer, positionOffset } from "./src/observations/index.ts"
import { Placement, placementLayer, RunIntent } from "./src/placement/index.ts"
import { Turns, turnsLayer } from "./src/turns/index.ts"
import { workspacesLayer } from "./src/workspace/index.ts"

const [sandbox, fakeExec] = process.argv.slice(2)

const scope = Effect.runSync(Scope.make())

const disclosureLive = disclosureLayer({})
const authorityLive = authorityLayer({ maxAutonomy: "high" })
const workspacesLive = Layer.provideMerge(
  workspacesLayer({ allowedRoots: [sandbox] }),
  custodyLayer,
)

const baseDeps = Layer.mergeAll(
  custodyLayer,
  workspacesLive,
  authorityLive,
  callersLayer(),
  disclosureLive,
  dialectLayer,
)

const decisionsLive = Layer.provideMerge(decisionsLayer, baseDeps)
const observationsLive = Layer.provideMerge(observationsLayer, baseDeps)

const localLive = Layer.provideMerge(
  localExecLayer({ droidPath: process.execPath, args: [fakeExec] }),
  baseDeps,
)

const placementLive = Layer.provideMerge(
  placementLayer({}),
  Layer.mergeAll(localLive, baseDeps),
)

const turnsLive = Layer.provideMerge(
  turnsLayer({ maxEvents: 4 }),
  Layer.mergeAll(decisionsLive, observationsLive, baseDeps),
)

const merged = Layer.mergeAll(
  turnsLive,
  placementLive,
  decisionsLive,
  observationsLive,
  localLive,
  baseDeps,
)

const context = Effect.runSync(Layer.buildWithScope(merged, scope))

const services = Effect.runSync(
  Effect.provide(
    Effect.gen(function* () {
      return {
        turns: yield* Turns,
        placement: yield* Placement,
        callers: yield* Callers,
        authority: yield* Authority,
        decisions: yield* Decisions,
        observations: yield* Observations,
        disclosure: yield* Disclosure,
        custody: yield* Custody,
      }
    }),
    context,
  ),
)

const checks = []
const record = (name, pass, detail) => {
  checks.push({ name, pass, detail: detail ?? null })
}

const jsonOf = (event) => Option.getOrThrow(releasedJson(event))

const releaseEvent = async (value, recipientId) => {
  const audience = await Effect.runPromise(services.disclosure.audience("event", recipientId))

  return Effect.runPromise(
    services.disclosure.release({ payload: ReleasePayload.JsonValue({ value }) }, audience),
  )
}

const eventKindsOf = (items) => {
  const kinds = []

  for (const item of items) {
    const json = releasedJson(item)

    if (Option.isSome(json) && json.value !== null && !Array.isArray(json.value)) {
      const kind = json.value["kind"]

      if (Schema.is(Schema.String)(kind)) kinds.push(kind)
    }
  }

  return kinds
}

const fail = (message) => {
  throw new Error(message)
}

try {
  // ---------------------------------------------------------------------
  // 1. Append and causal ordering on the swapped store.
  // ---------------------------------------------------------------------
  {
    const audience = await Effect.runPromise(services.disclosure.audience("event", "proof-reader"))
    const feed = await Effect.runPromise(services.observations.open({ audience }))

    for (const n of [1, 2, 3, 4, 5]) {
      const event = await releaseEvent({ n }, "proof-reader")
      await Effect.runPromise(services.observations.append(feed, event))
    }

    const page = await Effect.runPromise(services.observations.observe(feed, null, 0))

    record(
      "append-order",
      JSON.stringify(page.items.map(jsonOf)) === JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]) && page.gap === false,
      JSON.stringify(page.items.map(jsonOf)),
    )

    // Resume from the opaque position: no event already delivered may
    // reappear.
    const second = await Effect.runPromise(services.observations.observe(feed, page.resume, 0))
    const mid = await Effect.runPromise(services.observations.positionFromOffset(feed, 3))
    const tail = await Effect.runPromise(services.observations.observe(feed, mid, 0))

    record(
      "resume-no-duplicates",
      second.items.length === 0 &&
        JSON.stringify(tail.items.map(jsonOf)) === JSON.stringify([{ n: 4 }, { n: 5 }]) &&
        positionOffset(tail.resume) === 5,
      "second=" + String(second.items.length) + " tail=" + JSON.stringify(tail.items.map(jsonOf)),
    )

    await Effect.runPromise(services.observations.close(feed))
  }

  // ---------------------------------------------------------------------
  // 2. Blocking wait wakes on a concurrent append.
  // ---------------------------------------------------------------------
  {
    const audience = await Effect.runPromise(services.disclosure.audience("event", "proof-waiter"))
    const feed = await Effect.runPromise(services.observations.open({ audience }))

    const waiter = Effect.runPromise(services.observations.observe(feed, null, 5000))

    await new Promise((resolve) => setTimeout(resolve, 30))

    const event = await releaseEvent({ late: true }, "proof-waiter")
    const started = Date.now()

    await Effect.runPromise(services.observations.append(feed, event))

    const page = await waiter
    const elapsed = Date.now() - started

    record(
      "wait-wakes-on-append",
      elapsed < 2000 && JSON.stringify(page.items.map(jsonOf)) === JSON.stringify([{ late: true }]),
      "elapsed=" + String(elapsed),
    )

    await Effect.runPromise(services.observations.close(feed))
  }

  // ---------------------------------------------------------------------
  // 3. Retention gap: eviction reports gap and omittedCount.
  // ---------------------------------------------------------------------
  {
    const audience = await Effect.runPromise(services.disclosure.audience("event", "proof-gap"))
    const feed = await Effect.runPromise(services.observations.open({ audience, maxEvents: 3 }))

    for (const n of [1, 2, 3, 4, 5]) {
      const event = await releaseEvent({ n }, "proof-gap")
      await Effect.runPromise(services.observations.append(feed, event))
    }

    const page = await Effect.runPromise(services.observations.observe(feed, null, 0))

    record(
      "retention-gap",
      page.gap === true &&
        page.omittedCount === 2 &&
        JSON.stringify(page.items.map(jsonOf)) === JSON.stringify([{ n: 3 }, { n: 4 }, { n: 5 }]),
      "gap=" + String(page.gap) + " omitted=" + String(page.omittedCount),
    )

    // A slow reader resuming from inside the evicted region recovers at the
    // retained watermark with no duplicates and no replayed history.
    const slowPosition = await Effect.runPromise(services.observations.positionFromOffset(feed, 0))
    const recovered = await Effect.runPromise(services.observations.observe(feed, slowPosition, 0))

    record(
      "slow-reader-recovery",
      recovered.gap === true &&
        recovered.omittedCount === 2 &&
        JSON.stringify(recovered.items.map(jsonOf)) === JSON.stringify([{ n: 3 }, { n: 4 }, { n: 5 }]),
      "recovered omitted=" + String(recovered.omittedCount),
    )

    // Byte-budget eviction on the segmented list too.
    const byteFeed = await Effect.runPromise(
      services.observations.open({ audience, maxBytes: 600 }),
    )

    for (const n of [1, 2, 3, 4]) {
      const event = await releaseEvent({ n, data: "x".repeat(200) }, "proof-gap")
      await Effect.runPromise(services.observations.append(byteFeed, event))
    }

    const bytePage = await Effect.runPromise(services.observations.observe(byteFeed, null, 0))

    record(
      "byte-budget-gap",
      bytePage.gap === true && bytePage.omittedCount > 0 && bytePage.items.length < 4,
      "bytePage omitted=" + String(bytePage.omittedCount),
    )

    await Effect.runPromise(services.observations.close(feed))
    await Effect.runPromise(services.observations.close(byteFeed))
  }

  // ---------------------------------------------------------------------
  // 4. permission:flood end-to-end: eviction never loses the live decision.
  // ---------------------------------------------------------------------
  {
    const caller = Effect.runSync(
      services.callers.admit(Option.getOrThrow(trustedEvidence("proof-flood"))),
    )
    const grant = Effect.runSync(
      services.authority.decide(
        caller,
        { kind: "local", id: "local-1" },
        { effect: "execute" },
        Evidence.Explicit({ ceiling: "high" }),
      ),
    )
    const leaseScope = await Effect.runPromise(Scope.make())

    try {
      const lease = await Effect.runPromise(
        services.placement
          .open(
            caller,
            RunIntent.Local({
              workspace: { kind: "borrowed", path: sandbox },
              settings: { autonomyLevel: "high" },
            }),
            grant,
            ["submit", "observe", "interrupt", "answer"],
          )
          .pipe(Scope.provide(leaseScope)),
      )

      const initialPage = await Effect.runPromise(services.turns.observeLease(lease, null, 0))
      const turn = await Effect.runPromise(
        services.turns.start(lease, { text: "permission:flood" }, grant),
      )

      await Effect.runPromise(services.turns.wait(turn, "decision_or_terminal", 5000))

      // Wait for the flood to evict the prompt event out of the 4-event
      // retention window.
      let evictedPage = await Effect.runPromise(
        services.turns.observe(turn, initialPage.resume, 500),
      )

      // The flood keeps arriving while pre-prompt events already evicted set
      // gap true, so keep polling until the prompt event itself is gone.
      for (
        let attempt = 0;
        attempt < 20 &&
        (!evictedPage.gap || eventKindsOf(evictedPage.items).includes("decision_offered"));
        attempt += 1
      ) {
        await Effect.runPromise(Effect.sleep("50 millis"))
        evictedPage = await Effect.runPromise(services.turns.observe(turn, initialPage.resume, 0))
      }

      const kinds = eventKindsOf(evictedPage.items)

      record(
        "flood-evicts-prompt-event",
        evictedPage.gap === true &&
          evictedPage.omittedCount > 0 &&
          !kinds.includes("decision_offered"),
        "gap=" + String(evictedPage.gap) + " kinds=" + kinds.join(","),
      )

      const afterEviction = await Effect.runPromise(services.turns.inspect(turn))
      const liveDecision = afterEviction.outstandingDecisions[0]

      if (liveDecision === undefined) fail("no live decision after eviction")

      record(
        "decision-survives-eviction",
        afterEviction.status === "running" && afterEviction.outstandingDecisions.length === 1,
        "status=" + afterEviction.status,
      )

      await Effect.runPromise(
        services.turns.decide(
          turn,
          liveDecision.ref,
          HumanChoice.Permission({ outcome: "proceed_once" }),
          grant,
        ),
      )

      const completed = await Effect.runPromise(services.turns.wait(turn, "terminal", 5000))

      record(
        "turn-completes-after-answer",
        completed.status === "completed" && completed.outstandingDecisions.length === 0,
        "status=" + completed.status,
      )

      await Effect.runPromise(services.turns.retireLease(lease))
      await Effect.runPromise(lease.release())
    } finally {
      await Effect.runPromise(Scope.close(leaseScope, Exit.void))
    }
  }
} catch (error) {
  record("harness-error", false, error instanceof Error ? error.message : String(error))
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void))
}

console.log("PROOF1_RESULT " + JSON.stringify({ checks }))
`

/** Recursive file listing as forward-slash relative paths, sorted. */
const collectRelativePaths = (root: string): ReadonlyArray<string> => {
  const collected: Array<string> = []

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        collected.push(relative(root, path).split(sep).join("/"))
      }
    }
  }

  walk(root)

  return collected.sort()
}

interface ProofCheck {
  readonly name: string
  readonly pass: boolean
  readonly detail: string | null
}

interface ProofResult {
  readonly checks: ReadonlyArray<ProofCheck>
}

const readResult = (stdout: string): ProofResult => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("PROOF1_RESULT "))

  if (line === undefined) {
    throw new Error("child process produced no PROOF1_RESULT line; stdout:\n" + stdout)
  }

  // SAFETY: the child harness serializes exactly this shape on its single
  // result line; a parse failure here is a test failure either way.
  return JSON.parse(line.slice("PROOF1_RESULT ".length)) as ProofResult
}

describe("structural proof 1: replace observation storage alone", () => {
  it("swaps only observations/private/store.ts and passes every case unmodified", () => {
    const tree = mkdtempSync(join(tmpdir(), "droid-mcp-proof1-"))

    try {
      cpSync(SRC_DIR, join(tree, "src"), { recursive: true })
      symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"), "dir")
      writeFileSync(join(tree, "src", STORE_RELATIVE), REPLACEMENT_STORE)
      writeFileSync(join(tree, "harness.mjs"), HARNESS)

      // -------------------------------------------------------------------
      // Structural claim: every other file in the copy is byte-identical to
      // the repo original. The store itself must differ.
      // -------------------------------------------------------------------
      const copiedRelative = collectRelativePaths(join(tree, "src"))
      const originalRelative = collectRelativePaths(SRC_DIR)

      expect(copiedRelative).toEqual(originalRelative)

      const storeCopied = readFileSync(join(tree, "src", STORE_RELATIVE))
      const storeOriginal = readFileSync(join(SRC_DIR, STORE_RELATIVE))

      expect(storeCopied.equals(storeOriginal)).toBe(false)
      expect(storeCopied.includes("segmentedLinkedStore")).toBe(true)
      expect(storeCopied.includes("arrayRingStore")).toBe(false)

      const differing: Array<string> = []

      for (const relativePath of originalRelative) {
        if (relativePath === "observations/private/store.ts") continue

        const copied = readFileSync(join(tree, "src", relativePath))
        const original = readFileSync(join(SRC_DIR, relativePath))

        if (!copied.equals(original)) differing.push(relativePath)
      }

      expect(differing).toEqual([])

      const stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", join(tree, "harness.mjs"), tree, FAKE_EXEC],
        {
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      )

      const result = readResult(stdout)
      const failed = result.checks.filter((check) => !check.pass)

      expect(failed.map((check) => check.name + ": " + String(check.detail))).toEqual([])
      expect(result.checks.map((check) => check.name).sort()).toEqual(
        [
          "append-order",
          "byte-budget-gap",
          "decision-survives-eviction",
          "flood-evicts-prompt-event",
          "resume-no-duplicates",
          "retention-gap",
          "slow-reader-recovery",
          "turn-completes-after-answer",
          "wait-wakes-on-append",
        ].sort(),
      )
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  }, 90_000)
})
