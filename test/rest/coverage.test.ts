import { readFileSync } from "node:fs"

import * as Schema from "effect/Schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { PR_AGENT_ID, startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

/**
 * Every hosted REST tool, called once through MCP, must reach exactly one
 * operation of the published OpenAPI snapshot, and together they must reach
 * all of them.
 */

const DESTRUCTIVE = "Destructive; confirm before calling."

/** The machine-template routes the SDK still calls; they are absent from the snapshot. */
const LEGACY_ROUTES = [
  "GET /api/v0/machines/templates",
  "GET /api/v0/machines/templates/{templateId}",
]

/** The hosted and Context tools that must carry the destructive sentence, and no others. */
const DESIGNATED_DESTRUCTIVE = [
  "rest_delete_computer",
  "rest_delete_environment",
  "rest_set_default_environment",
  "rest_cancel_environment_build",
  "rest_delete_remote_session",
  "rest_delete_wiki_run",
  "rest_update_wiki_privacy",
  "rest_edit_ci_workflow",
  "rest_invite_organization_user",
  "rest_remove_organization_user",
  "rest_update_organization_computer_secrets",
  "rest_delete_service_account",
  "rest_create_service_account_api_key",
  "rest_rotate_service_account_api_key",
  "rest_revoke_service_account_api_key",
  "context_delete_document",
  "context_delete_file",
]

const OperationsFixture = Schema.Struct({
  source: Schema.String,
  version: Schema.String,
  retrieved: Schema.String,
  operations: Schema.Array(Schema.String),
})

const fixture = Schema.decodeUnknownSync(OperationsFixture)(
  JSON.parse(
    readFileSync(new URL("../fixtures/factory-openapi-operations.json", import.meta.url), "utf8"),
  ),
)

const WithId = Schema.Struct({ id: Schema.String })
const WithTransfer = Schema.Struct({ transferId: Schema.String })
const WithBuild = Schema.Struct({ id: Schema.String, buildId: Schema.String })
const WithSession = Schema.Struct({ sessionId: Schema.String })
const WithAccount = Schema.Struct({ serviceAccount: WithId })
const WithKey = Schema.Struct({ apiKey: WithId })

const ServerInfo = Schema.Struct({
  profile: Schema.String,
  toolCount: Schema.Number,
  operationCount: Schema.Number,
})

const REPO = "https://github.com/acme/app"

