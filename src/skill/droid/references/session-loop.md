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
  "cursor": 412,
  "events": [{ "seq": 401, "kind": "assistant_text", "text": "I will read the helper." }],
  "truncated": false
}
```

Hold on to `cursor`. It is the `seq` of the last event in `events`, and passing
it back never repeats an event.

## Poll

```json
{ "sessionId": "3f1c...", "cursor": 412, "waitMs": 20000 }
```

Poll with the cursor a previous call returned, not with `0`. Starting at `0`
after the ring buffer has moved on returns `truncated: true` and only the last
500 events, which loses the `turn_completed` that tells you the outcome.

A prompt of only whitespace is rejected with `invalid_prompt` before any turn
starts, so an accidental empty send costs nothing.

Stop when `status` is `completed` or `failed`. A `failed` turn still has a
`result.reason`; `process_exit` means the CLI exited, and the session is no
longer usable.

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

`session_run` starts a session, sends one prompt, and closes it, all in one
call. It is the shortest path for a self-contained question. Reach for
`session_create` when you need to answer prompts or keep context between turns.
