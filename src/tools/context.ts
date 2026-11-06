import { Buffer } from "node:buffer"

import {
  appendContextSession,
  createContextDocument,
  createContextFile,
  createContextSpace,
  deleteContextDocument,
  deleteContextFile,
  getContextDocument,
  getContextDocumentByPath,
  getContextSession,
  getContextSpace,
  listContextDocuments,
  listContextSessions,
  listContextSpaces,
  readContextFilePart,
  readContextSessionRecords,
  registerContextSession,
  updateContextDocument,
  uploadContextFilePart,
} from "@factory/droid-sdk"
import * as Tool from "effect/ai/Tool"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { decodeJsonText } from "../droid/rest-http.ts"
import { RestService } from "../droid/rest-service.ts"
import type { ContextApiOptions, RestResult } from "../droid/rest-service.ts"
import { ToolFailure } from "./failure.ts"
import {
  Cursor,
  DESTRUCTIVE,
  PageLimit,
  invalidParams,
  restDomain,
  restFailure,
} from "./rest-kit.ts"
import type { RestDomain, RestHandler, RestToolEntry } from "./rest-kit.ts"

/**
 * Context tools: spaces, documents, files, and stored session records on the
 * Prem origin named by `FACTORY_CONTEXT_BASE_URL`, through the SDK's Context
 * helpers. Inputs are checked here first, because the helpers send whatever
 * they are given and only validate responses.
 */

const COUNTER_MAX = "9223372036854775807"

const BODY_MAX_BYTES = 256 * 1024
const PATH_MAX_BYTES = 512
const NAME_MAX_LENGTH = 120
const PART_MAX_BYTES = 3 * 1024 * 1024
const PART_MAX_BASE64_LENGTH = (PART_MAX_BYTES / 3) * 4
const PART_MAX_INDEX = 8
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

/** Input fields that decode without services, so a handler can re-decode its arguments. */
interface PlainFields {
  readonly [name: PropertyKey]: Schema.Top & { readonly DecodingServices: never }
}

type ParamsOf<Fields extends PlainFields> = Schema.Struct<Fields>["Type"]

interface ContextToolSpec<Fields extends PlainFields, A> {
  readonly name: string
  /** The SDK helper's name, used in failure messages. */
  readonly operation: string
  readonly description: string
  readonly inputs: Fields
  /** The reason a call is refused before any request, if any. */
  readonly check?: (params: ParamsOf<Fields>) => string | undefined
  readonly run: (params: ParamsOf<Fields>, options: ContextApiOptions) => Promise<A>
}

const CONTEXT_ORIGIN =
  " Served by the Context API on the Prem origin in FACTORY_CONTEXT_BASE_URL, not the hosted API."

const PAGED =
  " One call returns one page; pass `nextCursor`, when present, as `cursor` for the next."

