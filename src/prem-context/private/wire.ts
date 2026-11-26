/**
 * Wire constants and input validation shared by the Context operations: the
 * exact size and shape bounds the legacy surface enforces, plus the response
 * member codecs the upstream replies are checked against. Decimal counters
 * travel as decimal strings everywhere, so values past 2^53 keep their
 * precision end to end.
 */
import { Buffer } from "node:buffer"

import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

export const CONTEXT_API_PATH = "/api/context"

export const COUNTER_MAX = "9223372036854775807"

export const BODY_MAX_BYTES = 256 * 1024
export const PATH_MAX_BYTES = 512
export const NAME_MAX_LENGTH = 120
export const PART_MAX_BYTES = 3 * 1024 * 1024
export const PART_MAX_BASE64_LENGTH = (PART_MAX_BYTES / 3) * 4
export const RECORD_MAX_BYTES = 64 * 1024
export const BATCH_MAX_BYTES = 256 * 1024
export const BATCH_MAX_RECORDS = 100

export const CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const

export type ContentTypeValue = (typeof CONTENT_TYPES)[number]

interface FileSizeTable {
  readonly "image/png": number
  readonly "image/jpeg": number
  readonly "image/gif": number
  readonly "image/webp": number
  readonly "application/pdf": number
}

/** The upstream per-type upload limits. */
export const FILE_MAX_BYTES: FileSizeTable = {
  "image/png": 10 * 1024 * 1024,
  "image/jpeg": 10 * 1024 * 1024,
  "image/gif": 10 * 1024 * 1024,
  "image/webp": 10 * 1024 * 1024,
  "application/pdf": 25 * 1024 * 1024,
}

/** The last part index of the largest file. */
export const PART_MAX_INDEX =
  Math.ceil(Math.max(...Object.values(FILE_MAX_BYTES)) / PART_MAX_BYTES) - 1

/** Same-length decimal strings compare like the numbers they spell. */
export const withinCounterRange = (value: string): boolean =>
  value.length < COUNTER_MAX.length || (value.length === COUNTER_MAX.length && value <= COUNTER_MAX)

const STRING_COUNTER =
  " A decimal string, never a JSON number, so counters past 2^53 keep their precision."

export const Version = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,18}$/),
  Schema.makeFilter(withinCounterRange),
).annotate({
  description: "A document version: 1 through " + COUNTER_MAX + "." + STRING_COUNTER,
})

export const Sequence = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,18})$/),
  Schema.makeFilter(withinCounterRange),
)

export const ContextId = Schema.NonEmptyString.check(
  Schema.makeFilter((value: string) => value !== "." && value !== ".."),
)

export const SpaceId = ContextId.annotate({ description: "The space ID (a UUID)." })

export const DocumentId = ContextId.annotate({ description: "The document ID (a UUID)." })

export const FileId = ContextId.annotate({
  description: "The file ID createContextFile returned.",
})

export const SessionId = ContextId.annotate({ description: "The stored session ID (a UUID)." })

export const DocumentPath = Schema.NonEmptyString.annotate({
  description:
    "A relative, forward-slash-separated document name of at most " +
    String(PATH_MAX_BYTES) +
    " UTF-8 bytes, such as `notes/plan.md`.",
})

export const DocumentBody = Schema.String.annotate({
  description:
    "Text contents of at most " + String(BODY_MAX_BYTES) + " UTF-8 bytes. Give `body` or `fileId`.",
})

export const CommitFileId = ContextId.annotate({
  description:
    "A fully uploaded pending file to commit as a binary document. Give `body` or `fileId`.",
})

export const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
  description: "Items per page, 1-100.",
})

export const Cursor = Schema.String

export const PartIndex = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: PART_MAX_INDEX }),
).annotate({ description: "The zero-based part index, 0-" + String(PART_MAX_INDEX) + "." })

export const AccessScope = Schema.Literals(["organization", "members"])

export const MergeMode = Schema.Literals(["auto", "strict"])

export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const Kinds = Schema.NonEmptyArray(Schema.Literals(["text", "binary"]))

export const MaxBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BATCH_MAX_BYTES }))

// ---------------------------------------------------------------------------
// Input cross-field checks (exactly the legacy preflight refusals)
// ---------------------------------------------------------------------------

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8")

export const pathProblem = (path: string): string | undefined =>
  utf8Bytes(path) > PATH_MAX_BYTES
    ? "path exceeds " + String(PATH_MAX_BYTES) + " UTF-8 bytes"
    : undefined

export interface DocumentContent {
  readonly body?: string | undefined
  readonly fileId?: string | undefined
}

export const contentProblem = (content: DocumentContent): string | undefined => {
  if ((content.body === undefined) === (content.fileId === undefined)) {
    return "give exactly one of body or fileId"
  }

  if (content.body !== undefined && utf8Bytes(content.body) > BODY_MAX_BYTES) {
    return "body exceeds " + String(BODY_MAX_BYTES) + " UTF-8 bytes"
  }

  return undefined
}

