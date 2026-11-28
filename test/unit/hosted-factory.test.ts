import { readFileSync } from "node:fs"
import { join } from "node:path"

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { authorityLayer } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { CallersApi, Conversation } from "../../src/caller/index.ts"
import {
  Capabilities,
  capabilitiesLayer,
  DeliveryUncertain,
  InvalidInput,
  MalformedPeerReply,
  OperationDenied,
  PeerFailure,
  TargetUnavailable,
} from "../../src/capabilities/index.ts"
import type { Invocation } from "../../src/capabilities/index.ts"
import { custodyLayer } from "../../src/custody/index.ts"
import {
  Disclosure,
  disclosureLayer,
  ReleasePayload,
  releasedJson,
} from "../../src/disclosure/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance, guidanceLayer } from "../../src/guidance/index.ts"
import type { GuidanceApi } from "../../src/guidance/index.ts"
import {
  HostedOperations,
  hostedOperationsLayer,
  HostedUnavailable,
} from "../../src/hosted-factory/index.ts"
import type { HostedInstallation } from "../../src/hosted-factory/index.ts"
import type { HostedTransport } from "../../src/hosted-factory/private/http.ts"
import { exchange, join as joinPath, segment } from "../../src/hosted-factory/private/kit.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi } from "../support/fake-factory-api.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CREDENTIAL = "test-hosted-credential-0123456789abcdef"

const makeServices = (options?: {
  readonly maxAutonomy?: "off" | "low" | "medium" | "high"
  readonly guidanceRequired?: boolean
  readonly protectedValues?: ReadonlyArray<string>
}) => {
  const disclosureLive = disclosureLayer({ protectedValues: options?.protectedValues })
  const callersLive = callersLayer()

  const authorityLive = authorityLayer({
    maxAutonomy: options?.maxAutonomy ?? "high",
  })

  const guidanceLive = guidanceLayer({ required: options?.guidanceRequired })

  const capabilitiesLive = Layer.provideMerge(
    capabilitiesLayer,
    Layer.merge(Layer.merge(callersLive, authorityLive), Layer.merge(guidanceLive, disclosureLive)),
  )

  const hostedLive = Layer.provideMerge(
    hostedOperationsLayer,
    Layer.mergeAll(
      capabilitiesLive,
      callersLive,
      authorityLive,
      guidanceLive,
      disclosureLive,
      custodyLayer,
    ),
  )

  const merged = Layer.mergeAll(
    hostedLive,
    capabilitiesLive,
    callersLive,
    authorityLive,
    guidanceLive,
    disclosureLive,
  )

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const hosted = yield* HostedOperations
        const capabilities = yield* Capabilities
        const callers = yield* Callers
        const guidance = yield* Guidance
        const disclosure = yield* Disclosure

        return { hosted, capabilities, callers, guidance, disclosure }
      }),
      merged,
    ),
  )
}

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

const deliverRoot = (guidance: GuidanceApi, scope: Conversation): void =>
  Effect.runSync(
    Effect.gen(function* () {
      const doc = yield* guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
      const delivered = yield* guidance.confirmRootDelivery(doc)

      yield* guidance.acknowledge(scope, delivered)
    }),
  )

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

const expectSuccess = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (!Exit.isSuccess(exit)) throw new Error("expected success, got failure")

  return exit.value
}

