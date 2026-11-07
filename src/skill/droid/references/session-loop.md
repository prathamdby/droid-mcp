# The session loop

## Create

```json
{ "cwd": "/home/me/src/app", "autonomyLevel": "low" }
```

The reply is:

```json
{
  "sessionId": "3f1c...",
  "cwd": "/home/me/src/app",
  "settings": { "autonomyLevel": "low", "interactionMode": "auto", "modelId": "claude-sonnet-4" }
}
```

`sessionId` is what every later call takes. An autonomy level above
`server_info.maxAutonomy` fails with `autonomy_exceeds_cap`, and a `cwd` that
does not exist fails with `invalid_cwd`. Both are cheap to fix; do not retry
blind.

## Send a prompt

```json
{ "sessionId": "3f1c...", "prompt": "Add a test for the retry helper", "waitMs": 20000 }
```

The reply says what happened:

```json
{
  "sessionId": "3f1c...",
  "status": "running",
  "cursor": 402,
  "events": [{ "seq": 401, "kind": "assistant_text", "text": "I will read the helper." }],
  "truncated": false
}
```

Hold on to `cursor`. It is the next sequence number, one past the last event,
not that event's `seq`. Pass it back unchanged and an event is never repeated.

## Poll

```json
{ "sessionId": "3f1c...", "cursor": 402, "waitMs": 20000 }
```

Poll with the cursor a previous call returned, not with `0`. Starting at `0`
after the ring buffer has moved on returns `truncated: true` and only the last
500 events, which loses the `turn_completed` that tells you the outcome.

A prompt of only whitespace is rejected with `invalid_prompt` before any turn
starts, so an accidental empty send costs nothing.

Stop when `status` is `completed`, `failed`, or `interrupted`. `interrupted` is
terminal for that turn; the session can take another prompt. A `failed` turn
still has a `result.reason`. `process_exit` means the CLI exited, later calls
fail with `session_closed`, and the session is no longer usable.

## Interrupt

```json
{ "sessionId": "3f1c...", "prompt": "change of plan" }
```

`session_interrupt` stops the current turn. The turn completes as `interrupted`,
and the session stays usable for the next prompt. The reply's `interrupted`
is `true` only when a turn was running; interrupting an idle session is
harmless and reports `false`.

## Close

`session_close` interrupts a running turn, cancels any pending prompt, and stops
the process. Closing a session id that is no longer open fails with
`session_not_found`; treat that as already closed.

## Concurrency

A session runs one turn at a time. A `session_stream` while one is running fails
with `session_busy`. Either poll to the end, or interrupt, or open a second
session. Independent work belongs in separate sessions so two turns cannot
serialize behind each other.

## Sessions versus one-shot runs

`session_run` starts a session, sends one prompt, and closes it when the turn
completes, fails, or is interrupted. A `running` result keeps the session so
you can poll `session_events`, answer prompts, and call `session_close`. It is
the shortest path for a self-contained question. Reach for `session_create`
when you need more than one turn.
