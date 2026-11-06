import * as sdk from "@factory/droid-sdk"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import { RestService } from "../droid/rest-service.ts"
import type { RestError } from "../droid/rest-service.ts"
import { jsonOf } from "../droid/rest-service.ts"
import { ToolFailure } from "./failure.ts"

/**
 * Factory API tools. They hit the hosted API (`/api/v0/...`) with
 * `FACTORY_API_KEY`, not the daemon. Every result is normalized to JSON at the
 * boundary; failures carry the API's own message.
 */

const apiOptions = (config: Config) => ({
  apiKey: config.factoryApiKey ?? "",
  baseUrl: config.factoryBaseUrl,
})

const toFailure = (error: RestError): ToolFailure => {
  const code = Match.value(error._tag).pipe(
    Match.when("RestRejected", () => "rest_rejected"),
    Match.when("RestUnavailable", () => "rest_unavailable"),
    Match.orElse(() => "factory_api_key_missing"),
  )

  const detail = Match.value(error).pipe(
    Match.tag("RestRejected", (value) => value.detail),
    Match.tag("RestUnavailable", (value) => value.detail),
    Match.orElse(() => undefined),
  )

  return {
    code,
    message: error.message + (detail === undefined ? "" : ": " + detail),
  }
}

const call = <A>(
  config: Config,
  name: string,
  run: () => Promise<A>,
): Effect.Effect<ReturnType<typeof jsonOf>, ToolFailure, RestService> =>
  RestService.use((rest) =>
    rest.call(name, run).pipe(Effect.map(jsonOf), Effect.mapError(toFailure)),
  )

const voidCall = (
  config: Config,
  name: string,
  run: () => Promise<void>,
): Effect.Effect<void, ToolFailure, RestService> =>
  RestService.use((rest) => rest.call(name, run).pipe(Effect.mapError(toFailure)))

const ComputerId = Schema.Struct({ computerId: Schema.String })

const ListComputers = Tool.make("rest_list_computers", {
  description: "List the cloud computers on this Factory account.",
  parameters: Tool.EmptyParams,
  success: Schema.Json,
  failure: ToolFailure,
  dependencies: [RestService],
})

const GetComputer = Tool.make("rest_get_computer", {
  description: "Read one cloud computer by id.",
  parameters: ComputerId,
  success: Schema.Json,
  failure: ToolFailure,
  dependencies: [RestService],
})

const CreateComputer = Tool.make("rest_create_computer", {
  description: "Create a cloud computer from a machine template.",
  parameters: Schema.Struct({
    name: Schema.String,
    remoteUser: Schema.String,
    provider: Schema.optional(Schema.Literals(["byom", "e2b"])),
    hostId: Schema.optional(Schema.String),
    repos: Schema.optional(Schema.Array(Schema.String)),
    autoInstallDeps: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Json,
  failure: ToolFailure,
  dependencies: [RestService],
})

const DeleteComputer = Tool.make("rest_delete_computer", {
  description: "Delete a cloud computer. Destructive; confirm before calling.",
  parameters: ComputerId,
  success: Schema.Struct({ deleted: Schema.Boolean }),
  failure: ToolFailure,
  dependencies: [RestService],
})

const RestartComputer = Tool.make("rest_restart_computer", {
  description: "Restart a cloud computer.",
  parameters: ComputerId,
  success: Schema.Struct({ restarted: Schema.Boolean }),
  failure: ToolFailure,
  dependencies: [RestService],
})

const ListMachineTemplates = Tool.make("rest_list_machine_templates", {
  description: "List the machine templates a computer can be created from.",
  parameters: Schema.Struct({
    limit: Schema.optional(Schema.Number),
    cursor: Schema.optional(Schema.String),
  }),
  success: Schema.Json,
  failure: ToolFailure,
  dependencies: [RestService],
})

const GetMachineTemplate = Tool.make("rest_get_machine_template", {
  description: "Read one machine template by id.",
  parameters: Schema.Struct({ templateId: Schema.String }),
  success: Schema.Json,
  failure: ToolFailure,
  dependencies: [RestService],
})

const ListRemoteSessions = Tool.make("rest_list_remote_sessions", {
  description: "List sessions across the account's computers, newest first.",
  parameters: Schema.Struct({
    computerId: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    cursor: Schema.optional(Schema.String),
  }),
  success: Schema.Json,
  failure: ToolFailure,
  dependencies: [RestService],
})

const ComputerMetrics = Tool.make("rest_get_computer_metrics", {
  description: "Read a cloud computer's resource metrics.",
  parameters: ComputerId,
  success: Schema.Json,
  failure: ToolFailure,
  dependencies: [RestService],
})

export const restTools = (config: Config) => {
  const tools: Array<Tool.Any> = [
    ListComputers,
    GetComputer,
    CreateComputer,
    DeleteComputer,
    RestartComputer,
    ComputerMetrics,
    ListMachineTemplates,
    GetMachineTemplate,
    ListRemoteSessions,
  ]

  const RestTools = Toolkit.make(
    ListComputers,
    GetComputer,
    CreateComputer,
    DeleteComputer,
    RestartComputer,
    ComputerMetrics,
    ListMachineTemplates,
    GetMachineTemplate,
    ListRemoteSessions,
  )

  const handlers = RestTools.of({
    rest_list_computers: () =>
      call(config, "listComputers", () => sdk.listComputers(apiOptions(config))),
    rest_get_computer: (params) =>
      call(config, "getComputer", () =>
        sdk.getComputer({ ...apiOptions(config), computerId: params.computerId }),
      ),
    rest_create_computer: (params) =>
      call(config, "createComputer", () =>
        sdk.createComputer({
          ...apiOptions(config),
          name: params.name,
          remoteUser: params.remoteUser,
          provider: params.provider,
          hostId: params.hostId,
          repos: params.repos === undefined ? undefined : [...params.repos],
          autoInstallDeps: params.autoInstallDeps,
        }),
      ),
    rest_delete_computer: (params) =>
      Effect.gen(function* () {
        yield* voidCall(config, "deleteComputer", () =>
          sdk.deleteComputer({ ...apiOptions(config), computerId: params.computerId }),
        )

        return { deleted: true }
      }),
    rest_restart_computer: (params) =>
      Effect.gen(function* () {
        yield* voidCall(config, "restartComputer", () =>
          sdk.restartComputer({ ...apiOptions(config), computerId: params.computerId }),
        )

        return { restarted: true }
      }),
    rest_get_computer_metrics: (params) =>
      call(config, "getComputerMetrics", () =>
        sdk.getComputerMetrics({ ...apiOptions(config), computerId: params.computerId }),
      ),
    rest_list_machine_templates: (params) =>
      call(config, "listMachineTemplates", () =>
        sdk.listMachineTemplates({
          ...apiOptions(config),
          limit: params.limit,
          cursor: params.cursor,
        }),
      ),
    rest_get_machine_template: (params) =>
      call(config, "getMachineTemplate", () =>
        sdk.getMachineTemplate({ ...apiOptions(config), templateId: params.templateId }),
      ),
    rest_list_remote_sessions: (params) =>
      call(config, "listRemoteSessions", () =>
        sdk.listRemoteSessions({
          ...apiOptions(config),
          computerId: params.computerId,
          limit: params.limit,
          cursor: params.cursor,
        }),
      ),
  })

  return { tools, handlers }
}
