/**
 * The per-method operation semantics of the daemon surface.
 *
 * Every bound operation is assembled from two pieces that never mix: the
 * reviewed wire evidence (`factory-dialect`'s codec for the method) and the
 * product semantics declared here — the canonical operation id, family,
 * effect kind, replay rule, authority treatment and output sensitivity. The
 * wire evidence alone never publishes anything: a method absent from this
 * file has no entry even when its codec exists, and a method absent from the
 * reviewed manifest has no codec even when semantics exist for it.
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../../authority/index.ts"

const AutonomyLevelSchema = Schema.Literals(["off", "low", "medium", "high"])

const AutonomyModeSchema = Schema.Literals([
  "normal",
  "spec",
  "auto-low",
  "auto-medium",
  "auto-high",
])

const SubagentAutonomySchema = Schema.Literals(["off", "low", "medium", "high", "inherit"])

/** A JSON record: the decoded shape of every wire parameter object here. */
export const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json)

/** Decodes a wire object into its record form; anything else is absent. */
export const decodeJsonRecord = (
  value: Schema.Json,
): Option.Option<Readonly<Record<string, Schema.Json>>> =>
  Schema.decodeUnknownOption(JsonRecordSchema)(value)

/** The product semantics one served daemon method is bound with. */
export interface MethodSemantics {
  readonly effect: "read" | "configure" | "session_load" | "queued_work"
  readonly destructive: boolean
  readonly initialize: boolean
  readonly sensitive: boolean
  readonly description: string
}

/** Wire methods the session runtime owns; this module never binds them. */
export const SESSION_OWNED_METHODS: ReadonlySet<string> = new Set([
  "droid.initialize_session",
  "droid.add_user_message",
  "droid.interrupt_session",
  "droid.close_session",
  "droid.request_permission",
  "droid.ask_user",
  "droid.pick_options",
  "droid.session_notification",
])

/** Exec-session reads the daemon socket does not serve; never bound here. */
export const DAEMON_UNSERVED_METHODS: ReadonlySet<string> = new Set([
  "droid.list_skills",
  "droid.list_tools",
  "droid.list_mcp_tools",
  "droid.list_mcp_registry",
])

/** The connection handshake is transport evidence, never a public operation. */
export const TRANSPORT_METHODS: ReadonlySet<string> = new Set(["daemon.authenticate"])

/**
 * Queued work: the autonomy a submitted message runs under on an existing
 * daemon session is a property of that session, so no request field proves
 * enforcement and the operator passthrough is the only path.
 */
export const QUEUED_WORK_METHODS: ReadonlySet<string> = new Set([
  "daemon.add_user_message",
  "droid.resolve_queued_user_message",
  "daemon.resolve_queued_user_message",
])

/**
 * Saved-session loads restore whatever authority the session was saved with;
 * no request field narrows it, so enforcement can never be proven here.
 */
export const SESSION_LOAD_METHODS: ReadonlySet<string> = new Set([
  "daemon.load_session",
  "droid.load_session",
])

