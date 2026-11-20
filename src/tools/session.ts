import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import { presentFields, toJsonValue } from "../droid/protocol.ts"
import type { JsonValue } from "../droid/protocol.ts"
import {
  MAX_WAIT_MS,
  SessionHubService,
  SessionSettingsSchema,
  TurnResultSchema,
  TurnStatusSchema,
  WorktreeInfoSchema,
} from "../droid/turns.ts"
import type { TurnResult } from "../droid/turns.ts"
import { createWorktree, removeWorktree } from "../droid/worktree.ts"
import type { WorktreeFields } from "../droid/worktree.ts"
import { ToolFailure } from "./failure.ts"
import { requireAutonomy, requireCwd, toolFailure } from "./guards.ts"
import { DELIVERIES } from "./session-delivery.ts"
import { presentTurn } from "./session-delivery.ts"
import { blockUntilSettled } from "./session-elicit.ts"

export const AutonomySchema = Schema.Literals(["off", "low", "medium", "high"])

export const WaitMsSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_MS }),
).annotate({ description: "How long to wait, in milliseconds: 20000 by default, 300000 at most." })

export const DeliverySchema = Schema.Literals(DELIVERIES).annotate({
  description:
    "detach returns at once with a session URI and no event dump. block waits until the turn ends, a prompt the client cannot answer, or 5 minutes.",
})

const WorktreeFlag = Schema.optionalKey(Schema.Boolean).annotate({
  description:
    "Create a git worktree and run there. Ephemeral worktrees are removed when the session closes.",
})

export const worktreeFields = {
  worktree: WorktreeFlag,
  worktreeLifecycle: Schema.optionalKey(Schema.Literals(["ephemeral", "persistent"])),
  worktreeBranchMode: Schema.optionalKey(Schema.Literals(["copy", "existing"])),
  worktreeBaseBranch: Schema.optionalKey(Schema.String),
  worktreeBaseBranchFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeNewBranch: Schema.optionalKey(Schema.String),
  worktreeDir: Schema.optionalKey(Schema.String).annotate({
    description: "Absolute directory that will contain the worktree.",
  }),
}

/** One `droid.*` request on a live session, with omitted fields left out of the params. */
export const commandSession = (
  sessionId: string,
  method: string,
  payload: Record<string, JsonValue | undefined>,
): Effect.Effect<JsonValue | undefined, ToolFailure, SessionHubService> =>
  SessionHubService.use((hub) =>
    hub
      .command({ sessionId, method, params: toJsonValue({ sessionId, ...presentFields(payload) }) })
      .pipe(Effect.mapError(toolFailure)),
  )

export const spawnCwd = (cwd: string, fields: WorktreeFields) =>
  Effect.gen(function* () {
    const checked = yield* requireCwd(cwd)

    const tree = yield* createWorktree(checked, fields).pipe(
      Effect.mapError((cause) => ({ code: cause.code, message: cause.message })),
    )

    return { cwd: tree?.path ?? checked, worktree: tree }
  })

const Create = Tool.make("session_create", {
  description:
    "Start a Droid session. Set worktree to use a separate git checkout. " +
    "Autonomy must not exceed the server's cap.",
  parameters: Schema.Struct({
    cwd: Schema.String,
    autonomyLevel: AutonomySchema,
    modelId: Schema.optionalKey(Schema.String),
    reasoningEffort: Schema.optionalKey(Schema.String),
    restrictToolIds: Schema.optionalKey(Schema.Array(Schema.String)),
    disabledToolIds: Schema.optionalKey(Schema.Array(Schema.String)),
    ...worktreeFields,
  }),
  success: Schema.Struct({
    sessionId: Schema.String,
    cwd: Schema.String,
    settings: SessionSettingsSchema,
    worktree: Schema.optional(WorktreeInfoSchema),
  }),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const Stream = Tool.make("session_stream", {
  description:
    "Send a prompt. Omit delivery to wait up to waitMs and return events. " +
    "detach returns a session URI and no event dump. block waits and uses a form when the client can.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    prompt: Schema.String,
    waitMs: Schema.optionalKey(WaitMsSchema),
    delivery: Schema.optionalKey(DeliverySchema),
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
    waitMs: Schema.optionalKey(WaitMsSchema),
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
        worktree: Schema.optional(WorktreeInfoSchema),
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
        const autonomyLevel = yield* requireAutonomy(config.maxAutonomy, params.autonomyLevel)
        const spawned = yield* spawnCwd(params.cwd, params)

        return yield* hub
          .create({
            cwd: spawned.cwd,
            autonomyLevel,
            maxAutonomy: config.maxAutonomy,
            modelId: params.modelId,
            reasoningEffort: params.reasoningEffort,
            restrictToolIds: params.restrictToolIds,
            disabledToolIds: params.disabledToolIds,
            worktree: spawned.worktree,
          })
          .pipe(
            Effect.mapError(toolFailure),
            Effect.tapError(() =>
              spawned.worktree?.lifecycle === "ephemeral"
                ? removeWorktree(spawned.worktree)
                : Effect.void,
            ),
          )
      }),
    session_stream: (params) =>
      SessionHubService.use((hub) => {
        const delivery = params.delivery
        const waited = delivery === undefined ? params.waitMs : 0

        const turn = hub
          .stream({
            sessionId: params.sessionId,
            prompt: params.prompt,
            waitMs: waited,
          })
          .pipe(Effect.mapError(toolFailure))

        if (delivery === "block") {
          return Effect.flatMap(turn, (result) =>
            blockUntilSettled(params.sessionId, result, config.maxAutonomy, params.waitMs),
          )
        }

        return Effect.map(turn, (result): TurnResult =>
          delivery === "detach" ? presentTurn(result) : result,
        )
      }),
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
