/**
 * The eighteen Context operations: spaces, documents, files and stored
 * session records. Each definition keeps its codec, preflight input checks,
 * target, authority demand, replay rule and reply codec together. Replies are
 * decoded into typed values before disclosure ever sees them, and every
 * failure is mapped here into the capabilities failure vocabulary: HTTP 409
 * keeps its safe conflict fields, a malformed upstream reply is distinct from
 * a conflict, and a network failure after handoff is uncertain delivery that
 * nothing retries.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { Demand, EffectKind } from "../../authority/index.ts"
import type { TargetRef } from "../../caller/index.ts"
import {
  DeliveryUncertain,
  InvalidInput,
  MalformedPeerReply,
  OperationConflict,
  PeerFailure,
  TargetUnavailable,
} from "../../capabilities/index.ts"
import type {
  BoundOperation,
  CapabilitiesApi,
  Definition,
  JsonSchemaObject,
  OperationAnnotations,
  OperationFailure,
  ProtectValues,
  ReplayPolicy,
} from "../../capabilities/index.ts"
import { ReleasePayload, type JsonProtection } from "../../disclosure/index.ts"
import {
  conflictFieldsOf,
  decodeReplyJson,
  defaultFetch,
  errorDetailOf,
  openTransport,
  RESPONSE_MAX_BYTES,
} from "./http.ts"
import type { ContextHttpRequest, ContextTransport, FetchLike, SendFailure } from "./http.ts"
import {
  AccessScope,
  AppendReply,
  CONTENT_TYPES,
  CommitFileId,
  contentProblem,
  CONTEXT_API_PATH,
  ContextId,
  Cursor,
  decodePart,
  DocumentBody,
  DocumentId,
  DocumentPath,
  DocumentReply,
  encodePathSegment,
  FileId,
  FILE_MAX_BYTES,
  firstProblem,
  isJsonObject,
  jsonlProblem,
  Kinds,
  Limit,
  MaxBytes,
  MergeMode,
  MetadataReply,
  NAME_MAX_LENGTH,
  pageOf,
  PART_MAX_BYTES,
  PartIndex,
  partProblem,
  pathProblem,
  queryOf,
  RecordsReply,
  Sequence,
  sequenceRangeProblem,
  SessionId,
  SessionReply,
  Sha256,
  SpaceId,
  SpaceReply,
  unicodeProblem,
  UploadReply,
  Version,
} from "./wire.ts"
import type { ContentTypeValue } from "./wire.ts"

// ---------------------------------------------------------------------------
// Installation view the operations close over
// ---------------------------------------------------------------------------

export interface OperationContext {
  readonly origin: string
  readonly timeoutMs: number
  readonly headers?: Readonly<Record<string, string>>
  readonly token?: () => Effect.Effect<string | undefined>
  readonly fetch?: FetchLike
}

type Failure = OperationFailure

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const badReply = (operation: string, why: string): MalformedPeerReply =>
  new MalformedPeerReply({
    message: operation + " returned a malformed Context API reply: " + why,
  })

/**
 * Reads the raw reply as JSON and checks the required members. Extra members
 * pass through untouched, so upstream additions never fail a whole page. The
 * decoded original JSON — not a re-encoded copy — is what moves on, so
 * decimal counters arrive as exactly the strings upstream sent. Reply
 * schemas are plain validation shapes (their encoded and decoded forms are
 * identical), so `Schema.is` is the exact check.
 */
const decodeMember = (
  operation: string,
  schema: Schema.Top,
  bytes: Uint8Array,
): Effect.Effect<Schema.Json, Failure> => {
  const json = decodeReplyJson(bytes)

  if (json === undefined) {
    return Effect.fail(badReply(operation, "the body is not valid JSON"))
  }

  return Schema.is(schema)(json)
    ? Effect.succeed(json)
    : Effect.fail(badReply(operation, "the body does not match the expected reply shape"))
}

/** Maps the transport failure vocabulary onto operation failures. */
const sendFailure = (operation: string, failure: SendFailure): Failure => {
  if (failure.kind === "oversized") {
    return new TargetUnavailable({
      message: operation + " returned more bytes than the response bound allows",
    })
  }

  if (failure.kind === "uncertain") {
    return new DeliveryUncertain({
      message:
        operation +
        (failure.timedOut
          ? " did not complete within the configured timeout; the write may have reached the Context API"
          : " could not finish the exchange; the write may have reached the Context API"),
    })
  }

  return new DeliveryUncertain({
    message: operation + " could not reach the Context origin",
  })
}

