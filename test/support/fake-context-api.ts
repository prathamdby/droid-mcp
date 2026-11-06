import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

export type Json = Schema.Json

export interface JsonObject {
  readonly [key: string]: Json
}

/** What a route answers: JSON, raw bytes, or no body. */
export interface ContextReply {
  readonly status?: number
  readonly json?: Json
  readonly bytes?: Uint8Array
  readonly headers?: Readonly<Record<string, string>>
}

export interface ContextRecordedRequest {
  readonly method: string
  /** The raw, still-encoded path. */
  readonly path: string
  /** The raw query string without `?`, or "". */
  readonly query: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  /** The matched `METHOD /template`, if any. */
  readonly route: string | undefined
}

interface ContextRequest extends ContextRecordedRequest {
  readonly params: Readonly<Record<string, string>>
  readonly searchParams: URLSearchParams
  readonly json: JsonObject
}

export interface StoredDocument {
  readonly id: string
  readonly spaceId: string
  path: string
  /** A decimal string; arithmetic uses BigInt so large counters stay exact. */
  version: string
  body: string
  /** Bodies by the version that held them, for three-way merges. */
  readonly revisions: Map<string, string>
  file: JsonObject | undefined
  retiredAt: string | null
  readonly createdAt: string
  updatedAt: string
}

export interface StoredFile {
  readonly fileId: string
  readonly spaceId: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly partSizeBytes: number
  readonly partCount: number
  readonly parts: Map<number, Uint8Array>
  committed: boolean
}

export interface StoredSession {
  readonly sessionId: string
  readonly spaceId: string
  readonly parentSessionId: string | null
  /** Record lines without their newline; record N has sequence N. */
  readonly records: Array<string>
  readonly createdAt: string
  updatedAt: string
}

export interface ContextState {
  readonly spaces: Map<string, JsonObject>
  readonly documents: Map<string, StoredDocument>
  readonly files: Map<string, StoredFile>
  readonly sessions: Map<string, StoredSession>
  /** The part size new uploads get; tests shrink it to exercise several parts. */
  partSizeBytes: number
  nextId: number
}

type ContextHandler = (
  request: ContextRequest,
  state: ContextState,
) => ContextReply | Promise<ContextReply>

export interface FakeContextApi {
  readonly baseUrl: string
  readonly requests: ReadonlyArray<ContextRecordedRequest>
  readonly state: ContextState
  readonly last: () => ContextRecordedRequest | undefined
  /** Adds or replaces a route for the current test; `reset` drops it. */
  readonly route: (key: string, handler: ContextHandler) => void
  /** The next request matching `key` gets this reply instead of the route's. */
  readonly failNext: (key: string, reply: ContextReply) => void
  readonly reset: () => void
  readonly close: () => Promise<void>
}

const API = "/api/context"
const SPACE = API + "/spaces/{spaceId}"
const DOCUMENT = SPACE + "/documents/{documentId}"
const FILE = SPACE + "/files/{fileId}"
const SESSION = SPACE + "/sessions/{sessionId}"

const CONTEXT_PRINCIPAL_ID = "sa-context"

const DEFAULT_PART_SIZE = 3 * 1024 * 1024
const DEFAULT_LIMIT = 50
const DEFAULT_MAX_BYTES = 256 * 1024
const UPLOAD_EXPIRES_AT = "2030-01-01T00:00:00.000Z"

const encoder = new TextEncoder()

/** A UUID the SDK's response schemas accept, numbered so tests read predictably. */
export const contextUuid = (n: number): string =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const seedState = (): ContextState => ({
  spaces: new Map(),
  documents: new Map(),
  files: new Map(),
  sessions: new Map(),
  partSizeBytes: DEFAULT_PART_SIZE,
  nextId: 1,
})

const nextUuid = (state: ContextState): string => contextUuid(state.nextId++)

const now = (): string => new Date().toISOString()

const attribution = (createdAt: string, updatedAt: string): JsonObject => ({
  createdByPrincipalKind: "service",
  createdByPrincipalId: CONTEXT_PRINCIPAL_ID,
  updatedByPrincipalKind: "service",
  updatedByPrincipalId: CONTEXT_PRINCIPAL_ID,
  createdAt,
  updatedAt,
})

