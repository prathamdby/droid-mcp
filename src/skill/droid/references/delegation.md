# Backend workflows

## Local versus daemon

Use `session_*` for client-driven coding turns. `daemon_*` and `droid_*` use
the long-running daemon and its ids, not the local hub's handles. The server
connects to or starts the daemon; `server_info` reports its connection.
Daemon message/turn-outcome operations exist, but do not provide the local
hub's prompt-and-cursor loop. Discover their schemas before using them.

`daemon_generate_semantic_diff` generates a semantic diff;
`daemon_get_semantic_diff_cache` and `daemon_save_semantic_diff_cache` manage
its cache. Git, worktrees, automation, crons, terminals, plugins, preferences,
and workstreams are indexed in [tool families](tool-families.md).

### Authority is not a universal sandbox

The server rejects explicit above-cap authority on supported generated
authority-changing methods and local create/run/settings/permission calls.
`daemon_initialize_session` fills omitted `autonomyLevel` and `autonomyMode`
from one `daemon_get_default_settings` snapshot: preserve within-cap values,
clamp higher ones, use `off`/`normal` when absent. Below a `high` cap, omitted
`skipPermissionsUnsafe` becomes `false` (it is not a snapshot field).
Persistent defaults stay unchanged. Initialize has no
`subagentAutonomyLevel` parameter.

`daemon_load_session` and `droid_load_session` cannot cap saved authority;
queued work may already run. List/message reads do not prove its authority.
Prefer `session_create` or `session_run` for cap-controlled work.
Workers are spawned by Droid, not a client worker-create tool;
`daemon_kill_worker_session` and `droid_kill_worker_session` stop them.

## Hosted computer to session

`rest_*` uses `FACTORY_BASE_URL` and `FACTORY_API_KEY`. Remote sessions require
organization support and run on a Factory computer, not this host.

1. Reuse a suitable computer, or choose an Environment with
   `rest_list_environments` / `rest_get_environment`.
2. Describe `rest_create_computer`; its input is
   `name` plus `source: { kind: "environment", environmentId, isListed: false }`.
3. Poll `rest_get_computer` until `active`; stop on `error` and inspect
   `rest_get_environment_build_diagnostics` if needed.
4. `rest_create_remote_session` with
   `body: { computerId, sessionSettings: { model: "auto" } }`.
5. `rest_post_remote_session_message` with the session id and `body: { text }`.
6. Read only the needed reply using `rest_get_remote_session_message` or
   `rest_list_remote_session_messages` (`role`, `cursor`).
   `rest_interrupt_remote_session` stops hosted work.

Use `batch`/`$from` for steps whose prerequisites are already satisfied.
Provisioning and build readiness still need checking between dependent phases.
Each REST operation sends one request; a batch does not wait for provisioning.
Before retrying an uncertain create/write, list or read back to avoid duplicates.

## Stored Context

`context_*` needs `FACTORY_CONTEXT_BASE_URL` (Prem origin), `FACTORY_API_KEY`,
and any configured `FACTORY_CONTEXT_HEADERS`. Without the origin, it fails
`context_base_url_missing` without sending a request.

- Spaces organize documents, binary files, and stored sessions. Registering
  a stored session starts no process.
- `context_register_session`, then `context_append_session` with
  `startSequence` equal to `lastSequence + 1`. Gaps/overlaps conflict;
  identical retries are accepted.
- `context_read_session_records`: while `hasMore`, pass `nextCursor` as
  `afterSequence`. Read only the records needed.
- `context_update_document` uses `expectedVersion`. On HTTP 409, reread and
  reconcile, rather than blindly repeating. Errors retain upstream conflict
  fields such as `currentVersion` and `currentSequence` when supplied.
- File flow: `context_create_file`, `context_upload_file_part`, then commit
  the uploaded `fileId` with document create/update; `context_read_file_part`
  reads base64 parts. Describe inputs for type, size, hash, and part limits.

Versions and sequences are decimal strings. Preserve them as strings, including
when computing the next sequence with integer-safe arithmetic.
