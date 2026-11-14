import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

export type Json = Schema.Json

export interface JsonObject {
  readonly [key: string]: Json
}

/** What a route answers. Exactly one of `json`, `text`, or `bytes` is used; none means no body. */
export interface FakeReply {
  readonly status?: number
  readonly json?: Json
  readonly text?: string
  readonly bytes?: Uint8Array
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface RecordedRequest {
  readonly method: string
  /** The raw, still-encoded path. */
  readonly path: string
  /** The raw query string without `?`, or "". */
  readonly query: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** The matched `METHOD /template`, if any. */
  readonly route: string | undefined
}

export interface FakeRequest extends RecordedRequest {
  /** Decoded path parameters by placeholder name. */
  readonly params: Readonly<Record<string, string>>
  readonly searchParams: URLSearchParams
  readonly json: Json | undefined
}

export interface FakeState {
  readonly computers: Map<string, JsonObject>
  /** GET reads per computer id; a `provisioning` computer turns `active` on its second read. */
  readonly computerReads: Map<string, number>
  readonly templates: Map<string, JsonObject>
  readonly transfers: Map<string, JsonObject>
  readonly environments: Map<string, JsonObject>
  readonly builds: Map<string, JsonObject>
  readonly sessions: Map<string, JsonObject>
  /** Messages per session id, oldest first. */
  readonly messages: Map<string, Array<JsonObject>>
  defaultEnvironmentId: string | undefined
  /** When set, every `/api/v0/sessions` route answers 403 with this detail. */
  sessionGate: string | undefined
  readonly wikiRuns: Map<string, JsonObject>
  /** Pull requests `POST /api/v0/automations/ci/edit` opened, oldest first. */
  readonly ciPullRequests: Array<JsonObject>
  /** Members by email. */
  readonly users: Map<string, JsonObject>
  readonly invites: Map<string, JsonObject>
  overagePreference: "droidCore" | "extraUsage" | null
  canManageOverage: boolean
  extraUsageBalanceCents: number
  globalLimit: number | null
  readonly groupLimits: Map<string, JsonObject>
  /** Individual limit overrides by email. */
  readonly userLimits: Map<string, number>
  /** Organization computer secrets, key to value; only keys are ever served. */
  readonly computerSecrets: Map<string, string>
  readonly serviceAccounts: Map<string, JsonObject>
  /** API key metadata by key id, each with its `serviceAccountId`. */
  readonly apiKeys: Map<string, JsonObject>
  /** Every one-time key value served, so tests can prove none reached a client. */
  readonly mintedKeyValues: Array<string>
  nextId: number
}

export type RouteHandler = (
  request: FakeRequest,
  state: FakeState,
) => FakeReply | Promise<FakeReply>

export interface FakeFactoryApi {
  readonly baseUrl: string
  readonly requests: ReadonlyArray<RecordedRequest>
  readonly state: FakeState
  readonly last: () => RecordedRequest | undefined
  /** Adds or replaces a route for the current test; `reset` drops it. */
  readonly route: (key: string, handler: RouteHandler) => void
  /** The next request matching `key` gets this reply instead of the route's. */
  readonly failNext: (
    key: string,
    status: number,
    body?: Json | string,
    headers?: Readonly<Record<string, string>>,
  ) => void
  readonly reset: () => void
  readonly close: () => Promise<void>
}

/** The `FactoryApiError` body the published contract uses on every non-2xx. */
const apiError = (status: number, detail: string, title = "Error"): FakeReply => ({
  status,
  json: { detail, status, title },
})

export const SEED_COMPUTER: JsonObject = {
  id: "c-1",
  name: "box",
  hostname: "box.local",
  providerType: "byom",
  status: "active",
  createdAt: 1,
  relayClientUrl: "wss://relay.example/c-1",
  remoteUser: "dev",
}

export const SEED_TEMPLATE: JsonObject = {
  templateId: "t-1",
  repoUrl: "github.com/acme/app",
  templateName: "app",
  defaultBranch: "main",
  createdBy: "user-1",
  createdAt: 1,
  buildStatus: { status: "success" },
  lastUpdatedAt: 2,
}

export const SEED_SESSION: JsonObject = {
  sessionId: "s-1",
  title: "add a test",
  status: "idle",
  messageCount: 4,
  createdAt: 1,
  updatedAt: 2,
  computerId: "c-1",
}

export const PR_AGENT_ID = "4d5cf2b0-f961-4b3e-a52e-1298524cfba4"

const SEED_SOURCE: JsonObject = {
  id: "src-1",
  name: "Factory cloud",
  supportsRepositories: true,
  supportsSetupScripts: true,
  provider: { id: "factory", name: "Factory" },
}

/** The Environment the motivating flow looks up by name. */
export const SEED_ENVIRONMENT: JsonObject = {
  id: PR_AGENT_ID,
  name: "pr-agent",
  scope: "organization",
  repositories: [{ url: "https://github.com/acme/app", branch: "main" }],
  setupScript: "pnpm install",
  source: SEED_SOURCE,
  currentBuildId: "build-2",
}

export const SEED_OTHER_ENVIRONMENT: JsonObject = {
  id: "e-docs",
  name: "docs-site",
  scope: "user",
  repositories: [{ url: "https://github.com/acme/docs", branch: "main" }],
  source: SEED_SOURCE,
  currentBuildId: "build-3",
}

/** `build-1` is an earlier failed attempt of `pr-agent`; `build-2` is its current, ready build. */
const SEED_BUILDS: ReadonlyArray<JsonObject> = [
  {
    buildId: "build-1",
    environmentId: PR_AGENT_ID,
    status: "failed",
    excerpt: "npm ERR! missing script: build",
  },
  { buildId: "build-2", environmentId: PR_AGENT_ID, status: "ready", excerpt: "build complete" },
  { buildId: "build-3", environmentId: "e-docs", status: "ready", excerpt: "build complete" },
]

/** `s-1` alternates roles so a role filter spans more than one page. */
const SEED_MESSAGES: ReadonlyArray<JsonObject> = (
  [
    ["msg-1", "user", "add a test"],
    ["msg-2", "assistant", "Looking at the suite."],
    ["msg-3", "tool", "ran vitest"],
    ["msg-4", "assistant", "Added the test."],
  ] as const
).map(([id, role, text], index) => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: index + 1,
  updatedAt: index + 1,
  seq: index + 1,
}))

export const SESSION_GATING_DETAIL =
  "Droid sessions API is not enabled for this organization. Contact Factory support."

const byKey = (key: string, items: ReadonlyArray<JsonObject>): Map<string, JsonObject> =>
  new Map(items.map((item) => [String(item[key]), item]))