let requestCounter = 0

const TITLES = new Map([
  [400, "Bad Request"],
  [404, "Not Found"],
  [409, "Conflict"],
])

/** The Context API's error body, with the conflict fields the SDK surfaces. */
export const contextError = (
  status: number,
  detail: string,
  extra: JsonObject = {},
): ContextReply => ({
  status,
  json: {
    detail,
    status,
    title: TITLES.get(status) ?? "Error",
    requestId: "req-" + String(++requestCounter),
    ...extra,
  },
})

const notFound = (what: string): ContextReply => contextError(404, what + " not found")

const badRequest = (detail: string): ContextReply =>
  contextError(400, detail, { code: "invalid_request" })

const isJsonObject = (value: Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const paramOf = (request: ContextRequest, name: string): string => request.params[name] ?? ""

const limitOf = (request: ContextRequest): number =>
  Number(request.searchParams.get("limit") ?? String(DEFAULT_LIMIT))

const nextVersion = (version: string): string => String(BigInt(version) + 1n)

const documentMetadata = (document: StoredDocument): JsonObject => {
  const metadata: JsonObject = {
    id: document.id,
    spaceId: document.spaceId,
    path: document.path,
    version: document.version,
    retiredAt: document.retiredAt,
    ...attribution(document.createdAt, document.updatedAt),
  }

  return document.file === undefined ? metadata : { ...metadata, file: document.file }
}

const documentJson = (document: StoredDocument): JsonObject => ({
  ...documentMetadata(document),
  body: document.body,
})

const sessionJson = (session: StoredSession): JsonObject => ({
  sessionId: session.sessionId,
  spaceId: session.spaceId,
  parentSessionId: session.parentSessionId,
  ownerKind: "service",
  ownerId: CONTEXT_PRINCIPAL_ID,
  lastSequence: String(session.records.length),
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

const fileMetadata = (file: StoredFile): JsonObject => ({
  fileId: file.fileId,
  contentType: file.contentType,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  partSizeBytes: file.partSizeBytes,
  partCount: file.partCount,
})

/** A page of `items` after the item whose `key` is `cursor`. */
const pageAfter = <T>(
  items: ReadonlyArray<T>,
  request: ContextRequest,
  keyOf: (item: T) => string,
  json: (item: T) => JsonObject,
): ContextReply => {
  const cursor = request.searchParams.get("cursor")
  const start = cursor === null ? 0 : items.findIndex((item) => keyOf(item) === cursor) + 1
  const limit = limitOf(request)
  const slice = items.slice(start, start + limit)
  const last = slice.at(-1)
  const more = start + limit < items.length && last !== undefined

  return {
    json: more ? { items: slice.map(json), nextCursor: keyOf(last) } : { items: slice.map(json) },
  }
}

const spaceOf = (request: ContextRequest, state: ContextState): JsonObject | undefined =>
  state.spaces.get(paramOf(request, "spaceId"))

/** The space must exist before anything inside it can be found. */
const inSpace =
  (handler: ContextHandler): ContextHandler =>
  (request, state) =>
    spaceOf(request, state) === undefined ? notFound("space") : handler(request, state)

const activeDocument = (
  request: ContextRequest,
  state: ContextState,
): StoredDocument | undefined => {
  const document = state.documents.get(paramOf(request, "documentId"))

  return document === undefined ||
    document.spaceId !== paramOf(request, "spaceId") ||
    document.retiredAt !== null
    ? undefined
    : document
}

const fileOf = (request: ContextRequest, state: ContextState): StoredFile | undefined => {
  const file = state.files.get(paramOf(request, "fileId"))

  return file?.spaceId === paramOf(request, "spaceId") ? file : undefined
}

const sessionOf = (request: ContextRequest, state: ContextState): StoredSession | undefined => {
  const session = state.sessions.get(paramOf(request, "sessionId"))

  return session?.spaceId === paramOf(request, "spaceId") ? session : undefined
}

const sha256Of = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const concatParts = (file: StoredFile): Uint8Array => {
  const bytes = new Uint8Array(file.sizeBytes)
  let offset = 0

  for (let index = 0; index < file.partCount; index++) {
    const part = file.parts.get(index) ?? new Uint8Array()

    bytes.set(part, offset)
    offset += part.byteLength
  }

  return bytes
}

/** Commits a pending file, or explains why it cannot be committed yet. */
const commitFile = async (
  state: ContextState,
  spaceId: string,
  fileId: string,
): Promise<StoredFile | ContextReply> => {
  const file = state.files.get(fileId)

  if (file === undefined || file.spaceId !== spaceId || file.committed) {
    return notFound("pending file")
  }

  if (file.parts.size !== file.partCount) {
    return contextError(409, "file " + fileId + " is missing parts", { code: "file_incomplete" })
  }

  if ((await sha256Of(concatParts(file))) !== file.sha256) {
    return contextError(409, "file " + fileId + " does not match its sha256", {
      code: "file_digest_mismatch",
    })
  }

  file.committed = true

  return file
}

const isStoredFile = (value: StoredFile | ContextReply): value is StoredFile => "fileId" in value

/** Line-wise three-way merge of equal-length texts; `undefined` on overlapping edits. */
const mergeLines = (base: string, current: string, submitted: string): string | undefined => {
  const baseLines = base.split("\n")
  const currentLines = current.split("\n")
  const submittedLines = submitted.split("\n")

  if (baseLines.length !== currentLines.length || baseLines.length !== submittedLines.length) {
    return undefined
  }

  const merged: Array<string> = []

  for (const [index, original] of baseLines.entries()) {
    const ours = currentLines[index] ?? ""
    const theirs = submittedLines[index] ?? ""

    if (ours === theirs || theirs === original) merged.push(ours)
    else if (ours === original) merged.push(theirs)
    else return undefined
  }

  return merged.join("\n")
}

const versionConflict = (document: StoredDocument, expectedVersion: string): ContextReply =>
  contextError(409, "document " + document.id + " changed since version " + expectedVersion, {
    code: "version_conflict",
    expectedVersion,
    currentVersion: document.version,
  })

const accept = (document: StoredDocument, body: string, file: JsonObject | undefined): void => {
  document.version = nextVersion(document.version)
  document.body = body
  document.file = file
  document.updatedAt = now()
  document.revisions.set(document.version, body)
}

const SPACE_ROUTES: ReadonlyArray<readonly [string, ContextHandler]> = [
  [
    "GET " + API + "/spaces",
    (request, state) =>
      pageAfter(
        [...state.spaces.values()],
        request,
        (space) => String(space.id),
        (space) => space,
      ),
  ],
  [
    "POST " + API + "/spaces",
    (request, state) => {
      const { name, accessScope } = request.json

      if (
        !Predicate.isString(name) ||
        (accessScope !== "organization" && accessScope !== "members")
      ) {
        return badRequest("name and accessScope are required")
      }

      const id = nextUuid(state)
      const at = now()
      const space: JsonObject = { id, name, accessScope, ...attribution(at, at) }

      state.spaces.set(id, space)

      return { status: 201, json: space }
    },
  ],
  [
    "GET " + SPACE,
    (request, state) => {
      const space = spaceOf(request, state)

      return space === undefined ? notFound("space") : { json: space }
    },
  ],
]

const DOCUMENT_ROUTES: ReadonlyArray<readonly [string, ContextHandler]> = [
  [
    "GET " + SPACE + "/documents",
    (request, state) => {
      const kinds = (request.searchParams.get("kinds") ?? "text").split(",")
      const spaceId = paramOf(request, "spaceId")

      const documents = [...state.documents.values()]
        .filter(
          (document) =>
            document.spaceId === spaceId &&
            document.retiredAt === null &&
            kinds.includes(document.file === undefined ? "text" : "binary"),
        )
        .sort((left, right) => (left.path < right.path ? -1 : 1))

      return pageAfter(documents, request, (document) => document.path, documentMetadata)
    },
  ],
  [
    "POST " + SPACE + "/documents",
    async (request, state) => {
      const { path, body, fileId } = request.json
      const spaceId = paramOf(request, "spaceId")

      if (!Predicate.isString(path) || (body === undefined) === (fileId === undefined)) {
        return badRequest("path and exactly one of body or fileId are required")
      }

      const taken = [...state.documents.values()].some(
        (document) =>
          document.spaceId === spaceId && document.path === path && document.retiredAt === null,
      )

      if (taken) return contextError(409, "a document exists at " + path, { code: "path_exists" })

      let file: JsonObject | undefined

      if (Predicate.isString(fileId)) {
        const committed = await commitFile(state, spaceId, fileId)

        if (!isStoredFile(committed)) return committed

        file = fileMetadata(committed)
      }

      const at = now()
      const text = Predicate.isString(body) ? body : ""

      const document: StoredDocument = {
        id: nextUuid(state),
        spaceId,
        path,
        version: "1",
        body: text,
        revisions: new Map([["1", text]]),
        file,
        retiredAt: null,
        createdAt: at,
        updatedAt: at,
      }

      state.documents.set(document.id, document)

      return { status: 201, json: documentMetadata(document) }
    },
  ],
  [
    "GET " + SPACE + "/documents/by-path",
    (request, state) => {
      const path = request.searchParams.get("path")
      const spaceId = paramOf(request, "spaceId")

      const document = [...state.documents.values()].find(
        (each) => each.spaceId === spaceId && each.path === path && each.retiredAt === null,
      )

      return document === undefined ? notFound("document") : { json: documentJson(document) }
    },
  ],
  [
    "GET " + DOCUMENT,
    (request, state) => {
      const document = activeDocument(request, state)

      return document === undefined ? notFound("document") : { json: documentJson(document) }
    },
  ],
  [
    "PUT " + DOCUMENT,
    async (request, state) => {
      const document = activeDocument(request, state)
      const { expectedVersion, body, fileId, merge } = request.json

      if (document === undefined) return notFound("document")

      if (!Predicate.isString(expectedVersion) || (body === undefined) === (fileId === undefined)) {
        return badRequest("expectedVersion and exactly one of body or fileId are required")
      }

      if (Predicate.isString(fileId)) {
        if (expectedVersion !== document.version) return versionConflict(document, expectedVersion)

        const committed = await commitFile(state, document.spaceId, fileId)

        if (!isStoredFile(committed)) return committed

        accept(document, "", fileMetadata(committed))

        return { json: documentMetadata(document) }
      }

      const submitted = Predicate.isString(body) ? body : ""

      if (expectedVersion === document.version) {
        accept(document, submitted, undefined)

        return merge === "auto"
          ? { json: documentJson(document) }
          : { json: documentMetadata(document) }
      }

      if (merge !== "auto") return versionConflict(document, expectedVersion)

      const base = document.revisions.get(expectedVersion)
      const merged = base === undefined ? undefined : mergeLines(base, document.body, submitted)

      if (merged === undefined) {
        return contextError(409, "edits since version " + expectedVersion + " overlap", {
          code: "merge_conflict",
          expectedVersion,
          currentVersion: document.version,
        })
      }

      accept(document, merged, undefined)

      return { json: documentJson(document) }
    },
  ],
  [
    "DELETE " + DOCUMENT,
    (request, state) => {
      const document = activeDocument(request, state)
      const { expectedVersion } = request.json

      if (document === undefined) return notFound("document")

      if (!Predicate.isString(expectedVersion)) return badRequest("expectedVersion is required")

      if (expectedVersion !== document.version) return versionConflict(document, expectedVersion)

      document.version = nextVersion(document.version)
      document.retiredAt = now()
      document.updatedAt = document.retiredAt

      return { json: documentMetadata(document) }
    },
  ],
]

const CONTENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]

const partIndexOf = (request: ContextRequest): number => Number(paramOf(request, "partIndex"))

const FILE_ROUTES: ReadonlyArray<readonly [string, ContextHandler]> = [
  [
    "POST " + SPACE + "/files",
    (request, state) => {
      const { contentType, sizeBytes, sha256 } = request.json

      if (
        !Predicate.isString(contentType) ||
        !CONTENT_TYPES.includes(contentType) ||
        !Predicate.isNumber(sizeBytes) ||
        sizeBytes < 1 ||
        !Predicate.isString(sha256)
      ) {
        return badRequest("contentType, sizeBytes, and sha256 are required")
      }

      const file: StoredFile = {
        fileId: nextUuid(state),
        spaceId: paramOf(request, "spaceId"),
        contentType,
        sizeBytes,
        sha256,
        partSizeBytes: state.partSizeBytes,
        partCount: Math.ceil(sizeBytes / state.partSizeBytes),
        parts: new Map(),
        committed: false,
      }

      state.files.set(file.fileId, file)

      return {
        status: 201,
        json: {
          fileId: file.fileId,
          partSizeBytes: file.partSizeBytes,
          partCount: file.partCount,
          expiresAt: UPLOAD_EXPIRES_AT,
        },
      }
    },
  ],
  [
    "PUT " + FILE + "/parts/{partIndex}",
    (request, state) => {
      const file = fileOf(request, state)
      const index = partIndexOf(request)

      if (file === undefined || file.committed) return notFound("pending file")

      if (!Number.isInteger(index) || index < 0 || index >= file.partCount) {
        return badRequest("part " + String(index) + " is out of range")
      }

      const last = index === file.partCount - 1
      const expected = last ? file.sizeBytes - index * file.partSizeBytes : file.partSizeBytes

      if (request.body.byteLength !== expected) {
        return contextError(
          400,
          "part " + String(index) + " must be " + String(expected) + " bytes",
          {
            code: "part_size_mismatch",
          },
        )
      }

      file.parts.set(index, request.body)

      return { status: 204 }
    },
  ],
  [
    "GET " + FILE + "/parts/{partIndex}",
    (request, state) => {
      const file = fileOf(request, state)
      const part = file?.committed === true ? file.parts.get(partIndexOf(request)) : undefined

      return part === undefined ? notFound("file part") : { bytes: part }
    },
  ],
  [
    "DELETE " + FILE,
    (request, state) => {
      const file = fileOf(request, state)

      if (file === undefined) return notFound("file")

      if (file.committed) {
        return contextError(409, "file " + file.fileId + " is committed", {
          code: "file_committed",
        })
      }

      state.files.delete(file.fileId)

      return { status: 204 }
    },
  ],
]

const SESSION_ROUTES: ReadonlyArray<readonly [string, ContextHandler]> = [
  [
    "GET " + SPACE + "/sessions",
    (request, state) => {
      const parent = request.searchParams.get("parentSessionId")
      const spaceId = paramOf(request, "spaceId")

      const sessions = [...state.sessions.values()].filter(
        (session) =>
          session.spaceId === spaceId &&
          (parent === null ||
            (parent === "root"
              ? session.parentSessionId === null
              : session.parentSessionId === parent)),
      )

      return pageAfter(sessions, request, (session) => session.sessionId, sessionJson)
    },
  ],
  [
    "PUT " + SESSION,
    (request, state) => {
      const sessionId = paramOf(request, "sessionId")
      const spaceId = paramOf(request, "spaceId")
      const parent = request.json.parentSessionId
      const parentSessionId = Predicate.isString(parent) ? parent : null
      const existing = state.sessions.get(sessionId)

      if (existing !== undefined) {
        return existing.spaceId === spaceId && existing.parentSessionId === parentSessionId
          ? { json: sessionJson(existing) }
          : contextError(409, "session " + sessionId + " is registered differently", {
              code: "session_conflict",
            })
      }

      if (parentSessionId !== null && state.sessions.get(parentSessionId)?.spaceId !== spaceId) {
        return notFound("parent session")
      }

      const at = now()

      const session: StoredSession = {
        sessionId,
        spaceId,
        parentSessionId,
        records: [],
        createdAt: at,
        updatedAt: at,
      }

      state.sessions.set(sessionId, session)

      return { status: 201, json: sessionJson(session) }
    },
  ],
  [
    "GET " + SESSION,
    (request, state) => {
      const session = sessionOf(request, state)

      return session === undefined ? notFound("session") : { json: sessionJson(session) }
    },
  ],
  [
    "POST " + SESSION + "/append",
    (request, state) => {
      const session = sessionOf(request, state)
      const { startSequence, contentJsonl } = request.json

      if (session === undefined) return notFound("session")

      if (!Predicate.isString(startSequence) || !Predicate.isString(contentJsonl)) {
        return badRequest("startSequence and contentJsonl are required")
      }

      const batch = contentJsonl.slice(0, -1).split("\n")
      const start = Number(startSequence)
      const last = session.records.length
      const through = String(BigInt(startSequence) + BigInt(batch.length - 1))
      const currentSequence = String(last)

      if (start === last + 1) {
        session.records.push(...batch)
        session.updatedAt = now()

        return {
          json: {
            lastSequence: String(session.records.length),
            acceptedThroughSequence: through,
            appendedRecords: batch.length,
          },
        }
      }

      if (start > last + 1) {
        return contextError(409, "records must continue from sequence " + currentSequence, {
          code: "sequence_gap",
          currentSequence,
        })
      }

      const stored = session.records.slice(start - 1, start - 1 + batch.length)

      if (
        stored.length === batch.length &&
        stored.every((record, index) => record === batch[index])
      ) {
        return {
          json: {
            lastSequence: currentSequence,
            acceptedThroughSequence: through,
            appendedRecords: 0,
          },
        }
      }

      return contextError(409, "records from sequence " + startSequence + " differ", {
        code: "sequence_conflict",
        currentSequence,
      })
    },
  ],
  [
    "GET " + SESSION + "/records",
    (request, state) => {
      const session = sessionOf(request, state)

      if (session === undefined) return notFound("session")

      const after = Number(request.searchParams.get("afterSequence") ?? "0")
      const limit = limitOf(request)
      const maxBytes = Number(request.searchParams.get("maxBytes") ?? String(DEFAULT_MAX_BYTES))
      const lines: Array<string> = []
      let bytes = 0

      for (const record of session.records.slice(after, after + limit)) {
        const size = encoder.encode(record + "\n").byteLength

        if (lines.length > 0 && bytes + size > maxBytes) break

        lines.push(record)
        bytes += size
      }

      const nextCursor = String(after + lines.length)

      return {
        json: {
          contentJsonl: lines.map((line) => line + "\n").join(""),
          lastSequence: String(session.records.length),
          nextCursor,
          hasMore: after + lines.length < session.records.length,
        },
      }
    },
  ],
]

const DEFAULT_ROUTES: ReadonlyArray<readonly [string, ContextHandler]> = [
  ...SPACE_ROUTES,
  ...[...DOCUMENT_ROUTES, ...FILE_ROUTES, ...SESSION_ROUTES].map(
    ([key, handler]) => [key, inSpace(handler)] as const,
  ),
]

interface Route {
  readonly key: string
  readonly method: string
  readonly segments: ReadonlyArray<string>
  readonly literals: number
  readonly handler: ContextHandler
}

const routeOf = (key: string, handler: ContextHandler): Route => {
  const space = key.indexOf(" ")
  const segments = key.slice(space + 1).split("/")

  return {
    key,
    method: key.slice(0, space),
    segments,
    literals: segments.filter((segment) => !segment.startsWith("{")).length,
    handler,
  }
}

const matchPath = (
  route: Route,
  segments: ReadonlyArray<string>,
): Record<string, string> | undefined => {
  if (route.segments.length !== segments.length) return undefined

  const params: Record<string, string> = {}

  for (const [index, pattern] of route.segments.entries()) {
    const segment = segments[index] ?? ""

    if (pattern.startsWith("{")) {
      if (segment.length === 0) return undefined

      params[pattern.slice(1, -1)] = decodeURIComponent(segment)
    } else if (pattern !== segment) {
      return undefined
    }
  }

  return params
}

const readBody = (request: IncomingMessage): Promise<Uint8Array> =>
  new Promise((resolve) => {
    const chunks: Array<Uint8Array> = []

    request.on("data", (chunk: Uint8Array) => {
      chunks.push(chunk)
    })
    request.on("end", () => {
      resolve(new Uint8Array(Buffer.concat(chunks)))
    })
  })

const decodeObject = (bytes: Uint8Array): JsonObject => {
  try {
    const json = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Json)(JSON.parse(new TextDecoder().decode(bytes))),
    )

    return isJsonObject(json) ? json : {}
  } catch {
    return {}
  }
}

