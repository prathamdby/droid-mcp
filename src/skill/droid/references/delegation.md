# Delegation

Four backends can hold a session for you here, and they are not
interchangeable: a local session, the daemon, a hosted session on a Factory
computer, and a stored Context session. Their ids never cross over.

## A session on this host

`session_create` starts a `droid exec` child process on the machine the server
runs on. It edits files here, runs commands here, and raises prompts here. This
is the right tool for any task that changes a repository.

Every session has its own working directory and autonomy level, so parallel work
is a matter of opening a second session rather than queueing behind the first.

## The daemon

The daemon is the long-lived `droid daemon` process. The server connects to it
over its Unix socket, or over `--daemon-url` when it is reached another way, and
supervises it: if it is not running, the first `daemon_*` call starts it.

The 130 `daemon_*` tools mirror the SDK's daemon methods one for one:

| Name                                                                                                                      | What it covers                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `daemon_list_available_sessions`, `daemon_list_opened_sessions`, `daemon_load_session`                                    | Sessions the daemon knows about, not sessions you created. |
| `daemon_create_automation`, `daemon_update_automation_schedule`, `daemon_run_automation`, `daemon_get_automation_history` | Scheduled and triggered work.                              |
| `daemon_list_managed_worktrees`, `daemon_save_worktree_setup_profile`, `daemon_inspect_worktree_deletion`                 | Git worktrees.                                             |
| `daemon_list_mcp_servers`, `daemon_toggle_mcp_tool`, `daemon_add_mcp_server`                                              | The daemon's own MCP configuration.                        |
| `daemon_search_sessions`, `daemon_archive_session`, `daemon_fork_session`                                                 | Session history.                                           |
| `daemon_get_semantic_diff`, `daemon_git_commit`, `daemon_git_push`, `daemon_create_pr`                                    | Repository operations the daemon already models.           |
| `daemon_list_models`, `daemon_get_default_settings`                                                                       | What this installation supports.                           |

A `daemon_*` tool takes daemon-shaped ids. A session you created with
`session_create` is not a daemon session, and `daemon_load_session` will not find
it.

Use the daemon to look across sessions, to schedule something for later, or to
do a git or worktree operation that is already modelled there. Do not use it to
run a coding turn: that is what a session is for.

`daemon_initialize_session` pins an omitted `autonomyLevel` or `autonomyMode`
from one `daemon_get_default_settings` snapshot onto that request. A value
inside `server_info.maxAutonomy` is kept, a higher value is lowered to the cap,
a missing level is `off`, and a missing mode is `normal`. When the cap is below
`high`, an omitted `skipPermissionsUnsafe` is sent as `false`. The snapshot is
not written back as persistent defaults, and initialize has no
`subagentAutonomyLevel` field. `daemon_load_session` and `droid_load_session`
send no saved authority, and queued work can already be running. For work that
has to stay inside the cap, use `session_create` or `session_run`.

`daemon_initialize_session` copies omitted `autonomyLevel`, `autonomyMode`, and,
when the cap is below `high`, `skipPermissionsUnsafe` from the
`daemon_get_default_settings` snapshot it just read. A lower observed value is
kept, and a missing field becomes `off`, `normal`, or `false`. The call does
not change persistent defaults. `daemon_load_session` and `droid_load_session`
open the authority stored with that saved session. Initialize has no
`subagentAutonomyLevel` field. For work that must stay inside the cap, use
`session_create` or `session_run`.

## Hosted sessions on Factory computers

The `rest_*` tools reach the hosted Factory API at `FACTORY_BASE_URL` with
`FACTORY_API_KEY`. A hosted session runs Droid on a Factory cloud computer, not
on this host, and it is driven by messages rather than by the turn loop. Hosted
sessions are enabled for selected organizations only; elsewhere the session
tools fail with `rest_rejected` and the upstream detail says so. A hosted
session id is not a local `session_*` handle, and `session_*` tools will not
accept it.

Each step below is a separate call. Read each result before the next call; no
tool chains them for you.