const seedState = (): FakeState => ({
  computers: byKey("id", [SEED_COMPUTER]),
  computerReads: new Map(),
  templates: byKey("templateId", [SEED_TEMPLATE]),
  transfers: new Map(),
  environments: byKey("id", [SEED_ENVIRONMENT, SEED_OTHER_ENVIRONMENT]),
  builds: byKey("buildId", SEED_BUILDS),
  sessions: byKey("sessionId", [SEED_SESSION]),
  messages: new Map([[String(SEED_SESSION.sessionId), [...SEED_MESSAGES]]]),
  defaultEnvironmentId: PR_AGENT_ID,
  sessionGate: undefined,
  wikiRuns: byKey("id", [SEED_WIKI_RUN]),
  ciPullRequests: [],
  users: byKey("email", SEED_USERS),
  invites: new Map(),
  overagePreference: "droidCore",
  canManageOverage: true,
  extraUsageBalanceCents: 0,
  globalLimit: 2_000_000,
  groupLimits: byKey("groupId", SEED_GROUP_LIMITS),
  userLimits: new Map([["grace@example.test", 3_000_000]]),
  computerSecrets: new Map([["NPM_TOKEN", "seed-npm-token-value"]]),
  serviceAccounts: byKey("id", [SEED_SERVICE_ACCOUNT]),
  apiKeys: byKey("id", [{ ...SEED_API_KEY, serviceAccountId: "sa-1" }]),
  mintedKeyValues: [],
  nextId: 2,
})

const page = (key: string, items: ReadonlyArray<JsonObject>): FakeReply => ({
  json: { [key]: [...items], pagination: { hasMore: false, nextCursor: null } },
})

const notFound = (what: string): FakeReply => apiError(404, what + " not found", "Not Found")

const badRequest = (detail: string): FakeReply => apiError(400, detail, "Bad Request")

const conflict = (detail: string): FakeReply => apiError(409, detail, "Conflict")

const isJsonObject = (value: Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const objectOf = (value: Json | undefined): JsonObject => (isJsonObject(value) ? value : {})

const bodyOf = (request: FakeRequest): JsonObject => objectOf(request.json)

const paramOf = (request: FakeRequest, name: string): string => request.params[name] ?? ""

const nextId = (state: FakeState, prefix: string): string => prefix + String(state.nextId++)

/** Transfer URLs point back at this fake so a test can prove nothing fetched them. */
const originOf = (request: FakeRequest): string => "http://" + (request.headers.host ?? "")

const TRANSFER_EXPIRES_AT = 1_900_000_000_000

/** Cursors carry reserved characters so tests prove they survive query encoding. */
const cursorAt = (offset: number): string => "page/" + String(offset) + "?&=#"

const CURSOR = /^page\/(\d+)\?&=#$/

const COMPUTER_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  [
    "GET /api/v0/computers",
    (_request, state) => ({ json: { computers: [...state.computers.values()] } }),
  ],
  [
    "POST /api/v0/computers",
    (request, state) => {
      const body = bodyOf(request)

      if (!Predicate.isString(body.name)) {
        return badRequest("name is required")
      }

      const id = nextId(state, "c-")
      const source = isJsonObject(body.source) ? body.source : undefined

      const computer: JsonObject = {
        id,
        name: body.name,
        providerType: Predicate.isString(body.provider) ? body.provider : "byom",
        status: "provisioning",
        createdAt: Date.now(),
        isListed: Predicate.isBoolean(source?.isListed) ? source.isListed : true,
      }

      state.computers.set(id, computer)

      return { status: 201, json: computer }
    },
  ],
  [
    "POST /api/v0/computers/bulk",
    (request, state) => {
      const body = bodyOf(request)

      if (!Predicate.isNumber(body.quantity) || !Predicate.isString(body.namePrefix)) {
        return badRequest("quantity and namePrefix are required")
      }

      const computers: Array<JsonObject> = []

      for (let index = 1; index <= body.quantity; index++) {
        const id = nextId(state, "c-")

        const computer: JsonObject = {
          id,
          name: body.namePrefix + "-" + String(index),
          providerType: Predicate.isString(body.provider) ? body.provider : "byom",
          status: "provisioning",
          createdAt: Date.now(),
        }

        state.computers.set(id, computer)
        computers.push(computer)
      }

      return { status: 201, json: { computers, requestedQuantity: body.quantity } }
    },
  ],
  ["GET /api/v0/computers/providers", () => ({ json: { providers: ["byom", "e2b", "daytona"] } })],
  [
    "GET /api/v0/computers/name/{name}",
    (request, state) => {
      const name = paramOf(request, "name")
      const computer = [...state.computers.values()].find((each) => each.name === name)

      return computer === undefined ? notFound("computer") : { json: computer }
    },
  ],
  [
    "GET /api/v0/computers/{computerId}",
    (request, state) => {
      const id = paramOf(request, "computerId")
      const computer = state.computers.get(id)

      if (computer === undefined) return notFound("computer")

      const reads = (state.computerReads.get(id) ?? 0) + 1

      state.computerReads.set(id, reads)

      if (computer.status !== "provisioning" || reads < 2) return { json: computer }

      const ready: JsonObject = { ...computer, status: "active" }

      state.computers.set(id, ready)

      return { json: ready }
    },
  ],
  [
    "PATCH /api/v0/computers/{computerId}",
    (request, state) => {
      const id = paramOf(request, "computerId")
      const computer = state.computers.get(id)

      if (computer === undefined) return notFound("computer")

      const updated: JsonObject = { ...computer, ...bodyOf(request) }

      state.computers.set(id, updated)

      return { json: updated }
    },
  ],
  [
    "DELETE /api/v0/computers/{computerId}",
    (request, state) =>
      state.computers.delete(paramOf(request, "computerId"))
        ? { status: 204 }
        : notFound("computer"),
  ],
  [
    "POST /api/v0/computers/{computerId}/restart",
    (request, state) =>
      state.computers.has(paramOf(request, "computerId"))
        ? { json: { wasRestarted: true } }
        : notFound("computer"),
  ],
  [
    "POST /api/v0/computers/{computerId}/refresh",
    (request, state) =>
      state.computers.has(paramOf(request, "computerId"))
        ? { json: { configured: 2, secretsConfigured: 1 } }
        : notFound("computer"),
  ],
  [
    "POST /api/v0/computers/{computerId}/install-deps",
    (request, state) => {
      const id = paramOf(request, "computerId")
      const computer = state.computers.get(id)

      if (computer === undefined) return notFound("computer")

      if (computer.status === "provisioning") {
        return conflict("dependencies are already being installed on " + id)
      }

      const installing: JsonObject = { ...computer, status: "provisioning" }

      state.computers.set(id, installing)

      return { status: 202, json: installing }
    },
  ],
  [
    "POST /api/v0/computers/{computerId}/activity",
    (request, state) =>
      state.computers.has(paramOf(request, "computerId"))
        ? { json: { lastActiveAt: 1_700_000_000_000 } }
        : notFound("computer"),
  ],
  [
    "GET /api/v0/computers/{computerId}/metrics",
    (request, state) =>
      state.computers.has(paramOf(request, "computerId"))
        ? { json: [{ timestamp: 1, cpuPercent: 3 }] }
        : notFound("computer"),
  ],
  [
    "POST /api/v0/computers/{computerId}/files/{fileName}/create-upload",
    (request, state) => {
      const computerId = paramOf(request, "computerId")
      const body = bodyOf(request)

      if (!state.computers.has(computerId)) return notFound("computer")

      if (paramOf(request, "fileName").includes("/")) {
        return badRequest("fileName may not contain a slash")
      }

      if (!Predicate.isNumber(body.sizeBytes) || !Predicate.isString(body.contentType)) {
        return badRequest("sizeBytes and contentType are required")
      }

      const transferId = nextId(state, "tr-")

      state.transfers.set(transferId, {
        transferId,
        computerId,
        fileName: paramOf(request, "fileName"),
        sizeBytes: body.sizeBytes,
        completed: false,
      })

      return {
        json: {
          transferId,
          expiresAt: TRANSFER_EXPIRES_AT,
          uploadUrl: originOf(request) + "/uploads/" + transferId,
          uploadFormFields: { key: "uploads/" + transferId, policy: "signed-policy" },
        },
      }
    },
  ],
  [
    "POST /api/v0/computers/{computerId}/files/{fileName}/complete-upload",
    (request, state) => {
      const body = bodyOf(request)

      if (!Predicate.isString(body.transferId) || !Predicate.isString(body.sessionId)) {
        return badRequest("transferId and sessionId are required")
      }

      if (Predicate.isString(body.destPath) && body.destPath.startsWith("/")) {
        return badRequest("destPath must be relative")
      }

      const transfer = state.transfers.get(body.transferId)

      if (
        transfer === undefined ||
        transfer.computerId !== paramOf(request, "computerId") ||
        transfer.fileName !== paramOf(request, "fileName")
      ) {
        return notFound("transfer")
      }

      if (transfer.completed === true) {
        return conflict("transfer " + body.transferId + " was already completed")
      }

      state.transfers.set(body.transferId, { ...transfer, completed: true })

      return {
        json: {
          transferId: body.transferId,
          fileName: transfer.fileName ?? "",
          byteLength: transfer.sizeBytes ?? 0,
        },
      }
    },
  ],
  [
    "POST /api/v0/computers/{computerId}/files/{fileName}/create-download",
    (request, state) => {
      if (!state.computers.has(paramOf(request, "computerId"))) return notFound("computer")

      if (!Predicate.isString(bodyOf(request).sessionId)) {
        return badRequest("sessionId is required")
      }

      const transferId = nextId(state, "tr-")

      return {
        json: {
          transferId,
          expiresAt: TRANSFER_EXPIRES_AT,
          downloadUrl: originOf(request) + "/downloads/" + transferId,
          byteLength: 42,
        },
      }
    },
  ],
  [
    "GET /api/v0/machines/templates",
    (_request, state) => page("templates", [...state.templates.values()]),
  ],
  [
    "GET /api/v0/machines/templates/{templateId}",
    (request, state) => {
      const template = state.templates.get(paramOf(request, "templateId"))

      return template === undefined ? notFound("template") : { json: template }
    },
  ],
]