const runEffect = <A, E>(program: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(program)

const jsonOf = (released: Parameters<typeof releasedJson>[0]): Schema.Json => {
  const json = releasedJson(released)

  if (Option.isNone(json)) throw new Error("expected a JSON release payload")

  return json.value
}

// ---------------------------------------------------------------------------
// Installation and catalog helpers
// ---------------------------------------------------------------------------

const installation = (
  api: FakeFactoryApi,
  overrides?: Partial<HostedInstallation>,
): HostedInstallation => ({
  origin: api.baseUrl,
  credential: () => Effect.succeed(CREDENTIAL),
  timeoutMs: 500,
  ...overrides,
})

const bindCatalog = (services: ReturnType<typeof makeServices>, site: HostedInstallation) =>
  Effect.gen(function* () {
    const entries = yield* services.hosted.entries(site)

    return yield* services.capabilities.assemble(entries)
  })

const invokeJson = (
  services: ReturnType<typeof makeServices>,
  catalog: Parameters<typeof services.capabilities.invoke>[0],
  who: Invocation,
  id: string,
  input: Schema.Json,
) => services.capabilities.invoke(catalog, who, id, input)

// ---------------------------------------------------------------------------
// Fake API lifecycle
// ---------------------------------------------------------------------------

let api: FakeFactoryApi

beforeAll(async () => {
  api = await startFakeFactoryApi()
})

beforeEach(() => {
  api.reset()
})

afterAll(async () => {
  await api.close()
})

// ---------------------------------------------------------------------------
// Installation validation
// ---------------------------------------------------------------------------

describe("hosted installation validation", () => {
  it("fails with HostedUnavailable when the origin is missing", async () => {
    const services = makeServices()

    const exit = await runEffect(services.hosted.entries({}))

    expect(Exit.isFailure(exit)).toBe(true)

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(HostedUnavailable)

    if (error instanceof HostedUnavailable) {
      expect(error.reason).toBe("missing-origin")
    }
  })

  it("fails with HostedUnavailable when the origin is blank", async () => {
    const services = makeServices()

    const exit = await runEffect(services.hosted.entries({ origin: "   " }))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(HostedUnavailable)

    if (error instanceof HostedUnavailable) {
      expect(error.reason).toBe("missing-origin")
    }
  })

  it("fails with HostedUnavailable when the origin is not a URL", async () => {
    const services = makeServices()

    const exit = await runEffect(services.hosted.entries({ origin: "not a url" }))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(HostedUnavailable)

    if (error instanceof HostedUnavailable) {
      expect(error.reason).toBe("invalid-origin")
    }
  })

  it("fails with HostedUnavailable when the origin uses a non-http scheme", async () => {
    const services = makeServices()

    const exit = await runEffect(services.hosted.entries({ origin: "ftp://example.test" }))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(HostedUnavailable)

    if (error instanceof HostedUnavailable) {
      expect(error.reason).toBe("invalid-scheme")
    }
  })

  it("fails with HostedUnavailable for a blank delegated scope entry", async () => {
    const services = makeServices()

    const exit = await runEffect(
      services.hosted.entries({
        origin: "http://127.0.0.1:1",
        delegatedScopes: ["  "],
      }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(HostedUnavailable)

    if (error instanceof HostedUnavailable) {
      expect(error.reason).toBe("invalid-delegated-scope")
    }
  })
})

// ---------------------------------------------------------------------------
// Binding coverage
// ---------------------------------------------------------------------------

describe("operation binding coverage", () => {
  it("binds every hosted operation into a catalog with the exact expected ids", async () => {
    const services = makeServices()

    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))

    expect(catalog.size).toBe(81)

    const who = makeInvocation(services.callers, "coverage")

    const descriptions = expectSuccess(
      await runEffect(services.capabilities.available(catalog, who)),
    )

    const ids = descriptions.map((description) => description.id).sort()

    const expectedDomains: ReadonlyArray<readonly [string, number]> = [
      ["rest_list_computers", 1],
      ["rest_get_computer", 1],
      ["rest_create_computer", 1],
      ["rest_delete_computer", 1],
      ["rest_restart_computer", 1],
      ["rest_get_computer_metrics", 1],
      ["rest_list_machine_templates", 1],
      ["rest_get_machine_template", 1],
      ["rest_get_computer_by_name", 1],
      ["rest_update_computer", 1],
      ["rest_refresh_computer", 1],
      ["rest_retry_install_deps", 1],
      ["rest_list_computer_providers", 1],
      ["rest_bulk_create_computers", 1],
      ["rest_record_computer_activity", 1],
      ["rest_create_computer_file_upload", 1],
      ["rest_complete_computer_file_upload", 1],
      ["rest_create_computer_file_download", 1],
      ["rest_list_environments", 1],
      ["rest_create_environment", 1],
      ["rest_get_environment", 1],
      ["rest_update_environment", 1],
      ["rest_delete_environment", 1],
      ["rest_ensure_default_environment", 1],
      ["rest_set_default_environment", 1],
      ["rest_list_environment_sources", 1],
      ["rest_list_environment_build_statuses", 1],
      ["rest_get_environment_build_diagnostics", 1],
      ["rest_get_environment_build_attempt_diagnostics", 1],
      ["rest_retry_environment_build", 1],
      ["rest_cancel_environment_build", 1],
      ["rest_list_remote_sessions", 1],
      ["rest_create_remote_session", 1],
      ["rest_get_remote_session", 1],
      ["rest_update_remote_session", 1],
      ["rest_delete_remote_session", 1],
      ["rest_interrupt_remote_session", 1],
      ["rest_list_remote_session_messages", 1],
      ["rest_post_remote_session_message", 1],
      ["rest_get_remote_session_message", 1],
      ["rest_list_remote_session_children", 1],
      ["rest_list_wiki_runs", 1],
      ["rest_create_wiki_run", 1],
      ["rest_get_wiki_run", 1],
      ["rest_delete_wiki_run", 1],
      ["rest_export_wiki_run", 1],
      ["rest_get_wiki_page", 1],
      ["rest_search_wiki_run", 1],
      ["rest_update_wiki_privacy", 1],
      ["rest_list_wiki_history", 1],
      ["rest_get_wiki_upload_access", 1],
      ["rest_create_wiki_video_upload_url", 1],
      ["rest_scan_ci_repositories", 1],
      ["rest_list_ci_repositories", 1],
      ["rest_list_ci_repository_owners", 1],
      ["rest_list_ci_jobs", 1],
      ["rest_list_ci_runs", 1],
      ["rest_edit_ci_workflow", 1],
      ["rest_get_billing_limits", 1],
      ["rest_set_billing_overage_preference", 1],
      ["rest_list_organization_users", 1],
      ["rest_invite_organization_user", 1],
      ["rest_remove_organization_user", 1],
      ["rest_get_organization_global_limit", 1],
      ["rest_set_organization_global_limit", 1],
      ["rest_get_organization_group_limits", 1],
      ["rest_set_organization_group_limits", 1],
      ["rest_get_organization_user_limits", 1],
      ["rest_set_organization_user_limits", 1],
      ["rest_list_organization_computer_secrets", 1],
      ["rest_update_organization_computer_secrets", 1],
      ["rest_list_organization_enterprise_control_history", 1],
      ["rest_list_service_accounts", 1],
      ["rest_create_service_account", 1],
      ["rest_get_service_account", 1],
      ["rest_update_service_account", 1],
      ["rest_delete_service_account", 1],
      ["rest_list_service_account_api_keys", 1],
      ["rest_create_service_account_api_key", 1],
      ["rest_rotate_service_account_api_key", 1],
      ["rest_revoke_service_account_api_key", 1],
    ]

    for (const [id] of expectedDomains) {
      expect(ids).toContain(id)
    }

    // Every entry belongs to the rest family and carries structural facts.
    for (const description of descriptions) {
      expect(description.family).toBe("rest")
      expect(description.inputSchema).toMatchObject({ type: "object" })
    }
  })

  it("assembles without duplicates or invalid entries", async () => {
    const services = makeServices()

    const exit = await runEffect(bindCatalog(services, installation(api)))

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("advertises the nested wiki search and file upload inputs", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "schema-check")

    const descriptions = expectSuccess(
      await runEffect(services.capabilities.available(catalog, who)),
    )

    const schemaFor = (id: string) =>
      descriptions.find((description) => description.id === id)?.inputSchema

    expect(schemaFor("rest_search_wiki_run")).toMatchObject({
      required: ["wikiRunId"],
      properties: { wikiRunId: { type: "string" }, query: { type: "object" } },
    })
    expect(schemaFor("rest_search_wiki_run")).not.toHaveProperty(["properties", "q"])
    expect(schemaFor("rest_create_computer_file_upload")).toMatchObject({
      required: ["computerId", "fileName", "body"],
      properties: {
        body: {
          required: ["sizeBytes", "contentType"],
          properties: {
            sizeBytes: { type: "integer", minimum: 0 },
            contentType: { type: "string", minLength: 1 },
          },
        },
        query: { type: "object" },
      },
    })
  })

  it.each(["rest_scan_ci_repositories", "rest_set_billing_overage_preference"])(
    "advertises %s as a non-destructive write",
    async (id) => {
      const services = makeServices()
      const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
      const who = makeInvocation(services.callers, "annotation-check")

      const descriptions = expectSuccess(
        await runEffect(services.capabilities.available(catalog, who)),
      )

      expect(descriptions.find((description) => description.id === id)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      })
    },
  )

  it("covers every published OpenAPI operation among the registered entries", async () => {
    const OpenApiFixtureSchema = Schema.Struct({
      operations: Schema.Array(Schema.String),
    })

    const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(OpenApiFixtureSchema))(
      readFileSync(
        join(import.meta.dirname, "../fixtures/factory-openapi-operations.json"),
        "utf8",
      ),
    )

    expect(fixture.operations).toHaveLength(77)

    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "openapi-coverage")

    const descriptions = expectSuccess(
      await runEffect(services.capabilities.available(catalog, who)),
    )

    expect(descriptions).toHaveLength(81)

    // -----------------------------------------------------------------------
    // The route table every operation performs against, mirrored one-to-one
    // from the hosted-factory private domain files. Path templates use the
    // published OpenAPI `{param}` shape.
    // -----------------------------------------------------------------------
    const ROUTES_BY_OPERATION = {
      rest_list_computers: ["GET /api/v0/computers"],
      rest_get_computer: ["GET /api/v0/computers/{computerId}"],
      rest_create_computer: ["POST /api/v0/computers"],
      rest_delete_computer: ["DELETE /api/v0/computers/{computerId}"],
      rest_restart_computer: ["POST /api/v0/computers/{computerId}/restart"],
      rest_get_computer_metrics: ["GET /api/v0/computers/{computerId}/metrics"],
      rest_list_machine_templates: [],
      rest_get_machine_template: [],
      rest_get_computer_by_name: ["GET /api/v0/computers/name/{name}"],
      rest_update_computer: ["PATCH /api/v0/computers/{computerId}"],
      rest_refresh_computer: ["POST /api/v0/computers/{computerId}/refresh"],
      rest_retry_install_deps: ["POST /api/v0/computers/{computerId}/install-deps"],
      rest_list_computer_providers: ["GET /api/v0/computers/providers"],
      rest_bulk_create_computers: ["POST /api/v0/computers/bulk"],
      rest_record_computer_activity: ["POST /api/v0/computers/{computerId}/activity"],
      rest_create_computer_file_upload: [
        "POST /api/v0/computers/{computerId}/files/{fileName}/create-upload",
      ],
      rest_complete_computer_file_upload: [
        "POST /api/v0/computers/{computerId}/files/{fileName}/complete-upload",
      ],
      rest_create_computer_file_download: [
        "POST /api/v0/computers/{computerId}/files/{fileName}/create-download",
      ],
      rest_list_environments: ["GET /api/v0/environments"],
      rest_create_environment: ["POST /api/v0/environments"],
      rest_get_environment: ["GET /api/v0/environments/{environmentId}"],
      rest_update_environment: ["PATCH /api/v0/environments/{environmentId}"],
      rest_delete_environment: ["DELETE /api/v0/environments/{environmentId}"],
      rest_ensure_default_environment: ["POST /api/v0/environments/default"],
      rest_set_default_environment: ["PUT /api/v0/environments/default"],
      rest_list_environment_sources: ["GET /api/v0/environments/source-options"],
      rest_list_environment_build_statuses: ["GET /api/v0/environments/build-statuses"],
      rest_get_environment_build_diagnostics: [
        "GET /api/v0/environments/{environmentId}/build-diagnostics",
      ],
      rest_get_environment_build_attempt_diagnostics: [
        "GET /api/v0/environments/{environmentId}/builds/{buildId}/diagnostics",
      ],
      rest_retry_environment_build: ["POST /api/v0/environments/{environmentId}/builds"],
      rest_cancel_environment_build: [
        "POST /api/v0/environments/{environmentId}/builds/{buildId}/cancel",
      ],
      rest_list_remote_sessions: ["GET /api/v0/sessions"],
      rest_create_remote_session: ["POST /api/v0/sessions"],
      rest_get_remote_session: ["GET /api/v0/sessions/{sessionId}"],
      rest_update_remote_session: ["PATCH /api/v0/sessions/{sessionId}"],
      rest_delete_remote_session: ["DELETE /api/v0/sessions/{sessionId}"],
      rest_interrupt_remote_session: ["POST /api/v0/sessions/{sessionId}/interrupt"],
      rest_list_remote_session_messages: ["GET /api/v0/sessions/{sessionId}/messages"],
      rest_post_remote_session_message: ["POST /api/v0/sessions/{sessionId}/messages"],
      rest_get_remote_session_message: ["GET /api/v0/sessions/{sessionId}/messages/{messageId}"],
      rest_list_remote_session_children: ["GET /api/v0/sessions/{sessionId}/children"],
      rest_list_wiki_runs: ["GET /api/v0/wiki"],
      rest_create_wiki_run: ["POST /api/v0/wiki"],
      rest_get_wiki_run: ["GET /api/v0/wiki/{wikiRunId}"],
      rest_delete_wiki_run: ["DELETE /api/v0/wiki/{wikiRunId}"],
      rest_export_wiki_run: ["GET /api/v0/wiki/{wikiRunId}/export"],
      rest_get_wiki_page: ["GET /api/v0/wiki/{wikiRunId}/pages/{pageId}"],
      rest_search_wiki_run: ["GET /api/v0/wiki/{wikiRunId}/search"],
      rest_update_wiki_privacy: ["POST /api/v0/wiki/{wikiRunId}/privacy"],
      rest_list_wiki_history: ["GET /api/v0/wiki/history/{repoUrl}"],
      rest_get_wiki_upload_access: ["GET /api/v0/wiki/upload-access"],
      rest_create_wiki_video_upload_url: ["POST /api/v0/wiki/video-upload-url"],
      rest_scan_ci_repositories: ["GET /api/v0/automations/ci/scan"],
      rest_list_ci_repositories: ["GET /api/v0/automations/ci/repositories"],
      rest_list_ci_repository_owners: ["GET /api/v0/automations/ci/repository-owners"],
      rest_list_ci_jobs: ["GET /api/v0/automations/ci/jobs"],
      rest_list_ci_runs: ["GET /api/v0/automations/ci/runs"],
      rest_edit_ci_workflow: ["POST /api/v0/automations/ci/edit"],
      rest_get_billing_limits: [],
      rest_set_billing_overage_preference: [],
      rest_list_organization_users: ["GET /api/v0/organization/users"],
      rest_invite_organization_user: ["POST /api/v0/organization/users/invite"],
      rest_remove_organization_user: ["DELETE /api/v0/organization/users"],
      rest_get_organization_global_limit: ["GET /api/v0/organization/usage/limits/global"],
      rest_set_organization_global_limit: ["PUT /api/v0/organization/usage/limits/global"],
      rest_get_organization_group_limits: ["GET /api/v0/organization/usage/limits/groups"],
      rest_set_organization_group_limits: ["PUT /api/v0/organization/usage/limits/groups"],
      rest_get_organization_user_limits: ["GET /api/v0/organization/usage/limits/users"],
      rest_set_organization_user_limits: ["PUT /api/v0/organization/usage/limits/users"],
      rest_list_organization_computer_secrets: ["GET /api/v0/organization/computer-secrets"],
      rest_update_organization_computer_secrets: ["PATCH /api/v0/organization/computer-secrets"],
      rest_list_organization_enterprise_control_history: [
        "GET /api/v0/organization/enterprise-controls/history",
      ],
      rest_list_service_accounts: ["GET /api/v0/service-accounts"],
      rest_create_service_account: ["POST /api/v0/service-accounts"],
      rest_get_service_account: ["GET /api/v0/service-accounts/{serviceAccountId}"],
      rest_update_service_account: ["PATCH /api/v0/service-accounts/{serviceAccountId}"],
      rest_delete_service_account: ["DELETE /api/v0/service-accounts/{serviceAccountId}"],
      rest_list_service_account_api_keys: [
        "GET /api/v0/service-accounts/{serviceAccountId}/api-keys",
      ],
      rest_create_service_account_api_key: [
        "POST /api/v0/service-accounts/{serviceAccountId}/api-keys",
      ],
      rest_rotate_service_account_api_key: [
        "POST /api/v0/service-accounts/{serviceAccountId}/api-keys/{keyId}/rotate",
      ],
      rest_revoke_service_account_api_key: [
        "POST /api/v0/service-accounts/{serviceAccountId}/api-keys/{keyId}/revoke",
      ],
    }

    const registered = new Set(descriptions.map((description) => description.id))

    // The table covers every registered entry exactly once.
    const tableKeys = Object.keys(ROUTES_BY_OPERATION).sort()

    expect(tableKeys).toEqual([...registered].sort())

    const published = new Set(fixture.operations)

    // No published route is claimed twice, and every non-empty route in the
    // table is a published OpenAPI operation. The four empty entries cover
    // non-OpenAPI endpoints (`/api/billing/limits`, overage preference, and
    // machine templates).
    const claimed: Array<string> = []

    for (const routes of Object.values(ROUTES_BY_OPERATION)) {
      for (const route of routes) {
        expect(published.has(route), route + " must be a published OpenAPI operation").toBe(true)
        claimed.push(route)
      }
    }

    const claimedSet = new Set(claimed)

    expect(claimedSet.size).toBe(claimed.length)
    expect(claimed).toHaveLength(77)

    for (const operation of fixture.operations) {
      expect(claimedSet.has(operation), operation + " must be covered by a registered entry").toBe(
        true,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end invocation across every domain
// ---------------------------------------------------------------------------

describe("end-to-end invocation against the fake hosted API", () => {
  const invokeOk = async (
    services: ReturnType<typeof makeServices>,
    catalog: Parameters<typeof services.capabilities.invoke>[0],
    who: Invocation,
    id: string,
    input: Schema.Json,
  ): Promise<Schema.Json> => {
    const released = expectSuccess(await runEffect(invokeJson(services, catalog, who, id, input)))

    return jsonOf(released)
  }

  it("reads computers, environments, sessions, wiki, ci, billing, organization and service accounts", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "reader")

    const computers = await invokeOk(services, catalog, who, "rest_list_computers", {})
    expect(computers).toMatchObject({ computers: expect.any(Array) })

    const environments = await invokeOk(services, catalog, who, "rest_list_environments", {})
    expect(environments).toMatchObject({ environments: expect.any(Array) })

    const sessions = await invokeOk(services, catalog, who, "rest_list_remote_sessions", {})
    expect(sessions).toMatchObject({ sessions: expect.any(Array) })

    const wikiRuns = await invokeOk(services, catalog, who, "rest_list_wiki_runs", {})
    expect(wikiRuns).toMatchObject({ runs: expect.any(Array) })

    const ciJobs = await invokeOk(services, catalog, who, "rest_list_ci_jobs", {})
    expect(ciJobs).toBeDefined()

    const billing = await invokeOk(services, catalog, who, "rest_get_billing_limits", {})
    expect(billing).toMatchObject({ usesTokenRateLimitsBilling: true })

    const users = await invokeOk(services, catalog, who, "rest_list_organization_users", {})
    expect(users).toMatchObject({ users: expect.any(Array) })

    const accounts = await invokeOk(services, catalog, who, "rest_list_service_accounts", {})
    expect(accounts).toMatchObject({ serviceAccounts: expect.any(Array) })
  })

  it("sends the bearer credential on every request without leaking it", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "credentialed")

    await invokeOk(services, catalog, who, "rest_get_billing_limits", {})

    const last = api.last()

    expect(last?.headers.authorization).toBe("Bearer " + CREDENTIAL)
  })

  it("creates, mutates and deletes a computer end to end", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "writer")

    const created = await invokeOk(services, catalog, who, "rest_create_computer", {
      name: "workstation",
    })

    expect(created).toMatchObject({ name: "workstation" })

    const computerId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(created).id

    const updated = await invokeOk(services, catalog, who, "rest_update_computer", {
      computerId,
      body: { name: "renamed" },
    })

    expect(updated).toMatchObject({ name: "renamed" })

    const restartedExit = await runEffect(
      invokeJson(services, catalog, who, "rest_restart_computer", { computerId }),
    )

    const restartedReleased = expectSuccess(restartedExit)

    expect(restartedReleased.payload).toEqual(ReleasePayload.Empty())

    const deletedExit = await runEffect(
      invokeJson(services, catalog, who, "rest_delete_computer", { computerId }),
    )

    const deletedReleased = expectSuccess(deletedExit)

    // A 204 empty success releases as the Empty payload, never as JSON null.
    expect(deletedReleased.payload).toEqual(ReleasePayload.Empty())
  })

  it("creates an environment and retries its build", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "env-writer")

    const created = await invokeOk(services, catalog, who, "rest_create_environment", {
      body: {
        name: "staging",
        repositories: [{ url: "https://example.test/repo", script: "make build" }],
      },
    })

    expect(created).toMatchObject({ id: expect.any(String), buildId: expect.any(String) })

    const createdEnv = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, buildId: Schema.String }),
    )(created)

    const environmentId = createdEnv.id
    const buildId = createdEnv.buildId

    const cancelledExit = await runEffect(
      invokeJson(services, catalog, who, "rest_cancel_environment_build", {
        environmentId,
        buildId,
      }),
    )

    expectSuccess(cancelledExit)

    const retried = await invokeOk(services, catalog, who, "rest_retry_environment_build", {
      environmentId,
    })

    expect(retried).toMatchObject({ id: environmentId, buildId: expect.any(String) })
  })

  it("creates a remote session, posts a message and deletes the session", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "session-writer")

    const created = await invokeOk(services, catalog, who, "rest_create_remote_session", {
      body: { computerId: "c-1" },
    })

    const sessionId = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(
      created,
    ).sessionId

    const posted = await invokeOk(services, catalog, who, "rest_post_remote_session_message", {
      sessionId,
      body: { text: "hello remote session" },
    })

    expect(posted).toMatchObject({ messageId: expect.any(String) })

    const messages = await invokeOk(services, catalog, who, "rest_list_remote_session_messages", {
      sessionId,
    })

    expect(messages).toMatchObject({ messages: expect.any(Array) })

    const deletedExit = await runEffect(
      invokeJson(services, catalog, who, "rest_delete_remote_session", { sessionId }),
    )

    expect(Exit.isSuccess(deletedExit)).toBe(true)
  })

  it("creates and deletes a wiki run", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "wiki-writer")

    const created = await invokeOk(services, catalog, who, "rest_create_wiki_run", {
      body: { repoUrl: "https://example.test/repo" },
    })

    expect(created).toBeDefined()

    const deletedExit = await runEffect(
      invokeJson(services, catalog, who, "rest_delete_wiki_run", { wikiRunId: "w-1" }),
    )

    expect(Exit.isSuccess(deletedExit)).toBe(true)
  })

  it("sends nested wiki search terms and extra query values on the wire", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "wiki-search")

    const result = await invokeOk(services, catalog, who, "rest_search_wiki_run", {
      wikiRunId: "w-1",
      query: { q: "fixture" },
    })

    expect(result).toMatchObject({ results: expect.any(Array) })
    expect(api.last()).toMatchObject({
      method: "GET",
      path: "/api/v0/wiki/w-1/search",
      query: "q=fixture",
      body: "",
    })

    await invokeOk(services, catalog, who, "rest_search_wiki_run", {
      wikiRunId: "w-1",
      query: { q: "a /+?", limit: 2, exact: false, tag: ["one", 3, true] },
    })

    expect(api.last()?.query).toBe("q=a%20%2F%2B%3F&limit=2&exact=false&tag=one&tag=3&tag=true")
  })

  it("lets the hosted API handle a wiki search without an optional query", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "wiki-search")

    const exit = await runEffect(
      invokeJson(services, catalog, who, "rest_search_wiki_run", { wikiRunId: "w-1" }),
    )

    expect(expectFailure(exit)).toBeInstanceOf(PeerFailure)
    expect(api.last()).toMatchObject({ path: "/api/v0/wiki/w-1/search", query: "" })
  })

  it.each<Schema.Json>([{ q: null }, { wikiRunId: "w-2" }, { q: "\uD800" }])(
    "rejects an invalid wiki search query %j before dispatch",
    async (query) => {
      const services = makeServices()
      const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
      const who = makeInvocation(services.callers, "wiki-search")

      const exit = await runEffect(
        invokeJson(services, catalog, who, "rest_search_wiki_run", { wikiRunId: "w-1", query }),
      )

      expect(expectFailure(exit)).toBeInstanceOf(InvalidInput)
      expect(api.requests).toHaveLength(0)
    },
  )

  it("forwards the upload media type and permits extra body and query fields", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "file-upload")
    const file = { computerId: "c-1", fileName: "notes.txt" }
    const body = { sizeBytes: 4, contentType: "text/plain" }

    const result = await invokeOk(services, catalog, who, "rest_create_computer_file_upload", {
      ...file,
      body,
    })

    expect(result).toMatchObject({ transferId: expect.any(String) })
    expect(api.last()).toMatchObject({
      method: "POST",
      path: "/api/v0/computers/c-1/files/notes.txt/create-upload",
      query: "",
      body: JSON.stringify(body),
    })

    const extendedBody = {
      ...body,
      contentType: "text/plain; charset=utf-8",
      metadata: { note: true },
    }

    await invokeOk(services, catalog, who, "rest_create_computer_file_upload", {
      ...file,
      body: extendedBody,
      query: { trace: true },
    })

    expect(api.last()).toMatchObject({
      query: "trace=true",
      body: JSON.stringify(extendedBody),
    })
  })

  it.each<Schema.Json>([
    { sizeBytes: 4, contentType: "" },
    { sizeBytes: -1, contentType: "text/plain" },
    { sizeBytes: 4 },
  ])("rejects an invalid upload body %j before dispatch", async (body) => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "file-upload")

    const exit = await runEffect(
      invokeJson(services, catalog, who, "rest_create_computer_file_upload", {
        computerId: "c-1",
        fileName: "notes.txt",
        body,
      }),
    )

    expect(expectFailure(exit)).toBeInstanceOf(InvalidInput)
    expect(api.requests).toHaveLength(0)
  })

  it("edits a ci workflow", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "ci-writer")

    const edited = await invokeOk(services, catalog, who, "rest_edit_ci_workflow", {
      body: { repoUrl: "https://github.com/acme/app", action: "enable" },
    })

    expect(edited).toBeDefined()

    expect(api.state.ciPullRequests.length).toBe(1)
  })

  it("sets the billing overage preference", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "billing-writer")

    const result = await invokeOk(services, catalog, who, "rest_set_billing_overage_preference", {
      body: { overagePreference: "extraUsage" },
    })

    expect(result).toMatchObject({ ok: true, overagePreference: "extraUsage" })
  })

  it("sets organization limits", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "org-writer")

    const global = await invokeOk(services, catalog, who, "rest_set_organization_global_limit", {
      body: { limit: 5_000_000 },
    })

    expect(global).toMatchObject({ limit: 5_000_000 })
  })

  it("creates and revokes a service account api key", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "sa-writer")

    const created = await invokeOk(services, catalog, who, "rest_create_service_account_api_key", {
      serviceAccountId: "sa-1",
      body: { name: "deploy" },
    })

    expect(created).toMatchObject({ notice: expect.any(String) })

    const keys = await invokeOk(services, catalog, who, "rest_list_service_account_api_keys", {
      serviceAccountId: "sa-1",
    })

    const keyList = Schema.decodeUnknownSync(
      Schema.Struct({ apiKeys: Schema.Array(Schema.Struct({ id: Schema.String })) }),
    )(keys).apiKeys

    const minted = keyList.find((key) => key.id !== "key-1")

    expect(minted).toBeDefined()

    if (minted !== undefined) {
      const revokedExit = await runEffect(
        invokeJson(services, catalog, who, "rest_revoke_service_account_api_key", {
          serviceAccountId: "sa-1",
          keyId: minted.id,
        }),
      )

      expect(Exit.isSuccess(revokedExit)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Nested target id validation
// ---------------------------------------------------------------------------

describe("nested target id validation", () => {
  it.each([
    ["../secret", "traversal"],
    ["id/sub", "slash"],
    ["id?foo=1", "question mark"],
    ["id#frag", "hash"],
    ["id with space", "whitespace"],
  ])("rejects computer id %s (%s) with InvalidInput before any request", async (computerId) => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "nested-check")

    const before = api.requests.length

    const exit = await runEffect(
      invokeJson(services, catalog, who, "rest_get_computer", { computerId }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(InvalidInput)
    expect(api.requests.length).toBe(before)
  })

  it("rejects a traversal buildId nested inside a deeper path before any request", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "nested-check-deep")

    const before = api.requests.length

    const exit = await runEffect(
      invokeJson(services, catalog, who, "rest_get_environment_build_attempt_diagnostics", {
        environmentId: "e-docs",
        buildId: "../secret",
      }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(InvalidInput)
    expect(api.requests.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Empty vs null result preservation
// ---------------------------------------------------------------------------

describe("absent, empty and null result preservation", () => {
  it("preserves a 204 empty reply as the Empty payload", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "empty-check")

    api.failNext("DELETE /api/v0/computers/{computerId}", 204)

    const released = expectSuccess(
      await runEffect(
        invokeJson(services, catalog, who, "rest_delete_computer", { computerId: "c-1" }),
      ),
    )

    expect(released.payload).toEqual(ReleasePayload.Empty())
  })

  it("preserves a literal JSON null reply as JSON null, distinct from empty", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "null-check")

    api.failNext("GET /api/v0/computers", 200, null)

    const released = expectSuccess(
      await runEffect(invokeJson(services, catalog, who, "rest_list_computers", {})),
    )

    const payload = released.payload

    expect(payload).not.toEqual(ReleasePayload.Empty())

    const json = jsonOf(released)

    expect(json).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

describe("bound failure vocabulary", () => {
  it("maps 404 onto TargetUnavailable", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "failure-check")

    const exit = await runEffect(
      invokeJson(services, catalog, who, "rest_get_computer", { computerId: "missing" }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(TargetUnavailable)
  })

  it("maps 403 onto OperationDenied", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "denied-check")

    api.state.sessionGate = "sessions disabled for this test"

    const exit = await runEffect(
      invokeJson(services, catalog, who, "rest_list_remote_sessions", {}),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(OperationDenied)

    if (error instanceof OperationDenied) {
      expect(error.reason).toBe("http_403")
    }
  })

  it("maps a 4xx rejection onto PeerFailure", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "rejection-check")

    api.failNext("POST /api/v0/computers", 400, {
      detail: "name is required",
      status: 400,
      title: "Bad Request",
    })

    const rejected = await runEffect(
      invokeJson(services, catalog, who, "rest_create_computer", { name: "valid-name" }),
    )

    const error = expectFailure(rejected)

    expect(error).toBeInstanceOf(PeerFailure)
  })

  it("maps malformed JSON onto MalformedPeerReply", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "badreply-check")

    api.failNext("GET /api/v0/computers", 200, "this is not json {")

    const exit = await runEffect(invokeJson(services, catalog, who, "rest_list_computers", {}))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(MalformedPeerReply)
  })

  it("never retries a mutation after a timeout; the single request stays uncertain", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "timeout-check")

    // Hang the create-computer route beyond the configured 500ms timeout.
    api.route(
      "POST /api/v0/computers",
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ json: { computer: {} } }), 5_000)
        }),
    )

    const before = api.requests.length

    const exit = await Effect.runPromiseExit(
      invokeJson(services, catalog, who, "rest_create_computer", { name: "slow" }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(DeliveryUncertain)

    // Exactly one request reached the server; nothing retried the mutation.
    expect(api.requests.length).toBe(before + 1)
  })

  it("maps a refused redirect onto DeliveryUncertain and never follows it cross-origin", async () => {
    const other = await startFakeFactoryApi()

    try {
      const services = makeServices()
      const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
      const who = makeInvocation(services.callers, "redirect-check")

      api.route("GET /api/v0/computers", () => ({
        status: 302,
        headers: { location: other.baseUrl + "/api/v0/computers" },
      }))

      const exit = await runEffect(invokeJson(services, catalog, who, "rest_list_computers", {}))
      const error = expectFailure(exit)

      expect(error).toBeInstanceOf(DeliveryUncertain)
      expect(other.requests.length).toBe(0)
    } finally {
      await other.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Secret classification
// ---------------------------------------------------------------------------

describe("request secret and minted value classification", () => {
  it("scrubs computer-secret upsert values from error detail", async () => {
    const secretValue = "scrubbed-upsert-value-0123456789"
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "secret-scrub")

    // The fake echoes the offending key=value pair in its 400 detail; the
    // override makes a POSIX-clean key reach that path so the test proves the
    // value never crosses back into the failure text.
    api.route("PATCH /api/v0/organization/computer-secrets", () => ({
      status: 400,
      json: {
        detail: "cannot store NEW_KEY=" + secretValue + ": rejected upstream",
        status: 400,
        title: "Bad Request",
      },
    }))

    const exit = await runEffect(
      invokeJson(services, catalog, who, "rest_update_organization_computer_secrets", {
        body: {
          upsert: [{ key: "NEW_KEY", value: secretValue }],
          delete: [],
        },
      }),
    )

    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(PeerFailure)

    if (error instanceof PeerFailure) {
      expect(error.message).not.toContain(secretValue)
      expect(error.detail ?? "").not.toContain(secretValue)
    }
  })

  it("never exposes a minted api key value in the client release", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "mint-check")

    const before = api.state.mintedKeyValues.length

    const released = expectSuccess(
      await runEffect(
        invokeJson(services, catalog, who, "rest_create_service_account_api_key", {
          serviceAccountId: "sa-1",
          body: { name: "minted-test" },
        }),
      ),
    )

    const minted = api.state.mintedKeyValues.slice(before)

    expect(minted.length).toBe(1)

    const serialized = JSON.stringify(released.payload)

    for (const value of minted) {
      expect(serialized).not.toContain(value)
    }

    const json = jsonOf(released)

    expect(json).toMatchObject({ notice: expect.any(String) })
  })

  it("never leaks the bearer credential in a failure message", async () => {
    const services = makeServices()
    const catalog = expectSuccess(await runEffect(bindCatalog(services, installation(api))))
    const who = makeInvocation(services.callers, "credential-leak-check")

    api.failNext("GET /api/v0/computers", 500, {
      detail: "upstream echoed credential " + CREDENTIAL,
      status: 500,
      title: "Error",
    })

    const exit = await runEffect(invokeJson(services, catalog, who, "rest_list_computers", {}))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(TargetUnavailable)

    if (error instanceof TargetUnavailable) {
      expect(error.message).not.toContain(CREDENTIAL)
    }
  })
})

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe("remote facets", () => {
  it("returns typed remote session facets without any daemon dependency", async () => {
    const services = makeServices()

    const facets = expectSuccess(await runEffect(services.hosted.facets(installation(api))))
    const kinds = facets.map((facet) => facet.kind).sort()

    expect(kinds).toEqual([
      "remote_session_interrupt",
      "remote_session_launch",
      "remote_session_send",
      "remote_session_status",
      "remote_session_stop",
    ])

    for (const facet of facets) {
      expect(facet.supported).toBe(true)
    }
  })

  it("fails facet lookup with HostedUnavailable for an invalid origin", async () => {
    const services = makeServices()

    const exit = await runEffect(services.hosted.facets({ origin: "not a url" }))
    const error = expectFailure(exit)

    expect(error).toBeInstanceOf(HostedUnavailable)
  })
})

