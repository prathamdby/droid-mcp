import { Buffer } from "node:buffer"

import * as Tool from "effect/ai/Tool"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type { JsonFields, JsonValue } from "../droid/protocol.ts"
import { decodeJsonText, encodePathSegment, isWellFormed } from "../droid/rest-http.ts"
import { RestService } from "../droid/rest-service.ts"
import type { ContextRequest, RestError, RestResult } from "../droid/rest-service.ts"
import { ToolFailure } from "./failure.ts"
import {
  Cursor,
  DESTRUCTIVE,
  PageLimit,
  invalidParams,
  restDomain,
  restFailure,
} from "./rest-kit.ts"
import type { RestDomain, RestHandler, RestParams, RestToolEntry } from "./rest-kit.ts"

/**
 * Context tools: spaces, documents, files, and stored session records on the
 * Prem origin named by `FACTORY_CONTEXT_BASE_URL`. Each tool sends the request
 * the SDK's Context helper of the same name would, through `RestService`, so
 * calls are cancellable and size-capped. Inputs are checked here first, as
 * the helpers do not check them, and responses are checked against the
 * helpers' contracts before redaction.
 */

const CONTEXT_API_PATH = "/api/context"

const COUNTER_MAX = "9223372036854775807"

const BODY_MAX_BYTES = 256 * 1024
const PATH_MAX_BYTES = 512
const NAME_MAX_LENGTH = 120
const PART_MAX_BYTES = 3 * 1024 * 1024
const PART_MAX_BASE64_LENGTH = (PART_MAX_BYTES / 3) * 4
const RECORD_MAX_BYTES = 64 * 1024
const BATCH_MAX_BYTES = 256 * 1024
const BATCH_MAX_RECORDS = 100

const CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const

/** The SDK's per-type upload limits, which it does not export. */
const FILE_MAX_BYTES = {
  "image/png": 10 * 1024 * 1024,
  "image/jpeg": 10 * 1024 * 1024,
  "image/gif": 10 * 1024 * 1024,
  "image/webp": 10 * 1024 * 1024,
  "application/pdf": 25 * 1024 * 1024,
} satisfies { readonly [Type in (typeof CONTENT_TYPES)[number]]: number }

/** The last part of the largest file, as the SDK derives it. */
const PART_MAX_INDEX = Math.ceil(Math.max(...Object.values(FILE_MAX_BYTES)) / PART_MAX_BYTES) - 1

/** Same-length decimal strings compare like the numbers they spell. */
const withinCounterRange = (value: string): boolean =>
  value.length < COUNTER_MAX.length || (value.length === COUNTER_MAX.length && value <= COUNTER_MAX)

const STRING_COUNTER =
  " A decimal string, never a JSON number, so counters past 2^53 keep their precision."

const Version = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,18}$/),
  Schema.makeFilter(withinCounterRange),
).annotate({
  description: "A document version: 1 through " + COUNTER_MAX + "." + STRING_COUNTER,
})

const Sequence = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,18})$/),
  Schema.makeFilter(withinCounterRange),
)

const ContextId = Schema.NonEmptyString.check(
  Schema.makeFilter((value: string) => value !== "." && value !== ".."),
)

const SpaceId = ContextId.annotate({ description: "The space ID (a UUID)." })
const DocumentId = ContextId.annotate({ description: "The document ID (a UUID)." })
const FileId = ContextId.annotate({ description: "The file ID createContextFile returned." })
const SessionId = ContextId.annotate({ description: "The stored session ID (a UUID)." })

const DocumentPath = Schema.NonEmptyString.annotate({
  description:
    "A relative, forward-slash-separated document name of at most " +
    String(PATH_MAX_BYTES) +
    " UTF-8 bytes, such as `notes/plan.md`.",
})

const DocumentBody = Schema.String.annotate({
  description:
    "Text contents of at most " + String(BODY_MAX_BYTES) + " UTF-8 bytes. Give `body` or `fileId`.",
})

