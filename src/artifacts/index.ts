/**
 * `artifacts` owns selection, byte encoding, inline budgets, retention and
 * continuation access.
 *
 * A released value smaller than the caller's inline budget is delivered
 * inline; a larger one is retained as encoded UTF-8 bytes and delivered as a
 * preview plus an opaque ref the owning caller pages through with `read`.
 * Retention enforces two independent limits on encoded bytes: the
 * value must fit both bounds before any eviction (an exact fit is eligible;
 * one byte over yields no ref and evicts nothing). If needed, the aggregate
 * bound then evicts the oldest entries.
 *
 * Every ref is bound to the caller that stored it: a foreign caller reading
 * it gets the same `ArtifactUnavailable` as a missing or expired ref. On
 * every read the retained value is revalidated against the current
 * disclosure policy; a tightened policy re-scrubs the bytes before they are
 * paged, so a retained ref can never bypass it. Pointer selection re-scopes
 * disclosure protection to the selected subtree, so later revalidation never
 * applies the root shape at the wrong position. Pages slice the stored
 * encoded buffer directly, end on UTF-8 character boundaries, and
 * concatenating consecutive pages reproduces the exact original bytes.
 */
import { randomBytes } from "node:crypto"

import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { type Caller, sameCaller } from "../caller/index.ts"
import { Disclosure, type DisclosureApi, type Released, releasedJson } from "../disclosure/index.ts"
import { pointerTokens } from "./private/pointer.ts"
import { type ArtifactStoreApi, openArtifactStore, type StoredEntry } from "./private/store.ts"
import { cleanEnd, decodeRange, isContinuationByte, pageEnd } from "./private/utf8.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INLINE_BYTES = 16_384
export const MIN_INLINE_BYTES = 1_024
export const MAX_INLINE_BYTES = 262_144

/** Retained artifacts expire after this long unused. */
export const DEFAULT_ARTIFACT_TTL_MS = 15 * 60_000

/** Total encoded bytes held across all retained artifacts; oldest go first. */
export const DEFAULT_AGGREGATE_BYTE_LIMIT = 64 * 1024 * 1024

/** Largest encoded byte size of any single retained artifact. */
export const DEFAULT_SINGLE_ARTIFACT_BYTE_LIMIT = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// ArtifactRef
// ---------------------------------------------------------------------------

declare const artifactRefBrand: unique symbol

/** An opaque continuation reference, issued only by this module. */
export type ArtifactRef = string & { readonly [artifactRefBrand]: true }

const REF_PATTERN = /^res_[A-Za-z0-9_-]{16}$/

/**
 * Validates the external shape of an artifact ref. A well-formed string is
 * input to lookup only; it is never proof of access or existence.
 */
export const parseArtifactRef = (raw: string): Option.Option<ArtifactRef> => {
  if (!REF_PATTERN.test(raw)) return Option.none()

  // SAFETY: the pattern pins the exact `res_<12 base64url bytes>` shape that
  // this module mints; validation checks shape only and grants no access.
  return Option.some(raw as ArtifactRef)
}

