/**
 * The pinned, reviewed manifest of SDK wire bindings.
 *
 * Every entry is reviewed wire evidence only: the peer method, its direction,
 * the reviewed SDK version and whether any product may serve it. No product
 * support, replay permission, authority or presentation fact lives here; a
 * reviewed binding alone never publishes a capability.
 */

/** The SDK version this manifest was reviewed against. */
export const PINNED_SDK_VERSION = "0.10.0"

/** SHA-256 of the SDK's bundled declaration file (`dist/index-*.d.ts`). */
export const PINNED_DECLARATION_SHA256 =
  "5e8232591e621941bdc7b07f37c1d55eb924b9f58dbef283a94f67b1bbda768f"

export type ReviewedDirection = "request" | "notification" | "server_request"

export interface ReviewedEntry {
  readonly method: string
  readonly direction: ReviewedDirection
  readonly served: boolean
  readonly reviewedVersion: string
}

const entry = (method: string, direction: ReviewedDirection, served: boolean): ReviewedEntry => ({
  method,
  direction,
  served,
  reviewedVersion: PINNED_SDK_VERSION,
})

/**
 * Every reviewed method of the pinned SDK.
 *
 * The 165 methods the SDK declarations advertise, plus the peer review
 * methods (`droid.request_permission`, `droid.ask_user`, `droid.pick_options`)
 * and the session notification (`droid.session_notification`), and the
 * connection handshake (`daemon.authenticate`) and session-store listings.
 * `droid.get_settings` is recorded as reviewed-but-unserved: the pinned SDK
 * declares no schema for it, so no codec exists and it cannot be dispatched.
 * The exec-session reads the daemon socket does not serve
 * (`droid.list_skills`, `droid.list_tools`, `droid.list_mcp_tools`,
 * `droid.list_mcp_registry`) are reviewed but unserved.
 */