const CommitFileId = ContextId.annotate({
  description:
    "A fully uploaded pending file to commit as a binary document. Give `body` or `fileId`.",
})

const Limit = PageLimit.annotate({ description: "Items per page, 1-100." })

const PartIndex = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: PART_MAX_INDEX }),
).annotate({ description: "The zero-based part index, 0-" + String(PART_MAX_INDEX) + "." })

/*
 * Response contracts, as the SDK helpers check them. Enumerations are open
 * strings, so a value added upstream does not fail a whole page; members
 * beyond these are kept.
 */

const attribution = {
  createdByPrincipalKind: Schema.String,
  createdByPrincipalId: Schema.String,
  updatedByPrincipalKind: Schema.String,
  updatedByPrincipalId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}

const SpaceReply = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  accessScope: Schema.String,
  ...attribution,
})

const FileReply = Schema.Struct({
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

const MetadataReply = Schema.Struct(metadataFields)

const DocumentReply = Schema.Struct({ ...metadataFields, body: Schema.String })

const UploadReply = Schema.Struct({
  fileId: Schema.String,
  partSizeBytes: Schema.Number,
  partCount: Schema.Number,
  expiresAt: Schema.String,
})

const SessionReply = Schema.Struct({
  sessionId: Schema.String,
  spaceId: Schema.String,
  parentSessionId: Schema.NullOr(Schema.String),
  ownerKind: Schema.String,
  ownerId: Schema.String,
  lastSequence: Sequence,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

const AppendReply = Schema.Struct({
  lastSequence: Sequence,
  acceptedThroughSequence: Version,
  appendedRecords: Schema.Int,
})

const RecordsReply = Schema.Struct({
  contentJsonl: Schema.String,
  lastSequence: Sequence,
  nextCursor: Sequence,
  hasMore: Schema.Boolean,
})

const pageOf = (item: Schema.Top) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.optional(Schema.String) })

type Parse = (json: JsonValue) => JsonValue | undefined

const isFields = (json: JsonValue): json is JsonFields =>
  Predicate.isObject(json) && !Array.isArray(json)

const matching =
  (schema: Schema.Top): Parse =>
  (json) =>
    Schema.is(schema)(json) ? json : undefined

/** Metadata the server returns without a body, completed with the body the SDK reports. */
const metadataWithBody =
  (body: string): Parse =>
  (json) =>
    isFields(json) && Schema.is(MetadataReply)(json) ? { ...json, body } : undefined

const segment = (value: string): string => encodePathSegment(value) ?? ""

const spacePath = (spaceId: string): string => CONTEXT_API_PATH + "/spaces/" + segment(spaceId)

const documentPath = (spaceId: string, documentId: string): string =>
  spacePath(spaceId) + "/documents/" + segment(documentId)

const sessionPath = (spaceId: string, sessionId: string): string =>
  spacePath(spaceId) + "/sessions/" + segment(sessionId)

const filePath = (spaceId: string, fileId: string): string =>
  spacePath(spaceId) + "/files/" + segment(fileId)

const partPath = (spaceId: string, fileId: string, partIndex: number): string =>
  filePath(spaceId, fileId) + "/parts/" + String(partIndex)

/** Present entries, in the order the SDK sends them. */
const queryOf = (
  entries: ReadonlyArray<readonly [string, string | number | undefined]>,
): ReadonlyArray<readonly [string, string]> =>
  entries.flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)] as const]))

/** One request, less the operation the tool supplies. */
type ContextCall = Omit<ContextRequest, "operation">

const read = (
  path: string,
  parse: Parse,
  query: ReadonlyArray<readonly [string, string]> = [],
): ContextCall => ({ method: "GET", path, query, body: undefined, response: "json", parse })

const write = (
  method: ContextRequest["method"],
  path: string,
  body: JsonValue | undefined,
  parse: Parse,
): ContextCall => ({ method, path, query: [], body, response: "json", parse })