describe("hosted REST coverage", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: "factory-coverage-key", factoryBaseUrl: api.baseUrl }),
    })
  })

  afterAll(async () => {
    await client.dispose()
    await api.close()
  })

  it("pins the snapshot the fixture was taken from", () => {
    expect(fixture.source).toBe("https://docs.factory.com/openapi.json")
    expect(fixture.version).toBe("0.1.0")
    expect(fixture.operations).toHaveLength(77)
    expect(new Set(fixture.operations).size).toBe(77)
  })

  it("reaches every snapshot operation and the two legacy routes, one tool per route", async () => {
    const routeOf = new Map<string, string>()

    /** Calls one tool, expects success and exactly one recorded request, and notes its route. */
    const hit = async (name: string, args: Json = {}): Promise<Json | undefined> => {
      const before = api.requests.length
      const result = await client.ok(name, args)

      expect(api.requests.length, name).toBe(before + 1)

      const route = api.requests.at(-1)?.route

      expect(route, name).toBeDefined()
      expect(routeOf.has(name), name + " called twice").toBe(false)
      routeOf.set(name, route ?? "")

      return result
    }

    await hit("rest_list_computers")
    await hit("rest_get_computer", { computerId: "c-1" })
    await hit("rest_get_computer_by_name", { name: "box" })

    const created = Schema.decodeUnknownSync(WithId)(
      await hit("rest_create_computer", { name: "coverage" }),
    )

    await hit("rest_update_computer", { computerId: "c-1", body: { remoteUser: "dev" } })
    await hit("rest_refresh_computer", { computerId: "c-1" })
    await hit("rest_restart_computer", { computerId: "c-1" })
    await hit("rest_get_computer_metrics", { computerId: "c-1" })
    await hit("rest_list_computer_providers")
    await hit("rest_bulk_create_computers", { body: { quantity: 1, namePrefix: "bulk" } })
    await hit("rest_record_computer_activity", { computerId: "c-1" })

    const upload = Schema.decodeUnknownSync(WithTransfer)(
      await hit("rest_create_computer_file_upload", {
        computerId: "c-1",
        fileName: "notes.txt",
        body: { sizeBytes: 4, contentType: "text/plain" },
      }),
    )

    await hit("rest_complete_computer_file_upload", {
      computerId: "c-1",
      fileName: "notes.txt",
      body: { transferId: upload.transferId, sessionId: "s-1" },
    })
    await hit("rest_create_computer_file_download", {
      computerId: "c-1",
      fileName: "notes.txt",
      body: { sessionId: "s-1" },
    })
    await hit("rest_list_machine_templates")
    await hit("rest_get_machine_template", { templateId: "t-1" })

    await hit("rest_list_environments")

    const environment = Schema.decodeUnknownSync(WithBuild)(
      await hit("rest_create_environment", { body: { name: "coverage-env", repositories: [] } }),
    )

    await hit("rest_get_environment", { environmentId: PR_AGENT_ID })
    await hit("rest_update_environment", {
      environmentId: "e-docs",
      body: { setupScript: "pnpm install" },
    })
    await hit("rest_ensure_default_environment")
    await hit("rest_set_default_environment", { body: { environmentId: PR_AGENT_ID } })
    await hit("rest_list_environment_sources")
    await hit("rest_list_environment_build_statuses", { environmentIds: [PR_AGENT_ID] })
    await hit("rest_get_environment_build_diagnostics", { environmentId: PR_AGENT_ID })
    await hit("rest_get_environment_build_attempt_diagnostics", {
      environmentId: PR_AGENT_ID,
      buildId: "build-1",
    })

    const retried = Schema.decodeUnknownSync(WithBuild)(
      await hit("rest_retry_environment_build", { environmentId: PR_AGENT_ID }),
    )

    await hit("rest_cancel_environment_build", {
      environmentId: PR_AGENT_ID,
      buildId: retried.buildId,
    })
    await hit("rest_delete_environment", { environmentId: environment.id })

    await hit("rest_list_remote_sessions")

    const session = Schema.decodeUnknownSync(WithSession)(
      await hit("rest_create_remote_session", {
        body: { computerId: "c-1", sessionSettings: { model: "auto" } },
      }),
    )

    await hit("rest_get_remote_session", { sessionId: "s-1" })
    await hit("rest_update_remote_session", {
      sessionId: "s-1",
      body: { sessionSettings: { model: "auto" } },
    })
    await hit("rest_interrupt_remote_session", { sessionId: "s-1" })
    await hit("rest_list_remote_session_messages", { sessionId: "s-1" })
    await hit("rest_post_remote_session_message", { sessionId: "s-1", body: { text: "hello" } })
    await hit("rest_get_remote_session_message", { sessionId: "s-1", messageId: "msg-1" })
    await hit("rest_list_remote_session_children", { sessionId: "s-1" })
    await hit("rest_delete_remote_session", { sessionId: session.sessionId })

    await hit("rest_retry_install_deps", { computerId: "c-1" })
    await hit("rest_delete_computer", { computerId: created.id })

    await hit("rest_list_wiki_runs")

    const run = Schema.decodeUnknownSync(WithId)(
      await hit("rest_create_wiki_run", { body: { repoUrl: REPO } }),
    )

    await hit("rest_get_wiki_run", { wikiRunId: "w-1" })
    await hit("rest_export_wiki_run", { wikiRunId: "w-1" })
    await hit("rest_get_wiki_page", { wikiRunId: "w-1", pageId: "p-1" })
    await hit("rest_search_wiki_run", { wikiRunId: "w-1", query: { q: "pnpm" } })
    await hit("rest_update_wiki_privacy", { wikiRunId: "w-1", body: { privacyLevel: "private" } })
    await hit("rest_list_wiki_history", { repoUrl: REPO })
    await hit("rest_get_wiki_upload_access", { repoUrl: REPO })
    await hit("rest_create_wiki_video_upload_url")
    await hit("rest_delete_wiki_run", { wikiRunId: run.id })

    await hit("rest_scan_ci_repositories")
    await hit("rest_list_ci_repositories")
    await hit("rest_list_ci_repository_owners")
    await hit("rest_list_ci_jobs")
    await hit("rest_list_ci_runs")
    await hit("rest_edit_ci_workflow", { body: { repoUrl: REPO, action: "create" } })

    await hit("rest_list_organization_users")
    await hit("rest_invite_organization_user", { body: { email: "new@example.test" } })
    await hit("rest_remove_organization_user", { email: "linus@example.test" })
    await hit("rest_get_organization_global_limit")
    await hit("rest_set_organization_global_limit", { body: { limit: 2_000_000 } })
    await hit("rest_get_organization_group_limits")
    await hit("rest_set_organization_group_limits", {
      body: { groups: [{ groupId: "grp-eng", limit: 5_000_000 }] },
    })
    await hit("rest_get_organization_user_limits")
    await hit("rest_set_organization_user_limits", {
      body: { users: [{ email: "ada@example.test", limit: 2_000_000 }] },
    })
    await hit("rest_list_organization_computer_secrets")
    await hit("rest_update_organization_computer_secrets", { body: { upsert: [], delete: [] } })
    await hit("rest_list_organization_enterprise_control_history")

    await hit("rest_list_service_accounts")

    const account = Schema.decodeUnknownSync(WithAccount)(
      await hit("rest_create_service_account", {
        body: { name: "coverage-bot", status: "active" },
      }),
    )

    await hit("rest_get_service_account", { serviceAccountId: "sa-1" })
    await hit("rest_update_service_account", {
      serviceAccountId: "sa-1",
      body: { description: "coverage" },
    })
    await hit("rest_list_service_account_api_keys", { serviceAccountId: "sa-1" })

    const key = Schema.decodeUnknownSync(WithKey)(
      await hit("rest_create_service_account_api_key", {
        serviceAccountId: "sa-1",
        body: { name: "coverage" },
      }),
    )

    await hit("rest_rotate_service_account_api_key", { serviceAccountId: "sa-1", keyId: "key-1" })
    await hit("rest_revoke_service_account_api_key", {
      serviceAccountId: "sa-1",
      keyId: key.apiKey.id,
    })
    await hit("rest_delete_service_account", { serviceAccountId: account.serviceAccount.id })

    const restTools = (await client.list()).flatMap((tool) =>
      tool.name.startsWith("rest_") ? [tool.name] : [],
    )

    expect(restTools).toHaveLength(79)
    expect([...routeOf.keys()].sort()).toEqual([...restTools].sort())

    const routes = [...routeOf.values()]

    expect(new Set(routes).size).toBe(routes.length)
    expect([...routes].sort()).toEqual([...fixture.operations, ...LEGACY_ROUTES].sort())
  })

  it("puts the destructive sentence on exactly the designated hosted and Context tools", async () => {
    const marked = (await client.list())
      .filter((tool) => tool.name.startsWith("rest_") || tool.name.startsWith("context_"))
      .filter((tool) => (tool.description ?? "").includes(DESTRUCTIVE))
      .map((tool) => tool.name)

    expect(marked.sort()).toEqual([...DESIGNATED_DESTRUCTIVE].sort())
  })

  it("reports the operation count, and the advertised count for its profile, in server_info", async () => {
    const listed = await client.list()
    const info = Schema.decodeUnknownSync(ServerInfo)(await client.ok("server_info"))

    expect(listed).toHaveLength(285)
    expect(info.operationCount).toBe(listed.length)
    expect(info.toolCount).toBe(info.profile === "compact" ? 16 : listed.length)
  })
})