/** Maps a non-2xx status onto the operation failure vocabulary, preserving conflicts. */
const statusFailure = (operation: string, status: number, bytes: Uint8Array): Failure => {
  const json = decodeReplyJson(bytes)
  const detail = errorDetailOf(json)
  const suffix = detail === undefined ? "" : ": " + detail

  if (status === 409) {
    const fields = conflictFieldsOf(json)

    const message =
      operation + " conflicts with the current state of the target (HTTP 409)" + suffix

    if (fields.currentVersion !== undefined && fields.currentSequence !== undefined) {
      return new OperationConflict({
        message,
        currentVersion: fields.currentVersion,
        currentSequence: fields.currentSequence,
      })
    }

    if (fields.currentVersion !== undefined) {
      return new OperationConflict({ message, currentVersion: fields.currentVersion })
    }

    if (fields.currentSequence !== undefined) {
      return new OperationConflict({ message, currentSequence: fields.currentSequence })
    }

    return new OperationConflict({ message })
  }

  if (status === 401 || status === 403) {
    return new PeerFailure({
      code: "operation_denied",
      message: operation + " was denied by the Context API (HTTP " + String(status) + ")" + suffix,
    })
  }

  if (status === 404) {
    return new TargetUnavailable({
      message: operation + " names a target the Context API does not have (HTTP 404)" + suffix,
    })
  }

  if (status >= 400 && status < 500) {
    return new PeerFailure({
      code: "peer_rejected",
      message:
        operation + " was rejected by the Context API (HTTP " + String(status) + ")" + suffix,
    })
  }

  if (status >= 300 && status < 400) {
    return new DeliveryUncertain({
      message:
        operation +
        " was redirected (HTTP " +
        String(status) +
        "); the Context transport never follows redirects",
    })
  }

  return new TargetUnavailable({
    message:
      operation + " failed upstream in the Context API (HTTP " + String(status) + ")" + suffix,
  })
}

/** One round trip, mapping transport and status onto the typed failure vocabulary. */
const exchange = (
  transport: ContextTransport,
  operation: string,
  request: Omit<ContextHttpRequest, "operation" | "path"> & { readonly path: string | undefined },
  maxBytes: number,
): Effect.Effect<{ readonly status: number; readonly bytes: Uint8Array }, Failure> =>
  request.path === undefined
    ? Effect.fail(new InvalidInput({ message: operation + " refused an unencodable path segment" }))
    : transport.send({ operation, ...request, path: request.path }, maxBytes).pipe(
        Effect.mapError((failure) => sendFailure(operation, failure)),
        Effect.flatMap((received) =>
          received.status >= 200 && received.status < 300
            ? Effect.succeed(received)
            : Effect.fail(statusFailure(operation, received.status, received.bytes)),
        ),
      )

/** A JSON exchange whose success body is decoded against `schema`. */
const jsonCall = (
  transport: ContextTransport,
  operation: string,
  method: ContextHttpRequest["method"],
  path: string | undefined,
  body: Schema.Json | undefined,
  schema: Schema.Top,
  query: ReadonlyArray<readonly [string, string]> = [],
): Effect.Effect<Schema.Json, Failure> =>
  exchange(transport, operation, { method, path, query, body }, RESPONSE_MAX_BYTES).pipe(
    Effect.flatMap((received) => decodeMember(operation, schema, received.bytes)),
  )

// ---------------------------------------------------------------------------
// Input decoding helpers
// ---------------------------------------------------------------------------

interface PlainFields {
  readonly [name: PropertyKey]: Schema.Top & { readonly DecodingServices: never }
}

/**
 * Combines schema decoding, Unicode well-formedness and cross-field preflight
 * checks. The struct carries its input type, so the decoded value reaches the
 * cross-field check and the operation body fully typed.
 */
const checkedDecode =
  <const Fields extends PlainFields>(
    schema: Schema.Struct<Fields>,
    why: string,
    check?: (input: Schema.Struct<Fields>["Type"]) => string | undefined,
  ) =>
  (input: Schema.Json): Effect.Effect<Schema.Struct<Fields>["Type"], InvalidInput> => {
    const problem = unicodeProblem(input)

    if (problem !== undefined) return Effect.fail(new InvalidInput({ message: problem }))

    const decoded = Schema.decodeUnknownOption(schema)(input)

    if (!Option.isSome(decoded)) return Effect.fail(new InvalidInput({ message: why }))

    const typed = decoded.value
    const cross = check === undefined ? undefined : check(typed)

    return cross === undefined
      ? Effect.succeed(typed)
      : Effect.fail(new InvalidInput({ message: cross }))
  }

// ---------------------------------------------------------------------------
// Shared facts
// ---------------------------------------------------------------------------

const readOnly: OperationAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const writeAnnotations: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

const idempotentWrite: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const destructive: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

const spaceTarget = (spaceId: string): TargetRef => ({ kind: "context", id: spaceId })

const SPACES_TARGET: TargetRef = { kind: "context", id: "spaces" }

const readDemand = (): Demand => ({ effect: "read" })
const writeDemand = (): Demand => ({ effect: "write" })

const READ: EffectKind = "read"
const WRITE: EffectKind = "write"

// ---------------------------------------------------------------------------
// Reply field sensitivity
// ---------------------------------------------------------------------------

const protection = (
  fixedKeys: ReadonlyArray<string>,
  atomicKeys: ReadonlyArray<string> = [],
  members?: { readonly [key: string]: JsonProtection },
): JsonProtection => {
  const base: JsonProtection = { fixedKeys, atomicKeys }

  return members === undefined ? base : { ...base, members }
}

const pageProtection = (item: JsonProtection): JsonProtection => ({
  fixedKeys: ["items", "nextCursor"],
  atomicKeys: ["nextCursor"],
  members: { items: { fixedKeys: [], atomicKeys: [], item } },
})

const ATTRIBUTION_FIXED_KEYS = [
  "createdByPrincipalKind",
  "createdByPrincipalId",
  "updatedByPrincipalKind",
  "updatedByPrincipalId",
  "createdAt",
  "updatedAt",
] as const