interface ContextClient {
  readonly send: (call: ContextCall) => Effect.Effect<RestResult, RestError>
  readonly bytes: (path: string, maxBytes: number) => Effect.Effect<Uint8Array, RestError>
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8")

const pathProblem = (path: string): string | undefined =>
  utf8Bytes(path) > PATH_MAX_BYTES
    ? "path exceeds " + String(PATH_MAX_BYTES) + " UTF-8 bytes"
    : undefined

interface DocumentContent {
  readonly body?: string | undefined
  readonly fileId?: string | undefined
}

const contentProblem = (content: DocumentContent): string | undefined => {
  if ((content.body === undefined) === (content.fileId === undefined)) {
    return "give exactly one of body or fileId"
  }

  if (content.body !== undefined && utf8Bytes(content.body) > BODY_MAX_BYTES) {
    return "body exceeds " + String(BODY_MAX_BYTES) + " UTF-8 bytes"
  }

  return undefined
}

/** Canonical base64 only: Node's decoder skips stray characters, so a lossy input is refused. */
const decodePart = (text: string): Uint8Array | undefined => {
  if (text.length === 0 || text.length > PART_MAX_BASE64_LENGTH) return undefined

  const bytes = Buffer.from(text, "base64")

  return bytes.toString("base64") === text ? new Uint8Array(bytes) : undefined
}

const partProblem = (text: string): string | undefined =>
  decodePart(text) === undefined
    ? "contentBase64 must be canonical base64 of 1 to " + String(PART_MAX_BYTES) + " bytes"
    : undefined

const jsonlRecords = (text: string): ReadonlyArray<string> => text.slice(0, -1).split("\n")

const jsonlProblem = (text: string): string | undefined => {
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

    if (!Predicate.isObject(decodeJsonText(record))) return label + " is not a JSON object"
  }

  return undefined
}

const sequenceRangeProblem = (startSequence: string, contentJsonl: string): string | undefined =>
  BigInt(startSequence) + BigInt(jsonlRecords(contentJsonl).length - 1) <= BigInt(COUNTER_MAX)
    ? undefined
    : "the batch would pass the largest sequence, " + COUNTER_MAX

const firstProblem = (...problems: ReadonlyArray<string | undefined>): string | undefined =>
  problems.find((problem) => problem !== undefined)

/** A lone surrogate cannot be put in a URL or a valid request, so it is refused up front. */
const unicodeProblem = (params: RestParams): string | undefined => {
  for (const [name, value] of Object.entries(params)) {
    const texts: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value]

    if (texts.some((text) => Predicate.isString(text) && !isWellFormed(text))) {
      return name + " is not well-formed Unicode"
    }
  }

  return undefined
}

/** Input fields that decode without services, so a handler can re-decode its arguments. */
interface PlainFields {
  readonly [name: PropertyKey]: Schema.Top & { readonly DecodingServices: never }
}

type ParamsOf<Fields extends PlainFields> = Schema.Struct<Fields>["Type"]

interface ContextToolSpec<Fields extends PlainFields> {
  readonly name: string
  /** The SDK helper's name, used in failure messages. */
  readonly operation: string
  readonly description: string
  readonly inputs: Fields
  /** The reason a call is refused before any request, if any. */
  readonly check?: (params: ParamsOf<Fields>) => string | undefined
  readonly call: (
    params: ParamsOf<Fields>,
    client: ContextClient,
  ) => Effect.Effect<RestResult, RestError>
}

const CONTEXT_ORIGIN =
  " Served by the Context API on the Prem origin in FACTORY_CONTEXT_BASE_URL, not the hosted API."

const PAGED =
  " One call returns one page; pass `nextCursor`, when present, as `cursor` for the next."