1. `rest_list_environments`, then pick the Environment by `name` (for example
   `pr-agent`). `rest_get_environment` shows its repositories and current build.
2. `rest_create_computer` with `name` and
   `source: { kind: "environment", environmentId, isListed: false }`. The
   computer starts in `provisioning`.
3. Poll `rest_get_computer` until `status` is `active`. Stop on `error`, and
   read `rest_get_environment_build_diagnostics` if the build failed.
4. `rest_create_remote_session` with `body: { computerId, sessionSettings: { model: "auto" } }`.
5. `rest_post_remote_session_message` with `body: { text }`. It returns a
   `messageId` and the session `status`.
6. `rest_list_remote_session_messages` (filter with `role`, page with
   `cursor`) or `rest_get_remote_session_message` to read the reply.
   `rest_interrupt_remote_session` stops a run that is going the wrong way.

Do not retry a create call that failed with `rest_rejected`: a 403 or 409 will
fail the same way, and a retry after an uncertain `rest_unavailable` can create
a second computer or session. List first and reuse what exists.

| Tool family                                        | What it covers                                               |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `rest_*_environment*`                              | Environments, their default, sources, and builds.            |
| `rest_*_computer*`, `rest_*_machine_template*`     | Computers, their files, metrics, and the templates they use. |
| `rest_*_remote_session*`                           | Hosted sessions, their messages, children, and interrupts.   |
| `rest_*_wiki*`, `rest_*_ci_*`                      | Wiki runs and CI automation on the account's repositories.   |
| `rest_*_organization_*`, `rest_*_service_account*` | Members, limits, organization secrets, and service accounts. |

Deleting a computer, an Environment, or a hosted session, cancelling a build,
and the other tools marked "Destructive; confirm before calling." change shared
state. Ask the user first.

File transfers return URLs and never fetch them: `rest_create_computer_file_upload`
gives an `uploadUrl` to send the bytes to, then `rest_complete_computer_file_upload`
places the file. A service-account key minted by
`rest_create_service_account_api_key` or `rest_rotate_service_account_api_key`
is never shown; the result carries a `notice` instead.

## Stored sessions in Context

The `context_*` tools reach the Context API on the Prem origin in
`FACTORY_CONTEXT_BASE_URL`, with `FACTORY_API_KEY` and the headers in
`FACTORY_CONTEXT_HEADERS`. Without that origin they fail with
`context_base_url_missing` and send nothing.

A space holds documents and stored sessions. A stored session is an
append-only list of JSONL records, such as a transcript another agent can read
later. Nothing runs in it: registering one starts no Droid, here or remotely.

- `context_register_session`, then `context_append_session` with
  `startSequence` set to the session's `lastSequence` + 1. A gap or overlap
  fails with HTTP 409 and `currentSequence`; resending an identical batch is
  accepted.
- `context_read_session_records` reads one page. Pass `nextCursor` as the next
  `afterSequence` while `hasMore` is true.
- `context_update_document` edits against `expectedVersion`. On a 409, read
  `currentVersion` from the message, reread the document, and decide again.

Versions and sequences are decimal strings. Pass them back as strings.

## Workers

`daemon_kill_worker_session` and `droid_kill_worker_session` stop a worker a
session spawned. They are the only worker tools: workers are created by Droid
itself, not by you. Read `daemon_list_opened_sessions` to find them before
killing one.

## Choosing

| The task                                 | Use                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Change code in this repository           | A session.                                                             |
| Answer a question about this repository  | `session_run`. If it returns `running`, poll and then `session_close`. |
| Run something every morning              | `daemon_create_automation`.                                            |
| Find a session from last week            | `daemon_search_sessions`.                                              |
| Prepare a branch and open a pull request | Session to edit, then `daemon_git_commit` and `daemon_create_pr`.      |
| Run Droid on a Factory cloud computer    | The hosted-session steps above, one call at a time.                    |
| Keep a transcript for another agent      | `context_register_session` and `context_append_session`.               |
