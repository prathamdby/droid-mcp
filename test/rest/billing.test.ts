import { describe, afterAll, beforeAll, beforeEach, expect, it } from "vitest"

import { policyOf } from "../../src/tools/policy.ts"
import { testConfig } from "../support/config.ts"
import { SEED_BILLING_LIMITS, startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const BILLING_TOOLS = ["rest_get_billing_limits", "rest_set_billing_overage_preference"] as const

describe("rest billing /limits tools over MCP", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: "factory-billing-key", factoryBaseUrl: api.baseUrl }),
    })
  })

  beforeEach(() => {
    api.reset()
  })

  afterAll(async () => {
    await client.dispose()
    await api.close()
  })

  it("lists both billing tools with read-only and non-destructive idempotent hints", async () => {
    const byName = new Map((await client.list()).map((tool) => [tool.name, tool]))

    for (const name of BILLING_TOOLS) expect(byName.has(name)).toBe(true)

    const getDesc = byName.get("rest_get_billing_limits")?.description ?? ""
    const setDesc = byName.get("rest_set_billing_overage_preference")?.description ?? ""

    expect(getDesc).toContain("/limits")
    expect(setDesc).toContain("/limits")

    expect(policyOf("rest_get_billing_limits", getDesc)).toEqual({
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    })
    expect(policyOf("rest_set_billing_overage_preference", setDesc)).toEqual({
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    })
  })

  it("reads /api/billing/limits with Standard and Droid Core windows", async () => {
    const result = await client.ok("rest_get_billing_limits")

    expect(api.last()?.method).toBe("GET")
    expect(api.last()?.path).toBe("/api/billing/limits")
    expect(api.last()?.headers.authorization).toBe("Bearer factory-billing-key")
    expect(result).toEqual({
      usesTokenRateLimitsBilling: true,
      hasActiveSubscription: true,
      limits: SEED_BILLING_LIMITS,
      overagePreference: "droidCore",
      canManageOverage: true,
      extraUsageBalanceCents: 0,
      extraUsageAllowed: true,
    })
  })

  it("updates overagePreference on /api/organization/subscription/set-overage-preference", async () => {
    const updated = await client.ok("rest_set_billing_overage_preference", {
      body: { overagePreference: "extraUsage" },
    })

    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe("/api/organization/subscription/set-overage-preference")
    expect(JSON.parse(api.last()?.body ?? "null")).toEqual({ overagePreference: "extraUsage" })
    expect(updated).toEqual({ ok: true, overagePreference: "extraUsage" })

    expect(await client.ok("rest_get_billing_limits")).toMatchObject({
      overagePreference: "extraUsage",
    })
  })

  it("accepts an empty 200 acknowledgement when setting overagePreference", async () => {
    api.route("POST /api/organization/subscription/set-overage-preference", () => ({
      status: 200,
    }))

    expect(
      await client.ok("rest_set_billing_overage_preference", {
        body: { overagePreference: "droidCore" },
      }),
    ).toEqual({ ok: true })
  })

  it("rejects missing or invalid overagePreference before sending a request", async () => {
    const badBodies: ReadonlyArray<Json> = [
      {},
      { body: {} },
      { body: { overagePreference: "invalid" } },
      { body: { overagePreference: null } },
    ]

    for (const args of badBodies) {
      const outcome = await client.call("rest_set_billing_overage_preference", args)

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(0)
  })

  it("maps a 403 when canManageOverage is false to rest_rejected", async () => {
    api.state.canManageOverage = false

    const failure = await client.fail("rest_set_billing_overage_preference", {
      body: { overagePreference: "extraUsage" },
    })

    expect(failure.code).toBe("rest_rejected")
    expect(failure.message).toContain("403")
  })
})