// ---------------------------------------------------------------------------
// Guidance gate
// ---------------------------------------------------------------------------

describe("guidance requirement", () => {
  it("requires the guide receipt when the installation marks guidanceRequired", async () => {
    const services = makeServices({ guidanceRequired: true })

    const catalog = expectSuccess(
      await runEffect(bindCatalog(services, installation(api, { guidanceRequired: true }))),
    )

    const who = makeInvocation(services.callers, "guidance-check")

    const denied = await runEffect(invokeJson(services, catalog, who, "rest_list_computers", {}))

    expect(Exit.isFailure(denied)).toBe(true)

    deliverRoot(services.guidance, who.conversation)

    const allowed = await runEffect(invokeJson(services, catalog, who, "rest_list_computers", {}))

    expect(Exit.isSuccess(allowed)).toBe(true)
  })
})

describe("path segment encoding", () => {
  it("refuses an unencodable segment before any request is sent", async () => {
    expect(segment("..")).toBeUndefined()
    expect(segment("\ud800")).toBeUndefined()
    expect(joinPath("/api", undefined, "/x")).toBeUndefined()
    expect(joinPath("/api", "/ok")).toBe("/api/ok")

    const sent: Array<string> = []

    const transport: HostedTransport = {
      secretValues: () => Effect.succeed([]),
      send: (request) => {
        sent.push(request.path)

        return Effect.die("send should not run")
      },
    }

    const exit = await Effect.runPromiseExit(
      exchange(transport, "rest_get", { method: "GET", path: undefined, query: [] }),
    )

    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined

    expect(sent).toEqual([])
    expect(failure).toBeInstanceOf(InvalidInput)
  })
})
