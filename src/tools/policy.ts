import * as Tool from "effect/ai/Tool"

/**
 * The four MCP tool hints, derived for every tool from its name and
 * description. Effect's defaults claim every tool is a destructive,
 * open-world write, so a client that honors hints would ask before every
 * read; these hints let it skip that for reads and warn where it matters.
 */
export interface ToolPolicy {
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly openWorld: boolean
}

/** The sentence codegen and the hosted tools put on tools that remove or overwrite state. */
export const DESTRUCTIVE_SENTENCE = "Destructive; confirm before calling."

/** Leading verbs of the action segment that only read. */
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "check",
  "inspect",
  "export",
  "events",
  "info",
  "models",
  "validate",
  "describe",
])

/** Reads whose verb does not say so. */
const READ_TOOLS = new Set(["daemon_resolve_pull_request_statuses"])

/** Writes that leave the same state when repeated with the same arguments. */
const IDEMPOTENT_VERBS = new Set([
  "set",
  "update",
  "toggle",
  "delete",
  "remove",
  "rename",
  "trust",
  "change",
  "enter",
  "exit",
  "close",
  "interrupt",
  "archive",
  "unarchive",
  "pause",
  "resume",
  "hold",
  "resize",
  "upsert",
  "ensure",
  "mark",
  "clear",
  "cancel",
  "uninstall",
  "acknowledge",
  "save",
  "revoke",
  "warmup",
])

/**
 * Local tools whose effect reaches past this host: a model turn, a git
 * remote, a pull request, a plugin marketplace, or an OAuth provider.
 */
const OPEN_WORLD_TOOLS = new Set([
  "session_stream",
  "session_run",
  "session_authenticate_mcp_server",
  "session_refresh_connector_tool_catalog",
  "daemon_add_user_message",
  "daemon_git_push",
  "daemon_create_pr",
  "daemon_resolve_pull_request_statuses",
  "daemon_submit_bug_report",
  "droid_submit_bug_report",
  "daemon_install_plugin",
  "daemon_update_plugin",
  "daemon_list_available_plugins",
  "daemon_add_marketplace",
  "daemon_update_marketplace",
  "daemon_list_mcp_registry",
  "droid_list_mcp_registry",
  "daemon_authenticate_mcp_server",
  "droid_authenticate_mcp_server",
  "daemon_run_automation",
  "daemon_dispatch_automation_run",
  "daemon_sf_publish_workstream_content",
  "droid_refresh_connector_tool_catalog",
])

/** The action words after the family prefix; `daemon_sf_*` drops its `sf` namespace. */
const actionOf = (name: string): ReadonlyArray<string> => {
  const words = name.split("_").slice(1)

  return words[0] === "sf" ? words.slice(1) : words
}

export const policyOf = (name: string, description: string): ToolPolicy => {
  const family = name.slice(0, name.indexOf("_"))
  const verb = actionOf(name)[0] ?? ""
  const readOnly = READ_VERBS.has(verb) || READ_TOOLS.has(name)
  const hosted = family === "rest" || family === "context"

  return {
    readOnly,
    destructive: !readOnly && description.includes(DESTRUCTIVE_SENTENCE),
    idempotent: readOnly || IDEMPOTENT_VERBS.has(verb),
    openWorld: hosted || OPEN_WORLD_TOOLS.has(name),
  }
}

export const annotateWith = <T extends Tool.Any>(tool: T, policy: ToolPolicy): T =>
  // SAFETY: `annotate` returns a clone of the same tool; its declared return
  // type drops the concrete tool type the caller keeps.
  tool
    .annotate(Tool.Readonly, policy.readOnly)
    .annotate(Tool.Destructive, policy.destructive)
    .annotate(Tool.Idempotent, policy.idempotent)
    .annotate(Tool.OpenWorld, policy.openWorld) as T

/** Annotates a tool from its own name and description. */
export const annotate = <T extends Tool.Any>(tool: T): T =>
  annotateWith(tool, policyOf(tool.name, Tool.getDescription(tool) ?? ""))