const startBuild = (state: FakeState, environmentId: string): string => {
  const buildId = nextId(state, "b-")

  state.builds.set(buildId, { buildId, environmentId, status: "building", excerpt: "" })

  return buildId
}

const diagnosticsOf = (build: JsonObject): FakeReply => ({
  json: {
    buildId: build.buildId ?? "",
    status: build.status ?? "building",
    excerpt: build.excerpt ?? "",
    truncated: false,
    withheld: false,
  },
})

const ENVIRONMENT_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  [
    "GET /api/v0/environments",
    (_request, state) => ({
      json: {
        environments: [...state.environments.values()],
        defaultEnvironmentId: state.defaultEnvironmentId ?? null,
        hiddenOrganizationEnvironmentCount: 0,
      },
    }),
  ],
  [
    "POST /api/v0/environments",
    (request, state) => {
      const body = bodyOf(request)

      if (!Predicate.isString(body.name) || !Array.isArray(body.repositories)) {
        return badRequest("name and repositories are required")
      }

      // Both published repository shapes require a url and a script.
      if (
        !body.repositories.every((repository) =>
          Schema.is(Schema.Struct({ url: Schema.String, script: Schema.String }))(repository),
        )
      ) {
        return badRequest("each repository needs a url and a script")
      }

      const id = nextId(state, "e-")
      const buildId = startBuild(state, id)

      state.environments.set(id, {
        id,
        name: body.name,
        scope: Predicate.isString(body.scope) ? body.scope : "user",
        repositories: body.repositories,
        source: SEED_SOURCE,
        currentBuildId: buildId,
      })

      if (body.makeOrganizationDefault === true) state.defaultEnvironmentId = id

      return { status: 201, json: { id, buildId } }
    },
  ],
  [
    "POST /api/v0/environments/default",
    (_request, state) => {
      const current = state.defaultEnvironmentId

      if (current !== undefined && state.environments.has(current)) return { status: 204 }

      const id = nextId(state, "e-")
      const buildId = startBuild(state, id)

      state.environments.set(id, {
        id,
        name: "Default",
        scope: "user",
        repositories: [],
        source: SEED_SOURCE,
        currentBuildId: buildId,
      })
      state.defaultEnvironmentId = id

      return { status: 204 }
    },
  ],
  [
    "PUT /api/v0/environments/default",
    (request, state) => {
      const { environmentId } = bodyOf(request)

      if (!Predicate.isString(environmentId)) return badRequest("environmentId is required")

      if (!state.environments.has(environmentId)) return notFound("environment")

      state.defaultEnvironmentId = environmentId

      return { json: { defaultEnvironmentId: environmentId } }
    },
  ],
  [
    "GET /api/v0/environments/source-options",
    () => ({
      json: {
        providers: [{ id: "factory", name: "Factory", sources: [SEED_SOURCE] }],
        unavailableProviders: [{ id: "e2b", name: "E2B", reason: "not configured" }],
      },
    }),
  ],
  [
    "GET /api/v0/environments/build-statuses",
    (request, state) => {
      const ids = request.searchParams.getAll("environmentIds")

      if (ids.length === 0) return badRequest("environmentIds is required")

      const builds = ids.flatMap((id) => {
        const build = state.builds.get(String(state.environments.get(id)?.currentBuildId))

        return build === undefined
          ? []
          : [{ environmentId: id, buildId: build.buildId ?? "", status: build.status ?? "" }]
      })

      return { json: { builds } }
    },
  ],
  [
    "GET /api/v0/environments/{environmentId}",
    (request, state) => {
      const environment = state.environments.get(paramOf(request, "environmentId"))

      return environment === undefined ? notFound("environment") : { json: environment }
    },
  ],
  [
    "PATCH /api/v0/environments/{environmentId}",
    (request, state) => {
      const id = paramOf(request, "environmentId")
      const environment = state.environments.get(id)

      if (environment === undefined) return notFound("environment")

      const buildId = startBuild(state, id)

      state.environments.set(id, { ...environment, ...bodyOf(request), currentBuildId: buildId })

      return { json: { id, buildId } }
    },
  ],
  [
    "DELETE /api/v0/environments/{environmentId}",
    (request, state) => {
      const id = paramOf(request, "environmentId")

      if (!state.environments.has(id)) return notFound("environment")

      if (id === state.defaultEnvironmentId) {
        return conflict("the default Environment cannot be deleted")
      }

      state.environments.delete(id)

      return { status: 204 }
    },
  ],
  [
    "GET /api/v0/environments/{environmentId}/build-diagnostics",
    (request, state) => {
      const environment = state.environments.get(paramOf(request, "environmentId"))
      const build = state.builds.get(String(environment?.currentBuildId))

      return build === undefined ? notFound("environment") : diagnosticsOf(build)
    },
  ],
  [
    "POST /api/v0/environments/{environmentId}/builds",
    (request, state) => {
      const id = paramOf(request, "environmentId")
      const environment = state.environments.get(id)

      if (environment === undefined) return notFound("environment")

      if (state.builds.get(String(environment.currentBuildId))?.status === "building") {
        return conflict("a build is already running for " + id)
      }

      const buildId = startBuild(state, id)

      state.environments.set(id, { ...environment, currentBuildId: buildId })

      return { json: { id, buildId } }
    },
  ],
  [
    "GET /api/v0/environments/{environmentId}/builds/{buildId}/diagnostics",
    (request, state) => {
      const build = state.builds.get(paramOf(request, "buildId"))

      return build === undefined || build.environmentId !== paramOf(request, "environmentId")
        ? notFound("build")
        : diagnosticsOf(build)
    },
  ],
  [
    "POST /api/v0/environments/{environmentId}/builds/{buildId}/cancel",
    (request, state) => {
      const buildId = paramOf(request, "buildId")
      const build = state.builds.get(buildId)

      if (build === undefined || build.environmentId !== paramOf(request, "environmentId")) {
        return notFound("build")
      }

      if (build.status !== "building") return conflict("build " + buildId + " is not running")

      state.builds.set(buildId, { ...build, status: "failed", excerpt: "cancelled" })

      return { status: 204 }
    },
  ],
]