interface HeaderMap {
  [name: string]: string
}

const headerRecord = (request: IncomingMessage): HeaderMap => {
  const headers: HeaderMap = {}

  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value
  }

  return headers
}

const write = (response: ServerResponse, reply: ContextReply): void => {
  const status = reply.status ?? 200
  const headers: HeaderMap = { ...reply.headers }

  if (status === 204) {
    response.writeHead(status, headers)
    response.end()

    return
  }

  if (reply.json !== undefined) {
    headers["content-type"] = "application/json"
    response.writeHead(status, headers)
    response.end(JSON.stringify(reply.json))

    return
  }

  if (reply.bytes !== undefined) {
    headers["content-type"] = "application/octet-stream"
    response.writeHead(status, headers)
    response.end(reply.bytes)

    return
  }

  response.writeHead(status, headers)
  response.end()
}

/**
 * A stand-in for a Prem Context API: stateful spaces, documents, files, and
 * stored sessions under `/api/context`, answering in the shapes the SDK's
 * response schemas accept. It records every request with its raw body bytes.
 */
export const startFakeContextApi = async (): Promise<FakeContextApi> => {
  const requests: Array<ContextRecordedRequest> = []
  const failures = new Map<string, Array<ContextReply>>()
  const overrides = new Map<string, ContextHandler>()
  let state = seedState()

  const routes = (): ReadonlyArray<Route> => {
    const table = new Map<string, ContextHandler>(DEFAULT_ROUTES)

    for (const [key, handler] of overrides) table.set(key, handler)

    return Array.from(table, ([key, handler]) => routeOf(key, handler))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request)
    const url = request.url ?? "/"
    const mark = url.indexOf("?")
    const path = mark < 0 ? url : url.slice(0, mark)
    const query = mark < 0 ? "" : url.slice(mark + 1)
    const method = request.method ?? "GET"
    const segments = path.split("/")

    const candidates = routes()
      .flatMap((route) => {
        const params = matchPath(route, segments)

        return params === undefined ? [] : [{ route, params }]
      })
      .sort((left, right) => right.route.literals - left.route.literals)

    const best = candidates.find((candidate) => candidate.route.method === method)

    const recorded: ContextRecordedRequest = {
      method,
      path,
      query,
      headers: headerRecord(request),
      body,
      route: best?.route.key,
    }

    requests.push(recorded)

    if (best === undefined) {
      write(
        response,
        contextError(candidates.length === 0 ? 404 : 405, "no route for " + method + " " + path),
      )

      return
    }

    const injected = failures.get(best.route.key)?.shift()

    if (injected !== undefined) {
      write(response, injected)

      return
    }

    const reply = await best.route.handler(
      {
        ...recorded,
        params: best.params,
        searchParams: new URLSearchParams(query),
        json: decodeObject(body),
      },
      state,
    )

    write(response, reply)
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()

  if (address === null || Predicate.isString(address))
    throw new Error("fake Context API did not bind")

  return {
    baseUrl: "http://127.0.0.1:" + String(address.port),
    requests,
    get state() {
      return state
    },
    last: () => requests.at(-1),
    route: (key, handler) => {
      overrides.set(key, handler)
    },
    failNext: (key, reply) => {
      failures.set(key, [...(failures.get(key) ?? []), reply])
    },
    reset: () => {
      requests.length = 0
      failures.clear()
      overrides.clear()
      state = seedState()
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}
