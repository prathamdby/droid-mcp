import { createHash } from "node:crypto"

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { Authority, authorityLayer } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { CallersApi } from "../../src/caller/index.ts"
import { Capabilities, capabilitiesLayer, OperationConflict } from "../../src/capabilities/index.ts"
import type { Catalog, Invocation, InvocationFailure } from "../../src/capabilities/index.ts"
import { ContextHeadersInvalid } from "../../src/context-headers/index.ts"
import { custodyLayer } from "../../src/custody/index.ts"
import {
  Disclosure,
  disclosureLayer,
  releasedJson,
  releasedMedia,
  releasedRecords,
} from "../../src/disclosure/index.ts"
import type { Released } from "../../src/disclosure/index.ts"
import { Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import {
  ContextOperations,
  contextOperationsLayer,
  ContextOriginMissing,
} from "../../src/prem-context/index.ts"
import { contextError, contextUuid, startFakeContextApi } from "../support/fake-context-api.ts"
import type { FakeContextApi } from "../support/fake-context-api.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TOKEN = "context-token-canary"
const TENANT = "org-tenant-canary"

const makeServices = (options?: {
  readonly maxAutonomy?: "off" | "low" | "medium" | "high"
  readonly guidanceRequired?: boolean
  readonly protectedValues?: ReadonlyArray<string>
  readonly allowedTargets?: ReadonlyArray<
    "local" | "daemon" | "hosted" | "context" | "session" | "system"
  >
}) => {
  const disclosureLive = disclosureLayer({ protectedValues: options?.protectedValues })
  const callersLive = callersLayer({ allowedTargets: options?.allowedTargets })

  const authorityLive = authorityLayer({
    maxAutonomy: options?.maxAutonomy ?? "high",
  })

  const guidanceLive = guidanceLayer({ required: options?.guidanceRequired })
  const custodyLive = custodyLayer

  const capabilitiesLive = Layer.provideMerge(
    capabilitiesLayer,
    Layer.merge(Layer.merge(callersLive, authorityLive), Layer.merge(guidanceLive, disclosureLive)),
  )

  const contextLive = Layer.provideMerge(
    contextOperationsLayer,
    Layer.mergeAll(
      capabilitiesLive,
      callersLive,
      authorityLive,
      guidanceLive,
      disclosureLive,
      custodyLive,
    ),
  )

  const merged = Layer.mergeAll(
    contextLive,
    capabilitiesLive,
    callersLive,
    authorityLive,
    guidanceLive,
    disclosureLive,
  )

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const contextOperations = yield* ContextOperations
        const capabilities = yield* Capabilities
        const callers = yield* Callers
        const authority = yield* Authority
        const guidance = yield* Guidance
        const disclosure = yield* Disclosure

        return { contextOperations, capabilities, callers, authority, guidance, disclosure }
      }),
      merged,
    ),
  )
}

type Services = ReturnType<typeof makeServices>

const makeInvocation = (
  callers: Pick<CallersApi, "admit" | "conversation">,
  principal: string,
): Invocation =>
  Effect.runSync(
    Effect.gen(function* () {
      const caller = yield* callers.admit(Option.getOrThrow(trustedEvidence(principal)))
      const conversation = yield* callers.conversation(caller)

      const invocation: Invocation = { caller, conversation }

      return invocation
    }),
  )

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

type InvokeExit = Exit.Exit<Released<"client">, InvocationFailure>

const successPayload = (exit: InvokeExit): Released<"client"> => {
  if (!Exit.isSuccess(exit)) throw new Error("expected success, got failure")

  return exit.value
}

const jsonOf = (exit: InvokeExit): Schema.Json => {
  const json = releasedJson(successPayload(exit))

  if (Option.isNone(json)) throw new Error("expected a JSON payload")

  return json.value
}

const mediaOf = (exit: InvokeExit) => {
  const media = releasedMedia(successPayload(exit))

  if (Option.isNone(media)) throw new Error("expected a media payload")

  return media.value
}

const recordsOf = (exit: InvokeExit) => {
  const records = releasedRecords(successPayload(exit))

  if (Option.isNone(records)) throw new Error("expected a records payload")

  return records.value
}

interface Harness {
  readonly services: Services
  readonly catalog: Catalog
  readonly who: Invocation
}

const makeHarness = async (
  api: FakeContextApi,
  options?: Parameters<typeof makeServices>[0] & {
    readonly timeoutMs?: number
    readonly headers?: Readonly<Record<string, string>>
    readonly token?: () => Effect.Effect<string | undefined>
  },
): Promise<Harness> => {
  const services = makeServices(options)

  const installation = {
    origin: api.baseUrl,
    token: options?.token ?? (() => Effect.succeed<string | undefined>(TOKEN)),
    headers: options?.headers ?? { "x-factory-organization": " \t" + TENANT + "\t " },
    timeoutMs: options?.timeoutMs,
  }

  const entries = await Effect.runPromise(services.contextOperations.entries(installation))
  const catalog = await Effect.runPromise(services.capabilities.assemble(entries))
  const who = makeInvocation(services.callers, "operator")

  return { services, catalog, who }
}

