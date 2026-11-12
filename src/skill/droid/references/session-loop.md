# Session loop

## Start and wait

```json
{ "cwd": "/home/me/src/app", "autonomyLevel": "low", "modelId": "auto" }
```

`session_create` returns `{ sessionId, cwd, settings }`. Send one prompt:

```json
{ "sessionId": "ID", "prompt": "Add and run a test for the retry helper", "waitMs": 0 }
```

`session_stream` returns `{ sessionId, status, cursor, events, truncated, result? }`.
A short wait hands control back with `running`; it does not detach ownership
or close the session. Continue with `session_events`:

```json
{ "sessionId": "ID", "cursor": 42, "waitMs": 300000 }
```

Always replace `42` with the previous response's cursor. Waits default to
20000 ms, accept 0..300000 ms, and are not a turn timeout.
`session_stream` waits for completion or its timeout. `session_events` returns
immediately for buffered events or a terminal turn; otherwise it wakes on the
next event or timeout, **not only at completion**. Long waits avoid empty
timeout polls but do not suppress event responses.

Default to fire-and-forget (deferred consumption). Consume status/cursor and
pending prompts while running, then the terminal `result` or last `assistant_text`.
This is deferred
consumption, not an event-free server mode. Intermediate events still arrive
and cost response bytes. To retain less in the agent context, filter them in
the client's execution layer, while preserving prompt handling and the last
assistant text. Stream events incrementally when progress, debugging, or
human interaction is needed.

In four isolated edits with `modelId: "auto"` (two per approach), this long-wait
approach returned 1992/1783 bytes versus 2713/2713 for 1-second incremental
polling; all edits passed. The saving came from avoiding empty timeouts, not
from ignoring text. Two runs do not establish a general latency advantage;
incremental clients can also long-poll.

For a task that can wait synchronously, a long initial `session_stream.waitMs`
can avoid intermediate polls. If prompts are possible, use a shorter initial
wait so you can answer within their deadline.

## Finish

`completed` means the turn finished, not that its edits are correct.
`result` may include `reason`, `turnId`, `durationMs`, `tokenUsage`, and
`structuredOutput`. `failed` and `interrupted` also end the turn. Inspect errors
before deciding to reuse the session; `process_exit` means its child died.

`session_interrupt { sessionId }` stops a running turn and reports
`{ interrupted }`; there is no `prompt` argument. After interruption, poll to
terminal before starting another turn. `session_busy` means one is still active.

`session_close { sessionId }` interrupts work, cancels prompts, and stops the
child. A missing id means it is already closed. Idle sessions are reaped after
30 minutes; cleanup remains the caller's responsibility.

## Retention

Events include `assistant_text`, `thinking`, `tool_call`, `tool_result`, `error`,
`turn_completed`, `prompt_resolved`, and prompt events. Text fields are capped
at 4096 UTF-8 bytes, marked `…[truncated]`; the ring holds 500 events or 256 KiB.
Top-level `truncated: true` means the requested cursor predates retained
events. Advancing the cursor prevents duplicates, but cannot restore lost
text. `result_read` only pages dispatch results; it cannot restore event text
already clipped by the session hub. Use an output file for large deliverables.

## One-shot alternative

`session_run` accepts `cwd`, `prompt`, `autonomyLevel`, optional `modelId`
and `waitMs`. In compact use:

```json
{
  "name": "session_run",
  "arguments": {
    "cwd": "/home/me/src/app",
    "autonomyLevel": "low",
    "prompt": "Explain the retry helper briefly",
    "waitMs": 20000
  },
  "maxBytes": 1024
}
```

It closes automatically on a terminal response. On `running`, retain its
`sessionId` and cursor, answer prompts, poll, and close yourself. Keep these
control fields when selecting/bounding a running result; recover them from
its `ref` before proceeding. Use `session_create` for multiple turns.
