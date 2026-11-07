# Prompts

Droid raises a prompt mid-turn as a server-to-client request. The server parks
it, publishes an event, and waits. The deadline is 300 seconds by default; when
it passes, the server resolves the prompt itself and the turn keeps going.

Always answer with the `requestId` from the event. Answering twice, or after the
deadline, fails with `prompt_not_found`.

## Permissions

```json
{
  "seq": 88,
  "kind": "pending_permission",
  "requestId": "droid-mcp-2",
  "promptType": "request_permission",
  "deadline": 1770000000000,
  "options": ["proceed_once", "proceed_always", "cancel"],
  "toolUses": [
    {
      "toolUse": { "id": "t-1", "name": "Write", "input": { "path": "src/a.ts" } },
      "confirmationType": "tool_use"
    }
  ]
}
```

Answer with one of the `options` the event listed:

```json
{ "sessionId": "3f1c...", "requestId": "droid-mcp-2", "outcome": "proceed_once" }
```

| Outcome               | Effect                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `proceed_once`        | Allow this call only.                                                                          |
| `proceed_always`      | Allow this tool for the rest of the session.                                                   |
| `proceed_always_file` | Allow this file for the rest of the session.                                                   |
| `proceed_auto_run`    | Enable automatic approval without a named level. Forwarded only when the server cap is high.   |
| `proceed_new_session` | Continue in a fresh session without a named level. Forwarded only when the server cap is high. |
| `proceed_edit`        | Allow after editing the spec; requires `editedSpecContent`.                                    |
| `cancel`              | Deny and tell Droid why (add `comment`).                                                       |

The full list also includes `proceed_auto_run_low`, `proceed_auto_run_medium`,
`proceed_auto_run_high`, `proceed_new_session_low`,
`proceed_new_session_medium`, `proceed_new_session_high`, `proceed_always_tools`,
`proceed_always_server`, and `proceed_report_false_positive`.

The server drops permission outcomes that would raise autonomy above
`server_info.maxAutonomy` and does not list them in `options`. A leveled
outcome such as `proceed_auto_run_low` is accepted only when that level is
within the cap. `proceed_auto_run` and `proceed_new_session` do not name a
level, so they are accepted only when the cap is `high`. `proceed_once`,
`cancel`, `proceed_edit`, and the `proceed_always*` grants stay available.
Sending an outcome above the cap fails with `autonomy_exceeds_cap` and is not
forwarded.

Send only what the event offered: the server rejects an outcome that was not
on the list, and it rejects `proceed_edit` without `editedSpecContent`.

A `comment` is passed through to Droid. Use it on `cancel` so the next turn is
not a repeat.

## Questions

```json
{
  "kind": "pending_question",
  "requestId": "droid-mcp-4",
  "promptType": "ask_user",
  "questions": [
    {
      "index": 0,
      "topic": "Database",
      "question": "Which database should the tests use?",
      "options": ["sqlite", "postgres"],
      "multiSelect": false
    }
  ]
}
```

Answer each index once:

```json
{
  "sessionId": "3f1c...",
  "requestId": "droid-mcp-4",
  "answers": [{ "index": 0, "answer": "sqlite" }]
}
```

The server fills in the question text and sends the structured answer Droid
expects. An index that was not in the event is rejected.

## Option pickers

```json
{
  "kind": "pending_options",
  "requestId": "droid-mcp-5",
  "promptType": "pick_options",
  "rows": [{ "id": "app", "label": "app", "detail": "a monorepo" }],
  "multi": false
}
```

```json
{
  "sessionId": "3f1c...",
  "requestId": "droid-mcp-5",
  "selectedIds": ["app"]
}
```

Send one id for a single-select prompt. `refresh: true` asks Droid for fresh
rows; the reply carries `refresh`, and the next `pending_options` event has the
new rows.

## Deadlines

`deadline` is epoch milliseconds. The server resolves an unanswered prompt at
that point with `prompt_resolved` and `reason: "timeout"`, and Droid continues
with its default. If you cannot answer, say so: `cancel` with a comment is
better than silence.

## After answering

The answer tool returns `{ "resolved": true }`. The turn is still running. Poll
`session_events` from the cursor you had; the next events are the ones the turn
produced after the prompt.
