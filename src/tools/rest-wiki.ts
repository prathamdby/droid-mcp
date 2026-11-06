import { DESTRUCTIVE, Id, restDomain, restTool } from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"

/** AutoWiki tools on the hosted API (`/api/v0/wiki`). */

const UNVERIFIED =
  " Upstream does not publish this operation's request or response fields, so `body` and " +
  "`query` are forwarded as given and their shapes are unverified."

const RUN = "/api/v0/wiki/{wikiRunId}"

export const wikiTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_list_wiki_runs",
      operation: "listWikiRuns",
      description: "List the latest wiki generation runs of the organization." + UNVERIFIED,
      method: "GET",
      path: "/api/v0/wiki",
    }),
    restTool({
      name: "rest_create_wiki_run",
      operation: "createWikiRun",
      description:
        "Start a wiki generation run for a connected repository, for example with " +
        "`body: { repoUrl }`. Check rest_get_wiki_upload_access first." +
        UNVERIFIED,
      method: "POST",
      path: "/api/v0/wiki",
      body: "optional",
    }),
    restTool({
      name: "rest_get_wiki_run",
      operation: "getWikiRun",
      description: "Read the status and output metadata of one wiki run." + UNVERIFIED,
      method: "GET",
      path: RUN,
      inputs: { wikiRunId: Id },
    }),
    restTool({
      name: "rest_delete_wiki_run",
      operation: "deleteWikiRun",
      description: "Delete a wiki run and its generated pages. " + DESTRUCTIVE + UNVERIFIED,
      method: "DELETE",
      path: RUN,
      inputs: { wikiRunId: Id },
      body: "optional",
    }),
    restTool({
      name: "rest_export_wiki_run",
      operation: "exportWikiRun",
      description:
        "Download a wiki run's generated files. A ZIP archive comes back as { encoding: " +
        "'base64', contentType, sizeBytes, data }; a JSON answer is returned as is." +
        UNVERIFIED,
      method: "GET",
      path: RUN + "/export",
      inputs: { wikiRunId: Id },
      response: "json-or-binary",
    }),
    restTool({
      name: "rest_get_wiki_page",
      operation: "getWikiPage",
      description: "Read one generated page of a wiki run." + UNVERIFIED,
      method: "GET",
      path: RUN + "/pages/{pageId}",
      inputs: { wikiRunId: Id, pageId: Id },
    }),
    restTool({
      name: "rest_search_wiki_run",
      operation: "searchWikiRun",
      description:
        "Search the generated pages of a wiki run; pass the search terms in `query`." + UNVERIFIED,
      method: "GET",
      path: RUN + "/search",
      inputs: { wikiRunId: Id },
    }),
    restTool({
      name: "rest_update_wiki_privacy",
      operation: "updateWikiPrivacy",
      description:
        "Change who can read a generated wiki; a wider level can expose its documentation. " +
        DESTRUCTIVE +
        UNVERIFIED,
      method: "POST",
      path: RUN + "/privacy",
      inputs: { wikiRunId: Id },
      body: "optional",
    }),
    restTool({
      name: "rest_list_wiki_history",
      operation: "listWikiHistory",
      description:
        "List the wiki runs of one repository. `repoUrl` is sent as a single encoded path " +
        "segment, so pass the full URL unchanged." +
        UNVERIFIED,
      method: "GET",
      path: "/api/v0/wiki/history/{repoUrl}",
      inputs: { repoUrl: Id },
    }),
    restTool({
      name: "rest_get_wiki_upload_access",
      operation: "getWikiUploadAccess",
      description:
        "Check whether the caller may upload a wiki for `repoUrl`, the URL later passed to " +
        "rest_create_wiki_run. Answers { allowed: true } or a rejection.",
      method: "GET",
      path: "/api/v0/wiki/upload-access",
      inputs: { repoUrl: Id },
      query: ["repoUrl"],
    }),
    restTool({
      name: "rest_create_wiki_video_upload_url",
      operation: "createWikiVideoUploadUrl",
      description:
        "Create a temporary upload URL for a generated wiki video. The URL is returned, never " +
        "fetched." +
        UNVERIFIED,
      method: "POST",
      path: "/api/v0/wiki/video-upload-url",
      body: "optional",
    }),
  ])
