---
name: droid
description: Drive Factory Droid through MCP for local coding turns and prompts,
  daemon sessions and automation, hosted computers and sessions, or stored
  Context documents, files, and transcripts.
---

# Droid

## Route once

Call `server_info` once for `profile`, counts, and `maxAutonomy`; reuse known
schemas and settings. Choose the backend before choosing an operation:

| Backend | Family                | Use                                                                                      |
| ------- | --------------------- | ---------------------------------------------------------------------------------------- |
| Local   | `session_*`           | Coding turns in a `droid exec` child on this host; client answers prompts.               |
| Daemon  | `daemon_*`, `droid_*` | Daemon-managed sessions, automation, git/worktrees, terminals, configuration.            |
| Hosted  | `rest_*`              | Factory computers, Environments, remote sessions, wiki, CI, organization administration. |
| Stored  | `context_*`           | Spaces, documents, files, append-only transcripts. Nothing runs.                         |

Keep ids within their backend. For daemon authority, hosted provisioning, or
Context writes, read [delegation](references/delegation.md) before acting.

## Spend fewer tokens

- Reuse tool names and schemas already in context. Search only an unknown
  capability; describe only the operations whose inputs you still need.
- In compact, prefer `batch` for related calls, with `$from` for dependencies.
  Return only the needed subtree with `select` and start with `maxBytes: 1024`.
  Page a stored result only when its preview or selected value is insufficient.
- Default to fire-and-forget (deferred consumption): retain status/cursor and
  handle prompts; consume only the terminal result or last assistant text when
  enough. Use long `waitMs` instead of repeated short timeouts.
  Optionally stream intermediate events to observe critical tasks, or when
  progress, debugging, or interaction matters.
- Omit unused optional inputs. Send `null` only where the schema permits it.
- Confirm destructive operations unless the user already authorized them.
  Dispatch does not bypass policy or obtain consent for you.

## Local turn

1. `session_create` with absolute existing `cwd`, explicit `autonomyLevel`
   (`off|low|medium|high`, within `maxAutonomy`), and optional `modelId`,
   `reasoningEffort`, `restrictToolIds`, or `disabledToolIds`. Retain `sessionId`.
2. `session_stream` sends `prompt`; retain its `cursor`. While `status` is
   `running`, call `session_events` with that cursor unchanged, then replace
   it with the new returned cursor. It is the next sequence number, not the
   last event's `seq`.
3. Answer `pending_permission`, `pending_question`, and `pending_options`
   before their `deadline`. Read [prompts](references/prompts.md) when one
   appears, even if you otherwise ignore intermediate events.
4. Stop polling on `completed`, `failed`, or `interrupted`. Check `result.reason`
   and any `error` event; verify the requested work. Reuse the session for
   another turn or `session_close` when done. Close every session you open.

`session_interrupt` stops a turn; `session_list` recovers live ids/status/cursors.
One session runs one turn at a time. Read [session loop](references/session-loop.md)
for wait behavior, event limits, streaming alternatives, and one-shot
`session_run` (in compact, call it through `tool_call`, not as a listed tool).

## Compact dispatch

Compact advertises 15 tools: `server_info`, nine local turn/prompt tools, and
`tools_search`, `tools_describe`, `tool_call`, `batch`, `result_read`.
All 284 operations remain reachable. Full advertises each operation directly;
the five dispatch tools are compact-only.

For an unknown operation: `tools_search { query, family?, readOnly?, limit }`
(start with a small limit), then `tools_describe { names }` only if its schema
is unknown. Run `tool_call { name, arguments, select?, maxBytes? }` or
`batch { steps, maxBytes? }`. Selection is one JSON Pointer, not a field list
or event filter. A truncated response carries a `ref` for `result_read`.

Read [tool families](references/tool-families.md) when discovering a capability,
chaining calls, recovering a result, or handling a failure. It explains
what the 284 tool names mean, indexes every capability family, and groups the server's
failure codes with recovery actions.
