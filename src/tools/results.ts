import { randomBytes } from "node:crypto"

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { ApiKeyId } from "../http/auth.ts"
import type { ToolFailure } from "./failure.ts"

/**
 * Bounded tool results. A result larger than the caller's byte budget is kept
 * here, whole and already redacted, and the caller gets a preview plus a
 * reference it can page through with `result_read`. Nothing is dropped: the
 * stored text is the exact JSON the full-size result would have carried.
 */

export const DEFAULT_RESULT_BYTES = 16_384
export const MIN_RESULT_BYTES = 1_024
export const MAX_RESULT_BYTES = 262_144

/** Results expire after this long unused. */
export const RESULT_TTL_MS = 15 * 60_000

/** Total bytes held across all stored results; the oldest go first past it. */
export const STORE_BYTE_LIMIT = 64 * 1024 * 1024

/** Room the envelope around a preview needs, with slack for its other fields. */
const ENVELOPE_OVERHEAD = 512

export const ResultBytes = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_RESULT_BYTES, maximum: MAX_RESULT_BYTES }),
).annotate({
  description:
    "Largest serialized result to return inline, in bytes: 16384 by default. A larger " +
    "result returns a preview and a ref for result_read.",
})

export const JsonPointer = Schema.String.annotate({
  description:
    'JSON Pointer (RFC 6901) into the result, such as "/sessions/0/id". Only that part is ' +
    "returned. Empty selects the whole result.",
})

interface Stored {
  readonly text: string
  readonly bytes: number
  readonly owner: string | undefined
  expiresAt: number
}

export interface ResultStoreApi {
  readonly put: (text: string) => Effect.Effect<string>
  readonly get: (ref: string) => Effect.Effect<Stored, ToolFailure>
}

export class ResultStore extends Context.Service<ResultStore, ResultStoreApi>()(
  "droid-mcp/ResultStore",
) {}

const notFound = (ref: string): ToolFailure => ({
  code: "result_not_found",
  message: "no stored result " + ref + "; it expired or belongs to another key. Repeat the call.",
})

/** The caller's key id, when the request came through the authenticated route. */
const currentOwner = Effect.map(Effect.serviceOption(ApiKeyId), Option.getOrUndefined)

export const makeResultStore = (now: () => number = Date.now): ResultStoreApi => {
  const entries = new Map<string, Stored>()
  let held = 0

  const drop = (ref: string, entry: Stored): void => {
    entries.delete(ref)
    held -= entry.bytes
  }

  const sweep = (at: number): void => {
    for (const [ref, entry] of entries) {
      if (entry.expiresAt <= at) drop(ref, entry)
    }
  }

  return {
    put: (text) =>
      Effect.map(currentOwner, (owner) => {
        const at = now()
        const bytes = Buffer.byteLength(text, "utf8")

        sweep(at)

        // Map iteration is insertion order, so the first entries are the oldest.
        for (const [ref, entry] of entries) {
          if (held + bytes <= STORE_BYTE_LIMIT) break

          drop(ref, entry)
        }

        const ref = "res_" + randomBytes(12).toString("base64url")

        entries.set(ref, { text, bytes, owner, expiresAt: at + RESULT_TTL_MS })
        held += bytes

        return ref
      }),
    get: (ref) =>
      Effect.flatMap(currentOwner, (owner) => {
        const at = now()

        sweep(at)

        const entry = entries.get(ref)

        if (entry === undefined || entry.owner !== owner) return Effect.fail(notFound(ref))

        entry.expiresAt = at + RESULT_TTL_MS

        return Effect.succeed(entry)
      }),
  }
}

export const resultStoreLayer = Layer.sync(ResultStore, () => makeResultStore())

type JsonObject = { readonly [key: string]: Schema.Json }

export const isJsonObject = (value: Schema.Json): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const unescape = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~")

const ArrayIndex = /^(0|[1-9][0-9]*)$/

/** Resolves an RFC 6901 pointer; `undefined` when a step does not exist. */
export const pointerGet = (value: Schema.Json, pointer: string): Schema.Json | undefined => {
  if (pointer === "") return value

  if (!pointer.startsWith("/")) return undefined

  let current: Schema.Json | undefined = value

  for (const raw of pointer.slice(1).split("/")) {
    const token = unescape(raw)

    if (Array.isArray(current)) {
      current = ArrayIndex.test(token) ? current[Number(token)] : undefined
    } else if (isJsonObject(current)) {
      current = Object.hasOwn(current, token) ? current[token] : undefined
    } else {
      return undefined
    }

    if (current === undefined) return undefined
  }

  return current
}

export const select = (
  value: Schema.Json | undefined,
  pointer: string | undefined,
): Effect.Effect<Schema.Json | undefined, ToolFailure> => {
  if (pointer === undefined || pointer === "" || value === undefined) return Effect.succeed(value)

  const selected = pointerGet(value, pointer)

  if (selected === undefined) {
    return Effect.fail({
      code: "invalid_select",
      message: "select " + JSON.stringify(pointer) + " does not name a part of the result",
    })
  }

  return Effect.succeed(selected)
}

/** The longest prefix of `text` within `bytes` UTF-8 bytes that ends on a character boundary. */
export const utf8Slice = (text: string, start: number, bytes: number): string => {
  const buffer = Buffer.from(text, "utf8")
  let from = Math.min(start, buffer.length)

  while (from > 0 && from < buffer.length && (buffer[from] & 0xc0) === 0x80) from -= 1

  let end = Math.min(from + bytes, buffer.length)

  while (end > from && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1

  return buffer.subarray(from, end).toString("utf8")
}

export interface Truncated {
  readonly truncated: true
  readonly ref: string
  readonly totalBytes: number
  readonly preview: string
  readonly hint: string
}

export type Bounded = { readonly result: Schema.Json | undefined } | Truncated

const HINT =
  "The result is larger than maxBytes. Read it with result_read { ref, offset }, narrow it " +
  "with select, or raise maxBytes."

const sizeOf = (value: Bounded): number => Buffer.byteLength(JSON.stringify(value), "utf8")

/**
 * Returns the value inline when it fits `maxBytes`, otherwise stores its JSON
 * text and returns a preview sized so the whole envelope still fits.
 */
export const bound = (
  store: ResultStoreApi,
  value: Schema.Json | undefined,
  maxBytes: number,
): Effect.Effect<Bounded> => {
  if (value === undefined) return Effect.succeed({ result: undefined })

  if (sizeOf({ result: value }) <= maxBytes) return Effect.succeed({ result: value })

  const text = JSON.stringify(value)

  return Effect.map(store.put(text), (ref): Bounded => {
    const totalBytes = Buffer.byteLength(text, "utf8")
    // Escaping inside a JSON string at most doubles a JSON text's bytes.
    let budget = Math.max(0, Math.floor((maxBytes - ENVELOPE_OVERHEAD) / 2))

    const envelopeOf = (preview: string): Truncated => ({
      truncated: true,
      ref,
      totalBytes,
      preview,
      hint: HINT,
    })

    let envelope = envelopeOf(utf8Slice(text, 0, budget))

    while (sizeOf(envelope) > maxBytes && budget > 0) {
      budget = Math.floor(budget / 2)
      envelope = envelopeOf(utf8Slice(text, 0, budget))
    }

    return envelope
  })
}