const SPACE_PROTECTION = protection(
  ["id", "name", "accessScope", ...ATTRIBUTION_FIXED_KEYS],
  ["id"],
)

const SPACE_PAGE_PROTECTION = pageProtection(SPACE_PROTECTION)

const FILE_FIXED_KEYS = [
  "fileId",
  "contentType",
  "sizeBytes",
  "sha256",
  "partSizeBytes",
  "partCount",
] as const

const FILE_PROTECTION = protection(FILE_FIXED_KEYS, ["fileId"])

const METADATA_FIXED_KEYS = [
  "id",
  "spaceId",
  "path",
  "version",
  "retiredAt",
  ...ATTRIBUTION_FIXED_KEYS,
  "file",
] as const

const METADATA_ATOMIC_KEYS = ["id", "spaceId", "path", "version"] as const

const METADATA_PROTECTION = protection(METADATA_FIXED_KEYS, METADATA_ATOMIC_KEYS, {
  file: FILE_PROTECTION,
})

const METADATA_PAGE_PROTECTION = pageProtection(METADATA_PROTECTION)

const DOCUMENT_PROTECTION = protection(
  [...METADATA_FIXED_KEYS, "body"],
  METADATA_ATOMIC_KEYS,
  METADATA_PROTECTION.members,
)

const UPLOAD_PROTECTION = protection(
  ["fileId", "partSizeBytes", "partCount", "expiresAt"],
  ["fileId"],
)

const SESSION_PROTECTION = protection(
  [
    "sessionId",
    "spaceId",
    "parentSessionId",
    "ownerKind",
    "ownerId",
    "lastSequence",
    "createdAt",
    "updatedAt",
  ],
  ["sessionId", "spaceId", "parentSessionId", "lastSequence"],
)

const SESSION_PAGE_PROTECTION = pageProtection(SESSION_PROTECTION)

const APPEND_PROTECTION = protection(
  ["lastSequence", "acceptedThroughSequence", "appendedRecords"],
  ["lastSequence", "acceptedThroughSequence"],
)

const RECEIPT_PROTECTION = protection(["ok", "partIndex", "sizeBytes"])

const OK_PROTECTION = protection(["ok"])

/** Discovery schema placeholder; the typed codec is authoritative. */
const schemaOf = (properties: { readonly [key: string]: Schema.Json }): JsonSchemaObject => ({
  type: "object",
  properties,
})

// ---------------------------------------------------------------------------
// Path builders
// ---------------------------------------------------------------------------

const segment = (value: string): string | undefined => encodePathSegment(value)

const append = (path: string | undefined, suffix: string): string | undefined =>
  path === undefined ? undefined : path + suffix

const spacePath = (spaceId: string): string | undefined => {
  const encoded = segment(spaceId)

  return encoded === undefined ? undefined : CONTEXT_API_PATH + "/spaces/" + encoded
}

const documentPath = (spaceId: string, documentId: string): string | undefined => {
  const encoded = segment(documentId)

  return encoded === undefined ? undefined : append(spacePath(spaceId), "/documents/" + encoded)
}

const sessionPath = (spaceId: string, sessionId: string): string | undefined => {
  const encoded = segment(sessionId)

  return encoded === undefined ? undefined : append(spacePath(spaceId), "/sessions/" + encoded)
}

const filePath = (spaceId: string, fileId: string): string | undefined => {
  const encoded = segment(fileId)

  return encoded === undefined ? undefined : append(spacePath(spaceId), "/files/" + encoded)
}

const partPath = (spaceId: string, fileId: string, partIndex: number): string | undefined =>
  append(filePath(spaceId, fileId), "/parts/" + String(partIndex))

// ---------------------------------------------------------------------------
// Definition assembly helper
// ---------------------------------------------------------------------------

interface OperationParts<I, O> {
  readonly id: string
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly annotations: OperationAnnotations
  readonly effect: EffectKind
  readonly replay: ReplayPolicy
  readonly protection?: JsonProtection
  readonly decode: (input: Schema.Json) => Effect.Effect<I, InvalidInput>
  readonly target: (input: I) => TargetRef
  readonly demand: (input: I) => Demand
  readonly perform: (input: I, transport: ContextTransport) => Effect.Effect<O, Failure>
  readonly classify: (input: I, output: O) => ReleasePayload
}

const jsonPayload = (value: Schema.Json): ReleasePayload => ReleasePayload.JsonValue({ value })

/**
 * A thunk that binds one typed operation against a supplied `Capabilities`.
 * The thunk keeps the input/output types in scope at the exact point where
 * `bind` is called, so no heterogeneous collection ever widens them.
 */
export type BindOperation = (capabilities: CapabilitiesApi) => BoundOperation

// ---------------------------------------------------------------------------
// The eighteen definitions
// ---------------------------------------------------------------------------