const contextTool = <const Fields extends PlainFields>(
  spec: ContextToolSpec<Fields>,
): RestToolEntry => {
  const parameters = Schema.Struct(spec.inputs)
  const decode = Schema.decodeUnknownOption(parameters)

  const tool: Tool.Any = Tool.make(spec.name, {
    description: spec.description + CONTEXT_ORIGIN,
    parameters,
    success: Schema.Json,
    failure: ToolFailure,
    dependencies: [RestService],
  })

  const handler: RestHandler = (raw) =>
    Effect.gen(function* () {
      const params = Option.getOrUndefined(decode(raw))

      if (params === undefined) {
        return yield* Effect.fail(invalidParams(spec.name, "arguments do not match the schema"))
      }

      const problem = unicodeProblem(raw) ?? spec.check?.(params)

      if (problem !== undefined) return yield* Effect.fail(invalidParams(spec.name, problem))

      const rest = yield* RestService

      const client: ContextClient = {
        send: (call) => rest.context({ operation: spec.operation, ...call }),
        bytes: (path, maxBytes) => rest.contextBytes({ operation: spec.operation, path, maxBytes }),
      }

      const json: RestResult = yield* spec.call(params, client).pipe(Effect.mapError(restFailure))

      return json === undefined ? { ok: true } : json
    })

  return { tool, handler }
}

