/**
 * AutoWiki operations on the hosted API (`/api/v0/wiki`). Upstream does not
 * publish these operations' request or response fields, so free-form bodies
 * are forwarded as given and their shapes are unverified.
 */
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  destructiveAnnotations,
  discoverySchema,
  hostedOperation,
  jsonOrBinaryOutcome,
  jsonOutcome,
  hostedTransport,
  readOnlyAnnotations,
  schemaOf,
  segment,
  writeAnnotations,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"
import {
  ExtraQuery,
  extraQueryProblem,
  firstIdProblem,
  HostedId,
  isWellFormed,
  JsonBody,
  queryEntries,
} from "./wire.ts"

const UNVERIFIED =
  " Upstream does not publish this operation's request or response fields, so `body` and " +
  "`query` are forwarded as given and their shapes are unverified."

const WIKI = "/api/v0/wiki"

const wikiRunPath = (wikiRunId: string): string => WIKI + "/" + segment(wikiRunId)

const wikiTarget: TargetRef = { kind: "hosted", id: "wiki" }

const wikiRunTarget = (wikiRunId: string): TargetRef => ({
  kind: "hosted",
  id: "wiki-run",
  scope: wikiRunId,
})

// ---------------------------------------------------------------------------
// Repository URLs placed in a path segment or query value
// ---------------------------------------------------------------------------

const CONTROL_OR_SPACE = /[\s\x7f-\x9f]/

/**
 * A repository URL is free-form data, not one nested target id: it keeps its
 * `/`, `?` and `#` because URLs need them, and the transport percent-encodes
 * it into exactly one segment so structure stays safe. What must be rejected
 * is what no encoding can rescue — emptiness, whitespace or control
 * characters, and ill-formed Unicode.
 */
const repoUrlProblem = (name: string, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined

  if (value.length === 0) return name + " must not be empty"

  if (!isWellFormed(value)) return name + " is not well-formed Unicode"

  if (CONTROL_OR_SPACE.test(value)) {
    return name + " must not contain whitespace or control characters"
  }

  return undefined
}

/** The schema a repository URL is decoded through: any non-empty string; shape rules run cross-field. */
const RepoUrl = Schema.NonEmptyString.annotate({
  description:
    "One repository URL, sent as a single percent-encoded path segment or query value. " +
    "Pass the full URL unchanged.",
})