const gated =
  (handler: RouteHandler): RouteHandler =>
  (request, state) =>
    state.sessionGate === undefined
      ? handler(request, state)
      : apiError(403, state.sessionGate, "Forbidden")

const sessionOf = (request: FakeRequest, state: FakeState): JsonObject | undefined =>
  state.sessions.get(paramOf(request, "sessionId"))

const SESSION_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  ["GET /api/v0/sessions", (_request, state) => page("sessions", [...state.sessions.values()])],
  [
    "POST /api/v0/sessions",
    (request, state) => {
      const body = bodyOf(request)

      if (!Predicate.isString(body.computerId)) return badRequest("computerId is required")

      const computer = state.computers.get(body.computerId)

      if (computer === undefined) return notFound("computer")

      if (computer.status !== "active") {
        return conflict("computer " + body.computerId + " is not active")
      }

      const sessionId = nextId(state, "s-")

      const session: JsonObject = {
        sessionId,
        title: "",
        status: "idle",
        messageCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        computerId: body.computerId,
        sessionSettings: objectOf(body.sessionSettings),
      }

      state.sessions.set(sessionId, session)
      state.messages.set(sessionId, [])

      return { status: 201, json: session }
    },
  ],
  [
    "GET /api/v0/sessions/{sessionId}",
    (request, state) => {
      const session = sessionOf(request, state)

      return session === undefined ? notFound("session") : { json: session }
    },
  ],
  [
    "PATCH /api/v0/sessions/{sessionId}",
    (request, state) => {
      const session = sessionOf(request, state)

      if (session === undefined) return notFound("session")

      const { sessionSettings } = bodyOf(request)

      const updated: JsonObject = {
        ...session,
        sessionSettings: { ...objectOf(session.sessionSettings), ...objectOf(sessionSettings) },
      }

      state.sessions.set(String(session.sessionId), updated)

      return { json: updated }
    },
  ],
  [
    "DELETE /api/v0/sessions/{sessionId}",
    (request, state) => {
      const id = paramOf(request, "sessionId")

      if (!state.sessions.delete(id)) return notFound("session")

      state.messages.delete(id)

      return { status: 204 }
    },
  ],
  [
    "POST /api/v0/sessions/{sessionId}/interrupt",
    (request, state) => {
      const session = sessionOf(request, state)

      if (session === undefined) return notFound("session")

      state.sessions.set(String(session.sessionId), { ...session, status: "idle" })

      return { json: { status: "idle" } }
    },
  ],
  [
    "GET /api/v0/sessions/{sessionId}/children",
    (request, state) => {
      const id = paramOf(request, "sessionId")

      if (!state.sessions.has(id)) return notFound("session")

      const sessions = [...state.sessions.values()].filter(
        (session) => session.parent_session_id === id,
      )

      return { json: { sessions } }
    },
  ],
  [
    "GET /api/v0/sessions/{sessionId}/messages",
    (request, state) => {
      const messages = state.messages.get(paramOf(request, "sessionId"))

      if (messages === undefined) return notFound("session")

      const role = request.searchParams.get("role")

      return pageOf(
        request,
        "messages",
        role === null ? messages : messages.filter((each) => each.role === role),
      )
    },
  ],
  [
    "POST /api/v0/sessions/{sessionId}/messages",
    (request, state) => {
      const session = sessionOf(request, state)
      const { text } = bodyOf(request)

      if (session === undefined) return notFound("session")

      if (!Predicate.isString(text)) return badRequest("text is required")

      const sessionId = String(session.sessionId)
      const messages = state.messages.get(sessionId) ?? []
      const messageId = nextId(state, "m-")

      messages.push({
        id: messageId,
        role: "user",
        content: [{ type: "text", text }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seq: messages.length + 1,
      })
      state.messages.set(sessionId, messages)
      state.sessions.set(sessionId, {
        ...session,
        status: "running",
        messageCount: messages.length,
      })

      return { json: { messageId, status: "running" } }
    },
  ],
  [
    "GET /api/v0/sessions/{sessionId}/messages/{messageId}",
    (request, state) => {
      const messageId = paramOf(request, "messageId")

      const message = state.messages
        .get(paramOf(request, "sessionId"))
        ?.find((each) => each.id === messageId)

      return message === undefined ? notFound("message") : { json: message }
    },
  ],
]

/** The bytes `GET /api/v0/wiki/{wikiRunId}/export` serves: a ZIP header plus bytes that are not UTF-8. */
export const WIKI_ZIP = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x7f, 0xc3,
])

