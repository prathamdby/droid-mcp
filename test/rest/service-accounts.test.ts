import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { KEY_NOTICE } from "../../src/tools/rest-service-accounts.ts"
import { testConfig } from "../support/config.ts"
import {
  SEED_API_KEY,
  SEED_SERVICE_ACCOUNT,
  startFakeFactoryApi,
} from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const FACTORY_KEY = "factory-sa-key"

const SERVICE_ACCOUNT_TOOLS = [
  "rest_list_service_accounts",
  "rest_create_service_account",
  "rest_get_service_account",
  "rest_update_service_account",
  "rest_delete_service_account",
  "rest_list_service_account_api_keys",
  "rest_create_service_account_api_key",
  "rest_rotate_service_account_api_key",
  "rest_revoke_service_account_api_key",
]

const DESTRUCTIVE = "Destructive; confirm before calling."

const EXPIRES_AT = 1_900_000_000_000

const KEYS = "/api/v0/service-accounts/sa-1/api-keys"

const MintedKey = Schema.Struct({
  apiKey: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    fingerprint: Schema.String,
    value: Schema.optional(Schema.String),
  }),
  notice: Schema.String,
})

describe("rest service account tools over MCP", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: FACTORY_KEY, factoryBaseUrl: api.baseUrl }),
    })
  })

  beforeEach(() => {
    api.reset()
  })

  afterAll(async () => {
    await client.dispose()
    await api.close()
  })

  const bodyOf = (): Json =>
    Schema.decodeUnknownSync(Schema.Json)(JSON.parse(api.last()?.body ?? "null"))

  it("lists all nine tools and warns on deletion and every key mutation", async () => {
    const byName = new Map((await client.list()).map((tool) => [tool.name, tool]))

    for (const name of SERVICE_ACCOUNT_TOOLS) expect(byName.has(name)).toBe(true)

    for (const name of [
      "rest_delete_service_account",
      "rest_create_service_account_api_key",
      "rest_rotate_service_account_api_key",
      "rest_revoke_service_account_api_key",
    ]) {
      expect(byName.get(name)?.description).toContain(DESTRUCTIVE)
    }
  })

  it("lists, creates, reads, updates, and deletes a service account", async () => {
    expect(await client.ok("rest_list_service_accounts")).toEqual({
      serviceAccounts: [SEED_SERVICE_ACCOUNT],
    })

    const body = { name: "deploy-bot", status: "active", description: "Deploys main" }

    const created = await client.ok("rest_create_service_account", { body })

    expect(created).toMatchObject({ serviceAccount: { id: "sa-2", ...body } })
    expect(api.last()?.method).toBe("POST")
    expect(bodyOf()).toEqual(body)

    expect(await client.fail("rest_create_service_account", { body })).toEqual({
      code: "rest_rejected",
      message:
        "createServiceAccount was rejected (HTTP 409): service account deploy-bot already exists",
    })

    expect(await client.ok("rest_get_service_account", { serviceAccountId: "sa-2" })).toEqual(
      created,
    )
    expect(api.last()?.path).toBe("/api/v0/service-accounts/sa-2")

    const updated = await client.ok("rest_update_service_account", {
      serviceAccountId: "sa-2",
      body: { status: "inactive", description: "Paused" },
    })

    expect(updated).toMatchObject({
      serviceAccount: { id: "sa-2", status: "inactive", description: "Paused" },
    })
    expect(api.last()?.method).toBe("PATCH")
    expect(bodyOf()).toEqual({ status: "inactive", description: "Paused" })

    expect(await client.ok("rest_delete_service_account", { serviceAccountId: "sa-2" })).toEqual({
      id: "sa-2",
      deleted: true,
    })
    expect(api.last()?.method).toBe("DELETE")

    expect(await client.fail("rest_get_service_account", { serviceAccountId: "sa-2" })).toEqual({
      code: "rest_rejected",
      message: "getServiceAccount was rejected (HTTP 404): service account not found",
    })
  })

  it("requires name and an active or inactive status before I/O", async () => {
    const invalid: ReadonlyArray<Json> = [
      { name: "x" },
      { status: "active" },
      { name: "", status: "active" },
      { name: "x", status: "deleted" },
    ]

    for (const body of invalid) {
      const outcome = await client.call("rest_create_service_account", { body })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(0)
  })

  it("lists key metadata without values", async () => {
    expect(
      await client.ok("rest_list_service_account_api_keys", { serviceAccountId: "sa-1" }),
    ).toEqual({ apiKeys: [SEED_API_KEY] })
    expect(api.last()?.path).toBe(KEYS)
  })

  it("mints a key, drops its one-time value, and says so", async () => {
    const outcome = await client.call("rest_create_service_account_api_key", {
      serviceAccountId: "sa-1",
      body: { name: "deploy", expiresAt: EXPIRES_AT },
    })

    const minted = api.state.mintedKeyValues[0] ?? ""
    const result = Schema.decodeUnknownSync(MintedKey)(outcome.structured)

    expect(minted.length).toBeGreaterThan(0)
    expect(result.apiKey.value).toBeUndefined()
    expect(result.apiKey).toMatchObject({ name: "deploy", fingerprint: "…" + minted.slice(-4) })
    expect(result.notice).toBe(KEY_NOTICE)
    expect(result.notice).toBe(
      "The one-time key value was not exposed and cannot be recovered through this tool.",
    )
    expect(outcome.text).not.toContain(minted)
    expect(JSON.stringify(outcome.structured)).not.toContain(minted)
    expect(api.last()?.path).toBe(KEYS)
    expect(bodyOf()).toEqual({ name: "deploy", expiresAt: EXPIRES_AT })

    const listed = await client.ok("rest_list_service_account_api_keys", {
      serviceAccountId: "sa-1",
    })

    expect(listed).toMatchObject({
      apiKeys: [SEED_API_KEY, { id: result.apiKey.id, expiresAt: EXPIRES_AT, isRevoked: false }],
    })
  })

  it("requires a key name before I/O", async () => {
    const outcome = await client.call("rest_create_service_account_api_key", {
      serviceAccountId: "sa-1",
      body: { expiresAt: EXPIRES_AT },
    })

    expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)
  })

  it("rotates a key with expiry and grace on the wire and drops the new value", async () => {
    const outcome = await client.call("rest_rotate_service_account_api_key", {
      serviceAccountId: "sa-1",
      keyId: "key-1",
      body: { expiresAt: EXPIRES_AT, gracePeriodMinutes: 5 },
    })

    const minted = api.state.mintedKeyValues[0] ?? ""
    const result = Schema.decodeUnknownSync(MintedKey)(outcome.structured)

    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe(KEYS + "/key-1/rotate")
    expect(bodyOf()).toEqual({ expiresAt: EXPIRES_AT, gracePeriodMinutes: 5 })
    expect(result.apiKey.value).toBeUndefined()
    expect(result.apiKey.id).not.toBe("key-1")
    expect(result.notice).toBe(KEY_NOTICE)
    expect(outcome.text).not.toContain(minted)
    expect(api.state.apiKeys.get("key-1")?.isRevoked).toBe(false)

    await client.ok("rest_rotate_service_account_api_key", {
      serviceAccountId: "sa-1",
      keyId: result.apiKey.id,
    })

    expect(api.last()?.body).toBe("")
    expect(api.state.apiKeys.get(result.apiKey.id)?.isRevoked).toBe(true)
  })

  it("rejects a grace period outside 0–10 minutes before I/O", async () => {
    for (const gracePeriodMinutes of [-1, 11, 2.5]) {
      const outcome = await client.call("rest_rotate_service_account_api_key", {
        serviceAccountId: "sa-1",
        keyId: "key-1",
        body: { gracePeriodMinutes },
      })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(0)
  })

  it("scrubs the configured key from a rotation error that repeats it", async () => {
    api.failNext("POST /api/v0/service-accounts/{serviceAccountId}/api-keys/{keyId}/rotate", 400, {
      detail: "caller " + FACTORY_KEY + " may not rotate key-1",
    })

    const failure = await client.fail("rest_rotate_service_account_api_key", {
      serviceAccountId: "sa-1",
      keyId: "key-1",
    })

    expect(failure).toEqual({
      code: "rest_rejected",
      message:
        "rotateServiceAccountApiKey was rejected (HTTP 400): caller [redacted] may not rotate key-1",
    })
  })

  it("revokes a key once, then reports the repeat as rest_rejected", async () => {
    expect(
      await client.ok("rest_revoke_service_account_api_key", {
        serviceAccountId: "sa-1",
        keyId: "key-1",
      }),
    ).toEqual({ ok: true })
    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe(KEYS + "/key-1/revoke")
    expect(api.last()?.body).toBe("")
    expect(api.state.apiKeys.get("key-1")?.isRevoked).toBe(true)

    expect(
      await client.fail("rest_revoke_service_account_api_key", {
        serviceAccountId: "sa-1",
        keyId: "key-1",
      }),
    ).toEqual({
      code: "rest_rejected",
      message: "revokeServiceAccountApiKey was rejected (HTTP 404): API key not found",
    })
    expect(api.requests).toHaveLength(2)
  })
})
