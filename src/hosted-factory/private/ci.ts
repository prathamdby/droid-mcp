/**
 * CI automation operations (`/api/v0/automations/ci`). Upstream does not
 * publish these operations' request or response fields, so their shapes are
 * unverified; the edit operation forwards its optional free-form `body` as
 * given.
 */
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  destructiveAnnotations,
  hostedOperation,
  hostedTransport,
  jsonOutcome,
  readOnlyAnnotations,
  schemaOf,
  writeAnnotations,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"
import { JsonBody } from "./wire.ts"

const CI = "/api/v0/automations/ci"

const ciTarget: TargetRef = { kind: "hosted", id: "ci-automations" }

/** Builds the CI automation operation binding thunks against one validated installation. */
export const ciBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  type EmptyInput = Readonly<Record<string, never>>

  const emptyDecode = checkedDecode(Schema.Struct({}), "arguments must be an empty object")

  const scanCiRepositories: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_scan_ci_repositories",
    description:
      "Scan the connected repositories and report their Factory CI workflow configuration. " +
      "Upstream does not publish this operation's request or response fields, so `query` is " +
      "forwarded as given and its shape is unverified.",
    inputSchema: schemaOf({}),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: emptyDecode,
    target: () => ciTarget,
    perform: () =>
      jsonOutcome(transport, "rest_scan_ci_repositories", {
        method: "GET",
        path: CI + "/scan",
        query: [],
      }),
  })

  const listCiRepositories: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_ci_repositories",
    description:
      "List the repositories eligible for Factory CI automation. Upstream does not publish " +
      "this operation's request or response fields, so `query` is forwarded as given and its " +
      "shape is unverified.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: emptyDecode,
    target: () => ciTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_ci_repositories", {
        method: "GET",
        path: CI + "/repositories",
        query: [],
      }),
  })

  const listCiRepositoryOwners: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_ci_repository_owners",
    description:
      "List the repository owners available when configuring Factory CI automation. Upstream " +
      "does not publish this operation's request or response fields, so `query` is forwarded " +
      "as given and its shape is unverified.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: emptyDecode,
    target: () => ciTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_ci_repository_owners", {
        method: "GET",
        path: CI + "/repository-owners",
        query: [],
      }),
  })

  const listCiJobs: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_ci_jobs",
    description:
      "List the organization's CI automation jobs. Upstream does not publish this operation's " +
      "request or response fields, so `query` is forwarded as given and its shape is unverified.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: emptyDecode,
    target: () => ciTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_ci_jobs", {
        method: "GET",
        path: CI + "/jobs",
        query: [],
      }),
  })

  const listCiRuns: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_ci_runs",
    description:
      "List GitHub Actions runs of the CI automation workflows. Upstream does not publish " +
      "this operation's request or response fields, so `query` is forwarded as given and its " +
      "shape is unverified.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: emptyDecode,
    target: () => ciTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_ci_runs", {
        method: "GET",
        path: CI + "/runs",
        query: [],
      }),
  })

  interface EditWorkflowInput {
    readonly body?: Readonly<Record<string, Schema.Json>>
  }

  const editCiWorkflow: Definition<EditWorkflowInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_edit_ci_workflow",
    description:
      "Create, update, or delete a repository's CI workflow by opening a pull request " +
      "upstream. Destructive; confirm before calling. Upstream does not publish this " +
      "operation's request or response fields, so `body` and `query` are forwarded as given " +
      "and their shapes are unverified.",
    inputSchema: schemaOf({ body: { type: "object" } }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({ body: Schema.optionalKey(JsonBody) }),
      "arguments do not match the schema",
    ),
    target: () => ciTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_edit_ci_workflow", {
        method: "POST",
        path: CI + "/edit",
        query: [],
        body: input.body,
      }),
  })

  return [
    binderOf(scanCiRepositories),
    binderOf(listCiRepositories),
    binderOf(listCiRepositoryOwners),
    binderOf(listCiJobs),
    binderOf(listCiRuns),
    binderOf(editCiWorkflow),
  ]
}