export const SEED_WIKI_RUN: JsonObject = {
  id: "w-1",
  repoUrl: "https://github.com/acme/app",
  status: "completed",
  privacyLevel: "private",
  pages: [
    { id: "p-1", title: "Overview", content: "The app renders invoices." },
    { id: "p-2", title: "Setup", content: "Run pnpm install, then pnpm dev." },
  ],
}

const pagesOf = (run: JsonObject): ReadonlyArray<JsonObject> =>
  Array.isArray(run.pages) ? run.pages.map(objectOf) : []

const wikiRunOf = (request: FakeRequest, state: FakeState): JsonObject | undefined =>
  state.wikiRuns.get(paramOf(request, "wikiRunId"))

const WIKI_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  ["GET /api/v0/wiki", (_request, state) => ({ json: { runs: [...state.wikiRuns.values()] } })],
  [
    "POST /api/v0/wiki",
    (request, state) => {
      const { repoUrl } = bodyOf(request)

      if (!Predicate.isString(repoUrl)) return badRequest("repoUrl is required")

      const id = nextId(state, "w-")
      const run: JsonObject = { id, repoUrl, status: "running", privacyLevel: "private", pages: [] }

      state.wikiRuns.set(id, run)

      return { json: run }
    },
  ],
  [
    "GET /api/v0/wiki/history/{repoUrl}",
    (request, state) => {
      const repoUrl = paramOf(request, "repoUrl")

      return {
        json: {
          repoUrl,
          runs: [...state.wikiRuns.values()].filter((run) => run.repoUrl === repoUrl),
        },
      }
    },
  ],
  [
    "GET /api/v0/wiki/upload-access",
    (request) =>
      request.searchParams.has("repoUrl")
        ? { json: { allowed: true } }
        : badRequest("repoUrl is required"),
  ],
  [
    "POST /api/v0/wiki/video-upload-url",
    (request, state) => {
      const uploadId = nextId(state, "video-")

      return {
        json: {
          uploadUrl: originOf(request) + "/uploads/" + uploadId,
          expiresAt: TRANSFER_EXPIRES_AT,
        },
      }
    },
  ],
  [
    "GET /api/v0/wiki/{wikiRunId}",
    (request, state) => {
      const run = wikiRunOf(request, state)

      return run === undefined ? notFound("wiki run") : { json: run }
    },
  ],
  [
    "DELETE /api/v0/wiki/{wikiRunId}",
    (request, state) => {
      const id = paramOf(request, "wikiRunId")

      return state.wikiRuns.delete(id) ? { json: { id, deleted: true } } : notFound("wiki run")
    },
  ],
  [
    "GET /api/v0/wiki/{wikiRunId}/export",
    (request, state) =>
      wikiRunOf(request, state) === undefined
        ? notFound("wiki run")
        : { bytes: WIKI_ZIP, contentType: "application/zip" },
  ],
  [
    "GET /api/v0/wiki/{wikiRunId}/pages/{pageId}",
    (request, state) => {
      const run = wikiRunOf(request, state)
      const pageId = paramOf(request, "pageId")
      const found = run === undefined ? undefined : pagesOf(run).find((each) => each.id === pageId)

      return found === undefined ? notFound("wiki page") : { json: found }
    },
  ],
  [
    "GET /api/v0/wiki/{wikiRunId}/search",
    (request, state) => {
      const run = wikiRunOf(request, state)
      const term = request.searchParams.get("q")

      if (run === undefined) return notFound("wiki run")

      if (term === null) return badRequest("q is required")

      const results = pagesOf(run).filter(
        (each) => Predicate.isString(each.content) && each.content.includes(term),
      )

      return { json: { results } }
    },
  ],
  [
    "POST /api/v0/wiki/{wikiRunId}/privacy",
    (request, state) => {
      const run = wikiRunOf(request, state)
      const { privacyLevel } = bodyOf(request)

      if (run === undefined) return notFound("wiki run")

      if (!Predicate.isString(privacyLevel)) return badRequest("privacyLevel is required")

      const updated: JsonObject = { ...run, privacyLevel }

      state.wikiRuns.set(String(run.id), updated)

      return { json: updated }
    },
  ],
]

const SEED_CI_REPOSITORIES: ReadonlyArray<JsonObject> = [
  { repoUrl: "https://github.com/acme/app", owner: "acme", hasWorkflow: true },
  { repoUrl: "https://github.com/beta/site", owner: "beta", hasWorkflow: false },
]

const CI_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  [
    "GET /api/v0/automations/ci/scan",
    () => ({
      json: {
        repositories: SEED_CI_REPOSITORIES.map((repository) => ({
          repoUrl: repository.repoUrl ?? "",
          workflows: repository.hasWorkflow === true ? [".github/workflows/droid.yml"] : [],
        })),
      },
    }),
  ],
  [
    "GET /api/v0/automations/ci/repositories",
    (request) => {
      const owner = request.searchParams.get("owner")

      return {
        json: {
          repositories: SEED_CI_REPOSITORIES.filter(
            (repository) => owner === null || repository.owner === owner,
          ),
        },
      }
    },
  ],
  [
    "GET /api/v0/automations/ci/repository-owners",
    () => ({ json: { owners: [{ login: "acme" }, { login: "beta" }] } }),
  ],
  [
    "GET /api/v0/automations/ci/jobs",
    () => ({ json: { jobs: [{ id: "job-review", name: "review", trigger: "pull_request" }] } }),
  ],
  [
    "GET /api/v0/automations/ci/runs",
    (request) => ({
      json: {
        runs: [{ id: 101, jobId: request.searchParams.get("jobId"), conclusion: "success" }],
      },
    }),
  ],
  [
    "POST /api/v0/automations/ci/edit",
    (request, state) => {
      const body = bodyOf(request)

      if (!Predicate.isString(body.repoUrl) || !Predicate.isString(body.action)) {
        return badRequest("repoUrl and action are required")
      }

      const number = state.ciPullRequests.length + 1

      const pullRequest: JsonObject = {
        number,
        url: body.repoUrl + "/pull/" + String(number),
        action: body.action,
      }

      state.ciPullRequests.push(pullRequest)

      return { json: { pullRequest } }
    },
  ],
]

export const SEED_USERS: ReadonlyArray<JsonObject> = ["ada", "grace", "linus"].map(
  (name, index) => ({
    id: "user-" + String(index + 1),
    email: name + "@example.test",
    createdAt: "2026-01-0" + String(index + 1) + "T00:00:00.000Z",
    metadata: {},
  }),
)

const SEED_CHANGES: ReadonlyArray<JsonObject> = [3, 2, 1].map((revision) => ({
  revision,
  settings: { webSearchDisabled: revision % 2 === 1 },
  user: { id: "user-1", email: "ada@example.test", name: "Ada" },
  updatedAt: "2026-02-0" + String(revision) + "T00:00:00.000Z",
}))

