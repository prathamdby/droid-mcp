# Served skill comparison

Measured on 2026-11-13 against the installed compact server, version 0.1.0,
daemon protocol 1.269.0. Each run used a fresh local session with `modelId: "auto"`
and `autonomyLevel: "medium"`. Run order: fire-1, stream-1, stream-2, fire-2.

## Method

Each disposable directory started with only `task.txt`, containing
`status=pending` plus a newline. Every run received exactly this prompt:

> Edit task.txt so its entire contents are exactly status=done followed by a newline. Read it back to verify. Do not modify any other file. Reply only DONE when verified.

- Fire-and-forget: `session_stream.waitMs: 0`, then `session_events.waitMs: 300000`.
  Retain status/cursor and check for prompts, without consuming intermediate text.
- Stream events: `session_stream.waitMs: 1000`, then `session_events.waitMs: 1000`.
  Consume each event response incrementally.

Both advance the returned cursor, stop on terminal status, and close the session.
No sleeps, artificial delays, or skipped cursors. All four completed, all four
files independently matched exactly `status=done\n`, and directory listings
contained only `task.txt`. Cleanup returned `closed: true` for every session;
a final session list contained no handles under the comparison directory.

Bytes count UTF-8 `JSON.stringify` of each structured tool result at the MCP
binding, before client filtering. This is a response-payload proxy, not HTTP/
JSON-RPC envelope size, exact billed tokens, or the child model's token usage.
Calls include create, stream, every poll, and close. They exclude shared
`server_info`, setup, independent file checks, and cleanup verification.
Wall time includes creation through close and the independent file read.

## Results

| Run      | Approach        | MCP calls | Response bytes | Approx tokens (bytes/4) | Wall seconds | Correct |
| -------- | --------------- | --------: | -------------: | ----------------------: | -----------: | ------- |
| fire-1   | Fire-and-forget |        10 |           1992 |                     498 |       29.284 | yes     |
| fire-2   | Fire-and-forget |         9 |           1783 |                  445.75 |       22.421 | yes     |
| stream-1 | Stream events   |        19 |           2713 |                  678.25 |       16.492 | yes     |
| stream-2 | Stream events   |        19 |           2713 |                  678.25 |       19.499 | yes     |

Choose long-wait outcome consumption as the default: 3775 bytes versus 5426
bytes, 30.43% less, and 19 calls versus 38. Mean bytes: 1887.5 versus 2713.
Use incremental streaming to observe critical tasks, or when live progress,
debugging, or interaction matters.

This compares these polling policies, not a server-side event-free mode.
`session_events` wakes on any event, even with a long wait. Ignoring event text
alone saves no returned bytes. Streaming clients can also use long waits.
The model used different tool sequences despite identical prompts; there are
only two samples per approach. Fire runs were slower here. The measured win
supports avoiding empty short-timeout responses, not a general speed claim.
The fire runs used the terminal result plus file verification; their final
response did not contain assistant text, so no final `DONE` text was assumed.

## Raw call measurements

Each row lists calls in order: create, stream, zero or more event polls, close.
The byte totals are checked against the raw tool-result log.

| Run      | Per-call response bytes                                                                      | Per-call milliseconds                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| fire-1   | 177, 112, 208, 208, 208, 208, 210, 210, 436, 15                                              | 1056, 92, 10524, 2897, 4583, 4056, 3561, 258, 12, 2235                                                     |
| fire-2   | 177, 112, 208, 208, 208, 210, 210, 435, 15                                                   | 1109, 56, 9122, 3759, 3175, 3437, 253, 11, 1492                                                            |
| stream-1 | 179, 112, 112, 112, 112, 112, 112, 112, 112, 112, 112, 208, 112, 112, 112, 210, 210, 435, 15 | 1070, 1080, 1015, 1022, 1018, 1017, 1024, 1020, 1017, 1019, 1015, 291, 1013, 1015, 1020, 65, 154, 13, 1593 |
| stream-2 | 179, 112, 112, 112, 112, 112, 112, 112, 112, 112, 112, 208, 112, 112, 112, 210, 210, 435, 15 | 2089, 1030, 1015, 1017, 1020, 1018, 1016, 1019, 1021, 1021, 1017, 722, 1015, 1023, 1020, 136, 25, 19, 3247 |

The first harness attempt created four idle sessions, then failed before
sending any task because Script did not expose `TextEncoder`. Those four were
recovered by their disposable cwd and closed. They are excluded setup attempts,
not failed task runs. The successful harness used a pure-JavaScript UTF-8
counter. The table above preserves the per-call measurements in the repository.

## Writing guidance

Applied [writing-for-agents at pinned revision 5863806](https://github.com/mattpocock/skills/tree/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/productivity/writing-for-agents):
keep routing and token posture in the entry, disclose branch-specific reference
behind explicit triggers, co-locate caveats, and remove duplicated instructions.
The three remote blobs were read ephemerally, without installing the skill.
