# Tool families

This server publishes 287 tools: 158 generated from the SDK's method surface and
129 hand-written for the turn loop, prompts, the hosted Factory API, and the
Context API. They are named by prefix, so a prefix is all you need to find one.

| Prefix     | Count | Source                                                                          |
| ---------- | ----- | ------------------------------------------------------------------------------- |
| `daemon_`  | 130   | Generated, one per `daemon.*` SDK method.                                       |
| `droid_`   | 28    | Generated, one per `droid.*` SDK method that the `session_*` tools do not own.  |
| `session_` | 31    | Hand-written. The local turn loop, prompts, and per-session administration.     |
| `rest_`    | 79    | Hand-written. The hosted Factory API on `FACTORY_BASE_URL`.                     |
| `context_` | 18    | Hand-written. The Context API on the Prem origin in `FACTORY_CONTEXT_BASE_URL`. |
| `server_`  | 1     | `server_info`.                                                                  |

The SDK has 35 `droid.*` methods. Seven of them belong to the session loop
(`initialize_session`, `close_session`, `add_user_message`, `interrupt_session`,
`request_permission`, `ask_user`, `pick_options`), so the `session_*` tools
cover them and they do not appear as `droid_*` tools. Using both would mean two
ways to drive one session. `droid_update_session_settings` is still exposed,
next to the hand-written `session_update_settings`.

## Finding a tool

Generated descriptions follow one shape:

```text
SDK method daemon.create_automation. Inputs: name, description, instructions, schedule.
Destructive; confirm before calling.
```

Hand-written tools that delete, revoke, rotate, invite, remove, cancel, or
change secrets, privacy, or CI workflows carry the same sentence,
"Destructive; confirm before calling." Ask the user before calling one. The
server does not ask for you.

Search descriptions rather than asking for the list. A client that loads all
287 schemas spends a lot of context on tools it will not call; `session_list_tools`
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

## Hosted REST families

Every `rest_*` tool sends exactly one request to `FACTORY_BASE_URL` with
`FACTORY_API_KEY`. Path and query parameters are named inputs; request bodies
go in `body`, whose required fields are listed in the schema and whose other
members are forwarded as given. Every tool also takes an optional `query`
object for extra query parameters.

| Names                                          | What they cover                                                |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `rest_*_computer*`, `rest_*_machine_template*` | Cloud computers, their files, metrics, and templates (18).     |
| `rest_*_environment*`                          | Environments, their sources, default, and builds (13).         |
| `rest_*_remote_session*`                       | Hosted sessions on a computer and their messages (10).         |
| `rest_*_wiki*`                                 | Wiki runs, pages, search, export, and privacy (11).            |
| `rest_*_ci_*`                                  | CI automation repositories, jobs, runs, and workflow PRs (6).  |
| `rest_*_organization_*`                        | Members, invitations, usage limits, secrets, and history (12). |
| `rest_*_service_account*`                      | Service accounts and their API keys (9).                       |

## Context families

Every `context_*` tool sends one request to `FACTORY_CONTEXT_BASE_URL` with
`FACTORY_API_KEY` and the headers in `FACTORY_CONTEXT_HEADERS`. Spaces hold
documents (text, or binary files uploaded in parts) and stored sessions
(append-only JSONL records). Stored sessions only hold records; nothing runs.

Versions and sequences are decimal strings, never JSON numbers, so counters past
2^53 keep their precision. Pass them back exactly as you received them.

## Paging

One call returns one page. Hosted list tools that take `cursor` return
`pagination.nextCursor`; pass it as `cursor` for the next page. Context list
tools return `nextCursor` when there is more; pass it as `cursor`.
`context_read_session_records` returns `nextCursor` and `hasMore`; pass
`nextCursor` as the next `afterSequence`. Cursors may contain reserved
characters, and the server encodes them, so pass them unchanged.

## Redaction

Results and errors never contain `FACTORY_API_KEY`, the MCP keys, or a
`FACTORY_CONTEXT_HEADERS` value. `rest_create_service_account_api_key` and
`rest_rotate_service_account_api_key` drop the minted key value and return a
`notice` instead. The value cannot be recovered through this server, so mint
keys where the user can read them directly when they need the value. Secret
values sent to `rest_update_organization_computer_secrets` are never echoed back,
even in an error.

## Transfers

`rest_create_computer_file_upload`, `rest_create_computer_file_download`, and
`rest_create_wiki_video_upload_url` return temporary transfer URLs, which the
server never fetches; move the bytes yourself, then call
`rest_complete_computer_file_upload` for an upload. `rest_export_wiki_run`
returns a ZIP as `{ encoding: "base64", contentType, sizeBytes, data }` (a JSON
answer passes through as is), and `context_read_file_part` returns one part of a
file as base64.

## Prompts and failures

`session_*`, `rest_*`, and `context_*` tools report failures as
`{ "code": ..., "message": ... }`. The code is stable and meant to be branched
on; the message is for a human. `rest_rejected` is an upstream 4xx and keeps its
detail; `rest_unavailable` is a 5xx, a timeout, a network error, malformed JSON,
or a refused redirect. Generated tools report the daemon's own error code where
it has one. All of these are documented in `SKILL.md`.
