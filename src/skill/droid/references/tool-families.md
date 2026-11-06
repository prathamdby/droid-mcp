# Tool families

This server publishes 199 tools: 158 generated from the SDK's method surface and
41 hand-written for the turn loop, prompts, and the hosted API. They are named by
prefix, so a prefix is all you need to find one.

| Prefix     | Count | Source                                                                |
| ---------- | ----- | --------------------------------------------------------------------- |
| `session_` | 31    | Hand-written. The turn loop, prompts, and per-session administration. |
| `daemon_`  | 130   | Generated, one per `daemon.*` SDK method.                             |
| `droid_`   | 35    | Generated, one per `droid.*` SDK method that a session already owns.  |
| `rest_`    | 9     | Hand-written. The hosted Factory API.                                 |
| `server_`  | 1     | `server_info`.                                                        |

`session_*` covers the eight SDK `droid.*` methods a session owns
(`initialize_session`, `close_session`, `add_user_message`, `interrupt_session`,
`update_session_settings`, `request_permission`, `ask_user`, `pick_options`), so
those four SDK names do not appear as `droid_*` tools. Using both would mean two
ways to drive one session.

## Finding a tool

Generated descriptions follow one shape:

```text
SDK method daemon.create_automation. Inputs: name, description, instructions, schedule.
Destructive; confirm before calling.
```

Search those descriptions rather than asking for the list. A client that loads
all 199 schemas spends a lot of context on tools it will not call; `session_list_tools`
lists what a running session has, and `daemon_list_mcp_tools` lists tools a
configured MCP server offers. Neither is a substitute for reading the tool you
are about to call.

## Naming

Generated names replace every dot in the method with an underscore, so
`daemon.sf.list_workstreams` becomes `daemon_sf_list_workstreams`. A generated
tool takes exactly the method's own parameters, validated against the schema the
SDK declares, and returns the daemon's reply as JSON.

Tool names are stable: they come from the method name, not from a hand-kept list.

## Daemon families

| Names                                                                                     | What they do                                 |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `daemon_list_available_sessions`, `daemon_list_opened_sessions`, `daemon_search_sessions` | Find sessions the daemon knows.              |
| `daemon_list_automations`, `daemon_create_automation`, `daemon_run_automation`            | Scheduled work.                              |
| `daemon_list_managed_worktrees`, `daemon_list_git_branches`, `daemon_git_commit`          | Repositories and worktrees.                  |
| `daemon_list_mcp_servers`, `daemon_add_mcp_server`, `daemon_toggle_mcp_tool`              | The daemon's MCP configuration.              |
| `daemon_list_models`, `daemon_list_skills`, `daemon_list_commands`                        | What this installation offers.               |
| `daemon_sf_*`                                                                             | Workstream activities, changes, and signals. |

## Prompts and failures

`session_*` tools report failures as `{ "code": ..., "message": ... }`. The code
is stable and meant to be branched on; the message is for a human. Generated
tools report the daemon's own error code where it has one. Both are documented in
`SKILL.md`.