const SEED_GROUP_LIMITS: ReadonlyArray<JsonObject> = [
  { groupId: "grp-eng", name: "Engineering", limit: 5_000_000 },
  { groupId: "grp-ops", name: "Operations", limit: null },
]

const MIN_LIMIT = 1_000_000

const SECRET_KEY = /^[A-Z_][A-Z0-9_]*$/

const isLimit = (value: Json | undefined): boolean =>
  value === null || (Predicate.isNumber(value) && Number.isInteger(value) && value >= MIN_LIMIT)

const secretList = (state: FakeState): FakeReply => ({
  json: { secrets: [...state.computerSecrets.keys()].map((key) => ({ key })) },
})

/** `limit` and `cursor` paging over `items`, with a cursor full of reserved characters. */
const pageOf = (request: FakeRequest, key: string, items: ReadonlyArray<JsonObject>): FakeReply => {
  const cursor = request.searchParams.get("cursor")
  const limit = Number(request.searchParams.get("limit") ?? "20")
  const match = cursor === null ? undefined : CURSOR.exec(cursor)

  if (cursor !== null && match === null) return badRequest("invalid cursor")

  const offset = Number(match?.[1] ?? "0")
  const hasMore = offset + limit < items.length

  return {
    json: {
      [key]: items.slice(offset, offset + limit),
      pagination: { hasMore, nextCursor: hasMore ? cursorAt(offset + limit) : null },
    },
  }
}

const ORGANIZATION_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  [
    "GET /api/v0/organization/users",
    (request, state) => pageOf(request, "users", [...state.users.values()]),
  ],
  [
    "POST /api/v0/organization/users/invite",
    (request, state) => {
      const { email, role } = bodyOf(request)

      if (!Predicate.isString(email)) return badRequest("email is required")

      if (state.users.has(email) || state.invites.has(email)) {
        return conflict(email + " is already a member or invited")
      }

      const invite: JsonObject = {
        email,
        role: Predicate.isString(role) ? role : "user",
        status: "invited",
      }

      state.invites.set(email, invite)

      return { json: invite }
    },
  ],
  [
    "DELETE /api/v0/organization/users",
    (request, state) => {
      const email = request.searchParams.get("email")

      if (email === null) return badRequest("email is required")

      return state.users.delete(email) ? { status: 204 } : notFound("user")
    },
  ],
  [
    "GET /api/v0/organization/usage/limits/global",
    (_request, state) => ({ json: { limit: state.globalLimit } }),
  ],
  [
    "PUT /api/v0/organization/usage/limits/global",
    (request, state) => {
      const { limit } = bodyOf(request)

      if (limit === undefined || !isLimit(limit)) {
        return badRequest("limit must be null or an integer of at least 1000000")
      }

      state.globalLimit = Predicate.isNumber(limit) ? limit : null

      return { json: { limit: state.globalLimit } }
    },
  ],
  [
    "GET /api/v0/organization/usage/limits/groups",
    (_request, state) => ({ json: { groupLimits: [...state.groupLimits.values()] } }),
  ],
  [
    "PUT /api/v0/organization/usage/limits/groups",
    (request, state) => {
      const { groups } = bodyOf(request)

      if (!Array.isArray(groups) || groups.length === 0) return badRequest("groups is required")

      const updated: Array<JsonObject> = []
      const errors: Array<JsonObject> = []

      for (const entry of groups.map(objectOf)) {
        const groupId = String(entry.groupId)
        const group = state.groupLimits.get(groupId)

        if (group === undefined) {
          errors.push({ groupId, error: "group not found in the synced directory" })
        } else if (isLimit(entry.limit)) {
          const limit = entry.limit ?? null

          state.groupLimits.set(groupId, { ...group, limit })
          updated.push({ groupId, limit })
        } else {
          errors.push({ groupId, error: "limit must be at least 1000000" })
        }
      }

      return { json: { updated, errors } }
    },
  ],
  [
    "GET /api/v0/organization/usage/limits/users",
    (_request, state) => ({
      json: {
        globalLimit: state.globalLimit,
        userLimits: Array.from(state.userLimits, ([email, limit]) => ({ email, limit })),
      },
    }),
  ],
  [
    "PUT /api/v0/organization/usage/limits/users",
    (request, state) => {
      const { users } = bodyOf(request)

      if (!Array.isArray(users) || users.length === 0) return badRequest("users is required")

      const updated: Array<JsonObject> = []
      const errors: Array<JsonObject> = []

      for (const entry of users.map(objectOf)) {
        const email = String(entry.email)

        if (!state.users.has(email)) {
          errors.push({ email, error: "user not found" })
        } else if (entry.limit === null) {
          state.userLimits.delete(email)
          updated.push({ email, limit: null })
        } else if (Predicate.isNumber(entry.limit) && isLimit(entry.limit)) {
          state.userLimits.set(email, entry.limit)
          updated.push({ email, limit: entry.limit })
        } else {
          errors.push({ email, error: "limit must be at least 1000000" })
        }
      }

      return { json: { updated, errors } }
    },
  ],
  ["GET /api/v0/organization/computer-secrets", (_request, state) => secretList(state)],
  [
    "PATCH /api/v0/organization/computer-secrets",
    (request, state) => {
      const body = bodyOf(request)

      if (!Array.isArray(body.upsert) || !Array.isArray(body.delete)) {
        return badRequest("upsert and delete are required")
      }

      const upserts = body.upsert.map(objectOf)

      for (const entry of upserts) {
        const key = String(entry.key)
        const value = String(entry.value)

        // Echoes the value on purpose: tests prove the client scrubs it from error detail.
        if (!SECRET_KEY.test(key)) {
          return badRequest("cannot store " + key + "=" + value + ": the key is not a POSIX name")
        }

        if (body.createOnly === true && state.computerSecrets.has(key)) {
          return conflict("secret " + key + " already exists")
        }
      }

      for (const entry of upserts) state.computerSecrets.set(String(entry.key), String(entry.value))

      for (const key of body.delete) state.computerSecrets.delete(String(key))

      return secretList(state)
    },
  ],
  [
    "GET /api/v0/organization/enterprise-controls/history",
    (request) => pageOf(request, "changes", SEED_CHANGES),
  ],
]

export const SEED_SERVICE_ACCOUNT: JsonObject = {
  id: "sa-1",
  name: "ci-bot",
  description: "Runs CI reviews",
  status: "active",
  createdBy: "user-1",
  teamIds: [],
  createdAt: 1,
}

export const SEED_API_KEY: JsonObject = {
  id: "key-1",
  name: "ci",
  fingerprint: "…a1b2",
  createdAt: 1,
  isRevoked: false,
}

/** A service account under construction; optional fields are added only when given. */
interface ServiceAccountFields {
  [key: string]: Json
}

const serviceAccountOf = (request: FakeRequest, state: FakeState): JsonObject | undefined =>
  state.serviceAccounts.get(paramOf(request, "serviceAccountId"))

