# Tool families and dispatch

The full profile publishes 284 tools: 154 generated from the SDK's method surface and
130 hand-written for local sessions, hosted REST, and Context.
Compact advertises `server_info`, nine turn/prompt tools, and five dispatch tools
(15 total); all 284 operations remain callable by name.

| Prefix     | Count | Backend/capability                                              |
| ---------- | ----- | --------------------------------------------------------------- |
| `daemon_`  | 130   | Daemon SDK methods.                                             |
| `droid_`   | 24    | Remaining session SDK methods, transported through the daemon.  |
| `session_` | 32    | Local hub turns, prompts, administration.                       |
| `rest_`    | 79    | Hosted Factory REST API.                                        |
| `context_` | 18    | Prem Context API.                                               |
| `server_`  | 1     | `server_info`: version, protocols, profile/counts, cap, daemon. |

Generated names replace dots with underscores: `daemon.sf.list_workstreams`
becomes `daemon_sf_list_workstreams`. Inputs and replies use SDK schemas.
The SDK has 35 `droid.*` methods. Seven of them belong to the session loop:
`initialize_session`, `add_user_message`, `interrupt_session`, `close_session`,
`request_permission`, `ask_user`, `pick_options`. Use the local wrappers for
that loop; these seven have no generated `droid_*` tool.

## Discover only what is missing

`tools_search` matches all query words against names/descriptions; narrow with
`family` (`server|session|daemon|droid|rest|context`), `readOnly`, and a small
`limit` (default 15, maximum 50). Page with returned `nextOffset` as `offset`
only if needed. `tools_describe { names }` accepts 1..20 names and returns
descriptions, `inputSchema`, and policy; unknown names, including the four removed
reads below, appear in `unknown` without discarding valid descriptions.
Reuse these schemas. The catalogs inside a session (`session_list_tools`) or
configured MCP servers (`daemon_list_mcp_tools`) are different catalogs.

`readOnly` and `destructive` hints describe the operation, not user consent.
Confirm destructive work unless already authorized; the server does not ask
on the client's behalf. `tool_call` and `batch` have broad dispatch hints:
inspect the underlying operation's policy.

## Bounded results and batch

`tool_call { name, arguments?, select?, maxBytes? }` runs the full handler,
including validation and autonomy checks. Start at `maxBytes: 1024`; increase
only when needed. Range: 1024..262144 bytes; default: 16384.
`select` is one RFC 6901 JSON Pointer (empty means whole result), applied before
bounding. It is not JSONPath, an event filter, or a multi-field projection.

`batch` runs 1..20 steps sequentially in one call, not in parallel or as a
transaction. Example after learning the schemas:

```json
{
  "steps": [
    {
      "id": "new",
      "name": "session_create",
      "arguments": { "cwd": "/absolute/project", "autonomyLevel": "low" },
      "select": "/sessionId"
    },
    {
      "name": "session_rename",
      "arguments": { "sessionId": { "$from": "new", "path": "/sessionId" }, "title": "Retry fix" }
    }
  ],
  "maxBytes": 2048
}
```

`$from` reads an earlier step's **full** result before `select` or truncation;
omit `path` for that entire result. Ids default to string indices and must
be unique. Stops on first failure unless `stopOnError: false`; completed
steps stay done. Inspect step statuses (`ok|failed|skipped`) and counts.
Batch defaults to 32768 bytes, divides its budget among steps, then clamps each
step to 1024..262144. `maxBytes` is not a hard total-response cap for a batch:
step envelopes and that minimum add overhead.

An oversized result returns `truncated`, `totalBytes`, `preview`, and `ref`
instead of `result`. The ref stores the selected subtree, not automatically
the unselected result. Recover only needed data:

- `result_read { ref, select: "/needed", length: 1024 }` selects inside the
  stored JSON and returns `selected` (itself bounded).
- For a byte page, use `{ ref, offset: 0, length: 1024 }`; follow `nextOffset`
  unchanged only while more text is needed. `chunk` is JSON text, not an object.

Refs are key-scoped, expire 15 minutes after last use, and may be evicted under
the 64 MiB store limit. On `invalid_select` after dispatch, the operation
already ran: use the error's `ref` for the full result, rather than rerunning.
If a ref is lost, repeat a safe read or reconcile a write's state first.

