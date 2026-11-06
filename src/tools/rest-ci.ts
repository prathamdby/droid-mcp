import { DESTRUCTIVE, restDomain, restTool } from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"

/** CI automation tools on the hosted API (`/api/v0/automations/ci`). */

const UNVERIFIED =
  " Upstream does not publish this operation's request or response fields, so `query` is " +
  "forwarded as given and its shape is unverified."

const CI = "/api/v0/automations/ci"

export const ciTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_scan_ci_repositories",
      operation: "scanCiRepositories",
      description:
        "Scan the connected repositories and report their Factory CI workflow configuration." +
        UNVERIFIED,
      method: "GET",
      path: CI + "/scan",
    }),
    restTool({
      name: "rest_list_ci_repositories",
      operation: "listCiRepositories",
      description: "List the repositories eligible for Factory CI automation." + UNVERIFIED,
      method: "GET",
      path: CI + "/repositories",
    }),
    restTool({
      name: "rest_list_ci_repository_owners",
      operation: "listCiRepositoryOwners",
      description:
        "List the repository owners available when configuring Factory CI automation." + UNVERIFIED,
      method: "GET",
      path: CI + "/repository-owners",
    }),
    restTool({
      name: "rest_list_ci_jobs",
      operation: "listCiJobs",
      description: "List the organization's CI automation jobs." + UNVERIFIED,
      method: "GET",
      path: CI + "/jobs",
    }),
    restTool({
      name: "rest_list_ci_runs",
      operation: "listCiRuns",
      description: "List GitHub Actions runs of the CI automation workflows." + UNVERIFIED,
      method: "GET",
      path: CI + "/runs",
    }),
    restTool({
      name: "rest_edit_ci_workflow",
      operation: "editCiWorkflow",
      description:
        "Create, update, or delete a repository's CI workflow by opening a pull request " +
        "upstream. " +
        DESTRUCTIVE +
        " Upstream does not publish this operation's request or response fields, so `body` " +
        "and `query` are forwarded as given and their shapes are unverified.",
      method: "POST",
      path: CI + "/edit",
      body: "optional",
    }),
  ])
