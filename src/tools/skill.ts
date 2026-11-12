import * as McpServer from "effect/ai/McpServer"
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { ToolProfile } from "../config.ts"
import { SKILL_FILES, SKILL_MD, SKILL_URI } from "../generated/skill.ts"

/**
 * The skill and the `droid` prompt. Both serve the same markdown: a client that
 * supports the Skills extension finds the skill, and a client that only knows
 * prompts can still ask for it by name.
 */

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
  "Drive Factory Droid. Read " +
  SKILL_URI +
  " before starting. Reuse server_info profile/cap and known schemas. " +
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

export const registrations = Layer.mergeAll(droidSkill(), droidPrompt())
