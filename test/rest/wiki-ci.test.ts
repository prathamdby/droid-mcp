import { Buffer } from "node:buffer"

import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { SEED_WIKI_RUN, WIKI_ZIP, startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi, Json } from "../support/fake-factory-api.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const WIKI_TOOLS = [
  "rest_list_wiki_runs",
  "rest_create_wiki_run",
  "rest_get_wiki_run",
  "rest_delete_wiki_run",
  "rest_export_wiki_run",
  "rest_get_wiki_page",
  "rest_search_wiki_run",
  "rest_update_wiki_privacy",
  "rest_list_wiki_history",
  "rest_get_wiki_upload_access",
  "rest_create_wiki_video_upload_url",
]

const CI_TOOLS = [
  "rest_scan_ci_repositories",
  "rest_list_ci_repositories",
  "rest_list_ci_repository_owners",
  "rest_list_ci_jobs",
  "rest_list_ci_runs",
  "rest_edit_ci_workflow",
]

const DESTRUCTIVE = "Destructive; confirm before calling."

/** Has `/`, `:` and `?`, so it only survives as one segment if fully encoded. */
const REPO_URL = "https://github.com/acme/app?tab=readme"

const Envelope = Schema.Struct({
  encoding: Schema.Literal("base64"),
  contentType: Schema.String,
  sizeBytes: Schema.Number,
  data: Schema.String,
})

