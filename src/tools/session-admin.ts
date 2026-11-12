import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import { EXEC_METHOD } from "../droid/exec-protocol.ts"
import { presentFields, toJsonValue } from "../droid/protocol.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { SessionHubService } from "../droid/turns.ts"
import { ToolFailure } from "./failure.ts"
import { requireAutonomy, requireCwd, toolFailure } from "./guards.ts"
import { AutonomySchema } from "./session.ts"

const ReasoningSchema = Schema.Literals([
  "none",
  "dynamic",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

const InteractionSchema = Schema.Literals(["auto", "spec", "agi", "mission"])

/**
 * Sends one `droid.*` request on a session and reports whatever the CLI
 * answers. Admin methods all share this shape, so they share one helper.
 */
const send = (
  params: { readonly sessionId: string },
  method: string,
  payload: Record<string, JsonValue | undefined>,
): Effect.Effect<JsonValue | undefined, ToolFailure, SessionHubService> =>
  SessionHubService.use((hub) =>
    hub
      .command({
        sessionId: params.sessionId,
        method,
        params: toJsonValue({ sessionId: params.sessionId, ...presentFields(payload) }),
      })
      .pipe(Effect.mapError(toolFailure)),
  )

const UpdateSettings = Tool.make("session_update_settings", {
  description:
    "Change a live session's autonomy, model, reasoning effort, or interaction mode. " +
    "The next turn uses the new settings.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    autonomyLevel: Schema.optionalKey(AutonomySchema),
    modelId: Schema.optionalKey(Schema.String),
    reasoningEffort: Schema.optionalKey(ReasoningSchema),
    interactionMode: Schema.optionalKey(InteractionSchema),
    specModeModelId: Schema.optionalKey(Schema.String),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ChangeCwd = Tool.make("session_change_cwd", {
  description: "Point a live session at another absolute directory.",
  parameters: Schema.Struct({ sessionId: Schema.String, cwd: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const EnterSpecMode = Tool.make("session_enter_spec_mode", {
  description: "Switch a live session into spec mode for the next turn.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ExitSpecMode = Tool.make("session_exit_spec_mode", {
  description: "Switch a live session back to auto interaction mode.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Rename = Tool.make("session_rename", {
  description: "Rename a session so it is recognizable in the session list.",
  parameters: Schema.Struct({ sessionId: Schema.String, title: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

export const sessionAdminTools = (config: Config) => {
  const tools: Array<Tool.Any> = [UpdateSettings, ChangeCwd, EnterSpecMode, ExitSpecMode, Rename]
  const AdminTools = Toolkit.make(UpdateSettings, ChangeCwd, EnterSpecMode, ExitSpecMode, Rename)

  const handlers = AdminTools.of({
    session_update_settings: (params) =>
      Effect.gen(function* () {
        if (params.autonomyLevel !== undefined) {
          yield* requireAutonomy(config.maxAutonomy, params.autonomyLevel)
        }

        const payload: Record<string, JsonValue | undefined> = {}

        if (params.autonomyLevel !== undefined) payload.autonomyLevel = params.autonomyLevel

        if (params.modelId !== undefined) payload.modelId = params.modelId

        if (params.reasoningEffort !== undefined) {
          payload.reasoningEffort = params.reasoningEffort
        }

        if (params.interactionMode !== undefined) payload.interactionMode = params.interactionMode

        if (params.specModeModelId !== undefined) payload.specModeModelId = params.specModeModelId

        return yield* send(params, EXEC_METHOD.updateSettings, payload)
      }),
    session_change_cwd: (params) =>
      Effect.gen(function* () {
        const cwd = yield* requireCwd(params.cwd)

        return yield* send(params, "droid.change_working_directory", { workingDirectory: cwd })
      }),
    session_enter_spec_mode: (params) =>
      send(params, EXEC_METHOD.updateSettings, { interactionMode: "spec" }),
    session_exit_spec_mode: (params) =>
      send(params, EXEC_METHOD.updateSettings, { interactionMode: "auto" }),
    session_rename: (params) => send(params, "droid.rename_session", { title: params.title }),
  })

  return { tools, handlers }
}