export const REVIEWED_ENTRIES: ReadonlyArray<ReviewedEntry> = [
  entry("daemon.acknowledge_mission_readiness_warning", "request", true),
  entry("daemon.add_marketplace", "request", true),
  entry("daemon.add_mcp_server", "request", true),
  entry("daemon.add_user_message", "request", true),
  entry("daemon.apply_automation_config", "request", true),
  entry("daemon.apply_user_preferences", "request", true),
  entry("daemon.archive_session", "request", true),
  entry("daemon.authenticate", "request", true),
  entry("daemon.authenticate_mcp_server", "request", true),
  entry("daemon.cancel_mcp_auth", "request", true),
  entry("daemon.change_working_directory", "request", true),
  entry("daemon.check_folder_trust", "request", true),
  entry("daemon.checkout_git_branch", "request", true),
  entry("daemon.cleanup_worktree", "request", true),
  entry("daemon.clear_mcp_auth", "request", true),
  entry("daemon.close_session", "request", true),
  entry("daemon.close_terminal", "request", true),
  entry("daemon.compact_session", "request", true),
  entry("daemon.create_automation", "request", true),
  entry("daemon.create_cron", "request", true),
  entry("daemon.create_pr", "request", true),
  entry("daemon.create_terminal", "request", true),
  entry("daemon.delete_automation", "request", true),
  entry("daemon.delete_cron", "request", true),
  entry("daemon.delete_custom_model", "request", true),
  entry("daemon.delete_worktree_setup_profile", "request", true),
  entry("daemon.dispatch_automation_run", "request", true),
  entry("daemon.execute_rewind", "request", true),
  entry("daemon.fork_automation", "request", true),
  entry("daemon.fork_session", "request", true),
  entry("daemon.generate_semantic_diff", "request", true),
  entry("daemon.get_automation_history", "request", true),
  entry("daemon.get_automation_visual", "request", true),
  entry("daemon.get_checkout_metadata", "request", true),
  entry("daemon.get_context_breakdown", "request", true),
  entry("daemon.get_default_settings", "request", true),
  entry("daemon.get_git_diff", "request", true),
  entry("daemon.get_git_diff_file_contents", "request", true),
  entry("daemon.get_mcp_config", "request", true),
  entry("daemon.get_rewind_info", "request", true),
  entry("daemon.get_semantic_diff_cache", "request", true),
  entry("daemon.get_session_messages", "request", true),
  entry("daemon.get_session_turn_outcome", "request", true),
  entry("daemon.get_user_preferences_state", "request", true),
  entry("daemon.get_workspace_file_content", "request", true),
  entry("daemon.git_commit", "request", true),
  entry("daemon.git_push", "request", true),
  entry("daemon.hold_session_crons", "request", true),
  entry("daemon.initialize_session", "request", true),
  entry("daemon.inspect_mission_readiness", "request", true),
  entry("daemon.inspect_worktree_deletion", "request", true),
  entry("daemon.install_plugin", "request", true),
  entry("daemon.interrupt_session", "request", true),
  entry("daemon.kill_worker_session", "request", true),
  entry("daemon.list_automations", "request", true),
  entry("daemon.list_available_plugins", "request", true),
  entry("daemon.list_available_sessions", "request", true),
  entry("daemon.list_commands", "request", true),
  entry("daemon.list_crons", "request", true),
  entry("daemon.list_files", "request", true),
  entry("daemon.list_git_branches", "request", true),
  entry("daemon.list_installed_plugins", "request", true),
  entry("daemon.list_managed_worktrees", "request", true),
  entry("daemon.list_marketplaces", "request", true),
  entry("daemon.list_mcp_registry", "request", true),
  entry("daemon.list_mcp_servers", "request", true),
  entry("daemon.list_mcp_tools", "request", true),
  entry("daemon.list_models", "request", true),
  entry("daemon.list_opened_sessions", "request", true),
  entry("daemon.list_skills", "request", true),
  entry("daemon.list_terminals", "request", true),
  entry("daemon.list_worktree_setup_profiles", "request", true),
  entry("daemon.load_session", "request", true),
  entry("daemon.pause_automation", "request", true),
  entry("daemon.remove_marketplace", "request", true),
  entry("daemon.remove_mcp_server", "request", true),
  entry("daemon.rename_automation", "request", true),
  entry("daemon.rename_session", "request", true),
  entry("daemon.resize_terminal", "request", true),
  entry("daemon.resolve_pull_request_statuses", "request", true),
  entry("daemon.resolve_queued_user_message", "request", true),
  entry("daemon.resolve_user_preferences", "request", true),
  entry("daemon.resume_automation", "request", true),
  entry("daemon.resume_session_crons", "request", true),
  entry("daemon.run_automation", "request", true),
  entry("daemon.save_semantic_diff_cache", "request", true),
  entry("daemon.save_worktree_setup_profile", "request", true),
  entry("daemon.search_files", "request", true),
  entry("daemon.search_sessions", "request", true),
  entry("daemon.set_plugin_enabled", "request", true),
  entry("daemon.set_skill_disabled", "request", true),
  entry("daemon.sf.create_workstream", "request", true),
  entry("daemon.sf.delete_workstream", "request", true),
  entry("daemon.sf.get_workstream", "request", true),
  entry("daemon.sf.hydrate_workstream_content", "request", true),
  entry("daemon.sf.list_activities", "request", true),
  entry("daemon.sf.list_changes", "request", true),
  entry("daemon.sf.list_events", "request", true),
  entry("daemon.sf.list_signals", "request", true),
  entry("daemon.sf.list_workstreams", "request", true),
  entry("daemon.sf.mark_events_read", "request", true),
  entry("daemon.sf.mark_events_unread", "request", true),
  entry("daemon.sf.publish_workstream_content", "request", true),
  entry("daemon.sf.resolve_activity_review", "request", true),
  entry("daemon.sf.update_workstream", "request", true),
  entry("daemon.start_pull_request_layer_manifest_generation", "request", true),
  entry("daemon.submit_bug_report", "request", true),
  entry("daemon.submit_mcp_auth_code", "request", true),
  entry("daemon.submit_mcp_auth_error", "request", true),
  entry("daemon.toggle_mcp_server", "request", true),
  entry("daemon.toggle_mcp_tool", "request", true),
  entry("daemon.trust_folder", "request", true),
  entry("daemon.unarchive_session", "request", true),
  entry("daemon.uninstall_plugin", "request", true),
  entry("daemon.update_automation", "request", true),
  entry("daemon.update_automation_model", "request", true),
  entry("daemon.update_automation_privacy", "request", true),
  entry("daemon.update_automation_prompt", "request", true),
  entry("daemon.update_automation_schedule", "request", true),
  entry("daemon.update_cron", "request", true),
  entry("daemon.update_marketplace", "request", true),
  entry("daemon.update_mcp_config", "request", true),
  entry("daemon.update_plugin", "request", true),
  entry("daemon.update_session_defaults", "request", true),
  entry("daemon.update_session_settings", "request", true),
  entry("daemon.upsert_custom_model", "request", true),
  entry("daemon.validate_working_directory", "request", true),
  entry("daemon.warmup_cache", "request", true),
  entry("daemon.write_terminal_data", "request", true),
  entry("daemon.write_workspace_file_content", "request", true),
  entry("droid.add_mcp_server", "request", true),
  entry("droid.add_user_message", "request", true),
  entry("droid.append_messages", "request", true),
  entry("droid.ask_user", "server_request", true),
  entry("droid.authenticate_mcp_server", "request", true),
  entry("droid.cancel_mcp_auth", "request", true),
  entry("droid.change_working_directory", "request", true),
  entry("droid.clear_mcp_auth", "request", true),
  entry("droid.close_session", "request", true),
  entry("droid.compact_session", "request", true),
  entry("droid.execute_rewind", "request", true),
  entry("droid.fork_session", "request", true),
  entry("droid.get_context_stats", "request", true),
  entry("droid.get_rewind_info", "request", true),
  entry("droid.get_settings", "request", false),
  entry("droid.initialize_session", "request", true),
  entry("droid.interrupt_session", "request", true),
  entry("droid.kill_worker_session", "request", true),
  entry("droid.list_mcp_registry", "request", false),
  entry("droid.list_mcp_servers", "request", true),
  entry("droid.list_mcp_tools", "request", false),
  entry("droid.list_skills", "request", false),
  entry("droid.list_tools", "request", false),
  entry("droid.load_session", "request", true),
  entry("droid.pick_options", "server_request", true),
  entry("droid.refresh_connector_tool_catalog", "request", true),
  entry("droid.remove_mcp_server", "request", true),
  entry("droid.rename_session", "request", true),
  entry("droid.request_permission", "server_request", true),
  entry("droid.resolve_queued_user_message", "request", true),
  entry("droid.session_notification", "notification", true),
  entry("droid.set_skill_disabled", "request", true),
  entry("droid.submit_bug_report", "request", true),
  entry("droid.submit_mcp_auth_code", "request", true),
  entry("droid.toggle_mcp_server", "request", true),
  entry("droid.toggle_mcp_tool", "request", true),
  entry("droid.update_session_settings", "request", true),
]

/** Every method with a reviewed binding, regardless of direction or service. */
export const reviewedMethods = (): ReadonlyArray<string> =>
  REVIEWED_ENTRIES.map((entry) => entry.method)
