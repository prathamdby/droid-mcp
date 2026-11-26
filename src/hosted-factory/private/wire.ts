/**
 * Wire constants and input validation shared by the hosted operations: the
 * exact segment, identifier and query rules the hosted API requires. Every
 * nested target id is checked here before any request is built, so a
 * traversal or control-character id can never reach the wire.
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

/** Well-formed Unicode is required for anything placed in a URL. */
const LONE_SURROGATE = /\p{Cs}/u

export const isWellFormed = (text: string): boolean => !LONE_SURROGATE.test(text)

/**
 * Encodes one value as exactly one URL path segment. A bare `.` or `..`
 * would be resolved by URL parsing even percent-encoded, so those and any
 * ill-formed Unicode are refused instead of encoded.
 */
export const encodePathSegment = (value: string): string | undefined =>
  value === "." || value === ".." || !isWellFormed(value) ? undefined : encodeURIComponent(value)

/** `a=1&a=2&b=x`, or "" when there is nothing to send. */
export const serializeQuery = (entries: ReadonlyArray<readonly [string, string]>): string =>
  entries.map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&")

export type JsonObject = { readonly [key: string]: Schema.Json }

export const isJsonObject = (value: Schema.Json): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/** Refuses lone surrogates in any string member of a raw input object. */
export const unicodeProblem = (input: Schema.Json): string | undefined => {
  if (!isJsonObject(input)) return undefined

  for (const [name, value] of Object.entries(input)) {
    const texts: ReadonlyArray<Schema.Json> = Array.isArray(value) ? value : [value]

    for (const text of texts) {
      if (Predicate.isString(text) && !isWellFormed(text)) {
        return name + " is not well-formed Unicode"
      }
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Nested target ids
// ---------------------------------------------------------------------------

const CONTROL_OR_SPACE = /[\s\x7f-\x9f]/

/**
 * A nested target id names exactly one path segment. Anything that would
 * change the path structure or the query — separators, traversal, reserved
 * characters, whitespace or control characters — is rejected before the
 * operation body ever builds a request.
 */
const idProblem = (value: string): string | undefined => {
  if (value.length === 0) return "must not be empty"

  if (!isWellFormed(value)) return "is not well-formed Unicode"

  if (value === "." || value === "..") return "must not be . or .."

  if (value.includes("/")) return "must not contain /"

  if (value.includes("?")) return "must not contain ?"

  if (value.includes("#")) return "must not contain #"

  if (CONTROL_OR_SPACE.test(value)) return "must not contain whitespace or control characters"

  return undefined
}

/** The schema every nested target id is decoded through. */
export const HostedId = Schema.NonEmptyString.check(
  Schema.makeFilter((value: string) => idProblem(value) === undefined),
).annotate({
  description:
    "One nested target id: non-empty, free of path separators, traversal, reserved characters, whitespace and control characters.",
})

/** The cross-field message for one offending member, or undefined when clean. */
export const nestedIdProblem = (name: string, value: string): string | undefined => {
  const problem = idProblem(value)

  return problem === undefined ? undefined : name + " " + problem
}

/** The first problem across a list of `{ name, value }` nested id members. */
export const firstIdProblem = (
  entries: ReadonlyArray<readonly [string, string | undefined]>,
): string | undefined => {
  for (const [name, value] of entries) {
    if (value === undefined) continue

    const problem = nestedIdProblem(name, value)

    if (problem !== undefined) return problem
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Shared input members
// ---------------------------------------------------------------------------

export const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
  description: "Items per page, 1-100.",
})

export const Cursor = Schema.String

/** Sent on the wire as `"true"` or `"false"`. */
export const BooleanFlag = Schema.Boolean

export const JsonBody = Schema.Record(Schema.String, Schema.Json)

/** An object whose listed fields are checked; upstream accepts more members, kept as given. */
export const openStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [JsonBody])

const QueryScalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])

export const ExtraQuery = Schema.Record(
  Schema.String,
  Schema.Union([QueryScalar, Schema.Array(QueryScalar)]),
).annotate({
  description: "Extra query parameters sent unchanged; a key may not repeat a named input.",
})

export const extraQueryProblem = (
  query: typeof ExtraQuery.Type | undefined,
  named: ReadonlyArray<string>,
): string | undefined => {
  if (query === undefined) return undefined

  const duplicate = Object.keys(query).find((key) => named.includes(key))

  if (duplicate !== undefined) return "query." + duplicate + " duplicates the named input"

  const malformed = queryEntries(Object.entries(query)).find(
    ([key, value]) => !isWellFormed(key) || !isWellFormed(value),
  )

  return malformed === undefined
    ? undefined
    : "query parameter " + malformed[0] + " is not well-formed Unicode"
}

/**
 * Present scalar entries, in declared order. Arrays repeat the key per item;
 * booleans serialize as `"true"` or `"false"`.
 */
export const queryEntries = (
  entries: ReadonlyArray<
    readonly [string, typeof QueryScalar.Type | ReadonlyArray<typeof QueryScalar.Type> | undefined]
  >,
): ReadonlyArray<readonly [string, string]> =>
  entries.flatMap(([key, value]) => {
    if (value === undefined) return []

    if (Array.isArray(value)) return value.map((item) => [key, String(item)] as const)

    return [[key, String(value)] as const]
  })
