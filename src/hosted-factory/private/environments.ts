/**
 * Environment operations (`/api/v0/environments`). Environments are the
 * image definitions computers build from; every build operation names its
 * environment and, when it acts on one attempt, the build id as well.
 */
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  destructiveAnnotations,
  destructiveIdempotentAnnotations,
  hostedOperation,
  idempotentWriteAnnotations,
  jsonOutcome,
  hostedTransport,
  readOnlyAnnotations,
  schemaOf,
  segment,
  writeAnnotations,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"
import { firstIdProblem, HostedId, JsonBody, queryEntries } from "./wire.ts"

const ENVIRONMENTS = "/api/v0/environments"

const environmentPath = (environmentId: string): string =>
  ENVIRONMENTS + "/" + segment(environmentId)

const buildPath = (environmentId: string, buildId: string): string =>
  environmentPath(environmentId) + "/builds/" + segment(buildId)

const environmentsTarget: TargetRef = { kind: "hosted", id: "environments" }

const environmentTarget = (environmentId: string): TargetRef => ({
  kind: "hosted",
  id: "environment",
  scope: environmentId,
})

const Repositories = Schema.Array(JsonBody).annotate({
  description: "Repositories to clone, as the upstream repository objects.",
})

/** Builds the environment operation binding thunks against one validated installation. */
export const environmentBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  type EmptyInput = Readonly<Record<string, never>>

  interface ListEnvironmentsInput {
    readonly serviceAccountId?: string
  }

  const listEnvironments: Definition<ListEnvironmentsInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_environments",
    description:
      "List the Environments visible to the caller, with the default Environment id. " +
      "Pass `serviceAccountId` to list as a service account.",
    inputSchema: schemaOf({ serviceAccountId: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({ serviceAccountId: Schema.optionalKey(Schema.String) }),
      "arguments do not match the schema",
    ),
    target: () => environmentsTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_list_environments", {
        method: "GET",
        path: ENVIRONMENTS,
        query: queryEntries([["serviceAccountId", input.serviceAccountId]]),
      }),
  })

  interface CreateEnvironmentInput {
    readonly body: {
      readonly name: string
      readonly repositories: ReadonlyArray<{ readonly [key: string]: Schema.Json }>
      readonly scope?: "user" | "organization"
      readonly setupScript?: string
      readonly sourceId?: string
      readonly makeOrganizationDefault?: boolean
    }
  }

  const createEnvironment: Definition<CreateEnvironmentInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_create_environment",
      description:
        "Create an Environment from `name` and `repositories` and start its first build. " +
        "Returns the new id and build id.",
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          body: Schema.Struct({
            name: HostedId,
            repositories: Repositories,
            scope: Schema.optionalKey(Schema.Literals(["user", "organization"])),
            setupScript: Schema.optionalKey(Schema.String),
            sourceId: Schema.optionalKey(Schema.String),
            makeOrganizationDefault: Schema.optionalKey(Schema.Boolean),
          }),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["body.name", input.body.name],
            ["body.sourceId", input.body.sourceId],
          ]),
      ),
      target: () => environmentsTarget,
      perform: (input) => {
        const entries: Array<readonly [string, Schema.Json]> = [
          ["name", input.body.name],
          ["repositories", [...input.body.repositories]],
        ]

        if (input.body.scope !== undefined) entries.push(["scope", input.body.scope])

        if (input.body.setupScript !== undefined) {
          entries.push(["setupScript", input.body.setupScript])
        }

        if (input.body.sourceId !== undefined) entries.push(["sourceId", input.body.sourceId])

        if (input.body.makeOrganizationDefault !== undefined) {
          entries.push(["makeOrganizationDefault", input.body.makeOrganizationDefault])
        }

        return jsonOutcome(transport, "rest_create_environment", {
          method: "POST",
          path: ENVIRONMENTS,
          query: [],
          body: Object.fromEntries(entries),
        })
      },
    },
  )

  interface EnvironmentInput {
    readonly environmentId: string
  }

  const environmentIdSchema = Schema.Struct({ environmentId: HostedId })

  const environmentCheck = (input: EnvironmentInput): string | undefined =>
    firstIdProblem([["environmentId", input.environmentId]])

  const getEnvironment: Definition<EnvironmentInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_environment",
    description: "Read one Environment by id, including its repositories, source, and build.",
    inputSchema: schemaOf({ environmentId: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      environmentIdSchema,
      "arguments do not match the schema",
      environmentCheck,
    ),
    target: (input) => environmentTarget(input.environmentId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_environment", {
        method: "GET",
        path: environmentPath(input.environmentId),
        query: [],
      }),
  })

  interface UpdateEnvironmentInput extends EnvironmentInput {
    readonly body: {
      readonly name?: string
      readonly repositories?: ReadonlyArray<{ readonly [key: string]: Schema.Json }>
      readonly setupScript?: string | null
      readonly sourceId?: string
    }
  }

  const updateEnvironment: Definition<UpdateEnvironmentInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_update_environment",
      description:
        "Update an Environment's name, repositories, setup script, or source; a change that " +
        "affects the image starts a new build.",
      inputSchema: schemaOf({ environmentId: { type: "string" }, body: { type: "object" } }),
      annotations: idempotentWriteAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          environmentId: HostedId,
          body: Schema.Struct({
            name: Schema.optionalKey(Schema.String),
            repositories: Schema.optionalKey(Repositories),
            setupScript: Schema.optionalKey(
              Schema.NullOr(Schema.String).annotate({
                description: "null clears the setup script.",
              }),
            ),
            sourceId: Schema.optionalKey(Schema.String),
          }),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["environmentId", input.environmentId],
            ["body.sourceId", input.body.sourceId],
          ]),
      ),
      target: (input) => environmentTarget(input.environmentId),
      perform: (input) => {
        const entries: Array<readonly [string, Schema.Json]> = []

        if (input.body.name !== undefined) entries.push(["name", input.body.name])

        if (input.body.repositories !== undefined) {
          entries.push(["repositories", [...input.body.repositories]])
        }

        if (input.body.setupScript !== undefined) {
          entries.push(["setupScript", input.body.setupScript])
        }

        if (input.body.sourceId !== undefined) entries.push(["sourceId", input.body.sourceId])

        return jsonOutcome(transport, "rest_update_environment", {
          method: "PATCH",
          path: environmentPath(input.environmentId),
          query: [],
          body: Object.fromEntries(entries),
        })
      },
    },
  )

  const deleteEnvironment: Definition<EnvironmentInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_delete_environment",
    description:
      "Delete an Environment. Upstream answers 409 when it cannot be deleted. " +
      "Destructive; confirm before calling.",
    inputSchema: schemaOf({ environmentId: { type: "string" } }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      environmentIdSchema,
      "arguments do not match the schema",
      environmentCheck,
    ),
    target: (input) => environmentTarget(input.environmentId),
    perform: (input) =>
      jsonOutcome(
        transport,
        "rest_delete_environment",
        {
          method: "DELETE",
          path: environmentPath(input.environmentId),
          query: [],
        },
        { emptyResponse: true },
      ),
  })

  const ensureDefaultEnvironment: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_ensure_default_environment",
    description:
      "Make sure the caller has a default Environment, creating one if needed. Safe to " +
      "repeat; returns { ok: true }.",
    inputSchema: schemaOf({}),
    annotations: idempotentWriteAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(Schema.Struct({}), "arguments must be an empty object"),
    target: () => environmentsTarget,
    perform: () =>
      jsonOutcome(
        transport,
        "rest_ensure_default_environment",
        {
          method: "POST",
          path: "/api/v0/environments/default",
          query: [],
        },
        { emptyResponse: true },
      ),
  })

  interface SetDefaultEnvironmentInput {
    readonly body: {
      readonly environmentId: string
    }
  }

  const setDefaultEnvironment: Definition<SetDefaultEnvironmentInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_set_default_environment",
      description:
        "Make `environmentId` the default Environment, replacing the current default for " +
        "everyone who relies on it. Destructive; confirm before calling.",
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: destructiveIdempotentAnnotations,
      effect: "write",
      replay: "no_retry",
      demand: () => ({ effect: "configure" }),
      decode: checkedDecode(
        Schema.Struct({ body: Schema.Struct({ environmentId: HostedId }) }),
        "arguments do not match the schema",
        (input) => firstIdProblem([["body.environmentId", input.body.environmentId]]),
      ),
      target: (input) => environmentTarget(input.body.environmentId),
      perform: (input) =>
        jsonOutcome(transport, "rest_set_default_environment", {
          method: "PUT",
          path: "/api/v0/environments/default",
          query: [],
          body: { environmentId: input.body.environmentId },
        }),
    })

  const listEnvironmentSources: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_environment_sources",
    description:
      "List the sources an Environment can be built from, and the providers that are " +
      "unavailable.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(Schema.Struct({}), "arguments must be an empty object"),
    target: () => environmentsTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_environment_sources", {
        method: "GET",
        path: "/api/v0/environments/source-options",
        query: [],
      }),
  })

  interface ListBuildStatusesInput {
    readonly environmentIds: readonly [string, ...Array<string>]
    readonly serviceAccountId?: string
  }

  const listEnvironmentBuildStatuses: Definition<ListBuildStatusesInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_list_environment_build_statuses",
      description: "Read the latest build status of each Environment in `environmentIds`.",
      inputSchema: schemaOf({
        environmentIds: { type: "array", items: { type: "string" } },
        serviceAccountId: { type: "string" },
      }),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(
        Schema.Struct({
          environmentIds: Schema.NonEmptyArray(HostedId),
          serviceAccountId: Schema.optionalKey(Schema.String),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem(input.environmentIds.map((id) => ["environmentIds", id] as const)),
      ),
      target: () => environmentsTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_list_environment_build_statuses", {
          method: "GET",
          path: "/api/v0/environments/build-statuses",
          query: queryEntries([
            ["environmentIds", [...input.environmentIds]],
            ["serviceAccountId", input.serviceAccountId],
          ]),
        }),
    })

  const getEnvironmentBuildDiagnostics: Definition<EnvironmentInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_get_environment_build_diagnostics",
      description:
        "Read the build log excerpt of an Environment's current build. Use " +
        "rest_get_environment_build_attempt_diagnostics for an earlier attempt.",
      inputSchema: schemaOf({ environmentId: { type: "string" } }),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(
        environmentIdSchema,
        "arguments do not match the schema",
        environmentCheck,
      ),
      target: (input) => environmentTarget(input.environmentId),
      perform: (input) =>
        jsonOutcome(transport, "rest_get_environment_build_diagnostics", {
          method: "GET",
          path: environmentPath(input.environmentId) + "/build-diagnostics",
          query: [],
        }),
    })

  interface BuildInput extends EnvironmentInput {
    readonly buildId: string
  }

  const buildCheck = (input: BuildInput): string | undefined =>
    firstIdProblem([
      ["environmentId", input.environmentId],
      ["buildId", input.buildId],
    ])

  const buildInputSchema = Schema.Struct({ environmentId: HostedId, buildId: HostedId })

  const getEnvironmentBuildAttemptDiagnostics: Definition<BuildInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_get_environment_build_attempt_diagnostics",
      description: "Read the build log excerpt of one build attempt of an Environment.",
      inputSchema: schemaOf({
        environmentId: { type: "string" },
        buildId: { type: "string" },
      }),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(buildInputSchema, "arguments do not match the schema", buildCheck),
      target: (input) => environmentTarget(input.environmentId),
      perform: (input) =>
        jsonOutcome(transport, "rest_get_environment_build_attempt_diagnostics", {
          method: "GET",
          path: buildPath(input.environmentId, input.buildId) + "/diagnostics",
          query: [],
        }),
    })

  const retryEnvironmentBuild: Definition<EnvironmentInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_retry_environment_build",
    description:
      "Start a new build of an Environment. Upstream answers 409 while a build is running.",
    inputSchema: schemaOf({ environmentId: { type: "string" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      environmentIdSchema,
      "arguments do not match the schema",
      environmentCheck,
    ),
    target: (input) => environmentTarget(input.environmentId),
    perform: (input) =>
      jsonOutcome(transport, "rest_retry_environment_build", {
        method: "POST",
        path: environmentPath(input.environmentId) + "/builds",
        query: [],
      }),
  })

  const cancelEnvironmentBuild: Definition<BuildInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_cancel_environment_build",
    description:
      "Cancel a running Environment build. Upstream answers 409 when the build is not " +
      "running. Destructive; confirm before calling.",
    inputSchema: schemaOf({ environmentId: { type: "string" }, buildId: { type: "string" } }),
    annotations: destructiveIdempotentAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(buildInputSchema, "arguments do not match the schema", buildCheck),
    target: (input) => environmentTarget(input.environmentId),
    perform: (input) =>
      jsonOutcome(
        transport,
        "rest_cancel_environment_build",
        {
          method: "POST",
          path: buildPath(input.environmentId, input.buildId) + "/cancel",
          query: [],
        },
        { emptyResponse: true },
      ),
  })

  return [
    binderOf(listEnvironments),
    binderOf(createEnvironment),
    binderOf(getEnvironment),
    binderOf(updateEnvironment),
    binderOf(deleteEnvironment),
    binderOf(ensureDefaultEnvironment),
    binderOf(setDefaultEnvironment),
    binderOf(listEnvironmentSources),
    binderOf(listEnvironmentBuildStatuses),
    binderOf(getEnvironmentBuildDiagnostics),
    binderOf(getEnvironmentBuildAttemptDiagnostics),
    binderOf(retryEnvironmentBuild),
    binderOf(cancelEnvironmentBuild),
  ]
}