## Capability index

Search the indicated family and subject, then describe only unfamiliar inputs.
This index covers groups, not an eager dump of all schemas.

### Local session administration

Beyond the direct loop and prompt tools:

- One-shot: `session_run` via dispatch in compact; see [session loop](session-loop.md).
- Settings/directory/spec/title: `session_update_settings`, `session_change_cwd`,
  `session_enter_spec_mode`, `session_exit_spec_mode`, `session_rename`.
- Context/history: `session_get_context_stats`, `session_compact`, `session_fork`,
  `session_get_rewind_info`, `session_rewind`. Inspect rewind effects before confirming.
- MCP configuration/auth: `session_list_mcp_servers`, `session_list_mcp_tools`,
  `session_add_mcp_server`, `session_remove_mcp_server`, `session_toggle_mcp_server`,
  `session_authenticate_mcp_server`, `session_submit_mcp_auth_code`,
  `session_refresh_connector_tool_catalog`.
- Tools/skills/models: `session_list_tools`, `session_list_skills`,
  `session_set_skill_disabled`, `session_models`. Request skill content only if needed.

### Daemon (`daemon_`)

Search subjects:

- Session/message/turn/queue: initialize/load/close/interrupt, list opened/available,
  search, messages/outcome, queued-message resolution, archive/unarchive, rename,
  fork, compact, context breakdown, rewind, worker termination.
- Settings/model/preferences/trust: defaults/session settings, cwd validation/change,
  folder trust, models/custom models, user preferences, cache warmup, authentication.
- Git/worktree/semantic diff/pull request: branches/checkout, diff/file contents,
  commit/push/create PR, PR status/layer-manifest generation, managed worktrees
  and setup profiles, deletion inspection/cleanup, semantic diff generation/cache.
- Automation/cron: config, create/list/update/delete/fork/run/dispatch, schedule/prompt/
  model/privacy, pause/resume/history/visuals; cron create/list/update/delete,
  per-session hold/resume.
- Terminal/workspace/files: terminal create/list/write/resize/close, workspace
  file read/write, file list/search, checkout metadata.
- MCP: registry/config, servers/tools, add/remove/toggle, authentication,
  submit code/error/cancel/clear.
- Skill/command/plugin/marketplace: list skills/commands, disable skills;
  plugin discover/install/update/enable/uninstall; marketplace list/add/update/remove.
- Mission readiness: inspect and acknowledge warnings.
- `sf`: workstream create/get/list/update/delete, content hydrate/publish,
  activities/reviews, changes, signals, events/read/unread.
- Bug report: submit diagnostics.

### Session SDK (`droid_`)

Daemon transport, daemon-shaped session ids. Capabilities: load, append
messages, resolve queued messages, update settings/cwd/title, compact/fork/
context stats/rewind, kill workers, disable skills,
MCP servers/configuration/authentication/tool toggles,
connector-catalog refresh, and bug reports. Prefer `session_*` wrappers when
working with a local hub handle.

Four additional SDK reads use the exec-session protocol, not the daemon socket,
and are not advertised in either profile:

| Removed name              | Supported replacement(s)                            |
| ------------------------- | --------------------------------------------------- |
| `droid_list_skills`       | `session_list_skills` or `daemon_list_skills`       |
| `droid_list_tools`        | `session_list_tools`                                |
| `droid_list_mcp_tools`    | `session_list_mcp_tools` or `daemon_list_mcp_tools` |
| `droid_list_mcp_registry` | `daemon_list_mcp_registry`                          |

`tool_call` and `batch` return `unknown_tool` with these replacements.
`tools_describe` lists removed names in `unknown` and preserves valid descriptions.
Create a local session for the `session_*` reads; the `daemon_*`
replacements require a daemon session id. There is no local registry wrapper.
The other 24 generated `droid_*` operations remain exposed; this does not
establish that every daemon implements them.

### Hosted REST (`rest_`)

- Computer/machine template: providers/templates, computer CRUD/bulk creation,
  lookup by name, restart/refresh/activity/metrics, file transfers.
- Environment: CRUD, defaults/ensure-default, sources, build statuses/diagnostics/
  attempt diagnostics, cancel/retry builds or dependency installation.