/** Builds every Context operation binding thunk against one validated installation. */
export const contextDefinitions = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const sharedTransport = openTransport(ctx.origin, {
    fetch: ctx.fetch ?? defaultFetch,
    timeoutMs: ctx.timeoutMs,
    headers: ctx.headers,
    token: ctx.token,
  })

  const invocationTransport = (protect: ProtectValues): ContextTransport => ({
    staticSecretValues: sharedTransport.staticSecretValues,
    send: (request, maxBytes) => sharedTransport.send(request, maxBytes, protect),
  })

  const operation = <I, O>(parts: OperationParts<I, O>): Definition<I, O> => ({
    facts: {
      id: parts.id,
      family: "context",
      description: parts.description,
      inputSchema: parts.inputSchema,
      effect: parts.effect,
      replay: parts.replay,
      annotations: parts.annotations,
    },
    decode: parts.decode,
    target: parts.target,
    demand: parts.demand,
    sensitiveValues: sharedTransport.staticSecretValues,
    perform: (_grant, input, _who, protect) => parts.perform(input, invocationTransport(protect)),
    classify: (input, output) => {
      const payload = parts.classify(input, output)

      return parts.protection === undefined
        ? { payload }
        : { payload, jsonProtection: parts.protection }
    },
  })

  /*
   * Binary part reads decode the original bytes first, then classify them so
   * disclosure sees them as media: protected bytes are refused there, never
   * redacted into a corrupted payload and never dumped raw.
   */
  const readPartBytes = (
    transport: ContextTransport,
    operationName: string,
    input: { readonly spaceId: string; readonly fileId: string; readonly partIndex: number },
  ): Effect.Effect<Uint8Array, Failure> =>
    exchange(
      transport,
      operationName,
      {
        method: "GET",
        path: partPath(input.spaceId, input.fileId, input.partIndex),
        query: [],
      },
      PART_MAX_BYTES + 1,
    ).pipe(
      Effect.flatMap((received) =>
        received.bytes.byteLength > PART_MAX_BYTES
          ? Effect.fail(
              new TargetUnavailable({
                message:
                  operationName +
                  " returned more than " +
                  String(PART_MAX_BYTES) +
                  " bytes for one file part",
              }),
            )
          : Effect.succeed(received.bytes),
      ),
    )

  // -- spaces ---------------------------------------------------------------

  interface CreateSpaceInput {
    readonly name: string
    readonly accessScope: "organization" | "members"
  }

  const createSpace: Definition<CreateSpaceInput, Schema.Json> = operation({
    id: "context_create_space",
    description:
      "Create a Context space named `name` (1-120 characters). `accessScope: organization` " +
      "opens it to the whole organization; `members` limits it to its members.",
    inputSchema: schemaOf({ name: { type: "string" }, accessScope: { type: "string" } }),
    annotations: writeAnnotations,
    effect: WRITE,
    replay: "no_retry",
    protection: SPACE_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({ name: Schema.String, accessScope: AccessScope }),
      "arguments do not match the schema",
      ({ name }) =>
        name.trim().length === 0 || name.trim().length > NAME_MAX_LENGTH
          ? "name must be 1 to " + String(NAME_MAX_LENGTH) + " characters after trimming"
          : undefined,
    ),
    target: () => SPACES_TARGET,
    demand: writeDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_create_space",
        "POST",
        CONTEXT_API_PATH + "/spaces",
        { name: input.name, accessScope: input.accessScope },
        SpaceReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface ListSpacesInput {
    readonly limit?: number
    readonly cursor?: string
  }

  const listSpaces: Definition<ListSpacesInput, Schema.Json> = operation({
    id: "context_list_spaces",
    description:
      "List the Context spaces the caller can read, as `{ items, nextCursor? }`. One call " +
      "returns one page; pass `nextCursor`, when present, as `cursor` for the next.",
    inputSchema: schemaOf({ limit: { type: "number" }, cursor: { type: "string" } }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    protection: SPACE_PAGE_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({ limit: Schema.optionalKey(Limit), cursor: Schema.optionalKey(Cursor) }),
      "arguments do not match the schema",
    ),
    target: () => SPACES_TARGET,
    demand: readDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_list_spaces",
        "GET",
        CONTEXT_API_PATH + "/spaces",
        undefined,
        pageOf(SpaceReply),
        queryOf([
          ["limit", input.limit],
          ["cursor", input.cursor],
        ]),
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface GetSpaceInput {
    readonly spaceId: string
  }

  const getSpace: Definition<GetSpaceInput, Schema.Json> = operation({
    id: "context_get_space",
    description: "Read one Context space by `spaceId`.",
    inputSchema: schemaOf({ spaceId: { type: "string" } }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    protection: SPACE_PROTECTION,
    decode: checkedDecode(Schema.Struct({ spaceId: SpaceId }), "arguments do not match the schema"),
    target: (input) => spaceTarget(input.spaceId),
    demand: readDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_get_space",
        "GET",
        spacePath(input.spaceId),
        undefined,
        SpaceReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  // -- documents -------------------------------------------------------------

  interface CreateDocumentInput {
    readonly spaceId: string
    readonly path: string
    readonly body?: string
    readonly fileId?: string
  }

  const createDocument: Definition<CreateDocumentInput, Schema.Json> = operation({
    id: "context_create_document",
    description:
      "Create a document at `path` in a space, from a text `body` or by committing an " +
      "uploaded file with `fileId` (exactly one). Returns the document metadata, including " +
      "its first `version`.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      path: { type: "string" },
      body: { type: "string" },
      fileId: { type: "string" },
    }),
    annotations: writeAnnotations,
    effect: WRITE,
    replay: "no_retry",
    protection: METADATA_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        path: DocumentPath,
        body: Schema.optionalKey(DocumentBody),
        fileId: Schema.optionalKey(CommitFileId),
      }),
      "arguments do not match the schema",
      (params) => firstProblem(pathProblem(params.path), contentProblem(params)),
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_create_document",
        "POST",
        append(spacePath(input.spaceId), "/documents"),
        input.fileId === undefined
          ? { path: input.path, body: input.body ?? "" }
          : { path: input.path, fileId: input.fileId },
        MetadataReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface ListDocumentsInput {
    readonly spaceId: string
    readonly limit?: number
    readonly cursor?: string
    readonly kinds?: ReadonlyArray<"text" | "binary">
  }

  const listDocuments: Definition<ListDocumentsInput, Schema.Json> = operation({
    id: "context_list_documents",
    description:
      "List document metadata in a space, ordered by path, as `{ items, nextCursor? }`. " +
      "`kinds` selects `text`, `binary`, or both; the server lists only text by default. " +
      "One call returns one page. The cursor is the last path of the previous page.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      limit: { type: "number" },
      cursor: { type: "string" },
      kinds: { type: "array" },
    }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    protection: METADATA_PAGE_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        limit: Schema.optionalKey(Limit),
        cursor: Schema.optionalKey(Cursor),
        kinds: Schema.optionalKey(Kinds),
      }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: readDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_list_documents",
        "GET",
        append(spacePath(input.spaceId), "/documents"),
        undefined,
        pageOf(MetadataReply),
        queryOf([
          ["limit", input.limit],
          ["cursor", input.cursor],
          ["kinds", input.kinds?.join(",")],
        ]),
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface GetDocumentInput {
    readonly spaceId: string
    readonly documentId: string
  }

  const getDocument: Definition<GetDocumentInput, Schema.Json> = operation({
    id: "context_get_document",
    description:
      "Read a document by `documentId`, with its `body` and current `version`. A binary " +
      "document has an empty body and a `file` description; read its bytes with " +
      "context_read_file_part.",
    inputSchema: schemaOf({ spaceId: { type: "string" }, documentId: { type: "string" } }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    protection: DOCUMENT_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({ spaceId: SpaceId, documentId: DocumentId }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: readDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_get_document",
        "GET",
        documentPath(input.spaceId, input.documentId),
        undefined,
        DocumentReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface GetDocumentByPathInput {
    readonly spaceId: string
    readonly path: string
  }

  const getDocumentByPath: Definition<GetDocumentByPathInput, Schema.Json> = operation({
    id: "context_get_document_by_path",
    description:
      "Read a document by its relative `path` in a space, with its `body` and `version`.",
    inputSchema: schemaOf({ spaceId: { type: "string" }, path: { type: "string" } }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    protection: DOCUMENT_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({ spaceId: SpaceId, path: DocumentPath }),
      "arguments do not match the schema",
      (params) => pathProblem(params.path),
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: readDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_get_document_by_path",
        "GET",
        append(spacePath(input.spaceId), "/documents/by-path"),
        undefined,
        DocumentReply,
        [["path", input.path]],
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface UpdateDocumentInput {
    readonly spaceId: string
    readonly documentId: string
    readonly expectedVersion: string
    readonly merge?: "auto" | "strict"
    readonly body?: string
    readonly fileId?: string
  }

  const updateDocument: Definition<UpdateDocumentInput, Schema.Json> = operation({
    id: "context_update_document",
    description:
      "Replace a document's contents with a text `body` or an uploaded `fileId` (exactly " +
      "one), as an edit of `expectedVersion`. `merge: auto` (the default) merges disjoint " +
      "changes made since that version and returns the merged `body` with the accepted " +
      "`version`; continue from both together, never the submitted body. `merge: strict` " +
      "fails with HTTP 409 and `currentVersion` unless `expectedVersion` is current. File " +
      "replacements are always strict. Do not retry an uncertain write; reread first.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      documentId: { type: "string" },
      expectedVersion: { type: "string" },
      merge: { type: "string" },
      body: { type: "string" },
      fileId: { type: "string" },
    }),
    annotations: writeAnnotations,
    effect: WRITE,
    replay: "no_retry",
    protection: DOCUMENT_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        documentId: DocumentId,
        expectedVersion: Version,
        merge: Schema.optionalKey(MergeMode),
        body: Schema.optionalKey(DocumentBody),
        fileId: Schema.optionalKey(CommitFileId),
      }),
      "arguments do not match the schema",
      (params) =>
        firstProblem(
          contentProblem(params),
          params.fileId !== undefined && params.merge === "auto"
            ? "a file replacement cannot be merged; omit merge or use strict"
            : undefined,
        ),
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) => {
      const merge = input.merge ?? "auto"
      const body = input.body ?? ""
      const path = documentPath(input.spaceId, input.documentId)

      if (input.fileId !== undefined) {
        return jsonCall(
          transport,
          "context_update_document",
          "PUT",
          path,
          { expectedVersion: input.expectedVersion, fileId: input.fileId },
          MetadataReply,
        ).pipe(
          Effect.map((metadata) => (isJsonObject(metadata) ? { ...metadata, body: "" } : metadata)),
        )
      }

      if (merge === "strict") {
        return jsonCall(
          transport,
          "context_update_document",
          "PUT",
          path,
          { expectedVersion: input.expectedVersion, body },
          MetadataReply,
        ).pipe(
          Effect.map((metadata) => (isJsonObject(metadata) ? { ...metadata, body } : metadata)),
        )
      }

      return jsonCall(
        transport,
        "context_update_document",
        "PUT",
        path,
        { expectedVersion: input.expectedVersion, body, merge },
        DocumentReply,
      )
    },
    classify: (_input, output) => jsonPayload(output),
  })

  interface DeleteDocumentInput {
    readonly spaceId: string
    readonly documentId: string
    readonly expectedVersion: string
  }

  const deleteDocument: Definition<DeleteDocumentInput, Schema.Json> = operation({
    id: "context_delete_document",
    description:
      "Delete a document, provided `expectedVersion` is still its current version (HTTP 409 " +
      "with `currentVersion` otherwise). Returns the retired document's metadata. " +
      "Destructive; confirm before calling.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      documentId: { type: "string" },
      expectedVersion: { type: "string" },
    }),
    annotations: destructive,
    effect: WRITE,
    replay: "no_retry",
    protection: METADATA_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({ spaceId: SpaceId, documentId: DocumentId, expectedVersion: Version }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_delete_document",
        "DELETE",
        documentPath(input.spaceId, input.documentId),
        { expectedVersion: input.expectedVersion },
        MetadataReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  // -- files -----------------------------------------------------------------

  interface CreateFileInput {
    readonly spaceId: string
    readonly contentType: ContentTypeValue
    readonly sizeBytes: number
    readonly sha256: string
  }

  const createFile: Definition<CreateFileInput, Schema.Json> = operation({
    id: "context_create_file",
    description:
      "Start an image or PDF upload of `sizeBytes` bytes whose SHA-256 is `sha256` (64 " +
      "lowercase hex characters). Images are at most 10 MiB and PDFs at most 25 MiB. " +
      "Returns `{ fileId, partSizeBytes, partCount, expiresAt }`. Upload every part with " +
      "context_upload_file_part, then commit the file with context_create_document or " +
      "context_update_document and `fileId` before `expiresAt`.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      contentType: { type: "string" },
      sizeBytes: { type: "number" },
      sha256: { type: "string" },
    }),
    annotations: writeAnnotations,
    effect: WRITE,
    replay: "no_retry",
    protection: UPLOAD_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        contentType: Schema.Literals(CONTENT_TYPES),
        sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        sha256: Sha256,
      }),
      "arguments do not match the schema",
      ({ contentType, sizeBytes }) =>
        sizeBytes > FILE_MAX_BYTES[contentType]
          ? contentType + " files are at most " + String(FILE_MAX_BYTES[contentType]) + " bytes"
          : undefined,
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_create_file",
        "POST",
        append(spacePath(input.spaceId), "/files"),
        { contentType: input.contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 },
        UploadReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface UploadFilePartInput {
    readonly spaceId: string
    readonly fileId: string
    readonly partIndex: number
    readonly contentBase64: string
  }

  interface UploadFilePartOutput {
    readonly ok: true
    readonly partIndex: number
    readonly sizeBytes: number
  }

  const uploadFilePart: Definition<UploadFilePartInput, UploadFilePartOutput> = operation({
    id: "context_upload_file_part",
    description:
      "Upload part `partIndex` of a pending file as canonical base64 in `contentBase64` " +
      "(1 byte to 3 MiB decoded). Every part is exactly `partSizeBytes` except the last. " +
      "Resending a part replaces it. Returns `{ ok: true, partIndex, sizeBytes }`.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      fileId: { type: "string" },
      partIndex: { type: "number" },
      contentBase64: { type: "string" },
    }),
    annotations: writeAnnotations,
    effect: WRITE,
    replay: "no_retry",
    protection: RECEIPT_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        fileId: FileId,
        partIndex: PartIndex,
        contentBase64: Schema.String,
      }),
      "arguments do not match the schema",
      (params) => partProblem(params.contentBase64),
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) => {
      const content = decodePart(input.contentBase64)

      if (content === undefined) {
        return Effect.fail(new InvalidInput({ message: "contentBase64 is not canonical base64" }))
      }

      return exchange(
        transport,
        "context_upload_file_part",
        {
          method: "PUT",
          path: partPath(input.spaceId, input.fileId, input.partIndex),
          query: [],
          body: content,
        },
        RESPONSE_MAX_BYTES,
      ).pipe(
        Effect.as({ ok: true as const, partIndex: input.partIndex, sizeBytes: content.byteLength }),
      )
    },
    classify: (_input, output) =>
      jsonPayload({ ok: output.ok, partIndex: output.partIndex, sizeBytes: output.sizeBytes }),
  })

  interface ReadFilePartInput {
    readonly spaceId: string
    readonly fileId: string
    readonly partIndex: number
  }

  interface ReadFilePartOutput {
    readonly partIndex: number
    readonly bytes: Uint8Array
  }

  /*
   * The original part bytes move from the wire into classification unchanged:
   * disclosure inspects them as media, refusing protected bytes rather than
   * releasing a corrupted redaction or a raw dump.
   */
  const readFilePart: Definition<ReadFilePartInput, ReadFilePartOutput> = operation({
    id: "context_read_file_part",
    description:
      "Read part `partIndex` of a committed file. Returns the exact part bytes as media; " +
      "concatenate parts in order to reconstruct the file. A part that contains a " +
      "protected value is refused.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      fileId: { type: "string" },
      partIndex: { type: "number" },
    }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({ spaceId: SpaceId, fileId: FileId, partIndex: PartIndex }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: readDemand,
    perform: (input, transport) =>
      Effect.map(readPartBytes(transport, "context_read_file_part", input), (bytes) => ({
        partIndex: input.partIndex,
        bytes,
      })),
    classify: (_input, output) =>
      ReleasePayload.Media({
        media: {
          contentType: "application/octet-stream",
          bytes: output.bytes,
          filename: "part-" + String(output.partIndex),
        },
      }),
  })

  interface DeleteFileInput {
    readonly spaceId: string
    readonly fileId: string
  }

  const deleteFile: Definition<DeleteFileInput, { readonly ok: true }> = operation({
    id: "context_delete_file",
    description:
      "Cancel a pending upload so it stops counting against the space's quota. Returns " +
      "{ ok: true }. Destructive; confirm before calling.",
    inputSchema: schemaOf({ spaceId: { type: "string" }, fileId: { type: "string" } }),
    annotations: destructive,
    effect: WRITE,
    replay: "no_retry",
    protection: OK_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({ spaceId: SpaceId, fileId: FileId }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) =>
      exchange(
        transport,
        "context_delete_file",
        { method: "DELETE", path: filePath(input.spaceId, input.fileId), query: [] },
        RESPONSE_MAX_BYTES,
      ).pipe(Effect.as({ ok: true })),
    classify: (_input, output) => jsonPayload(output),
  })

  // -- stored sessions --------------------------------------------------------

  interface RegisterSessionInput {
    readonly spaceId: string
    readonly sessionId: string
    readonly parentSessionId?: string
  }

  const registerSession: Definition<RegisterSessionInput, Schema.Json> = operation({
    id: "context_register_session",
    description:
      "Register a stored session record under `sessionId`, optionally as a child of " +
      "`parentSessionId`; repeating an identical registration confirms it. Stored sessions " +
      "hold records only: nothing runs, unlike local session_* or hosted remote sessions.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      sessionId: { type: "string" },
      parentSessionId: { type: "string" },
    }),
    annotations: idempotentWrite,
    effect: WRITE,
    replay: "no_retry",
    protection: SESSION_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        sessionId: SessionId,
        parentSessionId: Schema.optionalKey(ContextId),
      }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_register_session",
        "PUT",
        sessionPath(input.spaceId, input.sessionId),
        input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId },
        SessionReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface GetSessionInput {
    readonly spaceId: string
    readonly sessionId: string
  }

  const getSession: Definition<GetSessionInput, Schema.Json> = operation({
    id: "context_get_session",
    description:
      "Read a stored session record: its parent, owner, and `lastSequence` (a decimal string).",
    inputSchema: schemaOf({ spaceId: { type: "string" }, sessionId: { type: "string" } }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    protection: SESSION_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({ spaceId: SpaceId, sessionId: SessionId }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: readDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_get_session",
        "GET",
        sessionPath(input.spaceId, input.sessionId),
        undefined,
        SessionReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface ListSessionsInput {
    readonly spaceId: string
    readonly limit?: number
    readonly cursor?: string
    readonly parentSessionId?: string
  }

  const listSessions: Definition<ListSessionsInput, Schema.Json> = operation({
    id: "context_list_sessions",
    description:
      "List stored session records in a space, as `{ items, nextCursor? }`. " +
      "`parentSessionId` filters to the children of one session, or `root` to sessions " +
      "without a parent. One call returns one page.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      limit: { type: "number" },
      cursor: { type: "string" },
      parentSessionId: { type: "string" },
    }),
    annotations: readOnly,
    effect: READ,
    replay: "safe_read",
    protection: SESSION_PAGE_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        limit: Schema.optionalKey(Limit),
        cursor: Schema.optionalKey(Cursor),
        parentSessionId: Schema.optionalKey(ContextId),
      }),
      "arguments do not match the schema",
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: readDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_list_sessions",
        "GET",
        append(spacePath(input.spaceId), "/sessions"),
        undefined,
        pageOf(SessionReply),
        queryOf([
          ["limit", input.limit],
          ["cursor", input.cursor],
          ["parentSessionId", input.parentSessionId],
        ]),
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface AppendSessionInput {
    readonly spaceId: string
    readonly sessionId: string
    readonly startSequence: string
    readonly contentJsonl: string
  }

  const appendSession: Definition<AppendSessionInput, Schema.Json> = operation({
    id: "context_append_session",
    description:
      "Append JSONL records to a stored session, the first at `startSequence` (the session's " +
      "`lastSequence` + 1). `contentJsonl` holds 1-100 JSON objects, one per line, each line " +
      "ending in a newline, at most 64 KiB per record and 256 KiB in total. Resending an " +
      "identical batch is a no-op; a gap or overlap fails with HTTP 409 and `currentSequence`.",
    inputSchema: schemaOf({
      spaceId: { type: "string" },
      sessionId: { type: "string" },
      startSequence: { type: "string" },
      contentJsonl: { type: "string" },
    }),
    annotations: writeAnnotations,
    effect: WRITE,
    replay: "no_retry",
    protection: APPEND_PROTECTION,
    decode: checkedDecode(
      Schema.Struct({
        spaceId: SpaceId,
        sessionId: SessionId,
        startSequence: Version,
        contentJsonl: Schema.String,
      }),
      "arguments do not match the schema",
      (params) =>
        firstProblem(
          jsonlProblem(params.contentJsonl),
          sequenceRangeProblem(params.startSequence, params.contentJsonl),
        ),
    ),
    target: (input) => spaceTarget(input.spaceId),
    demand: writeDemand,
    perform: (input, transport) =>
      jsonCall(
        transport,
        "context_append_session",
        "POST",
        append(sessionPath(input.spaceId, input.sessionId), "/append"),
        { startSequence: input.startSequence, contentJsonl: input.contentJsonl },
        AppendReply,
      ),
    classify: (_input, output) => jsonPayload(output),
  })

  interface ReadSessionRecordsInput {
    readonly spaceId: string
    readonly sessionId: string
    readonly afterSequence?: string
    readonly limit?: number
    readonly maxBytes?: number
  }

  interface ReadSessionRecordsOutput {
    readonly contentJsonl: string
    readonly lastSequence: string
    readonly nextCursor: string
    readonly hasMore: boolean
  }

  const readSessionRecords: Definition<ReadSessionRecordsInput, ReadSessionRecordsOutput> =
    operation({
      id: "context_read_session_records",
      description:
        'Read stored session records after `afterSequence` (default "0"), at most `limit` ' +
        "records (1-100) and `maxBytes` bytes (1-262144). Returns `{ contentJsonl, " +
        "lastSequence, nextCursor, hasMore }`; pass `nextCursor` as the next `afterSequence`. " +
        "One call reads one page.",
      inputSchema: schemaOf({
        spaceId: { type: "string" },
        sessionId: { type: "string" },
        afterSequence: { type: "string" },
        limit: { type: "number" },
        maxBytes: { type: "number" },
      }),
      annotations: readOnly,
      effect: READ,
      replay: "safe_read",
      decode: checkedDecode(
        Schema.Struct({
          spaceId: SpaceId,
          sessionId: SessionId,
          afterSequence: Schema.optionalKey(Sequence),
          limit: Schema.optionalKey(Limit),
          maxBytes: Schema.optionalKey(MaxBytes),
        }),
        "arguments do not match the schema",
      ),
      target: (input) => spaceTarget(input.spaceId),
      demand: readDemand,
      perform: (input, transport) =>
        exchange(
          transport,
          "context_read_session_records",
          {
            method: "GET",
            path: append(sessionPath(input.spaceId, input.sessionId), "/records"),
            query: queryOf([
              ["afterSequence", input.afterSequence],
              ["limit", input.limit],
              ["maxBytes", input.maxBytes],
            ]),
          },
          RESPONSE_MAX_BYTES,
        ).pipe(
          Effect.flatMap((received) => {
            const json = decodeReplyJson(received.bytes)

            if (json === undefined) {
              return Effect.fail(
                badReply("context_read_session_records", "the body is not valid JSON"),
              )
            }

            const decoded = Schema.decodeUnknownOption(RecordsReply)(json)

            return Option.isSome(decoded)
              ? Effect.succeed(decoded.value)
              : Effect.fail(
                  badReply(
                    "context_read_session_records",
                    "the body does not match the expected reply shape",
                  ),
                )
          }),
        ),
      classify: (_input, output) => {
        /*
         * Ordered session records are decoded from their JSONL transport form
         * before disclosure: each line is one stored record. A line that is
         * not valid JSON is kept as a plain string rather than failing the
         * whole page — the records are stored data, never input to execution.
         */
        const records = output.contentJsonl
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line): Schema.Json => {
            try {
              const parsed = Option.getOrUndefined(
                Schema.decodeUnknownOption(Schema.Json)(JSON.parse(line)),
              )

              return parsed === undefined ? line : parsed
            } catch {
              return line
            }
          })

        return ReleasePayload.Records({ items: records })
      },
    })

  /*
   * Each thunk closes over one typed definition and calls `bind` inside the
   * closure, where the input and output types are still in scope. No cast
   * and no type-erased collection is involved.
   */
  const binders: Array<BindOperation> = [
    (capabilities) => capabilities.bind(createSpace),
    (capabilities) => capabilities.bind(listSpaces),
    (capabilities) => capabilities.bind(getSpace),
    (capabilities) => capabilities.bind(createDocument),
    (capabilities) => capabilities.bind(listDocuments),
    (capabilities) => capabilities.bind(getDocument),
    (capabilities) => capabilities.bind(getDocumentByPath),
    (capabilities) => capabilities.bind(updateDocument),
    (capabilities) => capabilities.bind(deleteDocument),
    (capabilities) => capabilities.bind(createFile),
    (capabilities) => capabilities.bind(uploadFilePart),
    (capabilities) => capabilities.bind(readFilePart),
    (capabilities) => capabilities.bind(deleteFile),
    (capabilities) => capabilities.bind(registerSession),
    (capabilities) => capabilities.bind(getSession),
    (capabilities) => capabilities.bind(listSessions),
    (capabilities) => capabilities.bind(appendSession),
    (capabilities) => capabilities.bind(readSessionRecords),
  ]

  return binders
}
