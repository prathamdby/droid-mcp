---
name: droid
description: Drive Factory Droid on this host through MCP tools. Use for coding
  tasks, long-running daemon sessions, permission prompts, and delegation to
  environments or computers.
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

## Two ways to delegate

- **A session** runs work here, under your control, with prompts. Use it for
  anything that edits files.
- **The daemon tools** (`daemon_*`) reach the long-running `droid daemon` and
  its automations, sessions, worktrees, MCP servers, and plugins. Use them to
  look across sessions, not to run one.

`droid_*` tools speak the same protocol inside a session you already own
(`session_update_settings`, `session_compact`, `session_rewind`, ...). They take
a `sessionId`.

## Failures worth knowing

| Code                      | Meaning                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `autonomy_exceeds_cap`    | Asked for more autonomy than `server_info.maxAutonomy`.           |
| `invalid_cwd`             | The directory does not exist or is not a directory.               |
| `session_not_found`       | The session id is wrong or already closed.                        |
| `session_busy`            | A turn is already running in that session; wait or interrupt.     |
| `prompt_not_found`        | That prompt is gone. Read `session_events` for the current state. |
| `prompt_mismatch`         | The tool does not match the pending prompt kind.                  |
| `daemon_unavailable`      | The `droid daemon` is not running and could not be started.       |
| `factory_api_key_missing` | The `rest_*` tools and daemon auth need `FACTORY_API_KEY`.        |

## References

- `references/session-loop.md`: the loop with real arguments and cursors.
- `references/prompts.md`: the three prompts, outcomes, and deadlines.
- `references/delegation.md`: sessions, the daemon, computers, and Relay.
- `references/tool-families.md`: what the 199 tool names mean and how to find one.
