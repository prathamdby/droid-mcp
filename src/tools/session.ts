import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import {
  MAX_WAIT_MS,
  SessionHubService,
  SessionSettingsSchema,
  TurnResultSchema,
  TurnStatusSchema,
} from "../droid/turns.ts"
import { ToolFailure } from "./failure.ts"
import { requireAutonomy, requireCwd, toolFailure } from "./guards.ts"

export const AutonomySchema = Schema.Literals(["off", "low", "medium", "high"])

export const WaitMsSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_MS }),
).annotate({ description: "How long to wait, in milliseconds: 20000 by default, 300000 at most." })

const Create = Tool.make("session_create", {
  description:
    "Start a Droid session in a directory. Every other session tool takes its sessionId. " +
    "Autonomy must not exceed the server's cap.",
  parameters: Schema.Struct({
    cwd: Schema.String,
    autonomyLevel: AutonomySchema,
    modelId: Schema.optional(Schema.String),
    reasoningEffort: Schema.optional(Schema.String),
    restrictToolIds: Schema.optional(Schema.Array(Schema.String)),
    disabledToolIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: Schema.Struct({
    sessionId: Schema.String,
    cwd: Schema.String,
    settings: SessionSettingsSchema,
  }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Stream = Tool.make("session_stream", {
  description:
    "Send a prompt to a session and wait for the turn. A running result keeps the session; " +
    "poll session_events with the returned cursor, which is the next sequence number, until " +
    "status is completed, failed, or interrupted.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    prompt: Schema.String,
    waitMs: Schema.optional(WaitMsSchema),
  }),
  success: TurnResultSchema,
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Events = Tool.make("session_events", {
  description:
    "Read events since a cursor. The cursor is the next sequence number, not the last seq; " +
    "pass a previous call's cursor back unchanged so no event is repeated. truncated is set " +
    "when that cursor is older than the retained buffer. Poll until status is completed, " +
    "failed, or interrupted.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    waitMs: Schema.optional(WaitMsSchema),
  }),
  success: TurnResultSchema,
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Interrupt = Tool.make("session_interrupt", {
  description: "Stop the running turn in a session; the turn completes as interrupted.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.Struct({ interrupted: Schema.Boolean }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Close = Tool.make("session_close", {
  description:
    "Interrupt any running turn, cancel pending prompts, and stop the session process. " +
    "Destructive; confirm before calling.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.Struct({ closed: Schema.Boolean }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const List = Tool.make("session_list", {
  description:
    "List the live local sessions: sessionId, cwd, turn status, next cursor, and settings. " +
    "Use it to recover a sessionId or cursor; it starts nothing.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({
        sessionId: Schema.String,
        cwd: Schema.String,
        status: TurnStatusSchema,
        cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        settings: SessionSettingsSchema,
      }),
    ),
  }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

export const sessionTools = (config: Config) => {
  const SessionTools = Toolkit.make(Create, Stream, Events, Interrupt, Close, List)

  const handlers = SessionTools.of({
    session_create: (params) =>
      Effect.gen(function* () {
        const hub = yield* SessionHubService
        const cwd = yield* requireCwd(params.cwd)
        const autonomyLevel = yield* requireAutonomy(config.maxAutonomy, params.autonomyLevel)

        return yield* hub
          .create({
            cwd,
            autonomyLevel,
            maxAutonomy: config.maxAutonomy,
            modelId: params.modelId,
            reasoningEffort: params.reasoningEffort,
            restrictToolIds: params.restrictToolIds,
            disabledToolIds: params.disabledToolIds,
          })
          .pipe(Effect.mapError(toolFailure))
      }),
    session_stream: (params) =>
      SessionHubService.use((hub) =>
        hub
          .stream({
            sessionId: params.sessionId,
            prompt: params.prompt,
            waitMs: params.waitMs,
          })
          .pipe(Effect.mapError(toolFailure)),
      ),
    session_events: (params) =>
      SessionHubService.use((hub) =>
        hub
          .events({ sessionId: params.sessionId, cursor: params.cursor, waitMs: params.waitMs })
          .pipe(Effect.mapError(toolFailure)),
      ),
    session_interrupt: (params) =>
      SessionHubService.use((hub) =>
        hub.interrupt(params.sessionId).pipe(Effect.mapError(toolFailure)),
      ),
    session_close: (params) =>
      SessionHubService.use((hub) =>
        hub.close(params.sessionId).pipe(Effect.mapError(toolFailure)),
      ),
    session_list: () =>
      SessionHubService.use((hub) =>
        Effect.map(hub.sessions, (sessions) => ({ sessions: [...sessions] })),
      ),
  })

  return { tools: [Create, Stream, Events, Interrupt, Close, List], handlers }
}
