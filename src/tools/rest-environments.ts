import * as Schema from "effect/Schema"

import { DESTRUCTIVE, Id, JsonBody, restDomain, restTool } from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"

/** Environment tools on the hosted API (`/api/v0/environments`). */

const ENVIRONMENT = "/api/v0/environments/{environmentId}"
const BUILD = ENVIRONMENT + "/builds/{buildId}"

const Repositories = Schema.Array(JsonBody).annotate({
  description: "Repositories to clone, as the upstream repository objects.",
})

export const environmentTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_list_environments",
      operation: "listEnvironments",
      description:
        "List the Environments visible to the caller, with the default Environment id. " +
        "Pass `serviceAccountId` to list as a service account.",
      method: "GET",
      path: "/api/v0/environments",
      inputs: { serviceAccountId: Schema.optional(Schema.String) },
      query: ["serviceAccountId"],
    }),
    restTool({
      name: "rest_create_environment",
      operation: "createEnvironment",
      description:
        "Create an Environment from `name` and `repositories` and start its first build. " +
        "Returns the new id and build id.",
      method: "POST",
      path: "/api/v0/environments",
      body: {
        name: Id,
        repositories: Repositories,
        scope: Schema.optional(Schema.Literals(["user", "organization"])),
        setupScript: Schema.optional(Schema.String),
        sourceId: Schema.optional(Schema.String),
        makeOrganizationDefault: Schema.optional(Schema.Boolean),
      },
    }),
    restTool({
      name: "rest_get_environment",
      operation: "getEnvironment",
      description: "Read one Environment by id, including its repositories, source, and build.",
      method: "GET",
      path: ENVIRONMENT,
      inputs: { environmentId: Id },
    }),
    restTool({
      name: "rest_update_environment",
      operation: "updateEnvironment",
      description:
        "Update an Environment's name, repositories, setup script, or source; a change that " +
        "affects the image starts a new build.",
      method: "PATCH",
      path: ENVIRONMENT,
      inputs: { environmentId: Id },
      body: {
        name: Schema.optional(Schema.String),
        repositories: Schema.optional(Repositories),
        setupScript: Schema.optional(Schema.String),
        sourceId: Schema.optional(Schema.String),
      },
    }),
    restTool({
      name: "rest_delete_environment",
      operation: "deleteEnvironment",
      description:
        "Delete an Environment. Upstream answers 409 when it cannot be deleted. " + DESTRUCTIVE,
      method: "DELETE",
      path: ENVIRONMENT,
      inputs: { environmentId: Id },
      response: "empty",
    }),
    restTool({
      name: "rest_ensure_default_environment",
      operation: "ensureDefaultEnvironment",
      description:
        "Make sure the caller has a default Environment, creating one if needed. Safe to " +
        "repeat; returns { ok: true }.",
      method: "POST",
      path: "/api/v0/environments/default",
      response: "empty",
    }),
    restTool({
      name: "rest_set_default_environment",
      operation: "setDefaultEnvironment",
      description:
        "Make `environmentId` the default Environment, replacing the current default for " +
        "everyone who relies on it. " +
        DESTRUCTIVE,
      method: "PUT",
      path: "/api/v0/environments/default",
      body: { environmentId: Id },
    }),
    restTool({
      name: "rest_list_environment_sources",
      operation: "listEnvironmentSources",
      description:
        "List the sources an Environment can be built from, and the providers that are " +
        "unavailable.",
      method: "GET",
      path: "/api/v0/environments/source-options",
    }),
    restTool({
      name: "rest_list_environment_build_statuses",
      operation: "listEnvironmentBuildStatuses",
      description: "Read the latest build status of each Environment in `environmentIds`.",
      method: "GET",
      path: "/api/v0/environments/build-statuses",
      inputs: {
        environmentIds: Schema.NonEmptyArray(Id),
        serviceAccountId: Schema.optional(Schema.String),
      },
      query: ["environmentIds", "serviceAccountId"],
    }),
    restTool({
      name: "rest_get_environment_build_diagnostics",
      operation: "getEnvironmentBuildDiagnostics",
      description:
        "Read the build log excerpt of an Environment's current build. Use " +
        "rest_get_environment_build_attempt_diagnostics for an earlier attempt.",
      method: "GET",
      path: ENVIRONMENT + "/build-diagnostics",
      inputs: { environmentId: Id },
    }),
    restTool({
      name: "rest_get_environment_build_attempt_diagnostics",
      operation: "getEnvironmentBuildAttemptDiagnostics",
      description: "Read the build log excerpt of one build attempt of an Environment.",
      method: "GET",
      path: BUILD + "/diagnostics",
      inputs: { environmentId: Id, buildId: Id },
    }),
    restTool({
      name: "rest_retry_environment_build",
      operation: "retryEnvironmentBuild",
      description:
        "Start a new build of an Environment. Upstream answers 409 while a build is running.",
      method: "POST",
      path: ENVIRONMENT + "/builds",
      inputs: { environmentId: Id },
    }),
    restTool({
      name: "rest_cancel_environment_build",
      operation: "cancelEnvironmentBuild",
      description:
        "Cancel a running Environment build. Upstream answers 409 when the build is not " +
        "running. " +
        DESTRUCTIVE,
      method: "POST",
      path: BUILD + "/cancel",
      inputs: { environmentId: Id, buildId: Id },
      response: "empty",
    }),
  ])
