/**
 * Computer and machine-template operations (`/api/v0/computers`,
 * `/api/v0/machines`). File transfer operations coordinate signed URLs but
 * never fetch them; the upload bytes and the download bytes always move
 * outside this module.
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  destructiveAnnotations,
  discoverySchema,
  hostedOperation,
  jsonOutcome,
  hostedTransport,
  readOnlyAnnotations,
  schemaOf,
  join,
  segment,
  writeAnnotations,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"
import {
  BooleanFlag,
  Cursor,
  ExtraQuery,
  extraQueryProblem,
  firstIdProblem,
  HostedId,
  isJsonObject,
  openStruct,
  PageLimit,
  queryEntries,
} from "./wire.ts"

const COMPUTERS = "/api/v0/computers"

const computerPath = (computerId: string): string | undefined => {
  const encoded = segment(computerId)

  return encoded === undefined ? undefined : COMPUTERS + "/" + encoded
}

const filePath = (computerId: string, fileName: string): string | undefined => {
  const computer = computerPath(computerId)
  const encoded = segment(fileName)

  return computer === undefined || encoded === undefined
    ? undefined
    : computer + "/files/" + encoded
}

const computersTarget: TargetRef = { kind: "hosted", id: "computers" }

const computerTarget = (computerId: string): TargetRef => ({
  kind: "hosted",
  id: "computer",
  scope: computerId,
})

const templatesTarget: TargetRef = { kind: "hosted", id: "machine-templates" }

const templateTarget = (templateId: string): TargetRef => ({
  kind: "hosted",
  id: "machine-template",
  scope: templateId,
})

const ComputerSource = Schema.Union([
  openStruct({
    kind: Schema.Literal("environment"),
    environmentId: HostedId,
    isListed: Schema.Boolean,
  }),
  openStruct({ kind: Schema.Literal("template"), templateId: HostedId, isListed: Schema.Boolean }),
  openStruct({
    kind: Schema.Literal("execution-template"),
    templateId: HostedId,
    isListed: Schema.Boolean,
  }),
  openStruct({ kind: Schema.Literal("computer"), sourceComputerId: HostedId }),
]).annotate({
  description:
    "What to build the computer from: an Environment, a template, an execution template, " +
    "or another computer.",
})

/** The nested ids a union-typed `source` member may carry, checked only when present as strings. */
const SOURCE_ID_KEYS: ReadonlyArray<string> = ["environmentId", "templateId", "sourceComputerId"]

const sourceIdProblem = (source: Schema.Json | undefined): string | undefined => {
  if (source === undefined || !isJsonObject(source)) return undefined

  const entries: Array<readonly [string, string | undefined]> = []

  for (const key of SOURCE_ID_KEYS) {
    const value = source[key]

    entries.push(["source." + key, Predicate.isString(value) ? value : undefined])
  }

  return firstIdProblem(entries)
}