/** Builds the wiki operation binding thunks against one validated installation. */
export const wikiBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  type EmptyInput = Readonly<Record<string, never>>

  const listWikiRuns: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_wiki_runs",
    description: "List the latest wiki generation runs of the organization." + UNVERIFIED,
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(Schema.Struct({}), "arguments must be an empty object"),
    target: () => wikiTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_wiki_runs", {
        method: "GET",
        path: WIKI,
        query: [],
      }),
  })

  interface OptionalBodyInput {
    readonly body?: Schema.Json
  }

  const optionalBodySchema = Schema.Struct({
    body: Schema.optionalKey(JsonBody),
  })

  const createWikiRun: Definition<OptionalBodyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_create_wiki_run",
    description:
      "Start a wiki generation run for a connected repository, for example with " +
      "`body: { repoUrl }`. Check rest_get_wiki_upload_access first." +
      UNVERIFIED,
    inputSchema: schemaOf({ body: { type: "object" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(optionalBodySchema, "arguments do not match the schema"),
    target: () => wikiTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_create_wiki_run", {
        method: "POST",
        path: WIKI,
        query: [],
        body: input.body,
      }),
  })

  interface WikiRunInput {
    readonly wikiRunId: string
  }

  const wikiRunInputSchema = Schema.Struct({ wikiRunId: HostedId })

  const wikiRunCheck = (input: WikiRunInput): string | undefined =>
    firstIdProblem([["wikiRunId", input.wikiRunId]])

  const getWikiRun: Definition<WikiRunInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_wiki_run",
    description: "Read the status and output metadata of one wiki run." + UNVERIFIED,
    inputSchema: schemaOf({ wikiRunId: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(wikiRunInputSchema, "arguments do not match the schema", wikiRunCheck),
    target: (input) => wikiRunTarget(input.wikiRunId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_wiki_run", {
        method: "GET",
        path: wikiRunPath(input.wikiRunId),
        query: [],
      }),
  })

  interface DeleteWikiRunInput {
    readonly wikiRunId: string
    readonly body?: Schema.Json
  }

  const deleteWikiRun: Definition<DeleteWikiRunInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_delete_wiki_run",
    description:
      "Delete a wiki run and its generated pages. Destructive; confirm before calling." +
      UNVERIFIED,
    inputSchema: schemaOf({
      wikiRunId: { type: "string" },
      body: { type: "object" },
    }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        wikiRunId: HostedId,
        body: Schema.optionalKey(JsonBody),
      }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["wikiRunId", input.wikiRunId]]),
    ),
    target: (input) => wikiRunTarget(input.wikiRunId),
    perform: (input) =>
      jsonOutcome(transport, "rest_delete_wiki_run", {
        method: "DELETE",
        path: wikiRunPath(input.wikiRunId),
        query: [],
        body: input.body,
      }),
  })

  const exportWikiRun: Definition<WikiRunInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_export_wiki_run",
    description:
      "Download a wiki run's generated files. A ZIP archive comes back as { encoding: " +
      "'base64', contentType, sizeBytes, data }; a JSON answer is returned as is." +
      UNVERIFIED,
    inputSchema: schemaOf({ wikiRunId: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(wikiRunInputSchema, "arguments do not match the schema", wikiRunCheck),
    target: (input) => wikiRunTarget(input.wikiRunId),
    perform: (input) =>
      jsonOrBinaryOutcome(transport, "rest_export_wiki_run", {
        method: "GET",
        path: wikiRunPath(input.wikiRunId) + "/export",
        query: [],
      }),
  })

  interface WikiPageInput {
    readonly wikiRunId: string
    readonly pageId: string
  }

  const getWikiPage: Definition<WikiPageInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_wiki_page",
    description: "Read one generated page of a wiki run." + UNVERIFIED,
    inputSchema: schemaOf({
      wikiRunId: { type: "string" },
      pageId: { type: "string" },
    }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({
        wikiRunId: HostedId,
        pageId: HostedId,
      }),
      "arguments do not match the schema",
      (input) =>
        firstIdProblem([
          ["wikiRunId", input.wikiRunId],
          ["pageId", input.pageId],
        ]),
    ),
    target: (input) => wikiRunTarget(input.wikiRunId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_wiki_page", {
        method: "GET",
        path: wikiRunPath(input.wikiRunId) + "/pages/" + segment(input.pageId),
        query: [],
      }),
  })

  const searchWikiRunSchema = Schema.Struct({
    wikiRunId: HostedId,
    query: Schema.optionalKey(ExtraQuery),
  })

  type SearchWikiRunInput = typeof searchWikiRunSchema.Type

  const searchWikiRun: Definition<SearchWikiRunInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_search_wiki_run",
    description:
      "Search the generated pages of a wiki run; pass the search terms in `query.q`." + UNVERIFIED,
    inputSchema: discoverySchema(searchWikiRunSchema),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(searchWikiRunSchema, "arguments do not match the schema", (input) =>
      extraQueryProblem(input.query, ["wikiRunId"]),
    ),
    target: (input) => wikiRunTarget(input.wikiRunId),
    perform: (input) =>
      jsonOutcome(transport, "rest_search_wiki_run", {
        method: "GET",
        path: wikiRunPath(input.wikiRunId) + "/search",
        query: queryEntries(Object.entries(input.query ?? {})),
      }),
  })

  interface UpdateWikiPrivacyInput {
    readonly wikiRunId: string
    readonly body?: Schema.Json
  }

  const updateWikiPrivacy: Definition<UpdateWikiPrivacyInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_update_wiki_privacy",
      description:
        "Change who can read a generated wiki; a wider level can expose its documentation. " +
        "Destructive; confirm before calling." +
        UNVERIFIED,
      inputSchema: schemaOf({
        wikiRunId: { type: "string" },
        body: { type: "object" },
      }),
      annotations: destructiveAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          wikiRunId: HostedId,
          body: Schema.optionalKey(JsonBody),
        }),
        "arguments do not match the schema",
        (input) => firstIdProblem([["wikiRunId", input.wikiRunId]]),
      ),
      target: (input) => wikiRunTarget(input.wikiRunId),
      perform: (input) =>
        jsonOutcome(transport, "rest_update_wiki_privacy", {
          method: "POST",
          path: wikiRunPath(input.wikiRunId) + "/privacy",
          query: [],
          body: input.body,
        }),
    },
  )

  interface WikiHistoryInput {
    readonly repoUrl: string
  }

  const listWikiHistory: Definition<WikiHistoryInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_wiki_history",
    description:
      "List the wiki runs of one repository. `repoUrl` is sent as a single encoded path " +
      "segment, so pass the full URL unchanged." +
      UNVERIFIED,
    inputSchema: schemaOf({ repoUrl: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({ repoUrl: RepoUrl }),
      "arguments do not match the schema",
      (input) => repoUrlProblem("repoUrl", input.repoUrl),
    ),
    target: () => wikiTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_list_wiki_history", {
        method: "GET",
        path: WIKI + "/history/" + segment(input.repoUrl),
        query: [],
      }),
  })

  interface WikiUploadAccessInput {
    readonly repoUrl: string
  }

  const getWikiUploadAccess: Definition<WikiUploadAccessInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_get_wiki_upload_access",
      description:
        "Check whether the caller may upload a wiki for `repoUrl`, the URL later passed to " +
        "rest_create_wiki_run. Answers { allowed: true } or a rejection.",
      inputSchema: schemaOf({ repoUrl: { type: "string" } }),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(
        Schema.Struct({ repoUrl: RepoUrl }),
        "arguments do not match the schema",
        (input) => repoUrlProblem("repoUrl", input.repoUrl),
      ),
      target: () => wikiTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_get_wiki_upload_access", {
          method: "GET",
          path: WIKI + "/upload-access",
          query: queryEntries([["repoUrl", input.repoUrl]]),
        }),
    },
  )

  const createWikiVideoUploadUrl: Definition<OptionalBodyInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_create_wiki_video_upload_url",
      description:
        "Create a temporary upload URL for a generated wiki video. The URL is returned, never " +
        "fetched." +
        UNVERIFIED,
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(optionalBodySchema, "arguments do not match the schema"),
      target: () => wikiTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_create_wiki_video_upload_url", {
          method: "POST",
          path: WIKI + "/video-upload-url",
          query: [],
          body: input.body,
        }),
    },
  )

  return [
    binderOf(listWikiRuns),
    binderOf(createWikiRun),
    binderOf(getWikiRun),
    binderOf(deleteWikiRun),
    binderOf(exportWikiRun),
    binderOf(getWikiPage),
    binderOf(searchWikiRun),
    binderOf(updateWikiPrivacy),
    binderOf(listWikiHistory),
    binderOf(getWikiUploadAccess),
    binderOf(createWikiVideoUploadUrl),
  ]
}
