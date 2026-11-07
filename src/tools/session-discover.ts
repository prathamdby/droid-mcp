import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import { presentFields, toJsonValue } from "../droid/protocol.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { SessionHubService, TurnResultSchema } from "../droid/turns.ts"
import { ToolFailure } from "./failure.ts"
import { requireAutonomy, requireCwd, toolFailure } from "./guards.ts"
import { AutonomySchema, WaitMsSchema } from "./session.ts"

const send = (
  sessionId: string,
  method: string,
  payload: Record<string, JsonValue | undefined>,
): Effect.Effect<JsonValue | undefined, ToolFailure, SessionHubService> =>
  SessionHubService.use((hub) =>
    hub
      .command({ sessionId, method, params: toJsonValue({ sessionId, ...presentFields(payload) }) })
      .pipe(Effect.mapError(toolFailure)),
  )

const ListTools = Tool.make("session_list_tools", {
  description: "List the tools available to a live session.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ListSkills = Tool.make("session_list_skills", {
  description: "List the skills a live session can load.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    includeContent: Schema.optional(Schema.Boolean),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const SetSkillDisabled = Tool.make("session_set_skill_disabled", {
  description: "Enable or disable a skill for a live session.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    skillName: Schema.String,
    disabled: Schema.Boolean,
    settingsLevel: Schema.optional(Schema.Literals(["user", "project", "local"])),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Models = Tool.make("session_models", {
  description: "List the models a live session reported at startup.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.Struct({ models: Schema.Array(Schema.Json) }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Run = Tool.make("session_run", {
  description:
    "Create a session and run one turn. The session is closed when the turn completes, fails, " +
    "or is interrupted. A running result keeps the session: poll session_events with the " +
    "returned cursor, answer prompts, then call session_close. Use session_create when you " +
    "need more than one turn.",
  parameters: Schema.Struct({
    cwd: Schema.String,
    prompt: Schema.String,
    autonomyLevel: AutonomySchema,
    modelId: Schema.optional(Schema.String),
    waitMs: Schema.optional(WaitMsSchema),
  }),
  success: TurnResultSchema,
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

export const sessionDiscoverTools = (config: Config) => {
  const list: Array<Tool.Any> = [ListTools, ListSkills, SetSkillDisabled, Models, Run]
  const DiscoverTools = Toolkit.make(ListTools, ListSkills, SetSkillDisabled, Models, Run)

  const handlers = DiscoverTools.of({
    session_list_tools: (params) => send(params.sessionId, "droid.list_tools", {}),
    session_list_skills: (params) =>
      send(params.sessionId, "droid.list_skills", { includeContent: params.includeContent }),
    session_set_skill_disabled: (params) =>
      send(params.sessionId, "droid.set_skill_disabled", {
        skillName: params.skillName,
        disabled: params.disabled,
        settingsLevel: params.settingsLevel,
      }),
    session_models: (params) =>
      SessionHubService.use((hub) =>
        hub.models(params.sessionId).pipe(
          Effect.map((models) => ({ models: [...models] })),
          Effect.mapError(toolFailure),
        ),
      ),
    session_run: (params) =>
      SessionHubService.use((hub) =>
        Effect.gen(function* () {
          const cwd = yield* requireCwd(params.cwd)
          const autonomyLevel = yield* requireAutonomy(config.maxAutonomy, params.autonomyLevel)

          const modelId = params.modelId

          const created = yield* hub
            .create({
              cwd,
              autonomyLevel,
              maxAutonomy: config.maxAutonomy,
              modelId,
            })
            .pipe(Effect.mapError(toolFailure))

          const waitMs = params.waitMs

          const turn =
            waitMs === undefined
              ? { sessionId: created.sessionId, prompt: params.prompt }
              : { sessionId: created.sessionId, prompt: params.prompt, waitMs }

          let retain = false

          return yield* Effect.ensuring(
            Effect.gen(function* () {
              const result = yield* hub.stream(turn).pipe(Effect.mapError(toolFailure))

              if (result.status === "running") retain = true

              return result
            }),
            Effect.gen(function* () {
              if (retain) return

              yield* hub.close(created.sessionId).pipe(Effect.ignore)
            }),
          )
        }),
      ),
  })

  return { tools: list, handlers }
}