/** Non-destructive configure effects: writes against the peer or a session. */
const CONFIGURE_METHODS: ReadonlySet<string> = new Set([
  "daemon.update_session_settings",
  "daemon.update_session_defaults",
  "droid.update_session_settings",
  "daemon.acknowledge_mission_readiness_warning",
  "daemon.add_marketplace",
  "daemon.add_mcp_server",
  "daemon.authenticate_mcp_server",
  "daemon.cancel_mcp_auth",
  "daemon.change_working_directory",
  "daemon.checkout_git_branch",
  "daemon.clear_mcp_auth",
  "daemon.close_session",
  "daemon.close_terminal",
  "daemon.compact_session",
  "daemon.create_automation",
  "daemon.create_cron",
  "daemon.create_pr",
  "daemon.create_terminal",
  "daemon.dispatch_automation_run",
  "daemon.fork_automation",
  "daemon.fork_session",
  "daemon.generate_semantic_diff",
  "daemon.git_commit",
  "daemon.hold_session_crons",
  "daemon.initialize_session",
  "daemon.install_plugin",
  "daemon.interrupt_session",
  "daemon.pause_automation",
  "daemon.rename_automation",
  "daemon.rename_session",
  "daemon.resize_terminal",
  "daemon.resolve_user_preferences",
  "daemon.resume_automation",
  "daemon.resume_session_crons",
  "daemon.run_automation",
  "daemon.save_semantic_diff_cache",
  "daemon.save_worktree_setup_profile",
  "daemon.set_plugin_enabled",
  "daemon.set_skill_disabled",
  "daemon.sf.create_workstream",
  "daemon.sf.hydrate_workstream_content",
  "daemon.sf.mark_events_read",
  "daemon.sf.mark_events_unread",
  "daemon.sf.publish_workstream_content",
  "daemon.sf.resolve_activity_review",
  "daemon.sf.update_workstream",
  "daemon.start_pull_request_layer_manifest_generation",
  "daemon.submit_bug_report",
  "daemon.submit_mcp_auth_code",
  "daemon.submit_mcp_auth_error",
  "daemon.toggle_mcp_server",
  "daemon.toggle_mcp_tool",
  "daemon.trust_folder",
  "daemon.unarchive_session",
  "daemon.update_automation",
  "daemon.update_automation_model",
  "daemon.update_automation_privacy",
  "daemon.update_automation_prompt",
  "daemon.update_automation_schedule",
  "daemon.update_cron",
  "daemon.update_marketplace",
  "daemon.update_plugin",
  "daemon.upsert_custom_model",
  "daemon.warmup_cache",
  "droid.add_mcp_server",
  "droid.append_messages",
  "droid.authenticate_mcp_server",
  "droid.cancel_mcp_auth",
  "droid.change_working_directory",
  "droid.clear_mcp_auth",
  "droid.compact_session",
  "droid.fork_session",
  "droid.refresh_connector_tool_catalog",
  "droid.rename_session",
  "droid.set_skill_disabled",
  "droid.submit_bug_report",
  "droid.submit_mcp_auth_code",
  "droid.toggle_mcp_server",
  "droid.toggle_mcp_tool",
])

/** Destructive configure effects: writes with a destructive tool annotation. */
const DESTRUCTIVE_CONFIGURE_METHODS: ReadonlySet<string> = new Set([
  "daemon.apply_automation_config",
  "daemon.apply_user_preferences",
  "daemon.archive_session",
  "daemon.cleanup_worktree",
  "daemon.delete_automation",
  "daemon.delete_cron",
  "daemon.delete_custom_model",
  "daemon.delete_worktree_setup_profile",
  "daemon.execute_rewind",
  "daemon.git_push",
  "daemon.kill_worker_session",
  "daemon.remove_marketplace",
  "daemon.remove_mcp_server",
  "daemon.sf.delete_workstream",
  "daemon.uninstall_plugin",
  "daemon.update_mcp_config",
  "daemon.write_terminal_data",
  "daemon.write_workspace_file_content",
  "droid.execute_rewind",
  "droid.kill_worker_session",
  "droid.remove_mcp_server",
])

/** Parameters that can carry tokens or other secrets a reply must never echo. */
const SENSITIVE_METHODS: ReadonlySet<string> = new Set([
  "daemon.initialize_session",
  "daemon.load_session",
  "droid.load_session",
  "daemon.add_mcp_server",
  "droid.add_mcp_server",
  "daemon.update_mcp_config",
  "daemon.upsert_custom_model",
  "daemon.submit_mcp_auth_code",
  "droid.submit_mcp_auth_code",
  "daemon.submit_mcp_auth_error",
  "daemon.submit_bug_report",
  "droid.submit_bug_report",
])

/** Canonical operation id: replace every wire namespace separator with an underscore. */
export const operationIdOf = (method: string): string => method.replaceAll(".", "_")

/** Operation family: the wire prefix maps exactly onto the catalog family. */
export const familyOf = (method: string): "daemon" | "droid" =>
  method.startsWith("droid.") ? "droid" : "daemon"

/** Description text is display-only; nothing ever reads it back for policy. */
const descriptionOf = (method: string): string =>
  "Daemon operation " +
  operationIdOf(method) +
  " (SDK method " +
  method +
  "). Consult the operation reference before use."

const LEVEL_RANKS: Readonly<Record<AutonomyLevel, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
}

const levelRank = (level: AutonomyLevel): number => LEVEL_RANKS[level]