describe("rest wiki and CI tools over MCP", () => {
  let api: FakeFactoryApi
  let client: ToolClient

  beforeAll(async () => {
    api = await startFakeFactoryApi()
    client = await connect({
      config: testConfig({ factoryApiKey: "factory-wiki-key", factoryBaseUrl: api.baseUrl }),
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

  it("lists all seventeen tools, labels passthrough shapes, and warns on mutations", async () => {
    const byName = new Map((await client.list()).map((tool) => [tool.name, tool]))
    const described = (name: string): string => byName.get(name)?.description ?? ""
    const schemaOf = (name: string): string => JSON.stringify(byName.get(name)?.inputSchema)

    for (const name of [...WIKI_TOOLS, ...CI_TOOLS]) {
      expect(byName.has(name)).toBe(true)
      expect(schemaOf(name)).toContain('"query"')
    }

    for (const name of WIKI_TOOLS.filter((each) => each !== "rest_get_wiki_upload_access")) {
      expect(described(name)).toContain("unverified")
    }

    for (const name of CI_TOOLS) expect(described(name)).toContain("unverified")

    for (const name of ["rest_delete_wiki_run", "rest_update_wiki_privacy"]) {
      expect(described(name)).toContain(DESTRUCTIVE)
    }

    expect(described("rest_edit_ci_workflow")).toContain(DESTRUCTIVE)
    expect(described("rest_edit_ci_workflow")).toContain("pull request")

    for (const name of [
      "rest_create_wiki_run",
      "rest_delete_wiki_run",
      "rest_update_wiki_privacy",
      "rest_create_wiki_video_upload_url",
      "rest_edit_ci_workflow",
    ]) {
      expect(schemaOf(name)).toContain('"body"')
    }

    for (const name of ["rest_list_wiki_runs", "rest_get_wiki_run", "rest_list_ci_jobs"]) {
      expect(schemaOf(name)).not.toContain('"body"')
    }
  })

  it("lists wiki runs", async () => {
    expect(await client.ok("rest_list_wiki_runs")).toEqual({ runs: [SEED_WIKI_RUN] })
    expect(api.last()?.route).toBe("GET /api/v0/wiki")
  })

  it("passes a wiki run's body and query through untouched", async () => {
    const body = { repoUrl: REPO_URL, branch: "main", options: { depth: 2, video: false } }

    const created = await client.ok("rest_create_wiki_run", {
      body,
      query: { dryRun: false, tag: ["docs", "v2"] },
    })

    expect(created).toMatchObject({ id: "w-2", repoUrl: REPO_URL, status: "running" })
    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.query).toBe("dryRun=false&tag=docs&tag=v2")
    expect(bodyOf()).toEqual(body)
  })

  it("reads a run, a page, and searches with passthrough query terms", async () => {
    expect(await client.ok("rest_get_wiki_run", { wikiRunId: "w-1" })).toEqual(SEED_WIKI_RUN)
    expect(api.last()?.path).toBe("/api/v0/wiki/w-1")

    expect(await client.ok("rest_get_wiki_page", { wikiRunId: "w-1", pageId: "p-2" })).toEqual({
      id: "p-2",
      title: "Setup",
      content: "Run pnpm install, then pnpm dev.",
    })
    expect(api.last()?.path).toBe("/api/v0/wiki/w-1/pages/p-2")

    const found = await client.ok("rest_search_wiki_run", {
      wikiRunId: "w-1",
      query: { q: "pnpm" },
    })

    expect(found).toEqual({ results: [expect.objectContaining({ id: "p-2" })] })
    expect(api.last()?.path).toBe("/api/v0/wiki/w-1/search")
    expect(api.last()?.query).toBe("q=pnpm")

    expect(await client.fail("rest_get_wiki_page", { wikiRunId: "w-1", pageId: "p-9" })).toEqual({
      code: "rest_rejected",
      message: "getWikiPage was rejected (HTTP 404): wiki page not found",
    })
  })

  it("changes privacy and deletes a run, then reports the missing run", async () => {
    const updated = await client.ok("rest_update_wiki_privacy", {
      wikiRunId: "w-1",
      body: { privacyLevel: "organization" },
    })

    expect(updated).toMatchObject({ id: "w-1", privacyLevel: "organization" })
    expect(api.last()?.path).toBe("/api/v0/wiki/w-1/privacy")
    expect(bodyOf()).toEqual({ privacyLevel: "organization" })

    expect(await client.ok("rest_delete_wiki_run", { wikiRunId: "w-1" })).toEqual({
      id: "w-1",
      deleted: true,
    })
    expect(api.last()?.method).toBe("DELETE")
    expect(api.last()?.body).toBe("")
    expect(api.state.wikiRuns.has("w-1")).toBe(false)

    expect((await client.fail("rest_delete_wiki_run", { wikiRunId: "w-1" })).code).toBe(
      "rest_rejected",
    )
  })

  it("sends a repoUrl with /, : and ? as one history path segment", async () => {
    await client.ok("rest_create_wiki_run", { body: { repoUrl: REPO_URL } })

    const history = await client.ok("rest_list_wiki_history", { repoUrl: REPO_URL })

    expect(api.last()?.path).toBe("/api/v0/wiki/history/" + encodeURIComponent(REPO_URL))
    expect(api.last()?.query).toBe("")
    expect(api.last()?.route).toBe("GET /api/v0/wiki/history/{repoUrl}")
    expect(history).toEqual({
      repoUrl: REPO_URL,
      runs: [expect.objectContaining({ id: "w-2", repoUrl: REPO_URL })],
    })
  })

  it("requires repoUrl for upload access and sends it as a query parameter", async () => {
    const missing = await client.call("rest_get_wiki_upload_access", {})

    expect(missing.rpcError ?? missing.isError).toBeTruthy()
    expect(api.requests).toHaveLength(0)

    expect(await client.ok("rest_get_wiki_upload_access", { repoUrl: REPO_URL })).toEqual({
      allowed: true,
    })
    expect(api.last()?.path).toBe("/api/v0/wiki/upload-access")
    expect(api.last()?.query).toBe("repoUrl=" + encodeURIComponent(REPO_URL))
  })

  it("returns a video upload URL without fetching it", async () => {
    const created = Schema.decodeUnknownSync(Schema.Struct({ uploadUrl: Schema.String }))(
      await client.ok("rest_create_wiki_video_upload_url", { body: { wikiRunId: "w-1" } }),
    )

    expect(created.uploadUrl).toContain("/uploads/video-")
    expect(bodyOf()).toEqual({ wikiRunId: "w-1" })
    expect(api.requests).toHaveLength(1)
  })

  it("exports ZIP bytes as a base64 envelope that decodes to the served bytes", async () => {
    const envelope = Schema.decodeUnknownSync(Envelope)(
      await client.ok("rest_export_wiki_run", { wikiRunId: "w-1" }),
    )

    expect(envelope.contentType).toBe("application/zip")
    expect(envelope.sizeBytes).toBe(WIKI_ZIP.byteLength)
    expect(Buffer.from(envelope.data, "base64").equals(Buffer.from(WIKI_ZIP))).toBe(true)
    expect(api.last()?.path).toBe("/api/v0/wiki/w-1/export")
    expect(api.last()?.headers.accept).toContain("application/octet-stream")
  })

  it("refuses export bytes that contain the Factory key, and scrubs it from the content type", async () => {
    const leaked = new TextEncoder().encode("PK\u0003\u0004 factory-wiki-key")

    api.route("GET /api/v0/wiki/{wikiRunId}/export", () => ({
      bytes: leaked,
      contentType: "application/zip",
    }))

    expect(await client.fail("rest_export_wiki_run", { wikiRunId: "w-1" })).toEqual({
      code: "rest_unavailable",
      message: "exportWikiRun returned binary content containing a protected value; refused",
    })

    api.route("GET /api/v0/wiki/{wikiRunId}/export", () => ({
      bytes: WIKI_ZIP,
      contentType: "application/zip; name=factory-wiki-key",
    }))

    const envelope = Schema.decodeUnknownSync(Envelope)(
      await client.ok("rest_export_wiki_run", { wikiRunId: "w-1" }),
    )

    expect(envelope.contentType).toBe("application/zip; name=[redacted]")
    expect(Buffer.from(envelope.data, "base64").equals(Buffer.from(WIKI_ZIP))).toBe(true)
  })

  it("passes a JSON export answer through unchanged", async () => {
    const json = { status: "pending", files: [{ path: "index.md", sizeBytes: 12 }] }

    api.route("GET /api/v0/wiki/{wikiRunId}/export", () => ({ json }))

    expect(await client.ok("rest_export_wiki_run", { wikiRunId: "w-1" })).toEqual(json)
  })

  it("reads every CI listing with passthrough query parameters", async () => {
    expect(await client.ok("rest_scan_ci_repositories")).toEqual({
      repositories: [
        { repoUrl: "https://github.com/acme/app", workflows: [".github/workflows/droid.yml"] },
        { repoUrl: "https://github.com/beta/site", workflows: [] },
      ],
    })
    expect(api.last()?.route).toBe("GET /api/v0/automations/ci/scan")

    expect(await client.ok("rest_list_ci_repositories", { query: { owner: "acme" } })).toEqual({
      repositories: [{ repoUrl: "https://github.com/acme/app", owner: "acme", hasWorkflow: true }],
    })
    expect(api.last()?.query).toBe("owner=acme")

    expect(await client.ok("rest_list_ci_repository_owners")).toEqual({
      owners: [{ login: "acme" }, { login: "beta" }],
    })
    expect(api.last()?.route).toBe("GET /api/v0/automations/ci/repository-owners")

    expect(await client.ok("rest_list_ci_jobs")).toEqual({
      jobs: [{ id: "job-review", name: "review", trigger: "pull_request" }],
    })
    expect(api.last()?.route).toBe("GET /api/v0/automations/ci/jobs")

    expect(await client.ok("rest_list_ci_runs", { query: { jobId: "job-review" } })).toEqual({
      runs: [{ id: 101, jobId: "job-review", conclusion: "success" }],
    })
    expect(api.last()?.query).toBe("jobId=job-review")
  })

  it("opens a workflow PR with the body and query as given", async () => {
    const body = {
      repoUrl: "https://github.com/acme/app",
      action: "create",
      workflow: { name: "droid-review", triggers: ["pull_request"] },
    }

    const opened = await client.ok("rest_edit_ci_workflow", { body, query: { draft: true } })

    expect(opened).toEqual({
      pullRequest: { number: 1, url: "https://github.com/acme/app/pull/1", action: "create" },
    })
    expect(api.last()?.method).toBe("POST")
    expect(api.last()?.query).toBe("draft=true")
    expect(bodyOf()).toEqual(body)
    expect(api.state.ciPullRequests).toHaveLength(1)
  })

  it("reports a rejected workflow edit and opens no PR", async () => {
    expect(await client.fail("rest_edit_ci_workflow")).toEqual({
      code: "rest_rejected",
      message: "editCiWorkflow was rejected (HTTP 400): repoUrl and action are required",
    })
    expect(api.last()?.body).toBe("")
    expect(api.state.ciPullRequests).toHaveLength(0)
  })
})