export const contextTools = (): RestDomain =>
  restDomain([
    contextTool({
      name: "context_create_space",
      operation: "createContextSpace",
      description:
        "Create a Context space named `name` (1-120 characters). `accessScope: organization` " +
        "opens it to the whole organization; `members` limits it to its members.",
      inputs: {
        name: Schema.String,
        accessScope: Schema.Literals(["organization", "members"]),
      },
      check: ({ name }) =>
        name.trim().length === 0 || name.trim().length > NAME_MAX_LENGTH
          ? "name must be 1 to " + String(NAME_MAX_LENGTH) + " characters after trimming"
          : undefined,
      call: ({ name, accessScope }, client) =>
        client.send(
          write("POST", CONTEXT_API_PATH + "/spaces", { name, accessScope }, matching(SpaceReply)),
        ),
    }),
    contextTool({
      name: "context_list_spaces",
      operation: "listContextSpaces",
      description:
        "List the Context spaces the caller can read, as `{ items, nextCursor? }`." + PAGED,
      inputs: { limit: Schema.optionalKey(Limit), cursor: Schema.optionalKey(Cursor) },
      call: ({ limit, cursor }, client) =>
        client.send(
          read(
            CONTEXT_API_PATH + "/spaces",
            matching(pageOf(SpaceReply)),
            queryOf([
              ["limit", limit],
              ["cursor", cursor],
            ]),
          ),
        ),
    }),
    contextTool({
      name: "context_get_space",
      operation: "getContextSpace",
      description: "Read one Context space by `spaceId`.",
      inputs: { spaceId: SpaceId },
      call: ({ spaceId }, client) => client.send(read(spacePath(spaceId), matching(SpaceReply))),
    }),
    contextTool({
      name: "context_create_document",
      operation: "createContextDocument",
      description:
        "Create a document at `path` in a space, from a text `body` or by committing an " +
        "uploaded file with `fileId` (exactly one). Returns the document metadata, including " +
        "its first `version`.",
      inputs: {
        spaceId: SpaceId,
        path: DocumentPath,
        body: Schema.optionalKey(DocumentBody),
        fileId: Schema.optionalKey(CommitFileId),
      },
      check: (params) => firstProblem(pathProblem(params.path), contentProblem(params)),
      call: ({ spaceId, path, body, fileId }, client) =>
        client.send(
          write(
            "POST",
            spacePath(spaceId) + "/documents",
            fileId === undefined ? { path, body: body ?? "" } : { path, fileId },
            matching(MetadataReply),
          ),
        ),
    }),
    contextTool({
      name: "context_list_documents",
      operation: "listContextDocuments",
      description:
        "List document metadata in a space, ordered by path, as `{ items, nextCursor? }`. " +
        "`kinds` selects `text`, `binary`, or both; the server lists only text by default." +
        PAGED +
        " The cursor is the last path of the previous page.",
      inputs: {
        spaceId: SpaceId,
        limit: Schema.optionalKey(Limit),
        cursor: Schema.optionalKey(Cursor),
        kinds: Schema.optionalKey(Schema.NonEmptyArray(Schema.Literals(["text", "binary"]))),
      },
      call: ({ spaceId, limit, cursor, kinds }, client) =>
        client.send(
          read(
            spacePath(spaceId) + "/documents",
            matching(pageOf(MetadataReply)),
            queryOf([
              ["limit", limit],
              ["cursor", cursor],
              ["kinds", kinds?.join(",")],
            ]),
          ),
        ),
    }),
    contextTool({
      name: "context_get_document",
      operation: "getContextDocument",
      description:
        "Read a document by `documentId`, with its `body` and current `version`. A binary " +
        "document has an empty body and a `file` description; read its bytes with " +
        "context_read_file_part.",
      inputs: { spaceId: SpaceId, documentId: DocumentId },
      call: ({ spaceId, documentId }, client) =>
        client.send(read(documentPath(spaceId, documentId), matching(DocumentReply))),
    }),
    contextTool({
      name: "context_get_document_by_path",
      operation: "getContextDocumentByPath",
      description:
        "Read a document by its relative `path` in a space, with its `body` and `version`.",
      inputs: { spaceId: SpaceId, path: DocumentPath },
      check: (params) => pathProblem(params.path),
      call: ({ spaceId, path }, client) =>
        client.send(
          read(spacePath(spaceId) + "/documents/by-path", matching(DocumentReply), [
            ["path", path],
          ]),
        ),
    }),
    contextTool({
      name: "context_update_document",
      operation: "updateContextDocument",
      description:
        "Replace a document's contents with a text `body` or an uploaded `fileId` (exactly " +
        "one), as an edit of `expectedVersion`. `merge: auto` (the default) merges disjoint " +
        "changes made since that version and returns the merged `body` with the accepted " +
        "`version`; continue from both together, never the submitted body. `merge: strict` " +
        "fails with HTTP 409 and `currentVersion` unless `expectedVersion` is current. File " +
        "replacements are always strict. Do not retry an uncertain write; reread first.",
      inputs: {
        spaceId: SpaceId,
        documentId: DocumentId,
        expectedVersion: Version,
        merge: Schema.optionalKey(Schema.Literals(["auto", "strict"])),
        body: Schema.optionalKey(DocumentBody),
        fileId: Schema.optionalKey(CommitFileId),
      },
      check: (params) =>
        firstProblem(
          contentProblem(params),
          params.fileId !== undefined && params.merge === "auto"
            ? "a file replacement cannot be merged; omit merge or use strict"
            : undefined,
        ),
      call: (
        { spaceId, documentId, expectedVersion, merge = "auto", body = "", fileId },
        client,
      ) => {
        const path = documentPath(spaceId, documentId)

        if (fileId !== undefined) {
          return client.send(write("PUT", path, { expectedVersion, fileId }, metadataWithBody("")))
        }

        // A strict write answers with metadata only; the server accepted the submitted body.
        return merge === "strict"
          ? client.send(write("PUT", path, { expectedVersion, body }, metadataWithBody(body)))
          : client.send(
              write("PUT", path, { expectedVersion, body, merge }, matching(DocumentReply)),
            )
      },
    }),
    contextTool({
      name: "context_delete_document",
      operation: "deleteContextDocument",
      description:
        "Delete a document, provided `expectedVersion` is still its current version (HTTP 409 " +
        "with `currentVersion` otherwise). Returns the retired document's metadata. " +
        DESTRUCTIVE,
      inputs: { spaceId: SpaceId, documentId: DocumentId, expectedVersion: Version },
      call: ({ spaceId, documentId, expectedVersion }, client) =>
        client.send(
          write(
            "DELETE",
            documentPath(spaceId, documentId),
            { expectedVersion },
            matching(MetadataReply),
          ),
        ),
    }),
    contextTool({
      name: "context_create_file",
      operation: "createContextFile",
      description:
        "Start an image or PDF upload of `sizeBytes` bytes whose SHA-256 is `sha256` (64 " +
        "lowercase hex characters). Images are at most 10 MiB and PDFs at most 25 MiB. " +
        "Returns `{ fileId, partSizeBytes, partCount, expiresAt }`. " +
        "Upload every part with context_upload_file_part, then commit the file with " +
        "context_create_document or context_update_document and `fileId` before `expiresAt`.",
      inputs: {
        spaceId: SpaceId,
        contentType: Schema.Literals(CONTENT_TYPES),
        sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      },
      check: ({ contentType, sizeBytes }) =>
        sizeBytes > FILE_MAX_BYTES[contentType]
          ? contentType + " files are at most " + String(FILE_MAX_BYTES[contentType]) + " bytes"
          : undefined,
      call: ({ spaceId, contentType, sizeBytes, sha256 }, client) =>
        client.send(
          write(
            "POST",
            spacePath(spaceId) + "/files",
            { contentType, sizeBytes, sha256 },
            matching(UploadReply),
          ),
        ),
    }),
    contextTool({
      name: "context_upload_file_part",
      operation: "uploadContextFilePart",
      description:
        "Upload part `partIndex` of a pending file as canonical base64 in `contentBase64` " +
        "(1 byte to 3 MiB decoded). Every part is exactly `partSizeBytes` except the last. " +
        "Resending a part replaces it. Returns `{ ok: true, partIndex, sizeBytes }`.",
      inputs: {
        spaceId: SpaceId,
        fileId: FileId,
        partIndex: PartIndex,
        contentBase64: Schema.String.annotate({
          description: "The part's bytes as canonical, padded base64.",
        }),
      },
      check: (params) => partProblem(params.contentBase64),
      call: ({ spaceId, fileId, partIndex, contentBase64 }, client) => {
        const content = decodePart(contentBase64) ?? new Uint8Array()

        return client
          .send({
            method: "PUT",
            path: partPath(spaceId, fileId, partIndex),
            query: [],
            body: content,
            response: "empty",
          })
          .pipe(Effect.as({ ok: true, partIndex, sizeBytes: content.byteLength }))
      },
    }),
    contextTool({
      name: "context_read_file_part",
      operation: "readContextFilePart",
      description:
        "Read part `partIndex` of a committed file. Returns `{ partIndex, sizeBytes, " +
        'encoding: "base64", data }`; decode `data` and concatenate parts in order to ' +
        "reconstruct the exact bytes. A part that contains a protected value is refused.",
      inputs: { spaceId: SpaceId, fileId: FileId, partIndex: PartIndex },
      call: ({ spaceId, fileId, partIndex }, client) =>
        client.bytes(partPath(spaceId, fileId, partIndex), PART_MAX_BYTES).pipe(
          Effect.map((bytes) => ({
            partIndex,
            sizeBytes: bytes.byteLength,
            encoding: "base64",
            data: Buffer.from(bytes).toString("base64"),
          })),
        ),
    }),
    contextTool({
      name: "context_delete_file",
      operation: "deleteContextFile",
      description:
        "Cancel a pending upload so it stops counting against the space's quota. Returns " +
        "{ ok: true }. " +
        DESTRUCTIVE,
      inputs: { spaceId: SpaceId, fileId: FileId },
      call: ({ spaceId, fileId }, client) =>
        client.send({
          method: "DELETE",
          path: filePath(spaceId, fileId),
          query: [],
          body: undefined,
          response: "empty",
        }),
    }),
    contextTool({
      name: "context_register_session",
      operation: "registerContextSession",
      description:
        "Register a stored session record under `sessionId`, optionally as a child of " +
        "`parentSessionId`; repeating an identical registration confirms it. Stored sessions " +
        "hold records only: nothing runs, unlike local session_* or hosted remote sessions.",
      inputs: {
        spaceId: SpaceId,
        sessionId: SessionId,
        parentSessionId: Schema.optionalKey(
          ContextId.annotate({ description: "The parent stored session ID." }),
        ),
      },
      call: ({ spaceId, sessionId, parentSessionId }, client) =>
        client.send(
          write(
            "PUT",
            sessionPath(spaceId, sessionId),
            parentSessionId === undefined ? {} : { parentSessionId },
            matching(SessionReply),
          ),
        ),
    }),
    contextTool({
      name: "context_get_session",
      operation: "getContextSession",
      description:
        "Read a stored session record: its parent, owner, and `lastSequence` (a decimal string).",
      inputs: { spaceId: SpaceId, sessionId: SessionId },
      call: ({ spaceId, sessionId }, client) =>
        client.send(read(sessionPath(spaceId, sessionId), matching(SessionReply))),
    }),
    contextTool({
      name: "context_list_sessions",
      operation: "listContextSessions",
      description:
        "List stored session records in a space, as `{ items, nextCursor? }`. " +
        "`parentSessionId` filters to the children of one session, or `root` to sessions " +
        "without a parent." +
        PAGED,
      inputs: {
        spaceId: SpaceId,
        limit: Schema.optionalKey(Limit),
        cursor: Schema.optionalKey(Cursor),
        parentSessionId: Schema.optionalKey(
          ContextId.annotate({ description: "A parent stored session ID, or `root`." }),
        ),
      },
      call: ({ spaceId, limit, cursor, parentSessionId }, client) =>
        client.send(
          read(
            spacePath(spaceId) + "/sessions",
            matching(pageOf(SessionReply)),
            queryOf([
              ["limit", limit],
              ["cursor", cursor],
              ["parentSessionId", parentSessionId],
            ]),
          ),
        ),
    }),
    contextTool({
      name: "context_append_session",
      operation: "appendContextSession",
      description:
        "Append JSONL records to a stored session, the first at `startSequence` (the session's " +
        "`lastSequence` + 1). `contentJsonl` holds 1-100 JSON objects, one per line, each line " +
        "ending in a newline, at most 64 KiB per record and 256 KiB in total. Resending an " +
        "identical batch is a no-op; a gap or overlap fails with HTTP 409 and `currentSequence`.",
      inputs: {
        spaceId: SpaceId,
        sessionId: SessionId,
        startSequence: Version.annotate({
          description: "The sequence of the first record, 1 or more." + STRING_COUNTER,
        }),
        contentJsonl: Schema.String,
      },
      check: (params) =>
        firstProblem(
          jsonlProblem(params.contentJsonl),
          sequenceRangeProblem(params.startSequence, params.contentJsonl),
        ),
      call: ({ spaceId, sessionId, startSequence, contentJsonl }, client) =>
        client.send(
          write(
            "POST",
            sessionPath(spaceId, sessionId) + "/append",
            { startSequence, contentJsonl },
            matching(AppendReply),
          ),
        ),
    }),
    contextTool({
      name: "context_read_session_records",
      operation: "readContextSessionRecords",
      description:
        'Read stored session records after `afterSequence` (default "0"), at most `limit` ' +
        "records (1-100) and `maxBytes` bytes (1-262144). Returns `{ contentJsonl, " +
        "lastSequence, nextCursor, hasMore }`; pass `nextCursor` as the next `afterSequence`. " +
        "One call reads one page.",
      inputs: {
        spaceId: SpaceId,
        sessionId: SessionId,
        afterSequence: Schema.optionalKey(
          Sequence.annotate({ description: "Read records after this sequence." + STRING_COUNTER }),
        ),
        limit: Schema.optionalKey(Limit),
        maxBytes: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BATCH_MAX_BYTES })),
        ),
      },
      call: ({ spaceId, sessionId, afterSequence, limit, maxBytes }, client) =>
        client.send({
          ...read(
            sessionPath(spaceId, sessionId) + "/records",
            matching(RecordsReply),
            queryOf([
              ["afterSequence", afterSequence],
              ["limit", limit],
              ["maxBytes", maxBytes],
            ]),
          ),
          response: "records",
        }),
    }),
  ])