type AutonomyMode = "normal" | "spec" | "auto-low" | "auto-medium" | "auto-high"

const MODE_LEVELS: Readonly<Record<AutonomyMode, AutonomyLevel | undefined>> = {
  normal: undefined,
  spec: undefined,
  "auto-low": "low",
  "auto-medium": "medium",
  "auto-high": "high",
}

/**
 * Maps the wire autonomy mode onto the autonomy level it grants. `normal`
 * and `spec` grant no auto authority and have no level.
 */
export const modeLevelOf = (mode: AutonomyMode): AutonomyLevel | undefined => MODE_LEVELS[mode]

const CAP_MODES: Readonly<
  Record<AutonomyLevel, "normal" | "auto-low" | "auto-medium" | "auto-high">
> = {
  off: "normal",
  low: "auto-low",
  medium: "auto-medium",
  high: "auto-high",
}

/** Writes the wire mode spelling for one autonomy level. */
export const capModeOf = (
  cap: AutonomyLevel,
): "normal" | "auto-low" | "auto-medium" | "auto-high" => CAP_MODES[cap]

/** True when `requested` does not exceed `cap`. */
export const levelWithinCap = (requested: AutonomyLevel, cap: AutonomyLevel): boolean =>
  levelRank(requested) <= levelRank(cap)

/**
 * Reads the autonomy level a wire mode field states, accepting only the
 * exact five spellings the schema admits.
 */
export const readModeField = (
  value: Schema.Json | undefined,
): "normal" | "spec" | "auto-low" | "auto-medium" | "auto-high" | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(AutonomyModeSchema)(value))

/** Reads a wire autonomy level field, accepting only the four spellings. */
export const readLevelField = (value: Schema.Json | undefined): AutonomyLevel | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(AutonomyLevelSchema)(value))

/** Subagent autonomy: the five spellings plus `inherit` (the parent level). */
export const readSubagentLevelField = (
  value: Schema.Json | undefined,
): AutonomyLevel | "inherit" | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(SubagentAutonomySchema)(value))

/**
 * The autonomy levels the request parameters state explicitly across the
 * three authority fields. `inherit` is the parent's level, not a new one, so
 * it contributes nothing here. `skipPermissionsUnsafe: true` is high-only
 * authority: it contributes `high`.
 */
export const explicitLevelsOf = (
  params: Readonly<Record<string, Schema.Json>>,
): ReadonlyArray<AutonomyLevel> => {
  const levels: Array<AutonomyLevel> = []

  const level = readLevelField(params["autonomyLevel"])

  if (level !== undefined) levels.push(level)

  const mode = readModeField(params["autonomyMode"])

  if (mode !== undefined) {
    const granted = modeLevelOf(mode)

    if (granted !== undefined) levels.push(granted)
  }

  const subagent = readSubagentLevelField(params["subagentAutonomyLevel"])

  if (subagent !== undefined && subagent !== "inherit") levels.push(subagent)

  if (params["skipPermissionsUnsafe"] === true) levels.push("high")

  return levels
}

/**
 * The semantics table for one method, derived once from the structural sets
 * above. Anything not listed as configure/queued/load is a pure read.
 */
export const semanticsOf = (method: string): MethodSemantics => {
  const initialize = method === "daemon.initialize_session"

  if (SESSION_LOAD_METHODS.has(method)) {
    return {
      effect: "session_load",
      destructive: false,
      initialize,
      sensitive: SENSITIVE_METHODS.has(method),
      description: descriptionOf(method),
    }
  }

  if (QUEUED_WORK_METHODS.has(method)) {
    return {
      effect: "queued_work",
      destructive: false,
      initialize,
      sensitive: SENSITIVE_METHODS.has(method),
      description: descriptionOf(method),
    }
  }

  const destructive = DESTRUCTIVE_CONFIGURE_METHODS.has(method)

  if (destructive || CONFIGURE_METHODS.has(method)) {
    return {
      effect: "configure",
      destructive,
      initialize,
      sensitive: SENSITIVE_METHODS.has(method),
      description: descriptionOf(method),
    }
  }

  return {
    effect: "read",
    destructive: false,
    initialize,
    sensitive: SENSITIVE_METHODS.has(method),
    description: descriptionOf(method),
  }
}
