---
name: droid
description: Drive Factory Droid on this host through MCP tools. Use for coding
  tasks, long-running daemon sessions, permission prompts, hosted sessions on
  Factory computers and Environments, and stored Context documents and
  sessions.
---

# Droid

This server runs one Droid per session on the host it is installed on. A
session is a child process that owns a working directory, an autonomy level,
and a model. You talk to it in turns.

## The turn loop

1. `session_create` asks for a `cwd` and an `autonomyLevel`. Autonomy is
   required: the server will not guess, and it rejects a level above
   `server_info.maxAutonomy`.
2. `session_stream` sends the prompt. It waits `waitMs` (20 s by default) for
   the turn, then returns either `completed`, `failed`, or `running`.
3. If it returned `running`, call `session_events` with the `cursor` it
   returned. Repeat until the status is no longer `running`. Every event has a
   `seq`; the cursor is the last `seq` you have seen, so nothing repeats.
4. When the turn is done, `session_close` stops the process. Sessions idle for
   30 minutes are reaped for you, but close what you opened.

`session_interrupt` stops a turn that is going the wrong way.

## Reading a turn

| Status      | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `completed` | Droid finished the turn. `result` carries the reason, token usage, and any structured output. |
| `failed`    | The turn ended in an error. The `error` event says why; `process_exit` means the CLI died.    |
| `running`   | Still working. Poll `session_events` from the cursor.                                         |

Events are `assistant_text`, `thinking`, `tool_call`, `tool_result`, `error`,
`turn_completed`, `prompt_resolved`, and the three prompt events. Long text is
capped at 4096 characters and the buffer holds 500 events or 256 KiB;
`truncated: true` means you started above what is retained, so re-read from the
`cursor` you were given rather than from `0`.

## Prompts

Droid stops mid-turn to ask. The event tells you which tool to call:

| Event                | Answer with                                                     |
| -------------------- | --------------------------------------------------------------- |
| `pending_permission` | `session_respond_permission` with an `outcome` the event listed |
| `pending_question`   | `session_answer_question` with one answer per question index    |
| `pending_options`    | `session_pick_options` with row ids from the event              |

Each event carries a `requestId` and a `deadline`. A prompt answered after the
deadline, or never answered, is resolved by the server and the turn continues
without you. Read `references/prompts.md` before answering your first one.

## Before you start

`server_info` reports the version, the tool count, the autonomy cap, and the
daemon this server is supervising. Call it first: the autonomy cap decides what
`session_create` will accept.

## Four session backends

Four tool families use the word "session", and their ids are not
interchangeable. Pick the backend first, then stay inside its family.

| Backend        | Tools                    | Where the work runs                                                                                                                                                               |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local session  | `session_*`              | A `droid exec` child process on this host, with prompts you answer. Use it for anything that edits files here.                                                                    |
| Daemon         | `daemon_*`, `droid_*`    | The long-running `droid daemon` on this host: its sessions, automations, worktrees, MCP servers, and plugins. Use it to look across sessions or schedule work, not to run a turn. |
| Hosted session | `rest_*_remote_session*` | A Factory cloud computer. Hosted sessions are enabled for selected organizations only.                                                                                            |
| Stored session | `context_*`              | Nowhere. The Context API stores session records and documents; nothing runs.                                                                                                      |

- A `session_create` id works only with `session_*` tools. `daemon_load_session`
  will not find it, and a hosted session id is not a local `session_*` handle.
- `droid_*` tools call SDK session methods that `session_*` does not already
  wrap, such as `droid_update_session_settings`, `droid_compact_session`, and
  `droid_execute_rewind`. They take a daemon `sessionId`.
- A hosted session needs a computer. The usual path is an Environment, then a
  computer built from it, then the session, then its messages, each as a
  separate call. `references/delegation.md` walks through it.
- `context_*` tools need `FACTORY_CONTEXT_BASE_URL`, the Prem origin that serves
  the Context API. Use them to keep notes, files, and session transcripts that
  another agent can read later.

## Failures worth knowing

| Code                       | Meaning                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `autonomy_exceeds_cap`     | Asked for more autonomy than `server_info.maxAutonomy`.                                                                             |
| `invalid_cwd`              | The directory does not exist or is not a directory.                                                                                 |
| `session_not_found`        | The session id is wrong or already closed.                                                                                          |
| `session_busy`             | A turn is already running in that session; wait or interrupt.                                                                       |
| `prompt_not_found`         | That prompt is gone. Read `session_events` for the current state.                                                                   |
| `prompt_mismatch`          | The tool does not match the pending prompt kind.                                                                                    |
| `daemon_unavailable`       | The `droid daemon` is not running and could not be started.                                                                         |
| `factory_api_key_missing`  | The `rest_*` and `context_*` tools and daemon auth need `FACTORY_API_KEY`.                                                          |
| `rest_rejected`            | The hosted or Context API refused the request (HTTP 4xx). The message keeps the upstream detail; fix the input, do not retry blind. |
| `rest_unavailable`         | The upstream failed (HTTP 5xx), timed out, could not be reached, answered with malformed JSON, or redirected. Retry later.          |
| `context_base_url_missing` | `FACTORY_CONTEXT_BASE_URL` is not set, so no `context_*` tool can run. No request was sent.                                         |

A rejected Context write on a version or sequence conflict (HTTP 409) names
`code`, `requestId`, `expectedVersion`, `currentVersion`, and
`currentSequence` where the API returned them. Reread, then decide; do not
resend the same write.

## References

- `references/session-loop.md`: the loop with real arguments and cursors.
- `references/prompts.md`: the three prompts, outcomes, and deadlines.
- `references/delegation.md`: the four backends, and the Environment-to-hosted-session flow.
- `references/tool-families.md`: what the 287 tool names mean and how to find one.