const contextTool = <const Fields extends PlainFields, A>(
  spec: ContextToolSpec<Fields, A>,
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

      const problem = spec.check?.(params)

      if (problem !== undefined) return yield* Effect.fail(invalidParams(spec.name, problem))

      const rest = yield* RestService

      const json: RestResult = yield* rest
        .context(spec.operation, (options) => spec.run(params, options))
        .pipe(Effect.mapError(restFailure))

      return json ?? { ok: true }
    })

  return { name: spec.name, tool, handler }
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
      run: (params, options) => createContextSpace({ ...options, ...params }),
    }),
    contextTool({
      name: "context_list_spaces",
      operation: "listContextSpaces",
      description:
        "List the Context spaces the caller can read, as `{ items, nextCursor? }`." + PAGED,
      inputs: { limit: Schema.optional(Limit), cursor: Schema.optional(Cursor) },
      run: (params, options) => listContextSpaces({ ...options, ...params }),
    }),
    contextTool({
      name: "context_get_space",
      operation: "getContextSpace",
      description: "Read one Context space by `spaceId`.",
      inputs: { spaceId: SpaceId },
      run: (params, options) => getContextSpace({ ...options, ...params }),
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
        body: Schema.optional(DocumentBody),
        fileId: Schema.optional(CommitFileId),
      },
      check: (params) => firstProblem(pathProblem(params.path), contentProblem(params)),
      run: ({ spaceId, path, body, fileId }, options) =>
        fileId === undefined
          ? createContextDocument({ ...options, spaceId, path, body: body ?? "" })
          : createContextDocument({ ...options, spaceId, path, fileId }),
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
        limit: Schema.optional(Limit),
        cursor: Schema.optional(Cursor),
        kinds: Schema.optional(Schema.NonEmptyArray(Schema.Literals(["text", "binary"]))),
      },
      run: (params, options) => listContextDocuments({ ...options, ...params }),
    }),
    contextTool({
      name: "context_get_document",
      operation: "getContextDocument",
      description:
        "Read a document by `documentId`, with its `body` and current `version`. A binary " +
        "document has an empty body and a `file` description; read its bytes with " +
        "context_read_file_part.",
      inputs: { spaceId: SpaceId, documentId: DocumentId },
      run: (params, options) => getContextDocument({ ...options, ...params }),
    }),
    contextTool({
      name: "context_get_document_by_path",
      operation: "getContextDocumentByPath",
      description:
        "Read a document by its relative `path` in a space, with its `body` and `version`.",
      inputs: { spaceId: SpaceId, path: DocumentPath },
      check: (params) => pathProblem(params.path),
      run: (params, options) => getContextDocumentByPath({ ...options, ...params }),
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
        merge: Schema.optional(Schema.Literals(["auto", "strict"])),
        body: Schema.optional(DocumentBody),
        fileId: Schema.optional(CommitFileId),
      },
      check: (params) =>
        firstProblem(
          contentProblem(params),
          params.fileId !== undefined && params.merge === "auto"
            ? "a file replacement cannot be merged; omit merge or use strict"
            : undefined,
        ),
      run: ({ spaceId, documentId, expectedVersion, merge, body, fileId }, options) =>
        fileId === undefined
          ? updateContextDocument({
              ...options,
              spaceId,
              documentId,
              expectedVersion,
              merge,
              body: body ?? "",
            })
          : updateContextDocument({ ...options, spaceId, documentId, expectedVersion, fileId }),
    }),
    contextTool({
      name: "context_delete_document",
      operation: "deleteContextDocument",
      description:
        "Delete a document, provided `expectedVersion` is still its current version (HTTP 409 " +
        "with `currentVersion` otherwise). Returns the retired document's metadata. " +
        DESTRUCTIVE,
      inputs: { spaceId: SpaceId, documentId: DocumentId, expectedVersion: Version },
      run: (params, options) => deleteContextDocument({ ...options, ...params }),
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
      run: (params, options) => createContextFile({ ...options, ...params }),
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
      run: async ({ spaceId, fileId, partIndex, contentBase64 }, options) => {
        const content = decodePart(contentBase64) ?? new Uint8Array()

        await uploadContextFilePart({ ...options, spaceId, fileId, partIndex, content })

        return { ok: true, partIndex, sizeBytes: content.byteLength }
      },
    }),
    contextTool({
      name: "context_read_file_part",
      operation: "readContextFilePart",
      description:
        "Read part `partIndex` of a committed file. Returns `{ partIndex, sizeBytes, " +
        'encoding: "base64", data }`; decode `data` and concatenate parts in order to ' +
        "reconstruct the exact bytes.",
      inputs: { spaceId: SpaceId, fileId: FileId, partIndex: PartIndex },
      run: async (params, options) => {
        const bytes = await readContextFilePart({ ...options, ...params })

        return {
          partIndex: params.partIndex,
          sizeBytes: bytes.byteLength,
          encoding: "base64",
          data: Buffer.from(bytes).toString("base64"),
        }
      },
    }),
    contextTool({
      name: "context_delete_file",
      operation: "deleteContextFile",
      description:
        "Cancel a pending upload so it stops counting against the space's quota. Returns " +
        "{ ok: true }. " +
        DESTRUCTIVE,
      inputs: { spaceId: SpaceId, fileId: FileId },
      run: (params, options) => deleteContextFile({ ...options, ...params }),
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
        parentSessionId: Schema.optional(
          ContextId.annotate({ description: "The parent stored session ID." }),
        ),
      },
      run: (params, options) => registerContextSession({ ...options, ...params }),
    }),
    contextTool({
      name: "context_get_session",
      operation: "getContextSession",
      description:
        "Read a stored session record: its parent, owner, and `lastSequence` (a decimal string).",
      inputs: { spaceId: SpaceId, sessionId: SessionId },
      run: (params, options) => getContextSession({ ...options, ...params }),
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
        limit: Schema.optional(Limit),
        cursor: Schema.optional(Cursor),
        parentSessionId: Schema.optional(
          ContextId.annotate({ description: "A parent stored session ID, or `root`." }),
        ),
      },
      run: (params, options) => listContextSessions({ ...options, ...params }),
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
      run: (params, options) => appendContextSession({ ...options, ...params }),
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
        afterSequence: Schema.optional(
          Sequence.annotate({ description: "Read records after this sequence." + STRING_COUNTER }),
        ),
        limit: Schema.optional(Limit),
        maxBytes: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BATCH_MAX_BYTES })),
        ),
      },
      run: (params, options) => readContextSessionRecords({ ...options, ...params }),
    }),
  ])
