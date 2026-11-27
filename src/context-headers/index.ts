/**
 * `context-headers` owns the validation and normalization of operator-supplied
 * static Context headers. The decision hidden here is which names and values
 * HTTP can carry safely, which names the Context transport owns, and how much
 * diagnostic information may cross without echoing configuration material.
 * It performs no transport I/O and knows nothing about the operation list.
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

/** A static Context header cannot be carried or interpreted safely. Neither names nor values are echoed. */
export class ContextHeadersInvalid extends Schema.TaggedError<ContextHeadersInvalid>()(
  "ContextHeadersInvalid",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

export type ContextHeaderProblemReason =
  | "invalid-shape"
  | "invalid-name"
  | "reserved-name"
  | "duplicate-name"
  | "invalid-value"

export interface ContextHeaderProblem {
  readonly reason: ContextHeaderProblemReason
}

export type ContextHeadersValidation =
  | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly problem: ContextHeaderProblem }

/** Fetch strips surrounding spaces and tabs before sending, so the stored value matches the wire. */
const HEADER_WHITESPACE = /^[ \t]+|[ \t]+$/g

/** Normalizes one operator header value to the bytes fetch writes on the wire. */
export const normalizeHeaderValue = (value: string): string => value.replace(HEADER_WHITESPACE, "")

/** Whether one name is a token HTTP can carry in a header field. */
export const isValidHeaderName = (name: string): boolean =>
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)

/** Whether a value carries a control character other than tab, or anything past Latin-1. */
export const hasForbiddenHeaderValueCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code <= 0x08 || (code >= 0x0b && code <= 0x1f) || code === 0x7f || code > 0xff) {
      return true
    }
  }

  return false
}

/** Headers this transport owns or that would break routing, authentication or framing. */
const RESERVED_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** Whether the transport owns or forbids one header name, case-insensitively. */
export const isReservedHeaderName = (name: string): boolean =>
  RESERVED_HEADERS.has(name.toLowerCase())

/**
 * Validates and normalizes static Context headers once for every entry path.
 * The input must be a record even for direct JavaScript embeddings, because
 * strings and arrays would otherwise enumerate as invented numeric header
 * names. Names must be HTTP tokens other than `__proto__`, which JavaScript
 * record carriers cannot represent safely as data; values must fit the
 * header wire format, and case-insensitive duplicates are refused.
 * Transport-owned names are either rejected (operator configuration) or
 * omitted (direct embedding); either way they never compete with
 * authentication, negotiation or framing.
 */
export const validateContextHeaders = (
  headers: Readonly<Record<string, string>>,
  options: { readonly reserved: "reject" | "ignore" },
): ContextHeadersValidation => {
  // Direct JavaScript embeddings are a runtime boundary too. A string or an
  // array is enumerable as numeric members, so shape validation must happen
  // before `Object.entries` can invent header names that were never supplied.
  if (!Predicate.isObject(headers) || Array.isArray(headers)) {
    return { ok: false, problem: { reason: "invalid-shape" } }
  }

  const entries: Array<readonly [string, string]> = []
  const seen = new Set<string>()

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()

    // JavaScript object and Headers carriers treat this one token as prototype
    // state rather than data, so it cannot be represented safely as a record key.
    if (lower === "__proto__" || !isValidHeaderName(name)) {
      return { ok: false, problem: { reason: "invalid-name" } }
    }

    if (isReservedHeaderName(name)) {
      if (options.reserved === "reject") {
        return { ok: false, problem: { reason: "reserved-name" } }
      }

      continue
    }

    if (seen.has(lower)) {
      return { ok: false, problem: { reason: "duplicate-name" } }
    }

    // The record is typed as string-valued, but direct JavaScript embeddings
    // are a runtime boundary too; reject rather than reading string methods
    // off a non-string value.
    if (!Schema.is(Schema.String)(value) || hasForbiddenHeaderValueCharacter(value)) {
      return { ok: false, problem: { reason: "invalid-value" } }
    }

    seen.add(lower)
    entries.push([name, normalizeHeaderValue(value)])
  }

  return { ok: true, headers: Object.fromEntries(entries) }
}