const invoke = (harness: Harness, id: string, input: Schema.Json): Promise<InvokeExit> =>
  Effect.runPromiseExit(
    harness.services.capabilities.invoke(harness.catalog, harness.who, id, input),
  )

const invokeJson = async (harness: Harness, id: string, input: Schema.Json): Promise<Schema.Json> =>
  jsonOf(await invoke(harness, id, input))

// ---------------------------------------------------------------------------
// Reply extraction schemas: tests decode, they never assert
// ---------------------------------------------------------------------------

const IdOnly = Schema.Struct({ id: Schema.String })

const Created = Schema.Struct({ id: Schema.String, version: Schema.String })

const SpacePage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String })),
  nextCursor: Schema.optional(Schema.String),
})

const SpaceTimingPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ createdAt: Schema.String })),
})

const NamedSpace = Schema.Struct({ id: Schema.String, name: Schema.String })

const BodyOnly = Schema.Struct({ body: Schema.String })

const DocumentList = Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) })

const VersionedBody = Schema.Struct({ version: Schema.String, body: Schema.String })

const VersionOnly = Schema.Struct({ version: Schema.String })

const Retired = Schema.Struct({ retiredAt: Schema.NullOr(Schema.String) })

const Upload = Schema.Struct({
  fileId: Schema.String,
  partSizeBytes: Schema.Number,
  partCount: Schema.Number,
})

const FileHolder = Schema.Struct({
  file: Schema.optional(Schema.Struct({ fileId: Schema.String })),
})

const Registered = Schema.Struct({ sessionId: Schema.String, lastSequence: Schema.String })

const SessionList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ sessionId: Schema.String })),
})

