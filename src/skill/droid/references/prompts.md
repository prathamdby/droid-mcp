# Prompts

Prompts park the turn until answered or cancelled at their `deadline` (epoch
milliseconds, 300 seconds by default). Even an outcome-only client must check
for them. Use the event's `requestId` with its `sessionId`; answer within the
deadline, then resume polling from your retained cursor.

## Permission

`pending_permission` contains `options` and `toolUses`. Choose only an offered
outcome, after obtaining any required user approval:

```json
{ "sessionId": "ID", "requestId": "hub-2", "outcome": "proceed_once" }
```

Optional `comment` explains the decision. `proceed_edit` requires nonempty
`editedSpecContent`. Outcomes accepted by the server:

- `proceed_once`, `cancel`.
- `proceed_always`, `proceed_always_file`, `proceed_always_tools`,
  `proceed_always_server`, `proceed_report_false_positive`.
- `proceed_auto_run_low`, `proceed_auto_run_medium`, `proceed_auto_run_high`,
  `proceed_new_session_low`, `proceed_new_session_medium`, `proceed_new_session_high`.
- `proceed_auto_run`, `proceed_new_session`, `proceed_edit`.

Leveled outcomes must fit `server_info.maxAutonomy`; unlevelled
`proceed_auto_run` and `proceed_new_session` require a `high` cap.
The server filters above-cap choices out of `options` and rejects them if sent.
Persistent grants are broader than one-call consent; prefer the smallest
offered grant that covers the user's authorization.

## Question

`pending_question` contains `questions` with `index`, `question`, optional
`topic`, `options`, and `multiSelect`. Supply one answer per question index:

```json
{
  "sessionId": "ID",
  "requestId": "hub-4",
  "answers": [{ "index": 0, "answer": "sqlite" }]
}
```

The server fills in question text. Use indices from this prompt, not positions
guessed from an earlier one.

## Options

`pending_options` contains `rows` (`id`, optional `label`/`detail`) and `multi`.
Select offered row ids; a single-select prompt accepts at most one:

```json
{ "sessionId": "ID", "requestId": "hub-5", "selectedIds": ["app"] }
```

`refresh: true` requests new rows instead of selecting; watch for a fresh event.
Permission/question answers return `{ resolved: true }`; option answers also
return `refresh`. An answer resolves the prompt, not the turn.

## Stale or invalid answers

`prompt_not_found`: already answered, expired, or retired. Poll current state.
`prompt_mismatch`: wrong answer tool. `invalid_outcome`,
`invalid_question_index`, `invalid_selection`, or `edited_spec_required`:
correct the answer from this event. Above-cap choices fail
`autonomy_exceeds_cap`. A timeout emits `prompt_resolved` with
`reason: "timeout"` and sends a cancellation response to Droid.
