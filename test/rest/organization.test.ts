import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { SEED_USERS, startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const ORGANIZATION_TOOLS = [
  "rest_list_organization_users",
  "rest_invite_organization_user",
  "rest_remove_organization_user",
  "rest_get_organization_global_limit",
  "rest_set_organization_global_limit",
  "rest_get_organization_group_limits",
  "rest_set_organization_group_limits",
  "rest_get_organization_user_limits",
  "rest_set_organization_user_limits",
  "rest_list_organization_computer_secrets",
  "rest_update_organization_computer_secrets",
  "rest_list_organization_enterprise_control_history",
]

const DESTRUCTIVE = "Destructive; confirm before calling."

/** A synthetic secret value that must reach upstream and never come back. */
const SECRET_VALUE = "****************"

const UserPage = Schema.Struct({
  users: Schema.Array(Schema.Struct({ email: Schema.String })),
  pagination: Schema.Struct({ hasMore: Schema.Boolean, nextCursor: Schema.NullOr(Schema.String) }),
})

const emailsOf = (users: ReadonlyArray<{ readonly email?: Json }>): ReadonlyArray<Json> =>
  users.map((user) => user.email ?? null)

describe("rest organization tools over MCP", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: "factory-org-key", factoryBaseUrl: api.baseUrl }),
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

  it("lists all twelve tools, warns on membership and secret changes, and scopes setters", async () => {
    const byName = new Map((await client.list()).map((tool) => [tool.name, tool]))
    const described = (name: string): string => byName.get(name)?.description ?? ""

    for (const name of ORGANIZATION_TOOLS) expect(byName.has(name)).toBe(true)

    for (const name of [
      "rest_invite_organization_user",
      "rest_remove_organization_user",
      "rest_update_organization_computer_secrets",
    ]) {
      expect(described(name)).toContain(DESTRUCTIVE)
    }

    expect(described("rest_set_organization_global_limit")).toContain("every member")
    expect(described("rest_set_organization_group_limits")).toContain("every member of the group")
    expect(described("rest_set_organization_user_limits")).toContain("overriding group and global")
  })

  it("pages organization users with a reserved-character cursor", async () => {
    const first = Schema.decodeUnknownSync(UserPage)(
      await client.ok("rest_list_organization_users", { limit: 2 }),
    )

    expect(api.last()?.query).toBe("limit=2")
    expect(emailsOf(first.users)).toEqual(emailsOf(SEED_USERS.slice(0, 2)))
    expect(first.pagination.hasMore).toBe(true)

    const cursor = first.pagination.nextCursor ?? ""

    expect(cursor).toMatch(/[/?&=#]/)

    const second = Schema.decodeUnknownSync(UserPage)(
      await client.ok("rest_list_organization_users", { limit: 2, cursor }),
    )

    expect(api.last()?.query).toBe("limit=2&cursor=" + encodeURIComponent(cursor))
    expect(emailsOf(second.users)).toEqual(emailsOf(SEED_USERS.slice(2)))
    expect(second.pagination).toEqual({ hasMore: false, nextCursor: null })

    const invalid = await client.call("rest_list_organization_users", { limit: 101 })

    expect(invalid.rpcError ?? invalid.isError).toBeTruthy()
    expect(api.requests).toHaveLength(2)
  })

  it("pages enterprise control history", async () => {
    const first = Schema.decodeUnknownSync(
      Schema.Struct({
        changes: Schema.Array(Schema.Struct({ revision: Schema.Number })),
        pagination: Schema.Struct({ nextCursor: Schema.NullOr(Schema.String) }),
      }),
    )(await client.ok("rest_list_organization_enterprise_control_history", { limit: 1 }))

    expect(api.last()?.path).toBe("/api/v0/organization/enterprise-controls/history")
    expect(first.changes.map((change) => change.revision)).toEqual([3])

    const next = await client.ok("rest_list_organization_enterprise_control_history", {
      limit: 2,
      cursor: first.pagination.nextCursor ?? "",
    })

    expect(next).toMatchObject({
      changes: [{ revision: 2 }, { revision: 1 }],
      pagination: { hasMore: false, nextCursor: null },
    })
  })

  it("invites a user once and reports the repeat invitation as a conflict", async () => {
    const body = { email: "new@example.test", role: "manager" }

    expect(await client.ok("rest_invite_organization_user", { body })).toEqual({
      email: "new@example.test",
      role: "manager",
      status: "invited",
    })
    expect(api.last()?.path).toBe("/api/v0/organization/users/invite")
    expect(bodyOf()).toEqual(body)

    expect(await client.fail("rest_invite_organization_user", { body })).toEqual({
      code: "rest_rejected",
      message:
        "inviteUser was rejected (HTTP 409): new@example.test is already a member or invited",
    })

    const missing = await client.call("rest_invite_organization_user", { body: { role: "user" } })

    expect(missing.rpcError ?? missing.isError).toBeTruthy()
    expect(api.requests).toHaveLength(2)
  })

  it("removes a user by email in the query", async () => {
    expect(
      await client.ok("rest_remove_organization_user", { email: "linus@example.test" }),
    ).toEqual({ ok: true })

    const request = api.last()

    expect(request?.method).toBe("DELETE")
    expect(request?.path).toBe("/api/v0/organization/users")
    expect(request?.query).toBe("email=linus%40example.test")
    expect(request?.body).toBe("")
    expect(api.state.users.has("linus@example.test")).toBe(false)

    expect(
      await client.fail("rest_remove_organization_user", { email: "linus@example.test" }),
    ).toEqual({
      code: "rest_rejected",
      message: "removeUser was rejected (HTTP 404): user not found",
    })

    const missing = await client.call("rest_remove_organization_user", {})

    expect(missing.rpcError ?? missing.isError).toBeTruthy()
    expect(api.requests).toHaveLength(2)
  })

  it("reads and writes the global limit", async () => {
    expect(await client.ok("rest_get_organization_global_limit")).toEqual({ limit: 2_000_000 })

    expect(
      await client.ok("rest_set_organization_global_limit", { body: { limit: 4_000_000 } }),
    ).toEqual({ limit: 4_000_000 })
    expect(api.last()?.method).toBe("PUT")
    expect(bodyOf()).toEqual({ limit: 4_000_000 })
    expect(await client.ok("rest_get_organization_global_limit")).toEqual({ limit: 4_000_000 })

    expect(
      await client.ok("rest_set_organization_global_limit", { body: { limit: null } }),
    ).toEqual({ limit: null })

    expect(
      (await client.fail("rest_set_organization_global_limit", { body: { limit: 5 } })).code,
    ).toBe("rest_rejected")

    const before = api.requests.length

    const invalid: ReadonlyArray<Json> = [{}, { limit: 1.5 }, { limit: "4000000" }]

    for (const body of invalid) {
      const outcome = await client.call("rest_set_organization_global_limit", { body })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(before)
  })

  it("reads and writes group limits, keeping per-group errors", async () => {
    expect(await client.ok("rest_get_organization_group_limits")).toEqual({
      groupLimits: [
        { groupId: "grp-eng", name: "Engineering", limit: 5_000_000 },
        { groupId: "grp-ops", name: "Operations", limit: null },
      ],
    })

    const groups = [
      { groupId: "grp-ops", limit: 7_000_000 },
      { groupId: "grp-eng", limit: null },
      { groupId: "grp-gone", limit: 1_000_000 },
    ]

    expect(await client.ok("rest_set_organization_group_limits", { body: { groups } })).toEqual({
      updated: [
        { groupId: "grp-ops", limit: 7_000_000 },
        { groupId: "grp-eng", limit: null },
      ],
      errors: [{ groupId: "grp-gone", error: "group not found in the synced directory" }],
    })
    expect(api.last()?.path).toBe("/api/v0/organization/usage/limits/groups")
    expect(bodyOf()).toEqual({ groups })

    expect(await client.ok("rest_get_organization_group_limits")).toMatchObject({
      groupLimits: [
        { groupId: "grp-eng", limit: null },
        { groupId: "grp-ops", limit: 7_000_000 },
      ],
    })

    const before = api.requests.length
    const invalid: ReadonlyArray<Json> = [{}, { groups: [] }, { groups: [{ limit: 1_000_000 }] }]

    for (const body of invalid) {
      const outcome = await client.call("rest_set_organization_group_limits", { body })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
    }

    expect(api.requests).toHaveLength(before)
  })

  it("reads and writes individual user limits", async () => {
    expect(await client.ok("rest_get_organization_user_limits")).toEqual({
      globalLimit: 2_000_000,
      userLimits: [{ email: "grace@example.test", limit: 3_000_000 }],
    })

    const users = [
      { email: "ada@example.test", limit: 6_000_000 },
      { email: "grace@example.test", limit: null },
    ]

    expect(await client.ok("rest_set_organization_user_limits", { body: { users } })).toEqual({
      updated: users,
      errors: [],
    })
    expect(api.last()?.method).toBe("PUT")
    expect(bodyOf()).toEqual({ users })

    expect(await client.ok("rest_get_organization_user_limits")).toEqual({
      globalLimit: 2_000_000,
      userLimits: [{ email: "ada@example.test", limit: 6_000_000 }],
    })

    const missing = await client.call("rest_set_organization_user_limits", { body: {} })

    expect(missing.rpcError ?? missing.isError).toBeTruthy()
  })

  it("lists computer secrets by name only", async () => {
    const outcome = await client.call("rest_list_organization_computer_secrets")

    expect(outcome.structured).toEqual({ secrets: [{ key: "NPM_TOKEN" }] })
    expect(outcome.text).not.toContain("seed-npm-token-value")
  })

  it("sends secret upserts upstream and never returns their values", async () => {
    const body = { upsert: [{ key: "API_TOKEN", value: SECRET_VALUE }], delete: ["NPM_TOKEN"] }

    const outcome = await client.call("rest_update_organization_computer_secrets", { body })

    expect(outcome.structured).toEqual({ secrets: [{ key: "API_TOKEN" }] })
    expect(outcome.text).not.toContain(SECRET_VALUE)
    expect(api.last()?.method).toBe("PATCH")
    expect(bodyOf()).toEqual(body)
    expect(api.state.computerSecrets.get("API_TOKEN")).toBe(SECRET_VALUE)
    expect(api.state.computerSecrets.has("NPM_TOKEN")).toBe(false)
  })

  it("scrubs a secret value an upstream success body echoes", async () => {
    api.route("PATCH /api/v0/organization/computer-secrets", () => ({
      json: { secrets: [{ key: "API_TOKEN", value: SECRET_VALUE }], note: "set " + SECRET_VALUE },
    }))

    const outcome = await client.call("rest_update_organization_computer_secrets", {
      body: { upsert: [{ key: "API_TOKEN", value: SECRET_VALUE }], delete: [] },
    })

    expect(outcome.structured).toEqual({ secrets: [{ key: "API_TOKEN" }], note: "[redacted]" })
    expect(outcome.text).not.toContain(SECRET_VALUE)
  })

  it("scrubs a secret value from a 400 error that echoes it", async () => {
    const outcome = await client.call("rest_update_organization_computer_secrets", {
      body: { upsert: [{ key: "bad-key", value: SECRET_VALUE }], delete: [] },
    })

    expect(outcome.isError).toBe(true)
    expect(outcome.text).not.toContain(SECRET_VALUE)
    expect(JSON.parse(outcome.text)).toEqual({
      code: "rest_rejected",
      message:
        "updateOrganizationComputerSecrets was rejected (HTTP 400): cannot store bad-key=" +
        "[redacted]: the key is not a POSIX name",
    })
    expect(api.last()?.body).toContain(SECRET_VALUE)
    expect(api.state.computerSecrets.has("bad-key")).toBe(false)
  })

  it("reports a create-only conflict and requires both upsert and delete before I/O", async () => {
    const conflict = await client.call("rest_update_organization_computer_secrets", {
      body: { upsert: [{ key: "NPM_TOKEN", value: SECRET_VALUE }], delete: [], createOnly: true },
    })

    expect(conflict.isError).toBe(true)
    expect(conflict.text).toContain("HTTP 409")
    expect(conflict.text).not.toContain(SECRET_VALUE)

    const before = api.requests.length

    const invalid: ReadonlyArray<Json> = [
      { upsert: [{ key: "A", value: SECRET_VALUE }] },
      { delete: ["A"] },
      { upsert: [{ key: "", value: SECRET_VALUE }], delete: [] },
      { upsert: [{ key: "A" }], delete: [] },
    ]

    for (const body of invalid) {
      const outcome = await client.call("rest_update_organization_computer_secrets", { body })

      expect(outcome.rpcError ?? outcome.isError).toBeTruthy()
      expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE)
    }

    expect(api.requests).toHaveLength(before)
  })
})