const SessionRead = Schema.Struct({ parentSessionId: Schema.NullOr(Schema.String) })

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  json: Schema.Json,
): S["Type"] => Schema.decodeUnknownSync(schema)(json)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prem-context", () => {
  let api: FakeContextApi

  beforeAll(async () => {
    api = await startFakeContextApi()
  })

  beforeEach(() => {
    api.reset()
  })

  afterAll(async () => {
    await api.close()
  })

  describe("origin validation", () => {
    it("fails with ContextOriginMissing when the installation carries no origin", async () => {
      const services = makeServices()

      const exit = await Effect.runPromiseExit(services.contextOperations.entries({}))
      const error = expectFailure(exit)

      expect(error).toBeInstanceOf(ContextOriginMissing)
    })

    it("fails with ContextOriginMissing for a blank or invalid origin", async () => {
      const services = makeServices()

      for (const origin of ["   ", "not a url", "ftp://example.com", "mailto:x@y.z"]) {
        const exit = await Effect.runPromiseExit(services.contextOperations.entries({ origin }))

        expect(expectFailure(exit)).toBeInstanceOf(ContextOriginMissing)
      }
    })

    it("rejects invalid static header names, values and duplicates without echoing values", async () => {
      const services = makeServices()
      const secret = "tenant-secret-canary"

      const invalidHeaders: ReadonlyArray<Readonly<Record<string, string>>> = [
        { "bad name": secret },
        { "x-tenant": secret + "\r\nX-Evil: 1" },
        { "X-Tenant": secret, "x-tenant": secret },
        Object.fromEntries([["__proto__", secret]]),
      ]

      for (const headers of invalidHeaders) {
        const exit = await Effect.runPromiseExit(
          services.contextOperations.entries({ origin: api.baseUrl, headers }),
        )

        const error = expectFailure(exit)

        expect(error).toBeInstanceOf(ContextHeadersInvalid)
        expect(JSON.stringify(error)).not.toContain(secret)
      }
    })

    it("rejects a non-string direct embedding header value as a typed validation failure", async () => {
      const services = makeServices()
      // JSON.parse is the runtime embedding boundary here: its untyped result
      // deliberately carries a non-string value into validation.
      const headers = JSON.parse('{"x-tenant":42}')

      const exit = await Effect.runPromiseExit(
        services.contextOperations.entries({ origin: api.baseUrl, headers }),
      )

      const error = expectFailure(exit)

      expect(error).toBeInstanceOf(ContextHeadersInvalid)

      if (error instanceof ContextHeadersInvalid) {
        expect(error.reason).toBe("invalid-value")
      }
    })

    it("rejects direct embedding header input that is not a record", async () => {
      const services = makeServices()

      for (const headers of [JSON.parse('"tenant"'), JSON.parse('["tenant"]')]) {
        const exit = await Effect.runPromiseExit(
          services.contextOperations.entries({ origin: api.baseUrl, headers }),
        )

        const error = expectFailure(exit)

        expect(error).toBeInstanceOf(ContextHeadersInvalid)

        if (error instanceof ContextHeadersInvalid) {
          expect(error.reason).toBe("invalid-shape")
        }
      }
    })

    it("never falls back to a hosted origin", async () => {
      const services = makeServices()
      const exit = await Effect.runPromiseExit(services.contextOperations.entries({}))

      expect(expectFailure(exit)).toBeInstanceOf(ContextOriginMissing)
      expect(api.requests).toHaveLength(0)
    })
  })

  describe("binding and assembly", () => {
    it("binds all eighteen context operations cleanly into one catalog", async () => {
      const harness = await makeHarness(api)

      expect(harness.catalog.size).toBe(18)

      const available = await Effect.runPromise(
        harness.services.capabilities.available(harness.catalog, harness.who),
      )

      const ids = available.map((entry) => entry.id).sort()

      expect(ids).toEqual(
        [
          "context_append_session",
          "context_create_document",
          "context_create_file",
          "context_create_space",
          "context_delete_document",
          "context_delete_file",
          "context_get_document",
          "context_get_document_by_path",
          "context_get_session",
          "context_get_space",
          "context_list_documents",
          "context_list_sessions",
          "context_list_spaces",
          "context_read_file_part",
          "context_read_session_records",
          "context_register_session",
          "context_update_document",
          "context_upload_file_part",
        ].sort(),
      )

      for (const entry of available) {
        expect(entry.family).toBe("context")
      }
    })
  })

  describe("end-to-end against the fake Context API", () => {
    const createSpace = async (harness: Harness, name = "notes"): Promise<string> => {
      const json = await invokeJson(harness, "context_create_space", {
        name,
        accessScope: "organization",
      })

      return decode(IdOnly, json).id
    }

    const createDocument = async (harness: Harness, spaceId: string, path: string, body: string) =>
      decode(Created, await invokeJson(harness, "context_create_document", { spaceId, path, body }))

    it("creates, lists and reads spaces, sending the scoped token and tenant header", async () => {
      const harness = await makeHarness(api)
      const first = await createSpace(harness, "one")
      const second = await createSpace(harness, "two")

      const request = api.requests[0]

      expect(request?.method).toBe("POST")
      expect(request?.path).toBe("/api/context/spaces")
      expect(request?.headers.authorization).toBe("Bearer " + TOKEN)
      expect(request?.headers["x-factory-organization"]).toBe(TENANT)

      const page = decode(SpacePage, await invokeJson(harness, "context_list_spaces", { limit: 1 }))

      expect(page.items.map((space) => space.id)).toEqual([first])
      expect(page.nextCursor).toBe(first)

      const read = decode(
        NamedSpace,
        await invokeJson(harness, "context_get_space", { spaceId: second }),
      )

      expect(read).toMatchObject({ id: second, name: "two" })
    })

    it("preserves protocol member names when a header value overlaps one", async () => {
      const harness = await makeHarness(api, {
        headers: { "x-factory-organization": "createdAt" },
      })

      await createSpace(harness, "structural")

      const page = decode(SpaceTimingPage, await invokeJson(harness, "context_list_spaces", {}))

      expect(page.items.length).toBeGreaterThan(0)
    })

    it("carries a short header value without corrupting the protocol shape", async () => {
      const harness = await makeHarness(api, {
        headers: { "x-factory-organization": "t" },
      })

      await createSpace(harness, "one")

      const page = decode(SpaceTimingPage, await invokeJson(harness, "context_list_spaces", {}))

      const request = api.requests.find(
        (recordedRequest) => recordedRequest.route === "POST /api/context/spaces",
      )

      expect(page.items.length).toBeGreaterThan(0)
      expect(request?.headers["x-factory-organization"]).toBe("t")
    })

    it("scrubs extension member names while preserving fixed protocol members", async () => {
      const extensionKey = "extension-" + TENANT

      api.route("GET /api/context/spaces", () => ({
        json: {
          items: [
            {
              id: contextUuid(810),
              name: "extension",
              accessScope: "organization",
              createdByPrincipalKind: "user",
              createdByPrincipalId: "principal",
              updatedByPrincipalKind: "user",
              updatedByPrincipalId: "principal",
              createdAt: "2026-11-27T00:00:00.000Z",
              updatedAt: "2026-11-27T00:00:00.000Z",
              [extensionKey]: "visible",
            },
          ],
        },
      }))

      const harness = await makeHarness(api)

      const page = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))(
        await invokeJson(harness, "context_list_spaces", {}),
      )

      const item = page.items[0]

      expect(item).toMatchObject({ id: contextUuid(810), createdAt: "2026-11-27T00:00:00.000Z" })
      expect(item).not.toHaveProperty(extensionKey)
      expect(JSON.stringify(item)).not.toContain(TENANT)
      expect(JSON.stringify(item)).toContain("[REDACTED]")
    })

    it("refuses a reply when a header value occupies an atomic identifier", async () => {
      api.route("GET /api/context/spaces", () => ({
        json: {
          items: [
            {
              id: "space-" + TENANT,
              name: "atomic",
              accessScope: "organization",
              createdByPrincipalKind: "user",
              createdByPrincipalId: "principal",
              updatedByPrincipalKind: "user",
              updatedByPrincipalId: "principal",
              createdAt: "2026-11-27T00:00:00.000Z",
              updatedAt: "2026-11-27T00:00:00.000Z",
            },
          ],
        },
      }))

      const harness = await makeHarness(api)
      const exit = await invoke(harness, "context_list_spaces", {})
      const error = expectFailure(exit)

      expect(error._tag).toBe("DisclosureRefused")
      expect(JSON.stringify(error)).not.toContain(TENANT)
    })

    it("protects each bearer actually sent when the credential getter rotates", async () => {
      const oldToken = "old-token-canary"
      const newToken = "new-token-canary"
      let reads = 0

      api.route("GET /api/context/spaces", (request) => ({
        json: {
          items: [
            {
              id: contextUuid(811),
              name: request.headers.authorization ?? "",
              accessScope: "organization",
              createdByPrincipalKind: "user",
              createdByPrincipalId: "principal",
              updatedByPrincipalKind: "user",
              updatedByPrincipalId: "principal",
              createdAt: "2026-11-27T00:00:00.000Z",
              updatedAt: "2026-11-27T00:00:00.000Z",
            },
          ],
        },
      }))

      const harness = await makeHarness(api, {
        token: () =>
          Effect.sync(() => {
            reads += 1

            return reads === 1 ? oldToken : newToken
          }),
      })

      const first = JSON.stringify(await invokeJson(harness, "context_list_spaces", {}))
      const second = JSON.stringify(await invokeJson(harness, "context_list_spaces", {}))

      expect(reads).toBe(2)

      for (const serialized of [first, second]) {
        expect(serialized).not.toContain(oldToken)
        expect(serialized).not.toContain(newToken)
        expect(serialized).toContain("Bearer [REDACTED]")
      }
    })

    it("protects the normalized bearer fetch places on the wire", async () => {
      const wireToken = "wire-token-canary"

      api.route("GET /api/context/spaces", (request) => ({
        json: {
          items: [
            {
              id: contextUuid(812),
              name: request.headers.authorization ?? "",
              accessScope: "organization",
              createdByPrincipalKind: "user",
              createdByPrincipalId: "principal",
              updatedByPrincipalKind: "user",
              updatedByPrincipalId: "principal",
              createdAt: "2026-11-27T00:00:00.000Z",
              updatedAt: "2026-11-27T00:00:00.000Z",
            },
          ],
        },
      }))

      const harness = await makeHarness(api, {
        token: () => Effect.succeed<string | undefined>(" \t" + wireToken + "\t\r\n"),
      })

      const serialized = JSON.stringify(await invokeJson(harness, "context_list_spaces", {}))

      const request = api.requests.find(
        (recordedRequest) => recordedRequest.route === "GET /api/context/spaces",
      )

      expect(request?.headers.authorization).toBe("Bearer " + wireToken)
      expect(serialized).not.toContain(wireToken)
      expect(serialized).toContain("Bearer [REDACTED]")
    })

    it("scrubs the bearer from a peer failure after the request was sent", async () => {
      const token = "failure-token-canary"

      api.route("GET /api/context/spaces", () => contextError(400, "echo " + token))

      const harness = await makeHarness(api, {
        token: () => Effect.succeed<string | undefined>(token),
      })

      const exit = await invoke(harness, "context_list_spaces", {})
      const error = expectFailure(exit)

      expect(error._tag).toBe("PeerFailure")
      expect(JSON.stringify(error)).not.toContain(token)
      expect(JSON.stringify(error)).toContain("[REDACTED]")
    })

    it("omits oversized peer detail whole instead of publishing a clipped secret fragment", async () => {
      const secret = ("oversized-secret-" + "0123456789").repeat(20)
      const prefix = secret.slice(0, 64)

      api.route("GET /api/context/spaces", () => contextError(400, secret))

      const harness = await makeHarness(api, {
        headers: { "x-factory-organization": secret },
      })

      const exit = await invoke(harness, "context_list_spaces", {})
      const error = expectFailure(exit)
      const serialized = JSON.stringify(error)

      expect(error._tag).toBe("PeerFailure")
      expect(serialized).not.toContain(prefix)
      expect(serialized).not.toContain("[REDACTED]")
    })

    it("passes peer detail to disclosure without trimming HTTP-preserved whitespace", async () => {
      const interior = "nbsp-tenant-secret-canary"
      const secret = "\u00a0" + interior + "\u00a0"

      api.route("GET /api/context/spaces", () => contextError(400, secret))

      const harness = await makeHarness(api, {
        headers: { "x-factory-organization": secret },
      })

      const exit = await invoke(harness, "context_list_spaces", {})
      const error = expectFailure(exit)
      const serialized = JSON.stringify(error)

      expect(error._tag).toBe("PeerFailure")
      expect(serialized).not.toContain(interior)
      expect(serialized).toContain("[REDACTED]")
    })

    it("normalizes operator headers and keeps transport-owned accept single", async () => {
      const harness = await makeHarness(api, {
        headers: {
          accept: "text/html",
          authorization: "x",
          "x-factory-organization": " " + TENANT + " ",
        },
      })

      await invokeJson(harness, "context_list_spaces", {})

      const request = api.requests.find(
        (recordedRequest) => recordedRequest.route === "GET /api/context/spaces",
      )

      expect(request?.headers.accept).toBe("application/json")
      expect(request?.headers.authorization).toBe("Bearer " + TOKEN)
      expect(request?.headers["x-factory-organization"]).toBe(TENANT)
    })

    it("creates, reads and lists documents by id and by path", async () => {
      const harness = await makeHarness(api)
      const spaceId = await createSpace(harness)
      const path = "plans/q3 roadmap?.md"
      const created = await createDocument(harness, spaceId, path, "ship it\n")

      expect(created.version).toBe("1")

      const byId = decode(
        BodyOnly,
        await invokeJson(harness, "context_get_document", {
          spaceId,
          documentId: created.id,
        }),
      )

      expect(byId.body).toBe("ship it\n")

      const byPath = decode(
        IdOnly,
        await invokeJson(harness, "context_get_document_by_path", { spaceId, path }),
      )

      expect(byPath.id).toBe(created.id)

      const listed = decode(
        DocumentList,
        await invokeJson(harness, "context_list_documents", {
          spaceId,
          kinds: ["text", "binary"],
        }),
      )

      expect(listed.items.map((item) => item.id)).toEqual([created.id])
    })

    it("updates strictly, merges a stale auto edit, and deletes only at the current version", async () => {
      const harness = await makeHarness(api)
      const spaceId = await createSpace(harness)
      const document = await createDocument(harness, spaceId, "notes.md", "a\nb\nc\n")

      const strict = decode(
        VersionedBody,
        await invokeJson(harness, "context_update_document", {
          spaceId,
          documentId: document.id,
          expectedVersion: "1",
          merge: "strict",
          body: "A\nb\nc\n",
        }),
      )

      expect(strict).toMatchObject({ version: "2", body: "A\nb\nc\n" })

      const merged = decode(
        VersionedBody,
        await invokeJson(harness, "context_update_document", {
          spaceId,
          documentId: document.id,
          expectedVersion: "1",
          body: "a\nb\nC\n",
        }),
      )

      expect(merged).toMatchObject({ version: "3", body: "A\nb\nC\n" })

      const deleted = decode(
        Retired,
        await invokeJson(harness, "context_delete_document", {
          spaceId,
          documentId: document.id,
          expectedVersion: "3",
        }),
      )

      expect(deleted.retiredAt).not.toBeNull()
    })

    it("keeps a version past 2^53 as an exact decimal string", async () => {
      const harness = await makeHarness(api)
      const spaceId = await createSpace(harness)
      const document = await createDocument(harness, spaceId, "big.md", "x")
      const stored = api.state.documents.get(document.id)

      if (stored === undefined) throw new Error("document not stored")

      stored.version = "9007199254740993"
      stored.revisions.set(stored.version, stored.body)

      const updated = decode(
        VersionOnly,
        await invokeJson(harness, "context_update_document", {
          spaceId,
          documentId: document.id,
          expectedVersion: "9007199254740993",
          merge: "strict",
          body: "y",
        }),
      )

      expect(updated.version).toBe("9007199254740994")
      expect(new TextDecoder().decode(api.requests.at(-1)?.body)).toContain(
        '"expectedVersion":"9007199254740993"',
      )
    })

    it("uploads a binary file in parts, commits it, and reads the exact bytes back", async () => {
      const harness = await makeHarness(api)
      const spaceId = await createSpace(harness)
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3])

      api.state.partSizeBytes = 4

      const upload = decode(
        Upload,
        await invokeJson(harness, "context_create_file", {
          spaceId,
          contentType: "image/png",
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      )

      const parts = [bytes.slice(0, 4), bytes.slice(4, 8), bytes.slice(8)]

      for (const [partIndex, part] of parts.entries()) {
        const uploaded = await invokeJson(harness, "context_upload_file_part", {
          spaceId,
          fileId: upload.fileId,
          partIndex,
          contentBase64: base64(part),
        })

        expect(uploaded).toEqual({ ok: true, partIndex, sizeBytes: part.byteLength })
      }

      const committed = decode(
        FileHolder,
        await invokeJson(harness, "context_create_document", {
          spaceId,
          path: "logo.png",
          fileId: upload.fileId,
        }),
      )

      expect(committed.file?.fileId).toBe(upload.fileId)

      const read: Array<Uint8Array> = []

      for (let partIndex = 0; partIndex < upload.partCount; partIndex++) {
        const media = mediaOf(
          await invoke(harness, "context_read_file_part", {
            spaceId,
            fileId: upload.fileId,
            partIndex,
          }),
        )

        read.push(media.bytes)
      }

      expect(new Uint8Array(Buffer.concat(read))).toEqual(bytes)
    })

    it("cancels a pending upload with context_delete_file", async () => {
      const harness = await makeHarness(api)
      const spaceId = await createSpace(harness)
      const bytes = new Uint8Array([1, 2, 3, 4])

      const upload = decode(
        Upload,
        await invokeJson(harness, "context_create_file", {
          spaceId,
          contentType: "application/pdf",
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      )

      expect(
        await invokeJson(harness, "context_delete_file", { spaceId, fileId: upload.fileId }),
      ).toEqual({ ok: true })
      expect(api.state.files.has(upload.fileId)).toBe(false)
    })

    it("registers sessions, appends ordered records, accepts an identical retry, and pages reads", async () => {
      const harness = await makeHarness(api)
      const spaceId = await createSpace(harness)
      const sessionId = contextUuid(910)
      const batch = '{"n":1}\n{"n":2}\n{"n":3}\n'

      const registered = decode(
        Registered,
        await invokeJson(harness, "context_register_session", { spaceId, sessionId }),
      )

      expect(registered).toMatchObject({ sessionId, lastSequence: "0" })

      const append = { spaceId, sessionId, startSequence: "1", contentJsonl: batch }

      expect(await invokeJson(harness, "context_append_session", append)).toEqual({
        lastSequence: "3",
        acceptedThroughSequence: "3",
        appendedRecords: 3,
      })

      // An identical retry is a no-op, not a conflict.
      expect(await invokeJson(harness, "context_append_session", append)).toEqual({
        lastSequence: "3",
        acceptedThroughSequence: "3",
        appendedRecords: 0,
      })

      const firstRecords = recordsOf(
        await invoke(harness, "context_read_session_records", { spaceId, sessionId, limit: 2 }),
      )

      // The released records are decoded JSON values, not raw JSONL text.
      expect(firstRecords).toEqual([{ n: 1 }, { n: 2 }])

      const rest = recordsOf(
        await invoke(harness, "context_read_session_records", {
          spaceId,
          sessionId,
          afterSequence: "2",
        }),
      )

      expect(rest).toEqual([{ n: 3 }])
    })

    it("lists stored sessions filtered by parent", async () => {
      const harness = await makeHarness(api)
      const spaceId = await createSpace(harness)
      const parent = contextUuid(900)
      const child = contextUuid(901)

      await invokeJson(harness, "context_register_session", { spaceId, sessionId: parent })
      await invokeJson(harness, "context_register_session", {
        spaceId,
        sessionId: child,
        parentSessionId: parent,
      })

      const roots = decode(
        SessionList,
        await invokeJson(harness, "context_list_sessions", { spaceId, parentSessionId: "root" }),
      )

      expect(roots.items.map((item) => item.sessionId)).toEqual([parent])

      const children = decode(
        SessionList,
        await invokeJson(harness, "context_list_sessions", {
          spaceId,
          parentSessionId: parent,
        }),
      )

      expect(children.items.map((item) => item.sessionId)).toEqual([child])

      const read = decode(
        SessionRead,
        await invokeJson(harness, "context_get_session", { spaceId, sessionId: child }),
      )

      expect(read.parentSessionId).toBe(parent)
    })
  })

  describe("conflict handling", () => {
    it("HTTP 409 returns OperationConflict retaining currentVersion, and never retries", async () => {
      const harness = await makeHarness(api)

      const space = decode(
        IdOnly,
        await invokeJson(harness, "context_create_space", {
          name: "notes",
          accessScope: "organization",
        }),
      )

      const created = decode(
        Created,
        await invokeJson(harness, "context_create_document", {
          spaceId: space.id,
          path: "notes.md",
          body: "v1",
        }),
      )

      const before = api.requests.length

      const exit = await invoke(harness, "context_update_document", {
        spaceId: space.id,
        documentId: created.id,
        expectedVersion: "99",
        merge: "strict",
        body: "stale",
      })

      const error = expectFailure(exit)

      expect(error).toBeInstanceOf(OperationConflict)

      if (error instanceof OperationConflict) {
        expect(error.currentVersion).toBe("1")
      }

      // Exactly one request: no silent retry of a conditional write.
      expect(api.requests.length).toBe(before + 1)
    })

    it("strips conflict continuations echoed as a configured header secret", async () => {
      const harness = await makeHarness(api)

      const space = decode(
        IdOnly,
        await invokeJson(harness, "context_create_space", {
          name: "notes",
          accessScope: "organization",
        }),
      )

      const created = decode(
        Created,
        await invokeJson(harness, "context_create_document", {
          spaceId: space.id,
          path: "notes.md",
          body: "v1",
        }),
      )

      api.failNext(
        "PUT /api/context/spaces/{spaceId}/documents/{documentId}",
        contextError(409, "conflicted", { currentVersion: TENANT, currentSequence: "7" }),
      )

      const exit = await invoke(harness, "context_update_document", {
        spaceId: space.id,
        documentId: created.id,
        expectedVersion: "99",
        merge: "strict",
        body: "stale",
      })

      const error = expectFailure(exit)

      expect(error).toBeInstanceOf(OperationConflict)

      if (error instanceof OperationConflict) {
        expect(error.message).toBe("operation failure")
        expect(error.currentVersion).toBeUndefined()
        expect(error.currentSequence).toBeUndefined()
        expect(JSON.stringify(error)).not.toContain(TENANT)
      }
    })

    it("a sequence gap conflict retains currentSequence", async () => {
      const harness = await makeHarness(api)

      const space = decode(
        IdOnly,
        await invokeJson(harness, "context_create_space", {
          name: "notes",
          accessScope: "organization",
        }),
      )

      const sessionId = contextUuid(920)

      await invokeJson(harness, "context_register_session", { spaceId: space.id, sessionId })
      await invokeJson(harness, "context_append_session", {
        spaceId: space.id,
        sessionId,
        startSequence: "1",
        contentJsonl: '{"n":1}\n',
      })

      const exit = await invoke(harness, "context_append_session", {
        spaceId: space.id,
        sessionId,
        startSequence: "5",
        contentJsonl: '{"n":5}\n',
      })

      const error = expectFailure(exit)

      expect(error).toBeInstanceOf(OperationConflict)

      if (error instanceof OperationConflict) {
        expect(error.currentSequence).toBe("1")
      }
    })
  })

  describe("malformed replies", () => {
    it("a malformed upstream reply fails with MalformedPeerReply, distinct from conflict", async () => {
      api.failNext("GET /api/context/spaces", { json: { items: "nope" } })

      const harness = await makeHarness(api)
      const exit = await invoke(harness, "context_list_spaces", {})
      const error = expectFailure(exit)

      expect(error._tag).toBe("MalformedPeerReply")
      expect(error._tag).not.toBe("OperationConflict")
    })

    it("a non-JSON upstream reply fails with MalformedPeerReply", async () => {
      api.route("GET /api/context/spaces", () => ({
        bytes: new TextEncoder().encode("<html>not json</html>"),
      }))

      const harness = await makeHarness(api)
      const exit = await invoke(harness, "context_list_spaces", {})

      expect(expectFailure(exit)._tag).toBe("MalformedPeerReply")
    })
  })

  describe("protected bytes", () => {
    it("a file part containing a protected value triggers a ProtectedBytes refusal", async () => {
      const harness = await makeHarness(api)

      const space = decode(
        IdOnly,
        await invokeJson(harness, "context_create_space", {
          name: "notes",
          accessScope: "organization",
        }),
      )

      const bytes = new TextEncoder().encode("PNG " + TENANT)

      const upload = decode(
        Upload,
        await invokeJson(harness, "context_create_file", {
          spaceId: space.id,
          contentType: "image/png",
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      )

      await invokeJson(harness, "context_upload_file_part", {
        spaceId: space.id,
        fileId: upload.fileId,
        partIndex: 0,
        contentBase64: base64(bytes),
      })
      await invokeJson(harness, "context_create_document", {
        spaceId: space.id,
        path: "leak.png",
        fileId: upload.fileId,
      })

      const exit = await invoke(harness, "context_read_file_part", {
        spaceId: space.id,
        fileId: upload.fileId,
        partIndex: 0,
      })

      const error = expectFailure(exit)

      expect(error._tag).toBe("ProtectedBytes")
    })

    it("a file part containing Latin-1 header bytes triggers a ProtectedBytes refusal", async () => {
      const secret = "latin-é-wire-secret"

      const harness = await makeHarness(api, {
        headers: { "x-factory-organization": secret },
      })

      const space = decode(
        IdOnly,
        await invokeJson(harness, "context_create_space", {
          name: "notes",
          accessScope: "organization",
        }),
      )

      const bytes = Uint8Array.from([...secret].map((character) => character.charCodeAt(0)))

      const upload = decode(
        Upload,
        await invokeJson(harness, "context_create_file", {
          spaceId: space.id,
          contentType: "application/pdf",
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      )

      await invokeJson(harness, "context_upload_file_part", {
        spaceId: space.id,
        fileId: upload.fileId,
        partIndex: 0,
        contentBase64: base64(bytes),
      })
      await invokeJson(harness, "context_create_document", {
        spaceId: space.id,
        path: "latin1.pdf",
        fileId: upload.fileId,
      })

      const exit = await invoke(harness, "context_read_file_part", {
        spaceId: space.id,
        fileId: upload.fileId,
        partIndex: 0,
      })

      expect(expectFailure(exit)._tag).toBe("ProtectedBytes")
    })
  })

  describe("input validation", () => {
    it("rejects path traversal and malformed ids with InvalidInput before any request", async () => {
      const harness = await makeHarness(api)
      const before = api.requests.length

      const traversal = await invoke(harness, "context_get_space", { spaceId: ".." })

      expect(expectFailure(traversal)._tag).toBe("InvalidInput")

      const dot = await invoke(harness, "context_get_space", { spaceId: "." })

      expect(expectFailure(dot)._tag).toBe("InvalidInput")

      const blank = await invoke(harness, "context_get_space", { spaceId: "" })

      expect(expectFailure(blank)._tag).toBe("InvalidInput")

      const surrogate = await invoke(harness, "context_get_space", { spaceId: "\ud800" })

      expect(expectFailure(surrogate)._tag).toBe("InvalidInput")

      const badVersion = await invoke(harness, "context_update_document", {
        spaceId: contextUuid(1),
        documentId: contextUuid(2),
        expectedVersion: "9223372036854775808",
        body: "x",
      })

      expect(expectFailure(badVersion)._tag).toBe("InvalidInput")

      const bothContents = await invoke(harness, "context_create_document", {
        spaceId: contextUuid(1),
        path: "a.md",
        body: "x",
        fileId: contextUuid(2),
      })

      expect(expectFailure(bothContents)._tag).toBe("InvalidInput")

      const badBase64 = await invoke(harness, "context_upload_file_part", {
        spaceId: contextUuid(1),
        fileId: contextUuid(2),
        partIndex: 0,
        contentBase64: "not base64!",
      })

      expect(expectFailure(badBase64)._tag).toBe("InvalidInput")

      const badJsonl = await invoke(harness, "context_append_session", {
        spaceId: contextUuid(1),
        sessionId: contextUuid(2),
        startSequence: "1",
        contentJsonl: "[1]\n",
      })

      expect(expectFailure(badJsonl)._tag).toBe("InvalidInput")

      // Nothing reached the server.
      expect(api.requests.length).toBe(before)
    })
  })

  describe("gates", () => {
    it("an invocation rejected at the gates never reaches the HTTP server", async () => {
      const harness = await makeHarness(api, { allowedTargets: ["local"] })
      const before = api.requests.length

      // Reads and writes alike are rejected at the delegation gate: the target
      // kind "context" is not delegable in this assembly.
      for (const [id, input] of [
        ["context_list_spaces", {}],
        ["context_create_space", { name: "x", accessScope: "members" }],
        ["context_delete_file", { spaceId: contextUuid(1), fileId: contextUuid(2) }],
      ] as const) {
        const exit = await invoke(harness, id, input)

        expect(expectFailure(exit)._tag).toBe("OperationNotVisible")
      }

      expect(api.requests.length).toBe(before)
    })
  })

  describe("scrubbing", () => {
    it("installation header values in a successful response are scrubbed through disclosure", async () => {
      const harness = await makeHarness(api)

      const space = decode(
        IdOnly,
        await invokeJson(harness, "context_create_space", {
          name: "notes",
          accessScope: "organization",
        }),
      )

      const created = decode(
        Created,
        await invokeJson(harness, "context_create_document", {
          spaceId: space.id,
          path: "leak.md",
          body: "tenant " + TENANT,
        }),
      )

      const read = await invokeJson(harness, "context_get_document", {
        spaceId: space.id,
        documentId: created.id,
      })

      expect(JSON.stringify(read)).not.toContain(TENANT)
      expect(read).toMatchObject({ body: "tenant [REDACTED]" })
    })

    it("still scrubs stored record member names containing a header value", async () => {
      const secret = "record-key-secret"

      const harness = await makeHarness(api, {
        headers: { "x-factory-organization": secret },
      })

      const space = decode(
        IdOnly,
        await invokeJson(harness, "context_create_space", {
          name: "records",
          accessScope: "organization",
        }),
      )

      const spaceId = space.id
      const sessionId = contextUuid(930)

      await invokeJson(harness, "context_register_session", { spaceId, sessionId })
      await invokeJson(harness, "context_append_session", {
        spaceId,
        sessionId,
        startSequence: "1",
        contentJsonl: '{"field record-key-secret":1}\n',
      })

      const records = recordsOf(
        await invoke(harness, "context_read_session_records", { spaceId, sessionId }),
      )

      expect(records).toEqual([{ "field [REDACTED]": 1 }])
    })

    it("installation header values inside a peer rejection detail are scrubbed before surfacing", async () => {
      api.failNext(
        "GET /api/context/spaces",
        contextError(403, "denied for tenant " + TENANT + " with token " + TOKEN),
      )

      const harness = await makeHarness(api)
      const exit = await invoke(harness, "context_list_spaces", {})
      const error = expectFailure(exit)

      expect(error._tag).toBe("PeerFailure")
      expect(JSON.stringify(error)).not.toContain(TENANT)
      expect(JSON.stringify(error)).not.toContain(TOKEN)
    })
  })

  describe("delivery certainty", () => {
    it("a redirect is refused without following it", async () => {
      api.failNext("GET /api/context/spaces", {
        status: 307,
        headers: { location: "http://127.0.0.1:1/api/context/spaces" },
      })

      const harness = await makeHarness(api)
      const exit = await invoke(harness, "context_list_spaces", {})

      expect(expectFailure(exit)._tag).toBe("DeliveryUncertain")
    })

    it("a timeout after request handoff is DeliveryUncertain, never retried", async () => {
      api.route(
        "GET /api/context/spaces",
        () => new Promise((resolve) => setTimeout(() => resolve({ json: { items: [] } }), 2_000)),
      )

      const harness = await makeHarness(api, { timeoutMs: 100 })
      const before = api.requests.length
      const exit = await invoke(harness, "context_list_spaces", {})

      expect(expectFailure(exit)._tag).toBe("DeliveryUncertain")
      expect(api.requests.length).toBe(before + 1)
    })

    it("upstream 404 maps to TargetUnavailable", async () => {
      const harness = await makeHarness(api)
      const exit = await invoke(harness, "context_get_space", { spaceId: contextUuid(77) })

      expect(expectFailure(exit)._tag).toBe("TargetUnavailable")
    })

    it("upstream 403 maps to PeerFailure", async () => {
      api.failNext("GET /api/context/spaces", contextError(403, "denied"))

      const harness = await makeHarness(api)
      const exit = await invoke(harness, "context_list_spaces", {})

      expect(expectFailure(exit)._tag).toBe("PeerFailure")
    })
  })
})
