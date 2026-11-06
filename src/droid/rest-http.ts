import { Buffer } from "node:buffer"

import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type { JsonValue } from "./protocol.ts"

/** Pure helpers for the hosted REST client: no I/O, no Effect services. */

const DETAIL_MAX_LENGTH = 500
const PLAIN_DETAIL_MAX_LENGTH = 200

export const REDACTED = "[redacted]"

/**
 * Encodes one value as exactly one path segment. A bare `.` or `..` would be
 * resolved by URL parsing (even percent-encoded), so those are refused.
 */
export const encodePathSegment = (value: string): string | undefined =>
  value === "." || value === ".." ? undefined : encodeURIComponent(value)

/** `a=1&a=2&b=x`, or "" when there is nothing to send. */
export const serializeQuery = (entries: ReadonlyArray<readonly [string, string]>): string =>
  entries.map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&")

/** Parses a body as JSON, or `undefined` when it is not JSON. */
export const decodeJsonText = (text: string): JsonValue | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(JSON.parse(text)))
  } catch {
    return undefined
  }
}

/** `application/json` and any `+json` media type, ignoring parameters. */
export const isJsonContentType = (contentType: string | null): boolean => {
  if (contentType === null) return false

  const media = (contentType.split(";")[0] ?? "").trim().toLowerCase()

  return media === "application/json" || media.endsWith("+json")
}

/**
 * Replaces every occurrence of a non-empty secret with a marker. Longer
 * secrets go first, so one that contains a shorter one is replaced whole.
 */
export const scrubSecrets = (text: string, secrets: ReadonlyArray<string>): string => {
  let result = text

  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED)
  }

  return result
}

const ErrorBody = Schema.Struct({
  detail: Schema.optional(Schema.Json),
  title: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Json),
})

const firstString = (candidates: ReadonlyArray<JsonValue | undefined>): string | undefined => {
  for (const candidate of candidates) {
    if (Predicate.isString(candidate) && candidate.trim().length > 0) return candidate
  }

  return undefined
}

const plainDetail = (text: string): string | undefined => {
  const trimmed = text.trim()

  if (trimmed.length === 0 || trimmed.length > PLAIN_DETAIL_MAX_LENGTH) return undefined

  if (trimmed.includes("<") || trimmed.includes("\n")) return undefined

  return trimmed
}

const cap = (text: string): string =>
  text.length <= DETAIL_MAX_LENGTH ? text : text.slice(0, DETAIL_MAX_LENGTH - 1) + "…"

/** A trimmed, scrubbed, length-capped detail string that is safe to put in a failure message. */
export const safeDetail = (text: string, secrets: ReadonlyArray<string>): string =>
  cap(scrubSecrets(text.trim(), secrets))

/**
 * The human-readable part of an error body: a `FactoryApiError`'s `detail`,
 * then `title`, then a legacy `error` string. A short single-line plain-text
 * body is kept; HTML and anything else is dropped rather than echoed.
 */
export const errorDetail = (text: string, secrets: ReadonlyArray<string>): string | undefined => {
  const json = decodeJsonText(text)

  const found =
    json === undefined
      ? plainDetail(text)
      : Option.match(Schema.decodeUnknownOption(ErrorBody)(json), {
          onNone: () => undefined,
          onSome: (body) => firstString([body.detail, body.title, body.error]),
        })

  return found === undefined ? undefined : safeDetail(found, secrets)
}

export type BinaryEnvelope = {
  readonly encoding: "base64"
  readonly contentType: string
  readonly sizeBytes: number
  readonly data: string
}

export const binaryEnvelope = (bytes: Uint8Array, contentType: string): BinaryEnvelope => ({
  encoding: "base64",
  contentType,
  sizeBytes: bytes.byteLength,
  data: Buffer.from(bytes).toString("base64"),
})
