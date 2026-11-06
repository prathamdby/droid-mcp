import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { SEED_COMPUTER, SEED_TEMPLATE, startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const FACTORY_KEY = "factory-test-key"

const COMPUTER_TOOLS = [
  "rest_list_computers",
  "rest_get_computer",
  "rest_get_computer_by_name",
  "rest_create_computer",
  "rest_update_computer",
  "rest_delete_computer",
  "rest_restart_computer",
  "rest_refresh_computer",
  "rest_retry_install_deps",
  "rest_get_computer_metrics",
  "rest_list_computer_providers",
  "rest_bulk_create_computers",
  "rest_record_computer_activity",
  "rest_create_computer_file_upload",
  "rest_complete_computer_file_upload",
  "rest_create_computer_file_download",
  "rest_list_machine_templates",
  "rest_get_machine_template",
]

describe("rest computer and template tools over MCP", () => {
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

  it("lists every computer and template tool with its inputs", async () => {
    const listed = await client.list()
    const byName = new Map(listed.map((tool) => [tool.name, tool]))

    for (const name of COMPUTER_TOOLS) expect(byName.has(name)).toBe(true)

    expect(JSON.stringify(byName.get("rest_create_computer")?.inputSchema)).toContain("source")
    expect(JSON.stringify(byName.get("rest_list_computers")?.inputSchema)).toContain(
      "includeUnlisted",
    )
  })

  it("lists computers with the bearer key and no query", async () => {
    const result = await client.ok("rest_list_computers")

    expect(result).toEqual({ computers: [SEED_COMPUTER] })

    const request = api.last()

    expect(request?.method).toBe("GET")
    expect(request?.path).toBe("/api/v0/computers")
    expect(request?.query).toBe("")
    expect(request?.headers.authorization).toBe("Bearer " + FACTORY_KEY)
    expect(request?.route).toBe("GET /api/v0/computers")
  })

  it("sends the list filters as query parameters", async () => {
    await client.ok("rest_list_computers", {
      hostId: "h-1",
      serviceAccountId: "sa-1",
      includeProvisioningSteps: true,
      includeUnlisted: false,
    })

    expect(api.last()?.query).toBe(
      "hostId=h-1&serviceAccountId=sa-1&includeProvisioningSteps=true&includeUnlisted=false",
    )
  })

  it("passes extra query parameters through and refuses duplicates before I/O", async () => {
    await client.ok("rest_list_computers", { query: { foo: "bar", tag: ["a", "b"], n: 3 } })

    expect(api.last()?.query).toBe("foo=bar&tag=a&tag=b&n=3")

    api.reset()

    const failure = await client.fail("rest_list_computers", {
      hostId: "h-1",
      query: { hostId: "h-2" },
    })

    expect(failure.code).toBe("invalid_params")
    expect(api.requests).toHaveLength(0)
  })

  it("reads one computer with sharedSessionId and includeProvisioningSteps", async () => {
    const result = await client.ok("rest_get_computer", {
      computerId: "c-1",
      sharedSessionId: "s-9",
      includeProvisioningSteps: true,
    })

    expect(result).toMatchObject({ id: "c-1", name: "box" })
    expect(api.last()?.path).toBe("/api/v0/computers/c-1")
    expect(api.last()?.query).toBe("sharedSessionId=s-9&includeProvisioningSteps=true")
  })

  it("encodes an id as exactly one path segment", async () => {
    const failure = await client.fail("rest_get_computer", { computerId: "a/b c?#" })

    expect(api.last()?.path).toBe("/api/v0/computers/a%2Fb%20c%3F%23")
    expect(api.last()?.route).toBe("GET /api/v0/computers/{computerId}")
    expect(failure).toEqual({
      code: "rest_rejected",
      message: "getComputer was rejected (HTTP 404): computer not found",
    })
  })

  it("rejects empty and dot-segment ids before I/O", async () => {
    const empty = await client.call("rest_get_computer", { computerId: "" })

    expect(empty.rpcError ?? empty.isError).toBeTruthy()

    const dots = await client.fail("rest_get_computer", { computerId: ".." })

    expect(dots.code).toBe("invalid_params")
    expect(api.requests).toHaveLength(0)
  })

  it("creates a computer from name, remoteUser, and repos alone", async () => {
    const result = await client.ok("rest_create_computer", {
      name: "box",
      remoteUser: "dev",
      repos: ["github.com/acme/app"],
    })

    expect(result).toMatchObject({ id: "c-2", name: "box" })
    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.headers["content-type"]).toBe("application/json")
    expect(bodyOf()).toEqual({ name: "box", remoteUser: "dev", repos: ["github.com/acme/app"] })
  })

  it("creates from an Environment source with any provider and no remote user", async () => {
    const source = {
      kind: "environment",
      environmentId: "4d5cf2b0-f961-4b3e-a52e-1298524cfba4",
      isListed: false,
      keepWhenIdle: true,
    }

    const result = await client.ok("rest_create_computer", {
      name: "pr-box",
      provider: "daytona",
      serviceAccountId: "sa-1",
      source,
    })

    expect(result).toMatchObject({ name: "pr-box", providerType: "daytona" })
    expect(bodyOf()).toEqual({
      name: "pr-box",
      provider: "daytona",
      serviceAccountId: "sa-1",
      source,
    })
  })

  it("forwards template and computer sources", async () => {
    await client.ok("rest_create_computer", {
      name: "a",
      source: { kind: "template", templateId: "t-1", isListed: true },
    })

    expect(bodyOf()).toMatchObject({ source: { kind: "template", templateId: "t-1" } })

    await client.ok("rest_create_computer", {
      name: "b",
      source: { kind: "computer", sourceComputerId: "c-1" },
    })

    expect(bodyOf()).toMatchObject({ source: { kind: "computer", sourceComputerId: "c-1" } })
  })

  it("rejects an incomplete source before I/O", async () => {
    const missingFlag = await client.call("rest_create_computer", {
      name: "a",
      source: { kind: "environment", environmentId: "e-1" },
    })

    const emptyId = await client.call("rest_create_computer", {
      name: "a",
      source: { kind: "environment", environmentId: "", isListed: false },
    })

    expect(missingFlag.rpcError ?? missingFlag.isError).toBeTruthy()
    expect(emptyId.rpcError ?? emptyId.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)
  })

  it("deletes and keeps the acknowledgment", async () => {
    expect(await client.ok("rest_delete_computer", { computerId: "c-1" })).toEqual({
      deleted: true,
    })
    expect(api.last()?.method).toBe("DELETE")
    expect(api.state.computers.has("c-1")).toBe(false)

    const again = await client.fail("rest_delete_computer", { computerId: "c-1" })

    expect(again.code).toBe("rest_rejected")
  })

  it("restarts with and without a mode", async () => {
    expect(await client.ok("rest_restart_computer", { computerId: "c-1" })).toEqual({
      restarted: true,
    })
    expect(api.last()?.path).toBe("/api/v0/computers/c-1/restart")
    expect(api.last()?.body).toBe("")

    await client.ok("rest_restart_computer", { computerId: "c-1", mode: "reboot" })

    expect(bodyOf()).toEqual({ mode: "reboot" })
  })

  it("reads metrics from a start time", async () => {
    const outcome = await client.call("rest_get_computer_metrics", {
      computerId: "c-1",
      start: "2026-01-01T00:00:00Z",
    })

    // MCP structured content must be an object, so an array result arrives as text only.
    expect(outcome.isError).toBe(false)
    expect(JSON.parse(outcome.text)).toEqual([{ timestamp: 1, cpuPercent: 3 }])
    expect(api.last()?.path).toBe("/api/v0/computers/c-1/metrics")
    expect(api.last()?.query).toBe("start=2026-01-01T00%3A00%3A00Z")
  })

  it("lists machine templates and reads one", async () => {
    const listed = await client.ok("rest_list_machine_templates", { limit: 10, cursor: "a b" })

    expect(listed).toMatchObject({ templates: [{ templateId: "t-1" }] })
    expect(api.last()?.path).toBe("/api/v0/machines/templates")
    expect(api.last()?.query).toBe("limit=10&cursor=a%20b")

    const one = await client.ok("rest_get_machine_template", { templateId: "t-1" })

    expect(one).toEqual(SEED_TEMPLATE)
    expect(api.last()?.path).toBe("/api/v0/machines/templates/t-1")
  })

  it("rejects template page limits outside 1-100 before I/O", async () => {
    for (const limit of [0, 101, 1.5]) {
      const outcome = await client.call("rest_list_machine_templates", { limit })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(0)
  })

  it("lists remote sessions for one computer", async () => {
    const listed = await client.ok("rest_list_remote_sessions", { computerId: "c-1", limit: 5 })

    expect(listed).toMatchObject({ sessions: [{ sessionId: "s-1" }] })
    expect(api.last()?.path).toBe("/api/v0/sessions")
    expect(api.last()?.query).toBe("computerId=c-1&limit=5")
  })

  it("reads a computer by name with its filters", async () => {
    const found = await client.ok("rest_get_computer_by_name", {
      name: "box",
      serviceAccountId: "sa-1",
      includeProvisioningSteps: false,
    })

    expect(found).toEqual(SEED_COMPUTER)
    expect(api.last()?.path).toBe("/api/v0/computers/name/box")
    expect(api.last()?.query).toBe("serviceAccountId=sa-1&includeProvisioningSteps=false")

    const missing = await client.fail("rest_get_computer_by_name", { name: "nope" })

    expect(missing).toEqual({
      code: "rest_rejected",
      message: "getComputerByName was rejected (HTTP 404): computer not found",
    })
  })

  it("updates a computer with a PATCH body that keeps unknown members", async () => {
    const body = { name: "renamed", remoteUser: "ops", labels: { team: "infra" } }
    const updated = await client.ok("rest_update_computer", { computerId: "c-1", body })

    expect(updated).toMatchObject({ id: "c-1", name: "renamed", remoteUser: "ops" })
    expect(api.last()?.method).toBe("PATCH")
    expect(api.last()?.path).toBe("/api/v0/computers/c-1")
    expect(bodyOf()).toEqual(body)
  })

  it("refreshes a computer and reports what was configured", async () => {
    expect(await client.ok("rest_refresh_computer", { computerId: "c-1" })).toEqual({
      configured: 2,
      secretsConfigured: 1,
    })
    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe("/api/v0/computers/c-1/refresh")
    expect(api.last()?.body).toBe("")
  })

  it("retries dependency installation and reports a 409 conflict as a failure", async () => {
    const accepted = await client.ok("rest_retry_install_deps", { computerId: "c-1" })

    expect(accepted).toMatchObject({ id: "c-1", status: "provisioning" })
    expect(api.last()?.path).toBe("/api/v0/computers/c-1/install-deps")

    const conflict = await client.fail("rest_retry_install_deps", { computerId: "c-1" })

    expect(conflict).toEqual({
      code: "rest_rejected",
      message:
        "retryInstallDeps was rejected (HTTP 409): dependencies are already being installed on c-1",
    })
  })

  it("lists the available computer providers", async () => {
    expect(await client.ok("rest_list_computer_providers")).toEqual({
      providers: ["byom", "e2b", "daytona"],
    })
    expect(api.last()?.route).toBe("GET /api/v0/computers/providers")
  })

  it("bulk-creates computers and requires quantity and namePrefix before I/O", async () => {
    const created = await client.ok("rest_bulk_create_computers", {
      body: { quantity: 2, namePrefix: "ci", provider: "e2b", autoInstallDeps: true },
    })

    expect(created).toMatchObject({
      requestedQuantity: 2,
      computers: [{ name: "ci-1" }, { name: "ci-2" }],
    })
    expect(api.last()?.path).toBe("/api/v0/computers/bulk")
    expect(bodyOf()).toEqual({
      quantity: 2,
      namePrefix: "ci",
      provider: "e2b",
      autoInstallDeps: true,
    })

    api.reset()

    const bodies: ReadonlyArray<Json> = [
      { namePrefix: "ci" },
      { quantity: 2 },
      { quantity: 0, namePrefix: "ci" },
    ]

    for (const body of bodies) {
      const outcome = await client.call("rest_bulk_create_computers", { body })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(0)
  })

  it("records computer activity with a shared session id and no body", async () => {
    expect(
      await client.ok("rest_record_computer_activity", {
        computerId: "c-1",
        sharedSessionId: "s-1",
      }),
    ).toEqual({ lastActiveAt: 1_700_000_000_000 })
    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.path).toBe("/api/v0/computers/c-1/activity")
    expect(api.last()?.query).toBe("sharedSessionId=s-1")
    expect(api.last()?.body).toBe("")
  })

  it("starts and completes an upload with the file name as one segment", async () => {
    const started = Schema.decodeUnknownSync(
      Schema.Struct({ transferId: Schema.String, uploadUrl: Schema.String }),
    )(
      await client.ok("rest_create_computer_file_upload", {
        computerId: "c-1",
        fileName: "dir/a b.txt",
        body: { sizeBytes: 12, contentType: "text/plain" },
      }),
    )

    expect(api.last()?.path).toBe("/api/v0/computers/c-1/files/dir%2Fa%20b.txt/create-upload")
    expect(bodyOf()).toEqual({ sizeBytes: 12, contentType: "text/plain" })
    expect(started.uploadUrl).toBe(api.baseUrl + "/uploads/" + started.transferId)

    const completed = await client.ok("rest_complete_computer_file_upload", {
      computerId: "c-1",
      fileName: "dir/a b.txt",
      body: { transferId: started.transferId, sessionId: "s-1", destPath: "/tmp/a b.txt" },
    })

    expect(completed).toEqual({
      transferId: started.transferId,
      fileName: "dir/a b.txt",
      byteLength: 12,
    })
    expect(api.last()?.path).toBe("/api/v0/computers/c-1/files/dir%2Fa%20b.txt/complete-upload")

    const again = await client.fail("rest_complete_computer_file_upload", {
      computerId: "c-1",
      fileName: "dir/a b.txt",
      body: { transferId: started.transferId, sessionId: "s-1" },
    })

    expect(again).toEqual({
      code: "rest_rejected",
      message:
        "completeComputerFileUpload was rejected (HTTP 409): transfer " +
        started.transferId +
        " was already completed",
    })
    // The returned upload URL points at the fake; nothing may have fetched it.
    expect(api.requests.map((request) => request.route)).toEqual([
      "POST /api/v0/computers/{computerId}/files/{fileName}/create-upload",
      "POST /api/v0/computers/{computerId}/files/{fileName}/complete-upload",
      "POST /api/v0/computers/{computerId}/files/{fileName}/complete-upload",
    ])
  })

  it("rejects transfer calls missing their required body fields before I/O", async () => {
    const calls: ReadonlyArray<readonly [string, Json]> = [
      ["rest_create_computer_file_upload", { sizeBytes: 1 }],
      ["rest_create_computer_file_upload", { contentType: "text/plain" }],
      ["rest_complete_computer_file_upload", { transferId: "tr-1" }],
      ["rest_complete_computer_file_upload", { sessionId: "s-1" }],
      ["rest_create_computer_file_download", { cwd: "/" }],
    ]

    for (const [name, body] of calls) {
      const outcome = await client.call(name, { computerId: "c-1", fileName: "a.txt", body })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    const noBody = await client.call("rest_create_computer_file_download", {
      computerId: "c-1",
      fileName: "a.txt",
    })

    expect(noBody.rpcError ?? noBody.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)
  })

  it("returns a download URL without fetching it", async () => {
    const download = await client.ok("rest_create_computer_file_download", {
      computerId: "c-1",
      fileName: "report.csv",
      body: { sessionId: "s-1", cwd: "/work", contentType: "text/csv" },
    })

    expect(download).toMatchObject({
      downloadUrl: expect.stringContaining(api.baseUrl),
      byteLength: 42,
    })
    expect(bodyOf()).toEqual({ sessionId: "s-1", cwd: "/work", contentType: "text/csv" })
    expect(api.requests).toHaveLength(1)
  })

  it("turns a created computer active on its second read", async () => {
    await client.ok("rest_create_computer", { name: "fresh" })

    expect(await client.ok("rest_get_computer", { computerId: "c-2" })).toMatchObject({
      status: "provisioning",
    })
    expect(await client.ok("rest_get_computer", { computerId: "c-2" })).toMatchObject({
      status: "active",
    })
  })
})
