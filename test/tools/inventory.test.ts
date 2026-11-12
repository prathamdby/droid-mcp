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
  "session_list",
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
  "rest_get_computer_by_name",
  "rest_create_computer",
  "rest_update_computer",
  "rest_delete_computer",
  "rest_restart_computer",
  "rest_refresh_computer",
  "rest_retry_install_deps",
  "rest_get_computer_metrics",
  "rest_list_computer_providers",
  "rest_bulk_create_computers",
  "rest_record_computer_activity",
  "rest_create_computer_file_upload",
  "rest_complete_computer_file_upload",
  "rest_create_computer_file_download",
  "rest_list_machine_templates",
  "rest_get_machine_template",
  "rest_list_environments",
  "rest_create_environment",
  "rest_get_environment",
  "rest_update_environment",
  "rest_delete_environment",
  "rest_ensure_default_environment",
  "rest_set_default_environment",
  "rest_list_environment_sources",
  "rest_list_environment_build_statuses",
  "rest_get_environment_build_diagnostics",
  "rest_get_environment_build_attempt_diagnostics",
  "rest_retry_environment_build",
  "rest_cancel_environment_build",
  "rest_list_remote_sessions",
  "rest_create_remote_session",
  "rest_get_remote_session",
  "rest_update_remote_session",
  "rest_delete_remote_session",
  "rest_interrupt_remote_session",
  "rest_list_remote_session_messages",
  "rest_post_remote_session_message",
  "rest_get_remote_session_message",
  "rest_list_remote_session_children",
  "rest_list_wiki_runs",
  "rest_create_wiki_run",
  "rest_get_wiki_run",
  "rest_delete_wiki_run",
  "rest_export_wiki_run",
  "rest_get_wiki_page",
  "rest_search_wiki_run",
  "rest_update_wiki_privacy",
  "rest_list_wiki_history",
  "rest_get_wiki_upload_access",
  "rest_create_wiki_video_upload_url",
  "rest_scan_ci_repositories",
  "rest_list_ci_repositories",
  "rest_list_ci_repository_owners",
  "rest_list_ci_jobs",
  "rest_list_ci_runs",
  "rest_edit_ci_workflow",
  "rest_list_organization_users",
  "rest_invite_organization_user",
  "rest_remove_organization_user",
  "rest_get_organization_global_limit",
  "rest_set_organization_global_limit",
  "rest_get_organization_group_limits",
  "rest_set_organization_group_limits",
  "rest_get_organization_user_limits",
  "rest_set_organization_user_limits",
  "rest_list_organization_computer_secrets",
  "rest_update_organization_computer_secrets",
  "rest_list_organization_enterprise_control_history",
  "rest_list_service_accounts",
  "rest_create_service_account",
  "rest_get_service_account",
  "rest_update_service_account",
  "rest_delete_service_account",
  "rest_list_service_account_api_keys",
  "rest_create_service_account_api_key",
  "rest_rotate_service_account_api_key",
  "rest_revoke_service_account_api_key",
  "context_create_space",
  "context_list_spaces",
  "context_get_space",
  "context_create_document",
  "context_list_documents",
  "context_get_document",
  "context_get_document_by_path",
  "context_update_document",
  "context_delete_document",
  "context_create_file",
  "context_upload_file_part",
  "context_read_file_part",
  "context_delete_file",
  "context_register_session",
  "context_get_session",
  "context_list_sessions",
  "context_append_session",
  "context_read_session_records",
] as const

const FAMILIES = ["server", "session", "rest", "context", "daemon", "droid"] as const

const familyOf = (name: string): string => name.slice(0, name.indexOf("_"))

const toolNames = (): ReadonlyArray<string> => Object.keys(toolsFor(testConfig()).toolkit.tools)

describe("tool inventory", () => {
  it("counts one generated tool per SDK method plus the hand-written tools", () => {
    const generated = SURFACE.filter((entry) => !SESSION_OWNED_METHODS.includes(entry.method))

    expect(SURFACE_COUNT).toBe(165)
    expect(toolNames()).toHaveLength(generated.length + HAND_WRITTEN.length)
  })

  it("exposes 288 tools in the expected families", () => {
    const counts = new Map<string, number>()

    for (const name of toolNames()) {
      counts.set(familyOf(name), (counts.get(familyOf(name)) ?? 0) + 1)
    }

    expect(toolNames()).toHaveLength(288)
    expect(Object.fromEntries(FAMILIES.map((family) => [family, counts.get(family) ?? 0]))).toEqual(
      { server: 1, session: 32, rest: 79, context: 18, daemon: 130, droid: 28 },
    )
    expect([...counts.keys()].every((family) => FAMILIES.some((known) => known === family))).toBe(
      true,
    )
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
