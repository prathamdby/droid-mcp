import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import {
  PR_AGENT_ID,
  SEED_ENVIRONMENT,
  SEED_OTHER_ENVIRONMENT,
  startFakeFactoryApi,
} from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const ENVIRONMENT_TOOLS = [
  "rest_list_environments",
  "rest_create_environment",
  "rest_get_environment",
  "rest_update_environment",
  "rest_delete_environment",
  "rest_ensure_default_environment",
  "rest_set_default_environment",
  "rest_list_environment_sources",
  "rest_list_environment_build_statuses",
  "rest_get_environment_build_diagnostics",
  "rest_get_environment_build_attempt_diagnostics",
  "rest_retry_environment_build",
  "rest_cancel_environment_build",
]

const WARNED = [
  "rest_delete_environment",
  "rest_set_default_environment",
  "rest_cancel_environment_build",
]

const Started = Schema.Struct({ id: Schema.String, buildId: Schema.String })

describe("rest Environment tools over MCP", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: "factory-env-key", factoryBaseUrl: api.baseUrl }),
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

  it("lists all thirteen tools and warns on the destructive ones", async () => {
    const byName = new Map((await client.list()).map((tool) => [tool.name, tool]))

    for (const name of ENVIRONMENT_TOOLS) expect(byName.has(name)).toBe(true)

    for (const name of WARNED) {
      expect(byName.get(name)?.description).toContain("Destructive; confirm before calling.")
    }
  })

  it("lists Environments with a service-account scope", async () => {
    const listed = await client.ok("rest_list_environments", { serviceAccountId: "sa-1" })

    expect(listed).toEqual({
      environments: [SEED_ENVIRONMENT, SEED_OTHER_ENVIRONMENT],
      defaultEnvironmentId: PR_AGENT_ID,
      hiddenOrganizationEnvironmentCount: 0,
    })
    expect(api.last()?.path).toBe("/api/v0/environments")
    expect(api.last()?.query).toBe("serviceAccountId=sa-1")
  })

  it("creates an Environment and keeps extra body members", async () => {
    const body = {
      name: "api",
      repositories: [{ url: "https://github.com/acme/api", script: "" }],
      scope: "organization",
      setupScript: "make deps",
      futureFlag: true,
    }

    const created = Schema.decodeUnknownSync(Started)(
      await client.ok("rest_create_environment", { body }),
    )

    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe("/api/v0/environments")
    expect(bodyOf()).toEqual(body)
    expect(api.state.environments.get(created.id)).toMatchObject({ name: "api" })
    expect(api.state.builds.get(created.buildId)).toMatchObject({ status: "building" })
  })

  it("requires name and repositories before I/O", async () => {
    const bodies: ReadonlyArray<Json> = [
      { name: "x" },
      { repositories: [] },
      { name: "", repositories: [] },
    ]

    for (const body of bodies) {
      const outcome = await client.call("rest_create_environment", { body })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(0)
  })

  it("reads one Environment and rejects an unknown id", async () => {
    expect(await client.ok("rest_get_environment", { environmentId: PR_AGENT_ID })).toEqual(
      SEED_ENVIRONMENT,
    )
    expect(api.last()?.path).toBe("/api/v0/environments/" + PR_AGENT_ID)

    expect(await client.fail("rest_get_environment", { environmentId: "e-x" })).toEqual({
      code: "rest_rejected",
      message: "getEnvironment was rejected (HTTP 404): environment not found",
    })
  })

  it("updates an Environment with PATCH and starts a new build", async () => {
    const updated = Schema.decodeUnknownSync(Started)(
      await client.ok("rest_update_environment", {
        environmentId: PR_AGENT_ID,
        body: { setupScript: "pnpm install --frozen-lockfile" },
      }),
    )

    expect(api.last()?.method).toBe("PATCH")
    expect(bodyOf()).toEqual({ setupScript: "pnpm install --frozen-lockfile" })
    expect(updated.id).toBe(PR_AGENT_ID)
    expect(updated.buildId).not.toBe("build-2")
  })

  it("clears a setup script with null on update only", async () => {
    await client.ok("rest_update_environment", {
      environmentId: PR_AGENT_ID,
      body: { setupScript: null },
    })

    expect(bodyOf()).toEqual({ setupScript: null })

    const create = await client.call("rest_create_environment", {
      body: { name: "x", repositories: [], setupScript: null },
    })

    expect(create.rpcError ?? create.isError).toBeTruthy()
    expect(api.requests).toHaveLength(1)
  })

  it("deletes an Environment and reports a delete conflict as a failure", async () => {
    expect(await client.ok("rest_delete_environment", { environmentId: "e-docs" })).toEqual({
      ok: true,
    })
    expect(api.last()?.method).toBe("DELETE")
    expect(api.state.environments.has("e-docs")).toBe(false)

    expect(await client.fail("rest_delete_environment", { environmentId: PR_AGENT_ID })).toEqual({
      code: "rest_rejected",
      message:
        "deleteEnvironment was rejected (HTTP 409): the default Environment cannot be deleted",
    })
    expect(api.state.environments.has(PR_AGENT_ID)).toBe(true)
  })

  it("ensures the default Environment with POST, repeatably", async () => {
    api.state.defaultEnvironmentId = undefined

    expect(await client.ok("rest_ensure_default_environment")).toEqual({ ok: true })

    const created = api.state.defaultEnvironmentId

    expect(created).toBeDefined()
    expect(await client.ok("rest_ensure_default_environment")).toEqual({ ok: true })
    expect(api.state.defaultEnvironmentId).toBe(created)
    expect(api.requests.map((request) => request.method + " " + request.path)).toEqual([
      "POST /api/v0/environments/default",
      "POST /api/v0/environments/default",
    ])
    expect(api.last()?.body).toBe("")
  })

  it("sets the default Environment with PUT", async () => {
    expect(
      await client.ok("rest_set_default_environment", { body: { environmentId: "e-docs" } }),
    ).toEqual({ defaultEnvironmentId: "e-docs" })
    expect(api.last()?.method).toBe("PUT")
    expect(bodyOf()).toEqual({ environmentId: "e-docs" })
    expect(api.state.defaultEnvironmentId).toBe("e-docs")

    const unknown = await client.fail("rest_set_default_environment", {
      body: { environmentId: "e-x" },
    })

    expect(unknown.code).toBe("rest_rejected")

    api.reset()

    const missing = await client.call("rest_set_default_environment", { body: {} })

    expect(missing.rpcError ?? missing.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)
  })

  it("lists Environment sources", async () => {
    expect(await client.ok("rest_list_environment_sources")).toMatchObject({
      providers: [{ id: "factory" }],
      unavailableProviders: [{ id: "e2b" }],
    })
    expect(api.last()?.route).toBe("GET /api/v0/environments/source-options")
  })

  it("sends environmentIds as repeated query keys", async () => {
    const statuses = await client.ok("rest_list_environment_build_statuses", {
      environmentIds: [PR_AGENT_ID, "e-docs"],
      serviceAccountId: "sa-1",
    })

    expect(statuses).toEqual({
      builds: [
        { environmentId: PR_AGENT_ID, buildId: "build-2", status: "ready" },
        { environmentId: "e-docs", buildId: "build-3", status: "ready" },
      ],
    })
    expect(api.last()?.query).toBe(
      "environmentIds=" + PR_AGENT_ID + "&environmentIds=e-docs&serviceAccountId=sa-1",
    )

    api.reset()

    const empty = await client.call("rest_list_environment_build_statuses", {
      environmentIds: [],
    })

    expect(empty.rpcError ?? empty.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)
  })

  it("distinguishes current build diagnostics from one attempt's", async () => {
    const current = await client.ok("rest_get_environment_build_diagnostics", {
      environmentId: PR_AGENT_ID,
    })

    expect(current).toEqual({
      buildId: "build-2",
      status: "ready",
      excerpt: "build complete",
      truncated: false,
      withheld: false,
    })
    expect(api.last()?.path).toBe("/api/v0/environments/" + PR_AGENT_ID + "/build-diagnostics")

    const attempt = await client.ok("rest_get_environment_build_attempt_diagnostics", {
      environmentId: PR_AGENT_ID,
      buildId: "build-1",
    })

    expect(attempt).toMatchObject({ buildId: "build-1", status: "failed" })
    expect(api.last()?.path).toBe(
      "/api/v0/environments/" + PR_AGENT_ID + "/builds/build-1/diagnostics",
    )
  })

  it("retries a build and reports a retry conflict while one runs", async () => {
    const retried = Schema.decodeUnknownSync(Started)(
      await client.ok("rest_retry_environment_build", { environmentId: PR_AGENT_ID }),
    )

    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe("/api/v0/environments/" + PR_AGENT_ID + "/builds")
    expect(api.state.builds.get(retried.buildId)).toMatchObject({ status: "building" })

    expect(
      await client.fail("rest_retry_environment_build", { environmentId: PR_AGENT_ID }),
    ).toEqual({
      code: "rest_rejected",
      message:
        "retryEnvironmentBuild was rejected (HTTP 409): a build is already running for " +
        PR_AGENT_ID,
    })
  })

  it("cancels a running build and never reports a rejected cancel as success", async () => {
    const retried = Schema.decodeUnknownSync(Started)(
      await client.ok("rest_retry_environment_build", { environmentId: PR_AGENT_ID }),
    )

    expect(
      await client.ok("rest_cancel_environment_build", {
        environmentId: PR_AGENT_ID,
        buildId: retried.buildId,
      }),
    ).toEqual({ ok: true })
    expect(api.last()?.path).toBe(
      "/api/v0/environments/" + PR_AGENT_ID + "/builds/" + retried.buildId + "/cancel",
    )

    const again = await client.call("rest_cancel_environment_build", {
      environmentId: PR_AGENT_ID,
      buildId: retried.buildId,
    })

    expect(again.isError).toBe(true)
    expect(again.structured).toBeUndefined()
    expect(JSON.parse(again.text)).toEqual({
      code: "rest_rejected",
      message:
        "cancelEnvironmentBuild was rejected (HTTP 409): build " +
        retried.buildId +
        " is not running",
    })
  })
})