/** Canonical base64 only: a lossy input (stray characters skipped) is refused. */
export const decodePart = (text: string): Uint8Array | undefined => {
  if (text.length === 0 || text.length > PART_MAX_BASE64_LENGTH) return undefined

  const bytes = Buffer.from(text, "base64")

  return bytes.toString("base64") === text ? new Uint8Array(bytes) : undefined
}

export const partProblem = (text: string): string | undefined =>
  decodePart(text) === undefined
    ? "contentBase64 must be canonical base64 of 1 to " + String(PART_MAX_BYTES) + " bytes"
    : undefined

export const jsonlRecords = (text: string): ReadonlyArray<string> => text.slice(0, -1).split("\n")

/** Lenient JSON used for input preflight only; the wire never parses untrusted replies with it. */
const decodeJsonLenient = (text: string): Schema.Json | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(JSON.parse(text)))
  } catch {
    return undefined
  }
}

export const jsonlProblem = (text: string): string | undefined => {
  if (!text.endsWith("\n")) return "contentJsonl must end with a newline"

  if (utf8Bytes(text) > BATCH_MAX_BYTES) {
    return "contentJsonl exceeds " + String(BATCH_MAX_BYTES) + " UTF-8 bytes"
  }

  const records = jsonlRecords(text)

  if (records.length > BATCH_MAX_RECORDS) {
    return "contentJsonl has more than " + String(BATCH_MAX_RECORDS) + " records"
  }

  for (const [index, record] of records.entries()) {
    const label = "contentJsonl record " + String(index + 1)

    if (utf8Bytes(record) + 1 > RECORD_MAX_BYTES) {
      return label + " exceeds " + String(RECORD_MAX_BYTES) + " UTF-8 bytes with its newline"
    }

    if (!Predicate.isObject(decodeJsonLenient(record))) return label + " is not a JSON object"
  }

  return undefined
}

export const sequenceRangeProblem = (
  startSequence: string,
  contentJsonl: string,
): string | undefined =>
  BigInt(startSequence) + BigInt(jsonlRecords(contentJsonl).length - 1) <= BigInt(COUNTER_MAX)
    ? undefined
    : "the batch would pass the largest sequence, " + COUNTER_MAX

export const firstProblem = (...problems: ReadonlyArray<string | undefined>): string | undefined =>
  problems.find((problem) => problem !== undefined)

/** A lone surrogate cannot be put in a URL or a valid request, so it is refused up front. */
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

/** Present entries, in the order they are declared. */
export const queryOf = (
  entries: ReadonlyArray<readonly [string, string | number | undefined]>,
): ReadonlyArray<readonly [string, string]> =>
  entries.flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)] as const]))

// ---------------------------------------------------------------------------
// Reply member codecs: what the upstream contract requires on success
// ---------------------------------------------------------------------------

const attribution = {
  createdByPrincipalKind: Schema.String,
  createdByPrincipalId: Schema.String,
  updatedByPrincipalKind: Schema.String,
  updatedByPrincipalId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}

export const SpaceReply = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  accessScope: Schema.String,
  ...attribution,
})

export const FileReply = Schema.Struct({
  fileId: Schema.String,
  contentType: Schema.String,
  sizeBytes: Schema.Number,
  sha256: Schema.String,
  partSizeBytes: Schema.Number,
  partCount: Schema.Number,
})

const metadataFields = {
  id: Schema.String,
  spaceId: Schema.String,
  path: Schema.String,
  version: Version,
  retiredAt: Schema.optional(Schema.NullOr(Schema.String)),
  ...attribution,
  file: Schema.optional(FileReply),
}

export const MetadataReply = Schema.Struct(metadataFields)

export const DocumentReply = Schema.Struct({ ...metadataFields, body: Schema.String })

export const UploadReply = Schema.Struct({
  fileId: Schema.String,
  partSizeBytes: Schema.Number,
  partCount: Schema.Number,
  expiresAt: Schema.String,
})

export const SessionReply = Schema.Struct({
  sessionId: Schema.String,
  spaceId: Schema.String,
  parentSessionId: Schema.NullOr(Schema.String),
  ownerKind: Schema.String,
  ownerId: Schema.String,
  lastSequence: Sequence,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

export const AppendReply = Schema.Struct({
  lastSequence: Sequence,
  acceptedThroughSequence: Version,
  appendedRecords: Schema.Int,
})

export const RecordsReply = Schema.Struct({
  contentJsonl: Schema.String,
  lastSequence: Sequence,
  nextCursor: Sequence,
  hasMore: Schema.Boolean,
})

export const pageOf = (item: Schema.Top) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.optional(Schema.String) })

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
