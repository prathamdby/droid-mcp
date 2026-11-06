import { createHash } from "node:crypto"
import { createServer } from "node:net"

import * as Schema from "effect/Schema"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { Config } from "../../src/config.ts"
import { testConfig } from "../support/config.ts"
import { contextError, contextUuid, startFakeContextApi } from "../support/fake-context-api.ts"
import type { FakeContextApi, Json } from "../support/fake-context-api.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const FACTORY_KEY = "factory-context-key-canary"
const TENANT_HEADER = "x-factory-organization"
const TENANT = "org-tenant-canary"
const DESTRUCTIVE = "Destructive; confirm before calling."

const CONTEXT_TOOLS = [
  "context_create_space",
  "context_list_spaces",
  "context_get_space",
  "context_create_document",
  "context_list_documents",
  "context_get_document",
  "context_get_document_by_path",
  "context_update_document",
  "context_delete_document",
  "context_create_file",
  "context_upload_file_part",
  "context_read_file_part",
  "context_delete_file",
  "context_register_session",
  "context_get_session",
  "context_list_sessions",
  "context_append_session",
  "context_read_session_records",
]

const Created = Schema.Struct({ id: Schema.String, version: Schema.String })

const Upload = Schema.Struct({
  fileId: Schema.String,
  partSizeBytes: Schema.Number,
  partCount: Schema.Number,
})

const Part = Schema.Struct({
  partIndex: Schema.Number,
  sizeBytes: Schema.Number,
  encoding: Schema.Literal("base64"),
  data: Schema.String,
})

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** A port that was free a moment ago, so nothing answers on it. */
const closedPort = async (): Promise<number> => {
  const server = createServer()

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  const port = address !== null && !Schema.is(Schema.String)(address) ? address.port : 0

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })

  return port
}

