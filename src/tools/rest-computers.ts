import * as Schema from "effect/Schema"

import {
  BooleanFlag,
  Cursor,
  DESTRUCTIVE,
  Id,
  JsonBody,
  PageLimit,
  restDomain,
  restTool,
} from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"

/** Computer and machine-template tools on the hosted API (`/api/v0/computers`, `/api/v0/machines`). */

const COMPUTER = "/api/v0/computers/{computerId}"

const FILE = COMPUTER + "/files/{fileName}"

/** Upstream accepts more members than it documents; they are forwarded as given. */
const sourceOf = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [JsonBody])

const ComputerSource = Schema.Union([
  sourceOf({ kind: Schema.Literal("environment"), environmentId: Id, isListed: Schema.Boolean }),
  sourceOf({ kind: Schema.Literal("template"), templateId: Id, isListed: Schema.Boolean }),
  sourceOf({
    kind: Schema.Literal("execution-template"),
    templateId: Id,
    isListed: Schema.Boolean,
  }),
  sourceOf({ kind: Schema.Literal("computer"), sourceComputerId: Id }),
]).annotate({
  description:
    "What to build the computer from: an Environment, a template, an execution template, " +
    "or another computer.",
})

export const computerTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_list_computers",
      operation: "listComputers",
      description: "List the cloud computers on this Factory account.",
      method: "GET",
      path: "/api/v0/computers",
      inputs: {
        hostId: Schema.optional(Schema.String),
        serviceAccountId: Schema.optional(Schema.String),
        includeProvisioningSteps: Schema.optional(BooleanFlag),
        includeUnlisted: Schema.optional(BooleanFlag),
      },
      query: ["hostId", "serviceAccountId", "includeProvisioningSteps", "includeUnlisted"],
    }),
    restTool({
      name: "rest_get_computer",
      operation: "getComputer",
      description: "Read one cloud computer by id.",
      method: "GET",
      path: COMPUTER,
      inputs: {
        computerId: Id,
        sharedSessionId: Schema.optional(Schema.String),
        includeProvisioningSteps: Schema.optional(BooleanFlag),
      },
      query: ["sharedSessionId", "includeProvisioningSteps"],
    }),
    restTool({
      name: "rest_create_computer",
      operation: "createComputer",
      description:
        "Create a cloud computer. Pass `source` to build it from an Environment, a template, " +
        "or another computer.",
      method: "POST",
      path: "/api/v0/computers",
      inputs: {
        name: Schema.String,
        remoteUser: Schema.optional(Schema.String),
        provider: Schema.optional(Schema.String),
        hostId: Schema.optional(Schema.String),
        repos: Schema.optional(Schema.Array(Schema.String)),
        autoInstallDeps: Schema.optional(Schema.Boolean),
        serviceAccountId: Schema.optional(Schema.String),
        source: Schema.optional(ComputerSource),
      },
      bodyFields: [
        "name",
        "remoteUser",
        "provider",
        "hostId",
        "repos",
        "autoInstallDeps",
        "serviceAccountId",
        "source",
      ],
    }),
    restTool({
      name: "rest_delete_computer",
      operation: "deleteComputer",
      description: "Delete a cloud computer. " + DESTRUCTIVE,
      method: "DELETE",
      path: COMPUTER,
      inputs: { computerId: Id },
      response: "empty",
      success: Schema.Struct({ deleted: Schema.Boolean }),
      result: () => ({ deleted: true }),
    }),
    restTool({
      name: "rest_restart_computer",
      operation: "restartComputer",
      description: "Restart a cloud computer: `resume` (the default upstream) or a full `reboot`.",
      method: "POST",
      path: COMPUTER + "/restart",
      inputs: { computerId: Id, mode: Schema.optional(Schema.Literals(["resume", "reboot"])) },
      bodyFields: ["mode"],
      response: "empty",
      success: Schema.Struct({ restarted: Schema.Boolean }),
      result: () => ({ restarted: true }),
    }),
    restTool({
      name: "rest_get_computer_metrics",
      operation: "getComputerMetrics",
      description: "Read a cloud computer's resource metrics, optionally from a `start` time.",
      method: "GET",
      path: COMPUTER + "/metrics",
      inputs: { computerId: Id, start: Schema.optional(Schema.String) },
      query: ["start"],
    }),
    restTool({
      name: "rest_list_machine_templates",
      operation: "listMachineTemplates",
      description: "List the machine templates a computer can be created from.",
      method: "GET",
      path: "/api/v0/machines/templates",
      inputs: { limit: Schema.optional(PageLimit), cursor: Schema.optional(Cursor) },
      query: ["limit", "cursor"],
    }),
    restTool({
      name: "rest_get_machine_template",
      operation: "getMachineTemplate",
      description: "Read one machine template by id.",
      method: "GET",
      path: "/api/v0/machines/templates/{templateId}",
      inputs: { templateId: Id },
    }),
    restTool({
      name: "rest_get_computer_by_name",
      operation: "getComputerByName",
      description: "Read one cloud computer by its name.",
      method: "GET",
      path: "/api/v0/computers/name/{name}",
      inputs: {
        name: Id,
        serviceAccountId: Schema.optional(Schema.String),
        includeProvisioningSteps: Schema.optional(BooleanFlag),
      },
      query: ["serviceAccountId", "includeProvisioningSteps"],
    }),
    restTool({
      name: "rest_update_computer",
      operation: "updateComputer",
      description:
        "Update a cloud computer's name, host, remote user, or identity key. " +
        "Members of `body` other than the documented ones are forwarded as given.",
      method: "PATCH",
      path: COMPUTER,
      inputs: { computerId: Id },
      body: {
        name: Schema.optional(Schema.String),
        hostId: Schema.optional(Schema.String),
        remoteUser: Schema.optional(Schema.String),
        computerIdentity: Schema.optional(JsonBody),
      },
    }),
    restTool({
      name: "rest_refresh_computer",
      operation: "refreshComputer",
      description:
        "Push the current configuration and secrets to a cloud computer; returns how many were set.",
      method: "POST",
      path: COMPUTER + "/refresh",
      inputs: { computerId: Id },
    }),
    restTool({
      name: "rest_retry_install_deps",
      operation: "retryInstallDeps",
      description:
        "Retry dependency installation on a cloud computer. Upstream answers 409 while an " +
        "installation is already running.",
      method: "POST",
      path: COMPUTER + "/install-deps",
      inputs: { computerId: Id },
    }),
    restTool({
      name: "rest_list_computer_providers",
      operation: "listAvailableComputerProviders",
      description: "List the computer providers this account can create computers on.",
      method: "GET",
      path: "/api/v0/computers/providers",
    }),
    restTool({
      name: "rest_bulk_create_computers",
      operation: "bulkCreateComputers",
      description:
        "Create `quantity` cloud computers named from `namePrefix`. The result lists the " +
        "computers created and may carry an error when fewer than requested were made.",
      method: "POST",
      path: "/api/v0/computers/bulk",
      body: {
        quantity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        namePrefix: Id,
        provider: Schema.optional(Schema.String),
        repos: Schema.optional(Schema.Array(Schema.String)),
        autoInstallDeps: Schema.optional(Schema.Boolean),
        serviceAccountId: Schema.optional(Schema.String),
      },
    }),
    restTool({
      name: "rest_record_computer_activity",
      operation: "recordComputerActivity",
      description: "Mark a cloud computer as active now so it is not treated as idle.",
      method: "POST",
      path: COMPUTER + "/activity",
      inputs: { computerId: Id, sharedSessionId: Schema.optional(Schema.String) },
      query: ["sharedSessionId"],
    }),
    restTool({
      name: "rest_create_computer_file_upload",
      operation: "createComputerFileUpload",
      description:
        "Start a file upload to a cloud computer. Returns a `transferId`, an `uploadUrl`, and " +
        "`uploadFormFields`; this tool never fetches the URL. Upload the bytes there yourself, " +
        "then call rest_complete_computer_file_upload.",
      method: "POST",
      path: FILE + "/create-upload",
      inputs: { computerId: Id, fileName: Id },
      body: { sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), contentType: Id },
    }),
    restTool({
      name: "rest_complete_computer_file_upload",
      operation: "completeComputerFileUpload",
      description:
        "Finish an upload started by rest_create_computer_file_upload and place the file on " +
        "the computer, optionally at `destPath`. Upstream answers 409 for a transfer that " +
        "cannot be completed.",
      method: "POST",
      path: FILE + "/complete-upload",
      inputs: { computerId: Id, fileName: Id },
      body: { transferId: Id, sessionId: Id, destPath: Schema.optional(Schema.String) },
    }),
    restTool({
      name: "rest_create_computer_file_download",
      operation: "createComputerFileDownload",
      description:
        "Prepare a file on a cloud computer for download. Returns a `downloadUrl`; this tool " +
        "never fetches it.",
      method: "POST",
      path: FILE + "/create-download",
      inputs: { computerId: Id, fileName: Id },
      body: {
        sessionId: Id,
        cwd: Schema.optional(Schema.String),
        filePath: Schema.optional(Schema.String),
        contentType: Schema.optional(Schema.String),
      },
    }),
  ])
