# Delegation

Three things can do work for you here, and they are not interchangeable.

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

## Remote computers and templates

The `rest_*` tools reach the hosted Factory API with `FACTORY_API_KEY`:

| Tool                                                       | What it does                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `rest_list_computers`                                      | The cloud computers on the account, each with its `relayClientUrl`.      |
| `rest_get_computer`                                        | One computer by id.                                                      |
| `rest_create_computer`                                     | Provision a computer from a template, with repos and dependency install. |
| `rest_restart_computer`, `rest_delete_computer`            | Lifecycle. Both are destructive in effect; confirm first.                |
| `rest_get_computer_metrics`                                | Resource metrics for a computer.                                         |
| `rest_list_machine_templates`, `rest_get_machine_template` | What a computer can be created from.                                     |
| `rest_list_remote_sessions`                                | Sessions across the account's computers.                                 |

Remote work is: provision or find a computer, then let that machine run its own
droid-mcp. Nothing on this server executes on a remote computer. The
`relayClientUrl` on a computer is the endpoint that host's own server is reached
through.

## Workers

`daemon_kill_worker_session` and `droid_kill_worker_session` stop a worker a
session spawned. They are the only worker tools: workers are created by Droid
itself, not by you. Read `daemon_list_opened_sessions` to find them before
killing one.

## Choosing

| The task                                 | Use                                                               |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Change code in this repository           | A session.                                                        |
| Answer a question about this repository  | `session_run`.                                                    |
| Run something every morning              | `daemon_create_automation`.                                       |
| Find a session from last week            | `daemon_search_sessions`.                                         |
| Prepare a branch and open a pull request | Session to edit, then `daemon_git_commit` and `daemon_create_pr`. |
| Work on a machine that is not this one   | `rest_*` to provision it, then that machine's own droid-mcp.      |