/** Builds the computer operation binding thunks against one validated installation. */
export const computerBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  type EmptyInput = Readonly<Record<string, never>>

  interface ListComputersInput {
    readonly hostId?: string
    readonly serviceAccountId?: string
    readonly includeProvisioningSteps?: boolean
    readonly includeUnlisted?: boolean
  }

  const listComputers: Definition<ListComputersInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_computers",
    description: "List the cloud computers on this Factory account.",
    inputSchema: schemaOf({
      hostId: { type: "string" },
      serviceAccountId: { type: "string" },
      includeProvisioningSteps: { type: "boolean" },
      includeUnlisted: { type: "boolean" },
    }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({
        hostId: Schema.optionalKey(Schema.String),
        serviceAccountId: Schema.optionalKey(Schema.String),
        includeProvisioningSteps: Schema.optionalKey(BooleanFlag),
        includeUnlisted: Schema.optionalKey(BooleanFlag),
      }),
      "arguments do not match the schema",
    ),
    target: () => computersTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_list_computers", {
        method: "GET",
        path: COMPUTERS,
        query: queryEntries([
          ["hostId", input.hostId],
          ["serviceAccountId", input.serviceAccountId],
          ["includeProvisioningSteps", input.includeProvisioningSteps],
          ["includeUnlisted", input.includeUnlisted],
        ]),
      }),
  })

  interface ComputerInput {
    readonly computerId: string
  }

  const computerIdSchema = Schema.Struct({ computerId: HostedId })

  const computerCheck = (input: ComputerInput): string | undefined =>
    firstIdProblem([["computerId", input.computerId]])

  interface GetComputerInput extends ComputerInput {
    readonly sharedSessionId?: string
    readonly includeProvisioningSteps?: boolean
  }

  const getComputer: Definition<GetComputerInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_computer",
    description: "Read one cloud computer by id.",
    inputSchema: schemaOf({
      computerId: { type: "string" },
      sharedSessionId: { type: "string" },
      includeProvisioningSteps: { type: "boolean" },
    }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({
        computerId: HostedId,
        sharedSessionId: Schema.optionalKey(Schema.String),
        includeProvisioningSteps: Schema.optionalKey(BooleanFlag),
      }),
      "arguments do not match the schema",
      computerCheck,
    ),
    target: (input) => computerTarget(input.computerId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_computer", {
        method: "GET",
        path: computerPath(input.computerId),
        query: queryEntries([
          ["sharedSessionId", input.sharedSessionId],
          ["includeProvisioningSteps", input.includeProvisioningSteps],
        ]),
      }),
  })

  interface CreateComputerInput {
    readonly name: string
    readonly remoteUser?: string
    readonly provider?: string
    readonly hostId?: string
    readonly repos?: ReadonlyArray<string>
    readonly autoInstallDeps?: boolean
    readonly serviceAccountId?: string
    readonly source?: Schema.Json
  }

  const createComputer: Definition<CreateComputerInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_create_computer",
    description:
      "Create a cloud computer. Pass `source` to build it from an Environment, a template, " +
      "or another computer.",
    inputSchema: schemaOf({
      name: { type: "string" },
      remoteUser: { type: "string" },
      provider: { type: "string" },
      hostId: { type: "string" },
      repos: { type: "array", items: { type: "string" } },
      autoInstallDeps: { type: "boolean" },
      serviceAccountId: { type: "string" },
      source: { type: "object" },
    }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        name: Schema.NonEmptyString,
        remoteUser: Schema.optionalKey(Schema.String),
        provider: Schema.optionalKey(Schema.String),
        hostId: Schema.optionalKey(Schema.String),
        repos: Schema.optionalKey(Schema.Array(Schema.String)),
        autoInstallDeps: Schema.optionalKey(Schema.Boolean),
        serviceAccountId: Schema.optionalKey(Schema.String),
        source: Schema.optionalKey(ComputerSource),
      }),
      "arguments do not match the schema",
      (input) => {
        const problem = firstIdProblem([
          ["hostId", input.hostId],
          ["serviceAccountId", input.serviceAccountId],
        ])

        return problem === undefined ? sourceIdProblem(input.source) : problem
      },
    ),
    target: () => computersTarget,
    perform: (input) => {
      const entries: Array<readonly [string, Schema.Json]> = [["name", input.name]]

      if (input.remoteUser !== undefined) entries.push(["remoteUser", input.remoteUser])

      if (input.provider !== undefined) entries.push(["provider", input.provider])

      if (input.hostId !== undefined) entries.push(["hostId", input.hostId])

      if (input.repos !== undefined) entries.push(["repos", [...input.repos]])

      if (input.autoInstallDeps !== undefined) {
        entries.push(["autoInstallDeps", input.autoInstallDeps])
      }

      if (input.serviceAccountId !== undefined) {
        entries.push(["serviceAccountId", input.serviceAccountId])
      }

      if (input.source !== undefined) entries.push(["source", input.source])

      return jsonOutcome(transport, "rest_create_computer", {
        method: "POST",
        path: COMPUTERS,
        query: [],
        body: Object.fromEntries(entries),
      })
    },
  })

  const deleteComputer: Definition<ComputerInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_delete_computer",
    description: "Delete a cloud computer. Destructive; confirm before calling.",
    inputSchema: schemaOf({ computerId: { type: "string" } }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(computerIdSchema, "arguments do not match the schema", computerCheck),
    target: (input) => computerTarget(input.computerId),
    perform: (input) =>
      jsonOutcome(
        transport,
        "rest_delete_computer",
        {
          method: "DELETE",
          path: computerPath(input.computerId),
          query: [],
        },
        { emptyResponse: true },
      ),
  })

  interface RestartComputerInput extends ComputerInput {
    readonly mode?: "resume" | "reboot"
  }

  const restartComputer: Definition<RestartComputerInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_restart_computer",
    description: "Restart a cloud computer: `resume` (the default upstream) or a full `reboot`.",
    inputSchema: schemaOf({ computerId: { type: "string" }, mode: { type: "string" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        computerId: HostedId,
        mode: Schema.optionalKey(Schema.Literals(["resume", "reboot"])),
      }),
      "arguments do not match the schema",
      computerCheck,
    ),
    target: (input) => computerTarget(input.computerId),
    perform: (input) =>
      jsonOutcome(
        transport,
        "rest_restart_computer",
        {
          method: "POST",
          path: computerPath(input.computerId) + "/restart",
          query: [],
          body: input.mode === undefined ? undefined : { mode: input.mode },
        },
        { emptyResponse: true },
      ),
  })

  interface GetMetricsInput extends ComputerInput {
    readonly start?: string
  }

  const getComputerMetrics: Definition<GetMetricsInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_computer_metrics",
    description: "Read a cloud computer's resource metrics, optionally from a `start` time.",
    inputSchema: schemaOf({ computerId: { type: "string" }, start: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({
        computerId: HostedId,
        start: Schema.optionalKey(Schema.String),
      }),
      "arguments do not match the schema",
      computerCheck,
    ),
    target: (input) => computerTarget(input.computerId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_computer_metrics", {
        method: "GET",
        path: computerPath(input.computerId) + "/metrics",
        query: queryEntries([["start", input.start]]),
      }),
  })

  interface ListTemplatesInput {
    readonly limit?: number
    readonly cursor?: string
  }

  const listMachineTemplates: Definition<ListTemplatesInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_machine_templates",
    description: "List the machine templates a computer can be created from.",
    inputSchema: schemaOf({ limit: { type: "number" }, cursor: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({
        limit: Schema.optionalKey(PageLimit),
        cursor: Schema.optionalKey(Cursor),
      }),
      "arguments do not match the schema",
    ),
    target: () => templatesTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_list_machine_templates", {
        method: "GET",
        path: "/api/v0/machines/templates",
        query: queryEntries([
          ["limit", input.limit],
          ["cursor", input.cursor],
        ]),
      }),
  })

  interface MachineTemplateInput {
    readonly templateId: string
  }

  const getMachineTemplate: Definition<MachineTemplateInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_machine_template",
    description: "Read one machine template by id.",
    inputSchema: schemaOf({ templateId: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({ templateId: HostedId }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["templateId", input.templateId]]),
    ),
    target: (input) => templateTarget(input.templateId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_machine_template", {
        method: "GET",
        path: join("/api/v0/machines/templates/", segment(input.templateId)),
        query: [],
      }),
  })

  interface GetComputerByNameInput {
    readonly name: string
    readonly serviceAccountId?: string
    readonly includeProvisioningSteps?: boolean
  }

  const getComputerByName: Definition<GetComputerByNameInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_get_computer_by_name",
      description: "Read one cloud computer by its name.",
      inputSchema: schemaOf({
        name: { type: "string" },
        serviceAccountId: { type: "string" },
        includeProvisioningSteps: { type: "boolean" },
      }),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(
        Schema.Struct({
          name: HostedId,
          serviceAccountId: Schema.optionalKey(Schema.String),
          includeProvisioningSteps: Schema.optionalKey(BooleanFlag),
        }),
        "arguments do not match the schema",
        (input) => firstIdProblem([["name", input.name]]),
      ),
      target: () => computersTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_get_computer_by_name", {
          method: "GET",
          path: join(COMPUTERS, "/name/", segment(input.name)),
          query: queryEntries([
            ["serviceAccountId", input.serviceAccountId],
            ["includeProvisioningSteps", input.includeProvisioningSteps],
          ]),
        }),
    },
  )

  interface UpdateComputerInput extends ComputerInput {
    readonly body: {
      readonly name?: string
      readonly hostId?: string
      readonly remoteUser?: string
      readonly computerIdentity?: { readonly [key: string]: Schema.Json }
      readonly [key: string]: Schema.Json | undefined
    }
  }

  const updateComputer: Definition<UpdateComputerInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_update_computer",
    description:
      "Update a cloud computer's name, host, remote user, or identity key. " +
      "Members of `body` other than the documented ones are forwarded as given.",
    inputSchema: schemaOf({ computerId: { type: "string" }, body: { type: "object" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        computerId: HostedId,
        body: openStruct({
          name: Schema.optionalKey(Schema.String),
          hostId: Schema.optionalKey(Schema.String),
          remoteUser: Schema.optionalKey(Schema.String),
          computerIdentity: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
        }),
      }),
      "arguments do not match the schema",
      computerCheck,
    ),
    target: (input) => computerTarget(input.computerId),
    perform: (input) => {
      const entries: Array<readonly [string, Schema.Json]> = []

      for (const [key, value] of Object.entries(input.body)) {
        if (value !== undefined) entries.push([key, value])
      }

      return jsonOutcome(transport, "rest_update_computer", {
        method: "PATCH",
        path: computerPath(input.computerId),
        query: [],
        body: Object.fromEntries(entries),
      })
    },
  })

  const refreshComputer: Definition<ComputerInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_refresh_computer",
    description:
      "Push the current configuration and secrets to a cloud computer; returns how many were set.",
    inputSchema: schemaOf({ computerId: { type: "string" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(computerIdSchema, "arguments do not match the schema", computerCheck),
    target: (input) => computerTarget(input.computerId),
    perform: (input) =>
      jsonOutcome(transport, "rest_refresh_computer", {
        method: "POST",
        path: computerPath(input.computerId) + "/refresh",
        query: [],
      }),
  })

  const retryInstallDeps: Definition<ComputerInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_retry_install_deps",
    description:
      "Retry dependency installation on a cloud computer. Upstream answers 409 while an " +
      "installation is already running.",
    inputSchema: schemaOf({ computerId: { type: "string" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(computerIdSchema, "arguments do not match the schema", computerCheck),
    target: (input) => computerTarget(input.computerId),
    perform: (input) =>
      jsonOutcome(transport, "rest_retry_install_deps", {
        method: "POST",
        path: computerPath(input.computerId) + "/install-deps",
        query: [],
      }),
  })

  const listComputerProviders: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_computer_providers",
    description: "List the computer providers this account can create computers on.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(Schema.Struct({}), "arguments must be an empty object"),
    target: () => computersTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_computer_providers", {
        method: "GET",
        path: "/api/v0/computers/providers",
        query: [],
      }),
  })

  interface BulkCreateComputersInput {
    readonly body: {
      readonly quantity: number
      readonly namePrefix: string
      readonly provider?: string
      readonly repos?: ReadonlyArray<string>
      readonly autoInstallDeps?: boolean
      readonly serviceAccountId?: string
    }
  }

  const bulkCreateComputers: Definition<BulkCreateComputersInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_bulk_create_computers",
      description:
        "Create `quantity` cloud computers named from `namePrefix`. The result lists the " +
        "computers created and may carry an error when fewer than requested were made.",
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          body: Schema.Struct({
            quantity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            namePrefix: Schema.NonEmptyString,
            provider: Schema.optionalKey(Schema.String),
            repos: Schema.optionalKey(Schema.Array(Schema.String)),
            autoInstallDeps: Schema.optionalKey(Schema.Boolean),
            serviceAccountId: Schema.optionalKey(Schema.String),
          }),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["body.namePrefix", input.body.namePrefix],
            ["body.serviceAccountId", input.body.serviceAccountId],
          ]),
      ),
      target: () => computersTarget,
      perform: (input) => {
        const entries: Array<readonly [string, Schema.Json]> = [
          ["quantity", input.body.quantity],
          ["namePrefix", input.body.namePrefix],
        ]

        if (input.body.provider !== undefined) entries.push(["provider", input.body.provider])

        if (input.body.repos !== undefined) entries.push(["repos", [...input.body.repos]])

        if (input.body.autoInstallDeps !== undefined) {
          entries.push(["autoInstallDeps", input.body.autoInstallDeps])
        }

        if (input.body.serviceAccountId !== undefined) {
          entries.push(["serviceAccountId", input.body.serviceAccountId])
        }

        return jsonOutcome(transport, "rest_bulk_create_computers", {
          method: "POST",
          path: "/api/v0/computers/bulk",
          query: [],
          body: Object.fromEntries(entries),
        })
      },
    },
  )

  interface RecordActivityInput extends ComputerInput {
    readonly sharedSessionId?: string
  }

  const recordComputerActivity: Definition<RecordActivityInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_record_computer_activity",
      description: "Mark a cloud computer as active now so it is not treated as idle.",
      inputSchema: schemaOf({
        computerId: { type: "string" },
        sharedSessionId: { type: "string" },
      }),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          computerId: HostedId,
          sharedSessionId: Schema.optionalKey(Schema.String),
        }),
        "arguments do not match the schema",
        computerCheck,
      ),
      target: (input) => computerTarget(input.computerId),
      perform: (input) =>
        jsonOutcome(transport, "rest_record_computer_activity", {
          method: "POST",
          path: computerPath(input.computerId) + "/activity",
          query: queryEntries([["sharedSessionId", input.sharedSessionId]]),
        }),
    },
  )

  interface FileInput extends ComputerInput {
    readonly fileName: string
  }

  const fileCheck = (input: FileInput): string | undefined =>
    firstIdProblem([
      ["computerId", input.computerId],
      ["fileName", input.fileName],
    ])

  const createFileUploadSchema = Schema.Struct({
    computerId: HostedId,
    fileName: HostedId,
    body: openStruct({
      sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      contentType: Schema.NonEmptyString,
    }),
    query: Schema.optionalKey(ExtraQuery),
  })

  type CreateFileUploadInput = typeof createFileUploadSchema.Type

  const createComputerFileUpload: Definition<CreateFileUploadInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_create_computer_file_upload",
      description:
        "Start a file upload to a cloud computer. Returns a `transferId`, an `uploadUrl`, and " +
        "`uploadFormFields`; this tool never fetches the URL. Upload the bytes there yourself, " +
        "then call rest_complete_computer_file_upload.",
      inputSchema: discoverySchema(createFileUploadSchema),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(createFileUploadSchema, "arguments do not match the schema", (input) =>
        extraQueryProblem(input.query, ["computerId", "fileName", "body"]),
      ),
      target: (input) => computerTarget(input.computerId),
      perform: (input) =>
        jsonOutcome(transport, "rest_create_computer_file_upload", {
          method: "POST",
          path: filePath(input.computerId, input.fileName) + "/create-upload",
          query: queryEntries(Object.entries(input.query ?? {})),
          body: input.body,
        }),
    })

  interface CompleteFileUploadInput extends FileInput {
    readonly body: {
      readonly transferId: string
      readonly sessionId: string
      readonly destPath?: string
    }
  }

  const completeComputerFileUpload: Definition<CompleteFileUploadInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_complete_computer_file_upload",
      description:
        "Finish an upload started by rest_create_computer_file_upload and place the file on " +
        "the computer, optionally at `destPath`. Upstream answers 409 for a transfer that " +
        "cannot be completed.",
      inputSchema: schemaOf({
        computerId: { type: "string" },
        fileName: { type: "string" },
        body: { type: "object" },
      }),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          computerId: HostedId,
          fileName: HostedId,
          body: Schema.Struct({
            transferId: HostedId,
            sessionId: HostedId,
            destPath: Schema.optionalKey(Schema.String),
          }),
        }),
        "arguments do not match the schema",
        (input) => {
          const problem = fileCheck(input)

          return problem === undefined
            ? firstIdProblem([
                ["body.transferId", input.body.transferId],
                ["body.sessionId", input.body.sessionId],
              ])
            : problem
        },
      ),
      target: (input) => computerTarget(input.computerId),
      perform: (input) => {
        const entries: Array<readonly [string, Schema.Json]> = [
          ["transferId", input.body.transferId],
          ["sessionId", input.body.sessionId],
        ]

        if (input.body.destPath !== undefined) entries.push(["destPath", input.body.destPath])

        return jsonOutcome(transport, "rest_complete_computer_file_upload", {
          method: "POST",
          path: filePath(input.computerId, input.fileName) + "/complete-upload",
          query: [],
          body: Object.fromEntries(entries),
        })
      },
    })

  interface CreateFileDownloadInput extends FileInput {
    readonly body: {
      readonly sessionId: string
      readonly cwd?: string
      readonly filePath?: string
      readonly contentType?: string
    }
  }

  const createComputerFileDownload: Definition<CreateFileDownloadInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_create_computer_file_download",
      description:
        "Prepare a file on a cloud computer for download. Returns a `downloadUrl`; this tool " +
        "never fetches it.",
      inputSchema: schemaOf({
        computerId: { type: "string" },
        fileName: { type: "string" },
        body: { type: "object" },
      }),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          computerId: HostedId,
          fileName: HostedId,
          body: Schema.Struct({
            sessionId: HostedId,
            cwd: Schema.optionalKey(Schema.String),
            filePath: Schema.optionalKey(Schema.String),
            contentType: Schema.optionalKey(Schema.String),
          }),
        }),
        "arguments do not match the schema",
        (input) => {
          const problem = fileCheck(input)

          return problem === undefined
            ? firstIdProblem([["body.sessionId", input.body.sessionId]])
            : problem
        },
      ),
      target: (input) => computerTarget(input.computerId),
      perform: (input) => {
        const entries: Array<readonly [string, Schema.Json]> = [["sessionId", input.body.sessionId]]

        if (input.body.cwd !== undefined) entries.push(["cwd", input.body.cwd])

        if (input.body.filePath !== undefined) entries.push(["filePath", input.body.filePath])

        if (input.body.contentType !== undefined) {
          entries.push(["contentType", input.body.contentType])
        }

        return jsonOutcome(transport, "rest_create_computer_file_download", {
          method: "POST",
          path: filePath(input.computerId, input.fileName) + "/create-download",
          query: [],
          body: Object.fromEntries(entries),
        })
      },
    })

  return [
    binderOf(listComputers),
    binderOf(getComputer),
    binderOf(createComputer),
    binderOf(deleteComputer),
    binderOf(restartComputer),
    binderOf(getComputerMetrics),
    binderOf(listMachineTemplates),
    binderOf(getMachineTemplate),
    binderOf(getComputerByName),
    binderOf(updateComputer),
    binderOf(refreshComputer),
    binderOf(retryInstallDeps),
    binderOf(listComputerProviders),
    binderOf(bulkCreateComputers),
    binderOf(recordComputerActivity),
    binderOf(createComputerFileUpload),
    binderOf(completeComputerFileUpload),
    binderOf(createComputerFileDownload),
  ]
}