- Remote session: create/get/list/update/delete, messages/list/get/post, children, interrupt.
- Wiki: create/get/list/delete runs, pages/search/history/export, privacy,
  upload access and video-upload URLs.
- CI: repository owners/repositories/scan, jobs/runs, workflow editing.
- Organization: users/invitations/removal, global/group/user limits,
  computer secrets, enterprise-control history.
- Service account: CRUD, API-key list/create/revoke/rotate.

Each operation sends one request to `FACTORY_BASE_URL` using `FACTORY_API_KEY`.
Path/query fields are named inputs; payload goes in `body` where the schema
defines it. Some operations, such as computer creation, use named body fields
instead. Optional `query` adds query parameters. Describe unfamiliar inputs.
Hosted list tools that accept cursors return `pagination.nextCursor`; pass it
back as `cursor` unchanged, only when another page is needed.

Transfer tools return temporary URLs; the server does not fetch them.
Upload computer bytes to the URL, then call `rest_complete_computer_file_upload`.
`rest_export_wiki_run` returns a ZIP as base64 metadata/data (JSON replies pass
through). Minted service-account key values are removed and replaced with
`notice`; they cannot be recovered here. Configured API/header secrets and
submitted organization-secret values are redacted from results/errors.

### Stored Context (`context_`)

Space create/get/list; document create/get/get-by-path/list/update/delete;
file create/upload-part/read-part/delete; session register/get/list/append/
read-records. Context lists page with `nextCursor` as `cursor`; record reads
instead use `afterSequence`. See [backend workflows](delegation.md) before
writing versions, sequences, or files.

## Failures

Tools report `{ code, message }`; turn failures can also appear in `error`
events or `result.reason`. Branch on code, inspect the message, and reconcile
state before retrying a mutation after a transport error or timeout.

- `unknown_tool`: search the correct operation name.
- `invalid_arguments`, `invalid_params`: correct inputs against the known schema;
  describe it only if missing/stale.
- `invalid_select`: correct the pointer; after dispatch use the attached `ref`,
  because work completed.
- `invalid_reference`: use an earlier successful step id and a path in its full result.
- `invalid_offset`: use the previous page's `nextOffset` (UTF-8 boundary).
- `result_not_found`: ref expired, evicted, or belongs to another key.
  Repeat only safe reads; reconcile writes.
- `internal_error`: unexpected dispatch failure; inspect state before retrying.
- `invalid_cwd`, `invalid_prompt`: use an existing absolute directory or a nonblank prompt.
- `autonomy_exceeds_cap`: lower requested authority to the reported cap.
- `session_not_found`, `session_closed`: wrong/closed/dead handle; inspect events
  if retained, close a dead child, create a new session if needed.
- `session_busy`: poll the existing turn or interrupt it before sending another.
- `prompt_not_found`, `prompt_mismatch`: refresh state or use the answer tool
  matching the pending kind.
- `invalid_outcome`, `invalid_question_index`, `invalid_selection`,
  `edited_spec_required`: use offered choices/indices/ids, or supply nonempty
  `editedSpecContent`; see [prompts](prompts.md).
- `process_exit`: CLI died (event code); the session is unusable. Inspect failure and close.
- `exec_failed`, `exec_timeout`: child launch/request failed or timed out.
  Inspect current turn/file state before rerunning.
- `daemon_unavailable`, `daemon_timeout`, `websocket_error`: daemon/socket
  unavailable or request timeout. Restore connectivity, inspect state, then retry only if safe.
- `daemon_auth_rejected`, `factory_api_key_missing`: repair server-side credentials/authentication.
- `daemon_method_unsupported`: the live daemon does not implement the named method
  at the reported protocol version. Use a supported replacement if available;
  this is not a transport failure.
- `daemon_protocol_error`: invalid wire reply/schema; check CLI/SDK compatibility.
- `rest_rejected`: HTTP 4xx, fix input/access. For 409 reread and reconcile state.
- `rest_unavailable`: network/5xx/timeout/malformed JSON/refused redirect;
  retry safe reads later, reconcile uncertain writes.
- `context_base_url_missing`: configure the Prem origin; no Context request was sent.

`config_invalid` is a startup/CLI configuration code; `unknown_error` is the
fallback mapping for an unrecognized application error. Upstream CLI error
events can carry additional codes; this list covers server-defined codes,
not every future upstream error.