describe("context tools over MCP", () => {
  let hosted: FakeFactoryApi
  let api: FakeContextApi
  let client: ToolClient

  const configFor = (overrides: Partial<Config> = {}): Config =>
    testConfig({
      factoryApiKey: FACTORY_KEY,
      factoryBaseUrl: hosted.baseUrl,
      factoryContextBaseUrl: api.baseUrl,
      factoryContextHeaders: { [TENANT_HEADER]: TENANT },
      ...overrides,
    })

  /** A second client for one test; it is disposed before the test ends. */
  const withClient = async (
    overrides: Partial<Config>,
    use: (other: ToolClient) => Promise<void>,
  ): Promise<void> => {
    const other = await connect({ config: configFor(overrides) })

    try {
      await use(other)
    } finally {
      await other.dispose()
    }
  }

  beforeAll(async () => {
    hosted = await startFakeFactoryApi()
    api = await startFakeContextApi()
    client = await connect({ config: configFor() })
  })

  beforeEach(() => {
    hosted.reset()
    api.reset()
  })

  afterEach(() => {
    expect(hosted.requests).toHaveLength(0)
  })

  afterAll(async () => {
    await client.dispose()
    await api.close()
    await hosted.close()
  })

  const bodyOf = (): Json =>
    Schema.decodeUnknownSync(Schema.Json)(
      JSON.parse(new TextDecoder().decode(api.last()?.body ?? new Uint8Array())),
    )

  const createSpace = async (name = "notes"): Promise<string> => {
    const space = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      await client.ok("context_create_space", { name, accessScope: "organization" }),
    )

    return space.id
  }

  const createDocument = async (spaceId: string, path: string, body: string) =>
    Schema.decodeUnknownSync(Created)(
      await client.ok("context_create_document", { spaceId, path, body }),
    )

  it("lists all eighteen tools and warns on the two deletions", async () => {
    const byName = new Map((await client.list()).map((tool) => [tool.name, tool]))

    for (const name of CONTEXT_TOOLS) {
      expect(byName.has(name)).toBe(true)
      expect(byName.get(name)?.description).toContain("FACTORY_CONTEXT_BASE_URL")
    }

    expect(byName.get("context_delete_document")?.description).toContain(DESTRUCTIVE)
    expect(byName.get("context_delete_file")?.description).toContain(DESTRUCTIVE)
  })

  it("sends the Factory key and the configured tenant header to the Context origin only", async () => {
    await createSpace()

    const request = api.last()

    expect(request?.method).toBe("POST")
    expect(request?.path).toBe("/api/context/spaces")
    expect(request?.headers.authorization).toBe("Bearer " + FACTORY_KEY)
    expect(request?.headers[TENANT_HEADER]).toBe(TENANT)
    expect(bodyOf()).toEqual({ name: "notes", accessScope: "organization" })
  })

  it("creates, lists across pages, and reads spaces", async () => {
    const first = await createSpace("one")
    const second = await createSpace("two")

    const page = Schema.decodeUnknownSync(
      Schema.Struct({
        items: Schema.Array(Schema.Struct({ id: Schema.String })),
        nextCursor: Schema.optional(Schema.String),
      }),
    )(await client.ok("context_list_spaces", { limit: 1 }))

    expect(page.items.map((space) => space.id)).toEqual([first])
    expect(page.nextCursor).toBe(first)
    expect(api.last()?.query).toBe("limit=1")

    expect(await client.ok("context_list_spaces", { limit: 1, cursor: first })).toMatchObject({
      items: [{ id: second, name: "two" }],
    })
    expect(await client.ok("context_get_space", { spaceId: second })).toMatchObject({
      id: second,
      name: "two",
      accessScope: "organization",
      createdByPrincipalKind: "service",
    })
  })

  it("creates and reads documents by ID and by path, and lists them by kind", async () => {
    const spaceId = await createSpace()
    const path = "plans/q3 roadmap?.md"
    const created = await createDocument(spaceId, path, "ship it\n")

    expect(created.version).toBe("1")
    expect(bodyOf()).toEqual({ path, body: "ship it\n" })

    expect(
      await client.ok("context_get_document", { spaceId, documentId: created.id }),
    ).toMatchObject({ id: created.id, path, body: "ship it\n", version: "1" })

    expect(await client.ok("context_get_document_by_path", { spaceId, path })).toMatchObject({
      id: created.id,
      body: "ship it\n",
    })
    expect(new URLSearchParams(api.last()?.query).get("path")).toBe(path)

    expect(
      await client.ok("context_list_documents", { spaceId, kinds: ["text", "binary"], limit: 10 }),
    ).toMatchObject({ items: [{ id: created.id, path }] })
    expect(new URLSearchParams(api.last()?.query).get("kinds")).toBe("text,binary")

    expect(await client.ok("context_list_documents", { spaceId, kinds: ["binary"] })).toEqual({
      items: [],
    })
  })

  it("updates strictly, reports a version conflict, and merges a stale auto edit", async () => {
    const spaceId = await createSpace()
    const document = await createDocument(spaceId, "notes.md", "a\nb\nc\n")
    const documentId = document.id

    expect(
      await client.ok("context_update_document", {
        spaceId,
        documentId,
        expectedVersion: "1",
        merge: "strict",
        body: "A\nb\nc\n",
      }),
    ).toMatchObject({ version: "2", body: "A\nb\nc\n" })
    expect(bodyOf()).toEqual({ expectedVersion: "1", body: "A\nb\nc\n" })

    const conflict = await client.fail("context_update_document", {
      spaceId,
      documentId,
      expectedVersion: "1",
      merge: "strict",
      body: "a\nb\nC\n",
    })

    expect(conflict.code).toBe("rest_rejected")
    expect(conflict.message).toMatch(
      /^updateContextDocument was rejected \(HTTP 409\): document \S+ changed since version 1 \(code: version_conflict, requestId: req-\d+, expectedVersion: 1, currentVersion: 2\)$/,
    )

    expect(
      await client.ok("context_update_document", {
        spaceId,
        documentId,
        expectedVersion: "1",
        body: "a\nb\nC\n",
      }),
    ).toMatchObject({ version: "3", body: "A\nb\nC\n" })
    expect(bodyOf()).toEqual({ expectedVersion: "1", body: "a\nb\nC\n", merge: "auto" })
  })

  it("replaces a document with an uploaded file, sending only expectedVersion and fileId", async () => {
    const spaceId = await createSpace()
    const document = await createDocument(spaceId, "logo.png", "placeholder")
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

    const upload = Schema.decodeUnknownSync(Upload)(
      await client.ok("context_create_file", {
        spaceId,
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    )

    await client.ok("context_upload_file_part", {
      spaceId,
      fileId: upload.fileId,
      partIndex: 0,
      contentBase64: base64(bytes),
    })

    expect(
      await client.ok("context_update_document", {
        spaceId,
        documentId: document.id,
        expectedVersion: document.version,
        fileId: upload.fileId,
      }),
    ).toMatchObject({ version: "2", body: "" })
    expect(bodyOf()).toEqual({ expectedVersion: document.version, fileId: upload.fileId })

    expect(
      await client.ok("context_get_document", { spaceId, documentId: document.id }),
    ).toMatchObject({
      version: "2",
      file: { fileId: upload.fileId, contentType: "image/png", sizeBytes: bytes.byteLength },
    })
  })

  it("keeps a version past 2^53 as an exact string", async () => {
    const spaceId = await createSpace()
    const document = await createDocument(spaceId, "big.md", "x")
    const stored = api.state.documents.get(document.id)

    if (stored === undefined) throw new Error("document not stored")

    stored.version = "9007199254740993"
    stored.revisions.set(stored.version, stored.body)

    expect(
      await client.ok("context_update_document", {
        spaceId,
        documentId: document.id,
        expectedVersion: "9007199254740993",
        merge: "strict",
        body: "y",
      }),
    ).toMatchObject({ version: "9007199254740994", body: "y" })
    expect(new TextDecoder().decode(api.last()?.body)).toContain(
      '"expectedVersion":"9007199254740993"',
    )
  })

  it("deletes a document only at its current version", async () => {
    const spaceId = await createSpace()
    const document = await createDocument(spaceId, "old.md", "bye")

    expect(
      await client.fail("context_delete_document", {
        spaceId,
        documentId: document.id,
        expectedVersion: "2",
      }),
    ).toMatchObject({
      code: "rest_rejected",
      message: expect.stringContaining("currentVersion: 1"),
    })

    expect(
      await client.ok("context_delete_document", {
        spaceId,
        documentId: document.id,
        expectedVersion: "1",
      }),
    ).toMatchObject({ id: document.id, retiredAt: expect.any(String) })
    expect(api.last()?.method).toBe("DELETE")
    expect(bodyOf()).toEqual({ expectedVersion: "1" })

    expect(
      await client.fail("context_get_document", { spaceId, documentId: document.id }),
    ).toMatchObject({ code: "rest_rejected", message: expect.stringContaining("(HTTP 404)") })
  })

  it("uploads a binary file in parts, commits it, and reads the exact bytes back", async () => {
    const spaceId = await createSpace()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3])

    api.state.partSizeBytes = 4

    const upload = Schema.decodeUnknownSync(Upload)(
      await client.ok("context_create_file", {
        spaceId,
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    )

    expect(upload).toMatchObject({ partSizeBytes: 4, partCount: 3 })

    const parts = [bytes.slice(0, 4), bytes.slice(4, 8), bytes.slice(8)]

    for (const [partIndex, part] of parts.slice(0, 2).entries()) {
      expect(
        await client.ok("context_upload_file_part", {
          spaceId,
          fileId: upload.fileId,
          partIndex,
          contentBase64: base64(part),
        }),
      ).toEqual({ ok: true, partIndex, sizeBytes: part.byteLength })
      expect(api.last()?.headers["content-type"]).toBe("application/octet-stream")
      expect(api.last()?.body).toEqual(part)
    }

    expect(
      await client.fail("context_create_document", {
        spaceId,
        path: "logo.png",
        fileId: upload.fileId,
      }),
    ).toMatchObject({ code: "rest_rejected", message: expect.stringContaining("file_incomplete") })

    await client.ok("context_upload_file_part", {
      spaceId,
      fileId: upload.fileId,
      partIndex: 2,
      contentBase64: base64(parts[2] ?? new Uint8Array()),
    })

    const document = await client.ok("context_create_document", {
      spaceId,
      path: "logo.png",
      fileId: upload.fileId,
    })

    expect(document).toMatchObject({
      file: { fileId: upload.fileId, contentType: "image/png", sizeBytes: 10, partCount: 3 },
    })

    const read: Array<Uint8Array> = []

    for (let partIndex = 0; partIndex < upload.partCount; partIndex++) {
      const part = Schema.decodeUnknownSync(Part)(
        await client.ok("context_read_file_part", { spaceId, fileId: upload.fileId, partIndex }),
      )

      expect(part.partIndex).toBe(partIndex)
      expect(part.sizeBytes).toBe(parts[partIndex]?.byteLength)
      read.push(new Uint8Array(Buffer.from(part.data, "base64")))
    }

    expect(new Uint8Array(Buffer.concat(read))).toEqual(bytes)
  })

  it("cancels a partially uploaded file", async () => {
    const spaceId = await createSpace()
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])

    api.state.partSizeBytes = 4

    const upload = Schema.decodeUnknownSync(Upload)(
      await client.ok("context_create_file", {
        spaceId,
        contentType: "application/pdf",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    )

    await client.ok("context_upload_file_part", {
      spaceId,
      fileId: upload.fileId,
      partIndex: 0,
      contentBase64: base64(bytes.slice(0, 4)),
    })

    expect(await client.ok("context_delete_file", { spaceId, fileId: upload.fileId })).toEqual({
      ok: true,
    })
    expect(api.last()?.method).toBe("DELETE")
    expect(api.state.files.has(upload.fileId)).toBe(false)

    expect(
      await client.fail("context_upload_file_part", {
        spaceId,
        fileId: upload.fileId,
        partIndex: 1,
        contentBase64: base64(bytes.slice(4)),
      }),
    ).toMatchObject({ code: "rest_rejected", message: expect.stringContaining("(HTTP 404)") })
  })

  it("registers sessions and filters them by root and parent", async () => {
    const spaceId = await createSpace()
    const parent = contextUuid(900)
    const child = contextUuid(901)

    expect(
      await client.ok("context_register_session", { spaceId, sessionId: parent }),
    ).toMatchObject({ sessionId: parent, parentSessionId: null, lastSequence: "0" })
    expect(bodyOf()).toEqual({})

    await client.ok("context_register_session", {
      spaceId,
      sessionId: child,
      parentSessionId: parent,
    })
    expect(bodyOf()).toEqual({ parentSessionId: parent })

    expect(
      await client.ok("context_register_session", { spaceId, sessionId: parent }),
    ).toMatchObject({ sessionId: parent })

    expect(
      await client.ok("context_list_sessions", { spaceId, parentSessionId: "root" }),
    ).toMatchObject({ items: [{ sessionId: parent }] })
    expect(
      await client.ok("context_list_sessions", { spaceId, parentSessionId: parent }),
    ).toMatchObject({ items: [{ sessionId: child, parentSessionId: parent }] })
    expect(await client.ok("context_get_session", { spaceId, sessionId: child })).toMatchObject({
      sessionId: child,
      parentSessionId: parent,
      ownerKind: "service",
    })
  })

  it("appends records, accepts an identical retry, rejects a gap, and pages reads", async () => {
    const spaceId = await createSpace()
    const sessionId = contextUuid(910)
    const batch = '{"n":1}\n{"n":2}\n{"n":3}\n'

    await client.ok("context_register_session", { spaceId, sessionId })

    const append = { spaceId, sessionId, startSequence: "1", contentJsonl: batch }

    expect(await client.ok("context_append_session", append)).toEqual({
      lastSequence: "3",
      acceptedThroughSequence: "3",
      appendedRecords: 3,
    })
    expect(await client.ok("context_append_session", append)).toEqual({
      lastSequence: "3",
      acceptedThroughSequence: "3",
      appendedRecords: 0,
    })

    const gap = await client.fail("context_append_session", {
      ...append,
      startSequence: "5",
      contentJsonl: '{"n":5}\n',
    })

    expect(gap.code).toBe("rest_rejected")
    expect(gap.message).toContain("code: sequence_gap")
    expect(gap.message).toContain("currentSequence: 3")

    expect(
      await client.ok("context_read_session_records", { spaceId, sessionId, limit: 2 }),
    ).toEqual({
      contentJsonl: '{"n":1}\n{"n":2}\n',
      lastSequence: "3",
      nextCursor: "2",
      hasMore: true,
    })

    expect(
      await client.ok("context_read_session_records", {
        spaceId,
        sessionId,
        afterSequence: "2",
        maxBytes: 262_144,
      }),
    ).toEqual({ contentJsonl: '{"n":3}\n', lastSequence: "3", nextCursor: "3", hasMore: false })
    expect(new URLSearchParams(api.last()?.query).get("afterSequence")).toBe("2")
  })

  /** Uploads `bytes` as one part and commits them, returning the file ID. */
  const commitFile = async (spaceId: string, bytes: Uint8Array): Promise<string> => {
    const upload = Schema.decodeUnknownSync(Upload)(
      await client.ok("context_create_file", {
        spaceId,
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    )

    await client.ok("context_upload_file_part", {
      spaceId,
      fileId: upload.fileId,
      partIndex: 0,
      contentBase64: base64(bytes),
    })
    await client.ok("context_create_document", {
      spaceId,
      path: "file-" + upload.fileId + ".png",
      fileId: upload.fileId,
    })

    return upload.fileId
  }

  it("returns file-part bytes intact even when their base64 spells a configured value", async () => {
    const spaceId = await createSpace()
    const fileId = await commitFile(spaceId, new Uint8Array([1, 2, 3]))

    await withClient(
      { factoryContextHeaders: { [TENANT_HEADER]: TENANT, "x-probe": "AQID" } },
      async (other) => {
        expect(await other.ok("context_read_file_part", { spaceId, fileId, partIndex: 0 })).toEqual(
          { partIndex: 0, sizeBytes: 3, encoding: "base64", data: "AQID" },
        )
      },
    )
  })

  it("refuses a file part whose bytes contain a configured value", async () => {
    const spaceId = await createSpace()
    const fileId = await commitFile(spaceId, new TextEncoder().encode("PNG " + TENANT))

    expect(await client.fail("context_read_file_part", { spaceId, fileId, partIndex: 0 })).toEqual({
      code: "rest_unavailable",
      message: "readContextFilePart returned binary content containing a protected value; refused",
    })
  })

  it.each([
    ["with a declared length", {}],
    ["streamed without a length", { "transfer-encoding": "chunked" }],
  ])("refuses a file part over 3 MiB %s before buffering it", async (_label, headers) => {
    api.failNext("GET /api/context/spaces/{spaceId}/files/{fileId}/parts/{partIndex}", {
      bytes: new Uint8Array(3 * 1024 * 1024 + 1),
      headers,
    })

    expect(
      await client.fail("context_read_file_part", {
        spaceId: contextUuid(1),
        fileId: contextUuid(2),
        partIndex: 0,
      }),
    ).toEqual({
      code: "rest_unavailable",
      message: "readContextFilePart returned more than 3145728 bytes (HTTP 200)",
    })
  })

  it("redacts stored records as JSON and returns valid JSONL", async () => {
    const spaceId = await createSpace()
    const sessionId = contextUuid(920)
    const quoted = 'say "hi" now'

    const records = [
      { enabled: true, n: 1 },
      { note: "tenant " + TENANT },
      { text: quoted, [quoted]: 1 },
    ]

    await client.ok("context_register_session", { spaceId, sessionId })
    await client.ok("context_append_session", {
      spaceId,
      sessionId,
      startSequence: "1",
      contentJsonl: records.map((record) => JSON.stringify(record) + "\n").join(""),
    })

    await withClient(
      { factoryContextHeaders: { [TENANT_HEADER]: TENANT, "x-flag": "true", "x-quote": quoted } },
      async (other) => {
        const page = Schema.decodeUnknownSync(Schema.Struct({ contentJsonl: Schema.String }))(
          await other.ok("context_read_session_records", { spaceId, sessionId }),
        )

        const lines = page.contentJsonl.split("\n")

        expect(lines.pop()).toBe("")
        expect(lines.map((line) => JSON.parse(line))).toEqual([
          { enabled: true, n: 1 },
          { note: "tenant [redacted]" },
          { text: "[redacted]", "[redacted]": 1 },
        ])
        expect(page.contentJsonl).not.toContain("hi")
      },
    )
  })

  it("refuses a lone surrogate before any request", async () => {
    expect(await client.fail("context_get_space", { spaceId: "\ud800" })).toEqual({
      code: "invalid_params",
      message: "context_get_space: spaceId is not well-formed Unicode",
    })
    expect((await client.fail("context_list_spaces", { cursor: "a\udfffb" })).code).toBe(
      "invalid_params",
    )
    expect(api.requests).toHaveLength(0)
  })

  it("keeps response members the contract does not name", async () => {
    api.failNext("GET /api/context/spaces", { json: { items: [], extra: { future: true } } })

    expect(await client.ok("context_list_spaces")).toEqual({ items: [], extra: { future: true } })
  })

  it("rejects invalid inputs before any request", async () => {
    const spaceId = contextUuid(1)
    const fileId = contextUuid(2)
    const sessionId = contextUuid(3)
    const documentId = contextUuid(4)
    const bigRecord = '{"x":"' + "a".repeat(64 * 1024 - 8) + '"}\n'

    expect(new TextEncoder().encode(bigRecord).byteLength).toBe(64 * 1024 + 1)

    const declared: ReadonlyArray<readonly [string, Json]> = [
      ["context_upload_file_part", { spaceId, fileId, partIndex: 0, contentBase64: "not base64!" }],
      ["context_upload_file_part", { spaceId, fileId, partIndex: 0, contentBase64: "QQ" }],
      ["context_upload_file_part", { spaceId, fileId, partIndex: 0, contentBase64: "" }],
      [
        "context_append_session",
        { spaceId, sessionId, startSequence: "1", contentJsonl: bigRecord },
      ],
      [
        "context_append_session",
        { spaceId, sessionId, startSequence: "1", contentJsonl: '{"a":1}' },
      ],
      ["context_append_session", { spaceId, sessionId, startSequence: "1", contentJsonl: "[1]\n" }],
      [
        "context_append_session",
        { spaceId, sessionId, startSequence: "9223372036854775807", contentJsonl: "{}\n{}\n" },
      ],
      ["context_create_document", { spaceId, path: "a.md", body: "x", fileId }],
      ["context_create_document", { spaceId, path: "a.md" }],
      ["context_create_document", { spaceId, path: "a.md", body: "é".repeat(128 * 1024 + 1) }],
      ["context_create_document", { spaceId, path: "p/".repeat(256) + "x", body: "x" }],
      [
        "context_update_document",
        { spaceId, documentId, expectedVersion: "1", merge: "auto", fileId },
      ],
      ["context_create_space", { name: "   ", accessScope: "members" }],
      [
        "context_create_file",
        {
          spaceId,
          contentType: "image/png",
          sizeBytes: 10 * 1024 * 1024 + 1,
          sha256: "a".repeat(64),
        },
      ],
      [
        "context_create_file",
        {
          spaceId,
          contentType: "application/pdf",
          sizeBytes: 25 * 1024 * 1024 + 1,
          sha256: "a".repeat(64),
        },
      ],
    ]

    for (const [name, args] of declared) {
      expect(await client.fail(name, args), name).toMatchObject({ code: "invalid_params" })
    }

    const schema: ReadonlyArray<readonly [string, Json]> = [
      ["context_read_file_part", { spaceId, fileId, partIndex: 9 }],
      ["context_upload_file_part", { spaceId, fileId, partIndex: -1, contentBase64: "AA==" }],
      ["context_update_document", { spaceId, documentId, expectedVersion: "0", body: "x" }],
      ["context_update_document", { spaceId, documentId, expectedVersion: "01", body: "x" }],
      ["context_update_document", { spaceId, documentId, expectedVersion: 2, body: "x" }],
      [
        "context_update_document",
        { spaceId, documentId, expectedVersion: "9223372036854775808", body: "x" },
      ],
      [
        "context_update_document",
        { spaceId, documentId, expectedVersion: "1", merge: "fast", body: "x" },
      ],
      ["context_delete_document", { spaceId, documentId, expectedVersion: "1.5" }],
      [
        "context_create_file",
        { spaceId, contentType: "image/png", sizeBytes: 1, sha256: "A".repeat(64) },
      ],
      [
        "context_create_file",
        { spaceId, contentType: "text/plain", sizeBytes: 1, sha256: "a".repeat(64) },
      ],
      [
        "context_create_file",
        { spaceId, contentType: "image/png", sizeBytes: 0, sha256: "a".repeat(64) },
      ],
      ["context_list_documents", { spaceId, kinds: ["image"] }],
      ["context_list_documents", { spaceId, kinds: [] }],
      ["context_list_spaces", { limit: 0 }],
      ["context_list_spaces", { limit: 101 }],
      ["context_list_spaces", { limit: 1.5 }],
      ["context_read_session_records", { spaceId, sessionId, maxBytes: 262_145 }],
      ["context_read_session_records", { spaceId, sessionId, maxBytes: 0 }],
      ["context_read_session_records", { spaceId, sessionId, afterSequence: "-1" }],
      ["context_get_space", { spaceId: ".." }],
      ["context_create_space", { name: "x", accessScope: "everyone" }],
    ]

    for (const [name, args] of schema) {
      const outcome = await client.call(name, args)

      expect(outcome.rpcError !== undefined || outcome.isError, name).toBe(true)
    }

    expect(api.requests).toHaveLength(0)
  })

  it("accepts the largest valid version and the boundary limits", async () => {
    const spaceId = await createSpace()

    const missing = await client.fail("context_update_document", {
      spaceId,
      documentId: contextUuid(99),
      expectedVersion: "9223372036854775807",
      body: "x",
    })

    expect(missing.message).toContain("(HTTP 404)")
    expect(bodyOf()).toMatchObject({ expectedVersion: "9223372036854775807" })
    expect(await client.ok("context_list_spaces", { limit: 100 })).toMatchObject({
      items: [{ id: spaceId }],
    })
    expect(
      await client.fail("context_read_session_records", {
        spaceId,
        sessionId: contextUuid(98),
        afterSequence: "0",
        limit: 1,
        maxBytes: 1,
      }),
    ).toMatchObject({ code: "rest_rejected", message: expect.stringContaining("(HTTP 404)") })
    expect(api.last()?.query).toBe("afterSequence=0&limit=1&maxBytes=1")
    expect(api.requests).toHaveLength(4)
  })

  it("fails with context_base_url_missing, before any request, when no origin is configured", async () => {
    await withClient({ factoryContextBaseUrl: undefined }, async (other) => {
      for (const name of ["context_list_spaces", "context_create_space"]) {
        const failure = await other.fail(
          name,
          name === "context_list_spaces" ? {} : { name: "x", accessScope: "members" },
        )

        expect(failure.code).toBe("context_base_url_missing")
        expect(failure.message).toContain("FACTORY_CONTEXT_BASE_URL")
      }
    })

    expect(api.requests).toHaveLength(0)
  })

  it("fails with factory_api_key_missing before any request when no key is set", async () => {
    await withClient({ factoryApiKey: undefined }, async (other) => {
      expect(await other.fail("context_list_spaces")).toMatchObject({
        code: "factory_api_key_missing",
      })
    })

    expect(api.requests).toHaveLength(0)
  })

  it("maps upstream 5xx to rest_unavailable and scrubs configured secrets from detail", async () => {
    api.failNext(
      "GET /api/context/spaces",
      contextError(503, "maintenance for " + TENANT + " with " + FACTORY_KEY),
    )

    const failure = await client.fail("context_list_spaces")

    expect(failure.code).toBe("rest_unavailable")
    expect(failure.message).toMatch(/^listContextSpaces failed upstream \(HTTP 503\): maintenance/)
    expect(failure.message).not.toContain(TENANT)
    expect(failure.message).not.toContain(FACTORY_KEY)
  })

  it("redacts configured secrets from successful results", async () => {
    const spaceId = await createSpace()
    const document = await createDocument(spaceId, "leak.md", "tenant " + TENANT)

    const read = await client.ok("context_get_document", { spaceId, documentId: document.id })

    expect(JSON.stringify(read)).not.toContain(TENANT)
    expect(read).toMatchObject({ body: "tenant [redacted]" })
  })

  it("reports a malformed response with a fixed message and no SDK text", async () => {
    api.failNext("GET /api/context/spaces", { json: { items: "nope" } })

    const failure = await client.fail("context_list_spaces")

    expect(failure).toEqual({
      code: "rest_unavailable",
      message: "listContextSpaces got an unexpected response from the Context API",
    })
  })

  it("refuses a redirect without reaching the redirect target", async () => {
    api.failNext("GET /api/context/spaces", {
      status: 307,
      headers: { location: hosted.baseUrl + "/api/context/spaces" },
    })

    expect(await client.fail("context_list_spaces")).toEqual({
      code: "rest_unavailable",
      message: "listContextSpaces was redirected (HTTP 307); redirect refused",
    })
    expect(hosted.requests).toHaveLength(0)
  })

  it("times out with the configured request timeout", async () => {
    api.route(
      "GET /api/context/spaces",
      () => new Promise((resolve) => setTimeout(() => resolve({ json: { items: [] } }), 1_500)),
    )

    await withClient({ requestTimeoutMs: 150 }, async (other) => {
      expect(await other.fail("context_list_spaces")).toEqual({
        code: "rest_unavailable",
        message: "listContextSpaces timed out after 150 ms waiting for the Context API",
      })
    })
  })

  it("reports a refused connection with a fixed message", async () => {
    const port = await closedPort()

    await withClient(
      { factoryContextBaseUrl: "http://127.0.0.1:" + String(port) },
      async (other) => {
        expect(await other.fail("context_list_spaces")).toEqual({
          code: "rest_unavailable",
          message: "listContextSpaces could not reach the Context API",
        })
      },
    )
  })
})
