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
    description: "Read the droid skill: the turn loop, prompts, and delegation.",
    content: () => Effect.succeed(SKILL_MD),
  })

/** What `initialize` tells a client before it lists a single tool. */
export const INSTRUCTIONS =
  "This server drives Factory Droid on this host. Read the droid skill at " +
  SKILL_URI +
  " before starting. A turn is session_create, then session_stream; poll " +
  "session_events from the cursor it returns until the status is not running. " +
  "Answer pending prompts with session_respond_permission, " +
  "session_answer_question, or session_pick_options, and call session_close when " +
  "the work is done. server_info reports the version and the autonomy cap."

/** The compact profile adds how to reach the operations it does not list. */
export const COMPACT_INSTRUCTIONS =
  INSTRUCTIONS +
  " Every other operation (daemon, hosted REST, Context, session administration) is not " +
  "listed: find it with tools_search, read its schema with tools_describe, and run it with " +
  "tool_call, or chain up to 20 with batch. Results over maxBytes return a preview and a " +
  "ref; read the rest with result_read."

export const instructionsFor = (profile: ToolProfile): string =>
  profile === "compact" ? COMPACT_INSTRUCTIONS : INSTRUCTIONS

export const registrations = Layer.mergeAll(droidSkill(), droidPrompt())