const mintRef = (): ArtifactRef => {
  const raw = "res_" + randomBytes(12).toString("base64url")

  // SAFETY: the minted string matches `REF_PATTERN` by construction — twelve
  // random bytes encode to exactly sixteen base64url characters.
  return raw as ArtifactRef
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SelectionBudget {
  readonly maxBytes?: number
  readonly select?: string
}

export interface PageRequest {
  readonly offset?: number
  /** Byte budget; a page can exceed it to return one complete UTF-8 character. */
  readonly length?: number
  readonly select?: string
}

export type Delivery = Data.TaggedEnum<{
  readonly Inline: { readonly value: Released<"client">; readonly bytes: number }
  readonly Preview: {
    readonly ref: ArtifactRef
    readonly preview: string
    readonly totalBytes: number
    readonly truncated: true
  }
}>

export const Delivery = Data.taggedEnum<Delivery>()

export interface Page {
  readonly ref: ArtifactRef
  readonly chunk: string
  readonly offset: number
  readonly nextOffset: number | null
  readonly totalBytes: number
  readonly done: boolean
}

export interface ArtifactsOptions {
  readonly aggregateByteLimit?: number
  readonly singleValueByteLimit?: number
  readonly ttlMs?: number
  readonly now?: () => number
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class SelectionFailed extends Schema.TaggedError<SelectionFailed>()("SelectionFailed", {
  message: Schema.String,
  pointer: Schema.String,
  recoveryRef: Schema.optional(Schema.String),
}) {}

/**
 * A single encoded value over the retention bound. Carries no ref: nothing
 * was retained, and checking it never evicts an existing entry.
 */
export class ArtifactTooLarge extends Schema.TaggedError<ArtifactTooLarge>()("ArtifactTooLarge", {
  message: Schema.String,
  bytes: Schema.Number,
  limit: Schema.Number,
}) {}

/**
 * One refusal shape for missing, expired, foreign and policy-refused refs:
 * an observer cannot distinguish them.
 */
export class ArtifactUnavailable extends Schema.TaggedError<ArtifactUnavailable>()(
  "ArtifactUnavailable",
  {
    message: Schema.String,
    ref: Schema.String,
  },
) {}

export class InvalidRange extends Schema.TaggedError<InvalidRange>()("InvalidRange", {
  message: Schema.String,
  offset: Schema.Number,
  totalBytes: Schema.Number,
  reason: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface StoredArtifact {
  readonly owner: Caller
  readonly released: Released<"client">
  readonly encoded: Uint8Array
  readonly revision: number
}

type Entry = StoredEntry<StoredArtifact>

const unavailable = (ref: string): ArtifactUnavailable =>
  new ArtifactUnavailable({
    message: "artifact is unavailable; it expired, never existed or belongs to another caller",
    ref,
  })

const clampInlineBudget = (maxBytes: number | undefined): number => {
  if (maxBytes === undefined) return DEFAULT_INLINE_BYTES

  return Math.min(MAX_INLINE_BYTES, Math.max(MIN_INLINE_BYTES, Math.floor(maxBytes)))
}

const encoder = new TextEncoder()

const encode = (text: string): Uint8Array => encoder.encode(text)

const sanitizeJson = (value: Schema.Json): Schema.Json => {
  if (Predicate.isNumber(value)) return Number.isFinite(value) ? value : null

  if (Array.isArray(value)) return value.map(sanitizeJson)

  if (Predicate.isObject(value) && !Array.isArray(value)) {
    const members: Array<readonly [string, Schema.Json]> = []

    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined && !Predicate.isFunction(member)) {
        // SAFETY: the value came from a Json-typed payload; exotic members
        // (undefined, functions) are filtered above, so every surviving
        // member is still within the Json union.
        members.push([key, sanitizeJson(member as Schema.Json)])
      }
    }

    return Object.fromEntries(members)
  }

  return value
}

const serializeJson = (value: Schema.Json): string => JSON.stringify(sanitizeJson(value)) ?? "null"

/**
 * The text form of a released value for retention and paging. JsonValue
 * payloads serialize to their exact JSON text; other payloads use the
 * canonical serialization of the content the release carries.
 */
const serializePayload = (released: Released<"client">): Option.Option<string> => {
  const json = releasedJson(released)

  if (Option.isSome(json)) return Option.some(serializeJson(json.value))

  return Option.none()
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ArtifactsApi {
  readonly present: (
    caller: Caller,
    value: Released<"client">,
    request: SelectionBudget,
  ) => Effect.Effect<Delivery, SelectionFailed | ArtifactTooLarge | ArtifactUnavailable>
  readonly read: (
    caller: Caller,
    ref: ArtifactRef,
    range: PageRequest,
  ) => Effect.Effect<Page, ArtifactUnavailable | InvalidRange | SelectionFailed>
  readonly part: (
    caller: Caller,
    value: Released<"client">,
    pointer: string,
  ) => Effect.Effect<Released<"client">, SelectionFailed | ArtifactUnavailable>
}

export class Artifacts extends Context.Service<Artifacts, ArtifactsApi>()(
  "droid-mcp-v2/Artifacts",
) {}

const resolveBytes = (released: Released<"client">) => {
  const text = serializePayload(released)

  const encoded = encode(Option.isSome(text) ? text.value : "")

  return { encoded, bytes: encoded.length }
}

const resolveEntry = (
  store: ArtifactStoreApi<StoredArtifact>,
  caller: Caller,
  ref: ArtifactRef,
  ttlMs: number,
): Effect.Effect<Entry, ArtifactUnavailable> =>
  Effect.suspend(() => {
    store.sweep()

    const entry = store.lookup(ref)

    if (entry === undefined || !sameCaller(entry.value.owner, caller)) {
      return Effect.fail(unavailable(ref))
    }

    store.touch(entry, ttlMs)

    return Effect.succeed(entry)
  })

const parseJsonPointer = (
  pointer: string,
): Effect.Effect<ReadonlyArray<string>, SelectionFailed> => {
  const path = pointerTokens(pointer)

  if (path === undefined) {
    return Effect.fail(
      new SelectionFailed({
        message: "select " + JSON.stringify(pointer) + " does not name a part of the value",
        pointer,
      }),
    )
  }

  return Effect.succeed(path)
}

const revalidateReleased = (
  disclosure: DisclosureApi,
  ref: string,
  released: Released<"client">,
): Effect.Effect<Released<"client">, ArtifactUnavailable> =>
  Effect.flatMap(
    Effect.exit(
      Effect.flatMap(disclosure.audience("client", released.recipientId), (audience) =>
        disclosure.revalidate(released, audience),
      ),
    ),
    (exit) => {
      if (Exit.isFailure(exit)) {
        // Disclosure refused revalidation: the retained bytes must never leak,
        // and the refusal is indistinguishable from a missing ref.
        return Effect.fail(unavailable(ref))
      }

      return Effect.succeed(exit.value)
    },
  )

const revalidatedEntry = (
  disclosure: DisclosureApi,
  entry: Entry,
): Effect.Effect<
  { readonly encoded: Uint8Array; readonly totalBytes: number },
  ArtifactUnavailable
> =>
  Effect.map(revalidateReleased(disclosure, entry.ref, entry.value.released), (revalidated) => {
    const encoded =
      revalidated.policyRevision === entry.value.revision
        ? entry.value.encoded
        : resolveBytes(revalidated).encoded

    return { encoded, totalBytes: encoded.length }
  })

/**
 * Narrows before revalidating a selected read. Tightening policy must judge
 * only the subtree being disclosed; an atomic collision in an unread sibling
 * must not make a safe selection unavailable.
 */
const revalidatedSelection = (
  disclosure: DisclosureApi,
  entry: Entry,
  pointer: string,
): Effect.Effect<
  { readonly encoded: Uint8Array; readonly totalBytes: number },
  ArtifactUnavailable | SelectionFailed
> =>
  Effect.gen(function* () {
    const json = releasedJson(entry.value.released)

    if (Option.isNone(json)) return yield* Effect.fail(unavailable(entry.ref))

    const path = yield* parseJsonPointer(pointer)
    const narrowed = disclosure.narrowJson(entry.value.released, path)

    if (Option.isNone(narrowed)) {
      return yield* Effect.fail(
        new SelectionFailed({
          message: "select " + JSON.stringify(pointer) + " does not name a part of the value",
          pointer,
        }),
      )
    }

    const currentRevision = yield* disclosure.policyRevision()

    if (narrowed.value.policyRevision === currentRevision) {
      // At the stored revision the narrowed bytes are already the visible
      // view. Rescrubbing them would treat inserted markers as original text
      // and diverge from the whole artifact's stored bytes.
      const encoded = resolveBytes(narrowed.value).encoded

      return { encoded, totalBytes: encoded.length }
    }

    const revalidated = yield* revalidateReleased(disclosure, entry.ref, narrowed.value)
    const encoded = resolveBytes(revalidated).encoded

    return { encoded, totalBytes: encoded.length }
  })

export const artifactsLayer = (
  options?: ArtifactsOptions,
): Layer.Layer<Artifacts, never, Disclosure> => {
  const aggregateByteLimit = options?.aggregateByteLimit ?? DEFAULT_AGGREGATE_BYTE_LIMIT
  const singleValueByteLimit = options?.singleValueByteLimit ?? DEFAULT_SINGLE_ARTIFACT_BYTE_LIMIT
  const ttlMs = options?.ttlMs ?? DEFAULT_ARTIFACT_TTL_MS
  const now = options?.now ?? Date.now

  return Layer.effect(
    Artifacts,
    Effect.gen(function* () {
      const disclosure = yield* Disclosure

      const store = openArtifactStore<StoredArtifact>({
        aggregateByteLimit,
        singleValueByteLimit,
        now,
      })

      const retain = (
        caller: Caller,
        released: Released<"client">,
        encoded: Uint8Array,
      ): Option.Option<ArtifactRef> => {
        const ref = mintRef()

        const inserted = store.insert(
          ref,
          {
            owner: caller,
            released,
            encoded,
            revision: released.policyRevision,
          },
          encoded.length,
          ttlMs,
        )

        return inserted ? Option.some(ref) : Option.none()
      }

      const selectionFailure = (
        caller: Caller,
        released: Released<"client">,
        pointer: string,
      ): SelectionFailed => {
        const recovery = retain(caller, released, resolveBytes(released).encoded)

        const base = {
          message: "select " + JSON.stringify(pointer) + " does not name a part of the value",
          pointer,
        }

        return new SelectionFailed(
          Option.isSome(recovery) ? { ...base, recoveryRef: recovery.value } : base,
        )
      }

      const present: ArtifactsApi["present"] = (caller, value, request) =>
        Effect.gen(function* () {
          const json = releasedJson(value)

          if (Option.isNone(json)) {
            return yield* Effect.fail(
              new SelectionFailed({
                message: "only a JSON value release can be presented as an artifact",
                pointer: request.select ?? "",
              }),
            )
          }

          let selected = value

          if (request.select !== undefined && request.select !== "") {
            const path = yield* Effect.exit(parseJsonPointer(request.select))

            if (Exit.isFailure(path)) {
              return yield* Effect.fail(selectionFailure(caller, value, request.select))
            }

            const narrowed = disclosure.narrowJson(value, path.value)

            if (Option.isNone(narrowed)) {
              return yield* Effect.fail(selectionFailure(caller, value, request.select))
            }

            selected = narrowed.value
          }

          const currentRevision = yield* disclosure.policyRevision()

          // `present` is itself a disclosure boundary, not only a selector:
          // a policy tightened since the original release must be enforced
          // before either inline delivery or retention. At the unchanged
          // revision the stored view is already the safe view.
          const deliverable =
            selected.policyRevision === currentRevision
              ? selected
              : yield* revalidateReleased(disclosure, "unretained", selected)

          const { encoded, bytes } = resolveBytes(deliverable)
          const budget = clampInlineBudget(request.maxBytes)

          if (bytes <= budget) return Delivery.Inline({ value: deliverable, bytes })

          const ref = retain(caller, deliverable, encoded)

          if (Option.isNone(ref)) {
            const limit = store.retentionByteLimit

            return yield* Effect.fail(
              new ArtifactTooLarge({
                message: `encoded value of ${bytes} bytes exceeds the retention limit of ${limit} bytes and was not retained`,
                bytes,
                limit,
              }),
            )
          }

          const end = cleanEnd(encoded, 0, budget)

          return Delivery.Preview({
            ref: ref.value,
            preview: decodeRange(encoded, 0, end),
            totalBytes: bytes,
            truncated: true,
          })
        })

      const read: ArtifactsApi["read"] = (caller, ref, range) =>
        Effect.gen(function* () {
          const entry = yield* resolveEntry(store, caller, ref, ttlMs)
          const useSelection = range.select !== undefined && range.select !== ""

          const { encoded, totalBytes } = useSelection
            ? yield* revalidatedSelection(disclosure, entry, range.select ?? "")
            : yield* revalidatedEntry(disclosure, entry)

          if (useSelection) {
            // The narrowed release is encoded under the current policy —
            // either because it already stored that exact view or because it
            // was revalidated above — so this selected part is paged under
            // the same bounds and character checks as the whole document
            // without revalidating unread siblings.
            const selectedBytes = encoded
            const selectedTotal = totalBytes
            const offset = range.offset ?? 0

            if (offset < 0 || offset > selectedTotal) {
              return yield* Effect.fail(
                new InvalidRange({
                  message:
                    "offset " +
                    offset +
                    " is outside the selected part's " +
                    selectedTotal +
                    " bytes",
                  offset,
                  totalBytes: selectedTotal,
                  reason: "offset_out_of_bounds",
                }),
              )
            }

            if (isContinuationByte(selectedBytes, offset)) {
              return yield* Effect.fail(
                new InvalidRange({
                  message: "offset " + offset + " splits a multi-byte UTF-8 character",
                  offset,
                  totalBytes: selectedTotal,
                  reason: "offset_mid_character",
                }),
              )
            }

            const length = Math.max(1, Math.floor(range.length ?? DEFAULT_INLINE_BYTES))
            const end = pageEnd(selectedBytes, offset, length)

            const page: Page = {
              ref,
              chunk: decodeRange(selectedBytes, offset, end),
              offset,
              nextOffset: end >= selectedTotal ? null : end,
              totalBytes: selectedTotal,
              done: end >= selectedTotal,
            }

            return page
          }

          const offset = range.offset ?? 0

          if (offset < 0 || offset > totalBytes) {
            return yield* Effect.fail(
              new InvalidRange({
                message: "offset " + offset + " is outside the artifact's " + totalBytes + " bytes",
                offset,
                totalBytes,
                reason: "offset_out_of_bounds",
              }),
            )
          }

          if (isContinuationByte(encoded, offset)) {
            return yield* Effect.fail(
              new InvalidRange({
                message: "offset " + offset + " splits a multi-byte UTF-8 character",
                offset,
                totalBytes,
                reason: "offset_mid_character",
              }),
            )
          }

          const length = Math.max(1, Math.floor(range.length ?? DEFAULT_INLINE_BYTES))
          const end = pageEnd(encoded, offset, length)
          const chunk = decodeRange(encoded, offset, end)
          const atEnd = end >= totalBytes

          const page: Page = {
            ref,
            chunk,
            offset,
            nextOffset: atEnd ? null : end,
            totalBytes,
            done: atEnd,
          }

          return page
        })

      // `part` selects within a value the caller already holds, so there is
      // no retained ref whose ownership could be enforced; the caller
      // parameter exists for interface parity with the other operations.
      const part: ArtifactsApi["part"] = (_caller, value, pointer) =>
        Effect.gen(function* () {
          const json = releasedJson(value)

          if (Option.isNone(json)) {
            return yield* Effect.fail(
              new SelectionFailed({
                message: "only a JSON value release can be selected by pointer",
                pointer,
              }),
            )
          }

          if (pointer === "") return value

          const path = yield* parseJsonPointer(pointer)
          const narrowed = disclosure.narrowJson(value, path)

          if (Option.isNone(narrowed)) {
            return yield* Effect.fail(
              new SelectionFailed({
                message: "select " + JSON.stringify(pointer) + " does not name a part of the value",
                pointer,
              }),
            )
          }

          return narrowed.value
        })

      return { present, read, part }
    }),
  )
}
