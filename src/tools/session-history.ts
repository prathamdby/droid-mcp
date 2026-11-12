import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { presentFields, toJsonValue } from "../droid/protocol.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { SessionHubService } from "../droid/turns.ts"
import { ToolFailure } from "./failure.ts"
import { toolFailure } from "./guards.ts"

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

const RewindInfo = Tool.make("session_get_rewind_info", {
  description: "Describe what rewinding to a message would restore or delete.",
  parameters: Schema.Struct({ sessionId: Schema.String, messageId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Rewind = Tool.make("session_rewind", {
  description:
    "Rewind a session to a message, restoring and deleting the listed files. Destructive; " +
    "confirm before calling.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    messageId: Schema.String,
    filesToRestore: Schema.optionalKey(Schema.Array(Schema.String)),
    filesToDelete: Schema.optionalKey(Schema.Array(Schema.String)),
    forkTitle: Schema.optionalKey(Schema.String),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Compact = Tool.make("session_compact", {
  description: "Compact a session's conversation to free context; reports removed messages.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    customInstructions: Schema.optionalKey(Schema.String),
    mode: Schema.optionalKey(Schema.String),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Fork = Tool.make("session_fork", {
  description: "Fork a session into a new one and return its id.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    title: Schema.optionalKey(Schema.String),
    tags: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ContextStats = Tool.make("session_get_context_stats", {
  description: "Report a session's context usage, including compaction thresholds.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

export const sessionHistoryTools = () => {
  const list: Array<Tool.Any> = [RewindInfo, Rewind, Compact, Fork, ContextStats]
  const HistoryTools = Toolkit.make(RewindInfo, Rewind, Compact, Fork, ContextStats)

  const handlers = HistoryTools.of({
    session_get_rewind_info: (params) =>
      send(params.sessionId, "droid.get_rewind_info", { messageId: params.messageId }),
    session_rewind: (params) =>
      send(params.sessionId, "droid.execute_rewind", {
        messageId: params.messageId,
        filesToRestore: params.filesToRestore,
        filesToDelete: params.filesToDelete,
        forkTitle: params.forkTitle,
      }),
    session_compact: (params) =>
      send(params.sessionId, "droid.compact_session", {
        customInstructions: params.customInstructions,
        mode: params.mode,
      }),
    session_fork: (params) =>
      send(params.sessionId, "droid.fork_session", { title: params.title, tags: params.tags }),
    session_get_context_stats: (params) => send(params.sessionId, "droid.get_context_stats", {}),
  })

  return { tools: list, handlers }
}