/** A key of `serviceAccountId`, keyed by `keyId`; another account's key is not found. */
const apiKeyOf = (request: FakeRequest, state: FakeState): JsonObject | undefined => {
  const key = state.apiKeys.get(paramOf(request, "keyId"))

  return key?.serviceAccountId === paramOf(request, "serviceAccountId") ? key : undefined
}

const keyMetadata = (key: JsonObject): JsonObject => {
  const { serviceAccountId: _owner, ...metadata } = key

  return metadata
}

/** Stores a new key and answers with its one-time value, as upstream does. */
const mintKey = (
  state: FakeState,
  serviceAccountId: string,
  name: string,
  expiresAt: Json | undefined,
): JsonObject => {
  const id = nextId(state, "key-")
  const value = "fk-minted-" + id + "-0123456789abcdef"
  const fingerprint = "…" + value.slice(-4)
  const expiry: JsonObject = Predicate.isNumber(expiresAt) ? { expiresAt } : {}

  state.apiKeys.set(id, {
    id,
    serviceAccountId,
    name,
    fingerprint,
    createdAt: Date.now(),
    isRevoked: false,
    ...expiry,
  })
  state.mintedKeyValues.push(value)

  return { apiKey: { id, value, fingerprint, name, ...expiry } }
}

const SERVICE_ACCOUNT_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  [
    "GET /api/v0/service-accounts",
    (_request, state) => ({ json: { serviceAccounts: [...state.serviceAccounts.values()] } }),
  ],
  [
    "POST /api/v0/service-accounts",
    (request, state) => {
      const { name, status, description } = bodyOf(request)

      if (!Predicate.isString(name) || (status !== "active" && status !== "inactive")) {
        return badRequest("name and status are required")
      }

      if ([...state.serviceAccounts.values()].some((account) => account.name === name)) {
        return conflict("service account " + name + " already exists")
      }

      const id = nextId(state, "sa-")

      const serviceAccount: ServiceAccountFields = {
        id,
        name,
        status,
        createdBy: "user-1",
        teamIds: [],
        createdAt: Date.now(),
      }

      if (Predicate.isString(description)) serviceAccount.description = description

      state.serviceAccounts.set(id, serviceAccount)

      return { status: 201, json: { serviceAccount } }
    },
  ],
  [
    "GET /api/v0/service-accounts/{serviceAccountId}",
    (request, state) => {
      const serviceAccount = serviceAccountOf(request, state)

      return serviceAccount === undefined
        ? notFound("service account")
        : { json: { serviceAccount } }
    },
  ],
  [
    "PATCH /api/v0/service-accounts/{serviceAccountId}",
    (request, state) => {
      const account = serviceAccountOf(request, state)
      const { description, status } = bodyOf(request)

      if (account === undefined) return notFound("service account")

      if (status !== undefined && status !== "active" && status !== "inactive") {
        return badRequest("status must be active or inactive")
      }

      const serviceAccount: ServiceAccountFields = { ...account, updatedAt: Date.now() }

      if (Predicate.isString(description)) serviceAccount.description = description

      if (Predicate.isString(status)) serviceAccount.status = status

      state.serviceAccounts.set(String(account.id), serviceAccount)

      return { json: { serviceAccount } }
    },
  ],
  [
    "DELETE /api/v0/service-accounts/{serviceAccountId}",
    (request, state) => {
      const id = paramOf(request, "serviceAccountId")

      return state.serviceAccounts.delete(id)
        ? { json: { id, deleted: true } }
        : notFound("service account")
    },
  ],
  [
    "GET /api/v0/service-accounts/{serviceAccountId}/api-keys",
    (request, state) => {
      const id = paramOf(request, "serviceAccountId")

      if (!state.serviceAccounts.has(id)) return notFound("service account")

      const apiKeys = [...state.apiKeys.values()].flatMap((key) =>
        key.serviceAccountId === id ? [keyMetadata(key)] : [],
      )

      return { json: { apiKeys } }
    },
  ],
  [
    "POST /api/v0/service-accounts/{serviceAccountId}/api-keys",
    (request, state) => {
      const id = paramOf(request, "serviceAccountId")
      const { name, expiresAt } = bodyOf(request)

      if (!state.serviceAccounts.has(id)) return notFound("service account")

      if (!Predicate.isString(name)) return badRequest("name is required")

      return { status: 201, json: mintKey(state, id, name, expiresAt) }
    },
  ],
  [
    "POST /api/v0/service-accounts/{serviceAccountId}/api-keys/{keyId}/rotate",
    (request, state) => {
      const key = apiKeyOf(request, state)
      const { expiresAt, gracePeriodMinutes } = bodyOf(request)

      if (key === undefined) return notFound("API key")

      if (key.isRevoked === true) return conflict("API key " + String(key.id) + " is revoked")

      if (
        gracePeriodMinutes !== undefined &&
        (!Predicate.isNumber(gracePeriodMinutes) ||
          gracePeriodMinutes < 0 ||
          gracePeriodMinutes > 10)
      ) {
        return badRequest("gracePeriodMinutes must be between 0 and 10")
      }

      const grace = Predicate.isNumber(gracePeriodMinutes) ? gracePeriodMinutes : 0

      state.apiKeys.set(String(key.id), {
        ...key,
        ...(grace === 0
          ? { isRevoked: true, revokedAt: Date.now() }
          : { expiresAt: Date.now() + grace * 60_000 }),
      })

      return {
        json: mintKey(
          state,
          paramOf(request, "serviceAccountId"),
          String(key.name),
          expiresAt ?? key.expiresAt,
        ),
      }
    },
  ],
  [
    "POST /api/v0/service-accounts/{serviceAccountId}/api-keys/{keyId}/revoke",
    (request, state) => {
      const key = apiKeyOf(request, state)

      if (key === undefined || key.isRevoked === true) return notFound("API key")

      state.apiKeys.set(String(key.id), { ...key, isRevoked: true, revokedAt: Date.now() })

      return { status: 204 }
    },
  ],
]

export const SEED_BILLING_LIMITS: JsonObject = {
  standard: {
    fiveHour: { usedPercent: 42, windowEnd: "2026-11-14T06:00:00.000Z", secondsRemaining: 3600 },
    weekly: { usedPercent: 68, windowEnd: "2026-11-18T00:00:00.000Z", secondsRemaining: 300_000 },
    monthly: {
      usedPercent: 35,
      windowEnd: "2026-12-01T00:00:00.000Z",
      secondsRemaining: 1_400_000,
    },
  },
  core: {
    fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
    weekly: { usedPercent: 12, windowEnd: "2026-11-18T00:00:00.000Z", secondsRemaining: 300_000 },
    monthly: {
      usedPercent: 8,
      windowEnd: "2026-12-01T00:00:00.000Z",
      secondsRemaining: 1_400_000,
    },
  },
}

const hasBearerAuth = (request: FakeRequest): boolean => {
  const header = request.headers.authorization ?? ""

  return header.startsWith("Bearer ") && header.length > "Bearer ".length
}

