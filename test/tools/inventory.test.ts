import { describe, expect, it } from "vitest"

import { SURFACE, SURFACE_COUNT } from "../../src/generated/surface.ts"
import { SESSION_OWNED_METHODS } from "../../src/tools/generated.ts"
import { toolsFor } from "../../src/tools/index.ts"
import { testConfig } from "../support/config.ts"

/** Every hand-written tool that is not generated from the SDK surface. */
const HAND_WRITTEN = [
  "server_info",
  "session_create",
  "session_stream",
  "session_events",
  "session_interrupt",
  "session_close",
  "session_respond_permission",
  "session_answer_question",
  "session_pick_options",
  "session_update_settings",
  "session_change_cwd",
  "session_enter_spec_mode",
  "session_exit_spec_mode",
  "session_rename",
  "session_add_mcp_server",
  "session_remove_mcp_server",
  "session_toggle_mcp_server",
  "session_list_mcp_servers",
  "session_list_mcp_tools",
  "session_refresh_connector_tool_catalog",
  "session_authenticate_mcp_server",
  "session_submit_mcp_auth_code",
  "session_list_tools",
  "session_list_skills",
  "session_set_skill_disabled",
  "session_get_rewind_info",
  "session_rewind",
  "session_compact",
  "session_fork",
  "session_get_context_stats",
  "session_models",
  "session_run",
  "rest_list_computers",
  "rest_get_computer",
  "rest_create_computer",
  "rest_delete_computer",
  "rest_restart_computer",
  "rest_get_computer_metrics",
  "rest_list_machine_templates",
  "rest_get_machine_template",
  "rest_list_remote_sessions",
] as const

const toolNames = (): ReadonlyArray<string> => Object.keys(toolsFor(testConfig()).toolkit.tools)

describe("tool inventory", () => {
  it("counts one generated tool per SDK method plus the hand-written tools", () => {
    const generated = SURFACE.filter((entry) => !SESSION_OWNED_METHODS.includes(entry.method))

    expect(SURFACE_COUNT).toBe(165)
    expect(toolNames()).toHaveLength(generated.length + HAND_WRITTEN.length)
  })

  it("has no duplicate names", () => {
    const names = toolNames()

    expect(new Set(names).size).toBe(names.length)
  })

  it("keeps every hand-written tool", () => {
    const names = new Set(toolNames())

    for (const name of HAND_WRITTEN) expect(names.has(name)).toBe(true)
  })

  it("does not expose a generated tool for a method the session tools own", () => {
    const names = new Set(toolNames())

    for (const entry of SURFACE) {
      if (SESSION_OWNED_METHODS.includes(entry.method)) expect(names.has(entry.tool)).toBe(false)
    }
  })

  it("describes every tool", () => {
    for (const tool of Object.values(toolsFor(testConfig()).toolkit.tools)) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(10)
    }
  })
})
