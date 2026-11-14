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
    expect(api.last()?.headers.authorization).toBe("Bearer factory-billing-key")
    expect(api.last()?.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(api.last()?.body ?? "null")).toEqual({ overagePreference: "extraUsage" })
    expect(updated).toEqual({ ok: true, overagePreference: "extraUsage" })

    expect(await client.ok("rest_get_billing_limits")).toMatchObject({
      overagePreference: "extraUsage",
    })

    const reverted = await client.ok("rest_set_billing_overage_preference", {
      body: { overagePreference: "droidCore" },
    })

    expect(api.last()?.headers.authorization).toBe("Bearer factory-billing-key")
    expect(JSON.parse(api.last()?.body ?? "null")).toEqual({ overagePreference: "droidCore" })
    expect(reverted).toEqual({ ok: true, overagePreference: "droidCore" })
    expect(await client.ok("rest_get_billing_limits")).toMatchObject({
      overagePreference: "droidCore",
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
    expect(api.last()?.headers.authorization).toBe("Bearer factory-billing-key")
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
    expect(api.state.overagePreference).toBe("droidCore")
  })

  it("maps a 403 when canManageOverage is false to rest_rejected and keeps the prior preference", async () => {
    api.state.canManageOverage = false

    const failure = await client.fail("rest_set_billing_overage_preference", {
      body: { overagePreference: "extraUsage" },
    })

    expect(api.last()?.headers.authorization).toBe("Bearer factory-billing-key")
    expect(failure.code).toBe("rest_rejected")
    expect(failure.message).toContain("403")
    expect(api.state.overagePreference).toBe("droidCore")
    expect(await client.ok("rest_get_billing_limits")).toMatchObject({
      overagePreference: "droidCore",
      canManageOverage: false,
    })
  })

  it("fails with factory_api_key_missing before I/O when FACTORY_API_KEY is unset", async () => {
    const keyless = await connect({
      config: testConfig({ factoryApiKey: undefined, factoryBaseUrl: api.baseUrl }),
    })

    try {
      expect((await keyless.fail("rest_get_billing_limits")).code).toBe("factory_api_key_missing")
      expect(
        (
          await keyless.fail("rest_set_billing_overage_preference", {
            body: { overagePreference: "extraUsage" },
          })
        ).code,
      ).toBe("factory_api_key_missing")
      expect(api.requests).toHaveLength(0)
      expect(api.state.overagePreference).toBe("droidCore")
    } finally {
      await keyless.dispose()
    }
  })
})