const BILLING_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  [
    "GET /api/billing/limits",
    (request, state) => {
      if (!hasBearerAuth(request)) {
        return apiError(401, "Missing Bearer authorization", "Unauthorized")
      }

      return {
        json: {
          usesTokenRateLimitsBilling: true,
          hasActiveSubscription: true,
          limits: SEED_BILLING_LIMITS,
          overagePreference: state.overagePreference,
          canManageOverage: state.canManageOverage,
          extraUsageBalanceCents: state.extraUsageBalanceCents,
          extraUsageAllowed: true,
        },
      }
    },
  ],
  [
    "POST /api/organization/subscription/set-overage-preference",
    (request, state) => {
      if (!hasBearerAuth(request)) {
        return apiError(401, "Missing Bearer authorization", "Unauthorized")
      }

      const { overagePreference } = bodyOf(request)

      if (overagePreference !== "droidCore" && overagePreference !== "extraUsage") {
        return badRequest("overagePreference must be droidCore or extraUsage")
      }

      if (!state.canManageOverage) {
        return apiError(
          403,
          "Only organization managers or owners can update overage preferences",
          "Forbidden",
        )
      }

      state.overagePreference = overagePreference

      return { json: { ok: true, overagePreference } }
    },
  ],
]

const DEFAULT_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  ...COMPUTER_ROUTES,
  ...ENVIRONMENT_ROUTES,
  ...SESSION_ROUTES.map(([key, handler]) => [key, gated(handler)] as const),
  ...WIKI_ROUTES,
  ...CI_ROUTES,
  ...BILLING_ROUTES,
  ...ORGANIZATION_ROUTES,
  ...SERVICE_ACCOUNT_ROUTES,
]

interface Route {
  readonly key: string
  readonly method: string
  readonly segments: ReadonlyArray<string>
  readonly literals: number
  readonly handler: RouteHandler
}

const routeOf = (key: string, handler: RouteHandler): Route => {
  const space = key.indexOf(" ")
  const segments = key.slice(space + 1).split("/")

  return {
    key,
    method: key.slice(0, space),
    segments,
    literals: segments.filter((segment) => !segment.startsWith("{")).length,
    handler,
  }
}

const matchPath = (
  route: Route,
  segments: ReadonlyArray<string>,
): Record<string, string> | undefined => {
  if (route.segments.length !== segments.length) return undefined

  const params: Record<string, string> = {}

  for (const [index, pattern] of route.segments.entries()) {
    const segment = segments[index] ?? ""

    if (pattern.startsWith("{")) {
      if (segment.length === 0) return undefined

      params[pattern.slice(1, -1)] = decodeURIComponent(segment)
    } else if (pattern !== segment) {
      return undefined
    }
  }

  return params
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = ""

    request.on("data", (chunk) => {
      body += String(chunk)
    })
    request.on("end", () => {
      resolve(body)
    })
  })

const decodeJson = (text: string): Json | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(JSON.parse(text)))
  } catch {
    return undefined
  }
}

interface HeaderMap {
  [name: string]: string
}

const headerRecord = (request: IncomingMessage): HeaderMap => {
  const headers: HeaderMap = {}

  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value
  }

  return headers
}

const write = (response: ServerResponse, reply: FakeReply): void => {
  const status = reply.status ?? 200
  const headers: HeaderMap = { ...reply.headers }

  if (status === 204 || status === 304) {
    response.writeHead(status, headers)
    response.end()

    return
  }

  if (reply.json !== undefined) {
    headers["content-type"] = reply.contentType ?? "application/json"
    response.writeHead(status, headers)
    response.end(JSON.stringify(reply.json))

    return
  }

  if (reply.text !== undefined) {
    headers["content-type"] = reply.contentType ?? "text/plain"
    response.writeHead(status, headers)
    response.end(reply.text)

    return
  }

  if (reply.bytes !== undefined) {
    headers["content-type"] = reply.contentType ?? "application/octet-stream"
    response.writeHead(status, headers)
    response.end(reply.bytes)

    return
  }

  response.writeHead(status, headers)
  response.end()
}

/**
 * A stand-in for the hosted Factory API: a route table of `METHOD /template`
 * handlers over per-test state. It records every request, answers 404 for an
 * unknown path and 405 for a known path with the wrong method, and lets a test
 * inject the next reply for a route.
 */
export const startFakeFactoryApi = async (): Promise<FakeFactoryApi> => {
  const requests: Array<RecordedRequest> = []
  const failures = new Map<string, Array<FakeReply>>()
  const overrides = new Map<string, RouteHandler>()
  let state = seedState()

  const routes = (): ReadonlyArray<Route> => {
    const table = new Map<string, RouteHandler>(DEFAULT_ROUTES)

    for (const [key, handler] of overrides) table.set(key, handler)

    return Array.from(table, ([key, handler]) => routeOf(key, handler))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request)
    const url = request.url ?? "/"
    const mark = url.indexOf("?")
    const path = mark < 0 ? url : url.slice(0, mark)
    const query = mark < 0 ? "" : url.slice(mark + 1)
    const method = request.method ?? "GET"
    const segments = path.split("/")

    const candidates = routes()
      .flatMap((route) => {
        const params = matchPath(route, segments)

        return params === undefined ? [] : [{ route, params }]
      })
      .sort((left, right) => right.route.literals - left.route.literals)

    const best = candidates.find((candidate) => candidate.route.method === method)

    const recorded: RecordedRequest = {
      method,
      path,
      query,
      headers: headerRecord(request),
      body,
      route: best?.route.key,
    }

    requests.push(recorded)

    if (best === undefined) {
      write(
        response,
        candidates.length === 0
          ? apiError(404, "no route for " + path, "Not Found")
          : apiError(405, method + " is not allowed on " + path, "Method Not Allowed"),
      )

      return
    }

    const injected = failures.get(best.route.key)?.shift()

    if (injected !== undefined) {
      write(response, injected)

      return
    }

    const reply = await best.route.handler(
      {
        ...recorded,
        params: best.params,
        searchParams: new URLSearchParams(query),
        json: decodeJson(body),
      },
      state,
    )

    write(response, reply)
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()

  if (address === null || Predicate.isString(address)) throw new Error("fake API did not bind")

  return {
    baseUrl: "http://127.0.0.1:" + String(address.port),
    requests,
    get state() {
      return state
    },
    last: () => requests.at(-1),
    route: (key, handler) => {
      overrides.set(key, handler)
    },
    failNext: (key, status, body, headers) => {
      const reply: FakeReply = Predicate.isString(body)
        ? {
            status,
            text: body,
            contentType: body.trimStart().startsWith("<") ? "text/html" : "text/plain",
            headers,
          }
        : { status, json: body, headers }

      failures.set(key, [...(failures.get(key) ?? []), reply])
    },
    reset: () => {
      requests.length = 0
      failures.clear()
      overrides.clear()
      state = seedState()
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}
