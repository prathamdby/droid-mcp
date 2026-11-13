import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { ToolProfile } from "../config.ts"
import { SKILL_FILES, SKILL_MD, SKILL_URI } from "../generated/skill.ts"
import { ApiKeyId } from "../http/auth.ts"
import { ToolFailure } from "./failure.ts"

/**
 * The skill and the `droid` prompt. Both serve the same markdown: a client that
 * supports the Skills extension finds the skill, and a client that only knows
 * prompts can still ask for it by name. Clients that only support tools can
 * call `skill_read`.
 */

const SKILL_URI_PREFIX = SKILL_URI.slice(0, SKILL_URI.lastIndexOf("/") + 1)

const SKILL_NOT_READ_MESSAGE =
  "Read the droid skill before calling session_* tools: call skill_read, read resource " +
  SKILL_URI +
  ", or get prompt droid."

const currentSessionKey = (explicitSessionId?: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (explicitSessionId !== undefined && explicitSessionId.length > 0) {
      return "session:" + explicitSessionId
    }

    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)

    const headerSessionId = Option.isSome(request)
      ? request.value.headers["mcp-session-id"]
      : undefined

    if (headerSessionId !== undefined && headerSessionId.length > 0) {
      return "session:" + headerSessionId
    }

    const keyId = yield* Effect.map(Effect.serviceOption(ApiKeyId), Option.getOrUndefined)

    if (keyId !== undefined) return "key:" + keyId

    return "default"
  })

export interface SkillGateApi {
  readonly markRead: Effect.Effect<void>
  readonly markSessionRead: (sessionId: string | undefined) => Effect.Effect<void>
  readonly requireRead: Effect.Effect<void, ToolFailure>
}

export class SkillGate extends Context.Service<SkillGate, SkillGateApi>()("droid-mcp/SkillGate") {}

export const makeSkillGate = (requireSkill: boolean): SkillGateApi => {
  const read = new Set<string>()

  const markSessionRead = (sessionId: string | undefined): Effect.Effect<void> =>
    currentSessionKey(sessionId).pipe(
      Effect.tap((key) =>
        Effect.sync(() => {
          read.add(key)
        }),
      ),
      Effect.asVoid,
    )

  return {
    markRead: markSessionRead(undefined),
    markSessionRead,
    requireRead: requireSkill
      ? Effect.flatMap(currentSessionKey(), (key) =>
          read.has(key)
            ? Effect.void
            : Effect.fail<ToolFailure>({ code: "skill_not_read", message: SKILL_NOT_READ_MESSAGE }),
        )
      : Effect.void,
  }
}

export const skillGateLayer = (requireSkill: boolean): Layer.Layer<SkillGate> =>
  Layer.sync(SkillGate, () => makeSkillGate(requireSkill))

export const SkillRead = Tool.make("skill_read", {
  description:
    "Read the droid skill markdown. Required before any session_* call unless the client " +
    "already read " +
    SKILL_URI +
    " or the droid prompt.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    uri: Schema.String,
    markdown: Schema.String,
  }),
  failure: ToolFailure,
  dependencies: [SkillGate],
})

export const skillReadHandler = () =>
  SkillGate.use((gate) =>
    Effect.as(gate.markRead, {
      uri: SKILL_URI,
      markdown: SKILL_MD,
    }),
  )

const isSkillTarget = (method: McpServer.MiddlewareMethod, target: string): boolean =>
  (method === "resources/read" && (target === SKILL_URI || target.startsWith(SKILL_URI_PREFIX))) ||
  (method === "prompts/get" && target === "droid") ||
  (method === "skills/get" && target === SKILL_URI)

export const skillReadObserver = McpServer.middleware(
  Effect.map(
    SkillGate,
    (gate) => (effect, options) =>
      isSkillTarget(options.method, options.target)
        ? Effect.tap(effect, () => gate.markSessionRead(options.sessionId))
        : effect,
  ),
)

export const droidSkill = (): Layer.Layer<never, Cause.IllegalArgumentError, McpServer.McpServer> =>
  McpServer.skill({ uri: SKILL_URI, files: SKILL_FILES })

export const droidPrompt = (): Layer.Layer<
  never,
  Cause.IllegalArgumentError,
  McpServer.McpServer
> =>
  McpServer.prompt({
    name: "droid",
    description:
      "Read the droid skill: token-efficient turns, dispatch, and all capability families.",
    content: () => Effect.succeed(SKILL_MD),
  })

/** What `initialize` tells a client before it lists a single tool. */
export const INSTRUCTIONS =
  "Drive Factory Droid. Call skill_read (or read " +
  SKILL_URI +
  " / prompt droid) before any session_* call; session_* fails with skill_not_read until you do. " +
  "Reuse server_info profile/cap and known schemas. " +
  "session_create -> session_stream -> session_events with each returned cursor; " +
  "use long waitMs and consume only the outcome when enough, but handle pending prompts " +
  "with session_respond_permission, session_answer_question, or session_pick_options. " +
  "Stop on terminal status; session_close when done."

/** The compact profile adds how to reach the operations it does not list. */
export const COMPACT_INSTRUCTIONS =
  INSTRUCTIONS +
  " All operations remain reachable: tools_search/tools_describe only for unknown names/inputs; " +
  "tool_call or batch (up to 20, $from dependencies). Use select and small maxBytes; " +
  "result_read only for needed data beyond the preview. Includes session administration, " +
  "daemon/droid, hosted REST, and Context."

export const instructionsFor = (profile: ToolProfile): string =>
  profile === "compact" ? COMPACT_INSTRUCTIONS : INSTRUCTIONS

export const registrations = Layer.mergeAll(droidSkill(), droidPrompt()).pipe(
  Layer.provide(skillReadObserver.layer),
)
