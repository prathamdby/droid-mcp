# droid-mcp

droid-mcp is an MCP server that lets an AI assistant drive Factory Droid on your machine. You connect an MCP client to it, and the assistant can start Droid sessions, run turns, answer permission prompts, manage long-running daemon sessions, and reach the hosted Factory API and the Context API through tools.

## Getting Started

Paste this into your coding agent:

```text
Read https://raw.githubusercontent.com/prathamdby/droid-mcp/main/SETUP.md and follow it to set up droid-mcp on this machine. Ask me the questions it lists first.
```

## What it does

The server provides 284 tools in six families. 154 are generated from the Factory Droid SDK, one per wire method, and 130 are hand-written.

| Prefix     | Count | What the tools cover                                                                                            |
| ---------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `daemon_`  | 130   | Generated. The long-running `droid daemon`: its sessions, automations, worktrees, and MCP servers.              |
| `droid_`   | 24    | Generated. Session-scoped SDK methods, excluding session-owned and confirmed daemon-unserved methods.           |
| `session_` | 32    | The local turn loop, prompts, and per-session administration.                                                   |
| `rest_`    | 79    | The hosted Factory API: computers, Environments, hosted sessions, wiki, CI, organization, and service accounts. |
| `context_` | 18    | The Context API on a Prem origin: spaces, documents, files, and stored session records.                         |
| `server_`  | 1     | `server_info`.                                                                                                  |

The 79 `rest_*` tools cover the 77 operations of the published Factory OpenAPI document (version 0.1.0) plus the two machine-template operations the SDK still calls.

### Tool profiles

By default the server runs the `compact` profile. `tools/list` advertises 15 tools instead of 284, so a client spends about 22 KB of context on the list instead of about 340 KB:

- The turn loop as first-class tools: `server_info`, `session_create`, `session_stream`, `session_events`, `session_interrupt`, `session_close`, `session_list`, and the three prompt answers.
- `tools_search` finds any of the 284 operations by keyword, family, or read-only hint, and `tools_describe` returns the full description and input schema of up to 20 of them.
- `tool_call` runs one operation by name with its arguments. It uses the same handler, validation, autonomy cap, and `{ code, message }` failures as the operation's own tool in the full profile.
- `batch` runs up to 20 operations in order in one call. An argument `{ "$from": "<step id>", "path": "/json/pointer" }` takes part of an earlier step's result, so intermediate results never return to the client.
- A result larger than `maxBytes` (16 KB by default) returns a preview and a `ref`. `result_read` reads the stored result by byte range or by JSON Pointer, so no data is lost. Refs expire 15 minutes after their last use and only the key that created a ref can read it.

If `select` fails after an operation completes, `tool_call` or the batch step returns `invalid_select` with a `ref` to its full result. Read that ref instead of repeating the operation. Byte offsets for `result_read` must fall on UTF-8 character boundaries; use `nextOffset` to page, or expect `invalid_offset` for an offset inside a character.

`--tool-profile full` advertises all 284 tools, one per operation. Every tool in both profiles carries MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so a client can skip confirmation for reads and ask before destructive calls.

`node --experimental-strip-types scripts/measure.ts` prints the `initialize` and `tools/list` sizes for both profiles.

It also serves a `droid` skill and a `droid` prompt that teach the assistant the turn loop, so you do not have to explain it yourself.

A turn works like this.

1. `session_create` starts a Droid child process for a working directory and an autonomy level. The server rejects any autonomy level above the cap reported by `server_info`.
2. `session_stream` sends the prompt and waits up to `waitMs`, 20 seconds by default and 300 seconds at most.
3. If the turn is still running, call `session_events` with the cursor it returned. The cursor is the next sequence number, one past the last event, so pass it back unchanged and events do not repeat. Call it until the status is `completed`, `failed`, or `interrupted`. A `running` result keeps the session; close it when you are done. `session_run` closes the session itself unless it returns `running`, in which case poll, answer prompts, and then `session_close`.
4. While the turn runs, prompts such as `pending_permission`, `pending_question`, and `pending_options` appear, each with a deadline. Answer them with the matching tool.
5. `session_close` stops the process. Sessions idle for 30 minutes are closed automatically.

## Requirements

- Node.js 24 or newer. The server runs its TypeScript directly with Node's type stripping, so there is no build step.
- The `droid` CLI on your `PATH`.
- A Factory API key in `FACTORY_API_KEY`. Droid itself needs this key, and so do the `rest_*` and `context_*` tools.
- pnpm, to install dependencies.

### Droid compatibility

Release surface checked on 2026-11-13: [Droid CLI 1.9.0](https://www.npmjs.com/package/@factory/cli)
and [Droid SDK 0.10.0](https://www.npmjs.com/package/@factory/droid-sdk) are current.
The SDK still declares 165 wire methods and protocol `1.269.0`; the 284-operation
inventory excludes four confirmed daemon-unserved `droid.*` reads.
CLI versions and wire protocol versions are separate.
The daemon client adopts the peer's protocol version and retries once on a mismatch.
`droid_list_skills`, `droid_list_tools`, `droid_list_mcp_tools`, and
`droid_list_mcp_registry` are not advertised. Compact dispatch returns `unknown_tool`
with supported replacements: `session_list_skills` or `daemon_list_skills`,
`session_list_tools`, `session_list_mcp_tools` or `daemon_list_mcp_tools`, and
`daemon_list_mcp_registry`, respectively. These replacements require a session id.
Other methods rejected as unimplemented return `daemon_method_unsupported` with
the method and peer protocol version. Transport failures retain their codes;
malformed replies and schema failures remain `daemon_protocol_error`.
See the [Factory changelog](https://docs.factory.com/changelog/release-notes).

## Set it up

```sh
pnpm install
export DROID_MCP_KEYS="$(openssl rand -hex 32)"
export FACTORY_API_KEY="fk-..."
pnpm start
```

The server listens on `http://127.0.0.1:7337/mcp`. Startup fails unless you set at least one MCP key. Generate a key with `openssl rand -hex 32` and keep it secret. Only requests that carry the key reach a tool.

## Connect a client

Add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "droid": {
      "type": "http",
      "url": "http://127.0.0.1:7337/mcp",
      "headers": { "Authorization": "Bearer <the key you generated>" }
    }
  }
}
```

Then ask the client to read the `droid` prompt or the skill at `skill://droid/SKILL.md`, and call `server_info` first. It reports the version, the tool profile, the advertised tool count, the operation count, the autonomy cap, and the daemon connection.

If you run the server on another machine, put a TLS proxy in front of it and keep the key required. `docs/hosting.md` has a systemd unit, a keys file layout, and TLS setup for that case.

## Configuration

Each flag also has an environment variable. The defaults work for a local install.

| Flag                 | Environment                 | Default                                             |
| -------------------- | --------------------------- | --------------------------------------------------- |
| `--host`             | `DROID_MCP_HOST`            | `127.0.0.1`                                         |
| `--port`             | `DROID_MCP_PORT`            | `7337`                                              |
| `--keys-file`        | `DROID_MCP_KEYS`            | none, startup fails without a key                   |
| `--max-autonomy`     | `DROID_MCP_MAX_AUTONOMY`    | `medium`                                            |
| `--tool-profile`     | `DROID_MCP_TOOL_PROFILE`    | `compact`; `full` lists every operation as a tool   |
| `--droid-path`       | `DROID_MCP_DROID_PATH`      | `droid`                                             |
| `--socket`           | `DROID_MCP_SOCKET`          | `$XDG_RUNTIME_DIR/droid-mcp/daemon.sock`            |
| `--daemon-url`       | `DROID_MCP_DAEMON_URL`      | none, the server spawns a daemon                    |
| `--runtime-dir`      | `DROID_MCP_RUNTIME_DIR`     |                                                     |
| `--allow-origin`     | `DROID_MCP_ALLOWED_ORIGINS` | none, requests with an `Origin` header are rejected |
| `--factory-base-url` | `FACTORY_BASE_URL`          | `https://api.factory.ai`                            |
|                      | `FACTORY_CONTEXT_BASE_URL`  | none, the `context_*` tools fail until it is set    |
|                      | `FACTORY_CONTEXT_HEADERS`   | none                                                |
| `--log-level`        | `DROID_MCP_LOG_LEVEL`       | `info`                                              |
| `--prompt-timeout`   |                             | `300000` ms                                         |
| `--request-timeout`  |                             | `30000` ms                                          |

`--max-autonomy` accepts `off`, `low`, `medium`, or `high`. `FACTORY_API_KEY` is read from the environment and is never logged and never returned by a tool.

`FACTORY_BASE_URL` and `FACTORY_CONTEXT_BASE_URL` must be bare `http` or `https` origins, with no path, query, fragment, or credentials. The `rest_*` tools call `FACTORY_BASE_URL`. The `context_*` tools call `FACTORY_CONTEXT_BASE_URL`, the Prem origin that serves the Context API, and fail with `context_base_url_missing` while it is unset. `FACTORY_CONTEXT_HEADERS` is a JSON object of string values sent with every Context request, for example `{"x-factory-organization":"org-..."}`. It may not set `authorization`, `cookie`, `host`, or framing headers such as `content-type`. An invalid value for any of the three stops startup with exit code 2. Context header values are treated as secrets, like the API key.

## Security

- Keep the MCP keys secret. Anyone who has a key can drive Droid on the host.
- The server binds to localhost by default. Do not expose the port without TLS and a required key.
- Requests that carry an `Origin` header are rejected unless you allow that origin explicitly.
- The REST and Context tools redact secrets from results and errors. A minted service-account key value is never returned, and secret values sent to the organization secrets tool are never echoed back.
- `--max-autonomy` bounds local `session_create` and `session_run`, the permission outcomes those sessions offer, and any authority field a generated tool sends explicitly (`autonomyLevel`, `autonomyMode`, `subagentAutonomyLevel`, and `skipPermissionsUnsafe: true`).
- `daemon_initialize_session` and `droid_initialize_session` copy an omitted `autonomyLevel` or `autonomyMode` from one `daemon_get_default_settings` snapshot onto that request. A snapshot value inside the cap is kept. A snapshot value above the cap is sent as the cap. A missing level is sent as `off`, and a missing mode as `normal`. When the cap is below `high`, an omitted `skipPermissionsUnsafe` is sent as `false`. The snapshot is read for that request only; persistent defaults are left unchanged. Initialize has no `subagentAutonomyLevel` field.
- `daemon_load_session` and `droid_load_session` send no saved authority, and work already queued on that session can be running. Use `session_create` and `session_run` when the cap has to bound the work.
- `daemon_initialize_session` copies an omitted `autonomyLevel`, `autonomyMode`, and, when `--max-autonomy` is below `high`, `skipPermissionsUnsafe` from one `daemon_get_default_settings` snapshot onto that request. A lower observed default is kept. A missing field becomes `off`, `normal`, or `false`. The call does not change persistent defaults.
- `daemon_load_session` and `droid_load_session` open a saved session at the authority stored with it. List and message reads do not show that authority, and `daemon_initialize_session` has no `subagentAutonomyLevel` field. Use local `session_create` or `session_run` when the work must stay inside `--max-autonomy`.

## Development

| Command              | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `pnpm start`         | Serve the MCP endpoint on `/mcp`                                   |
| `pnpm run doctor`    | Connect to the daemon, authenticate, and print one JSON object     |
| `pnpm typecheck`     | Run `tsc --noEmit`                                                 |
| `pnpm lint`          | oxlint, with the anti-slop plugin in `tools/oxlint`                |
| `pnpm fmt:check`     | Check formatting with oxfmt                                        |
| `pnpm test`          | Run every test project that needs no model                         |
| `pnpm codegen`       | Regenerate `src/generated/surface.ts` and `src/generated/skill.ts` |
| `pnpm codegen:check` | Fail if a generated file is stale                                  |

Tests split by what they need. The `unit`, `http`, `process`, and `integration` projects run against fakes and a real server process. The `live` project needs a real model and a real daemon and stays off by default.

Codegen uses TypeScript 6's compiler API. TypeScript 7 replaces that API and is
not a drop-in upgrade. Node type definitions stay on the Node 24 runtime baseline.
Optional tool inputs must be omitted when unused; `null` is accepted only where
the schema explicitly allows it, such as clearing an Environment's setup script.

The source layout:

```text
src/
├── main.ts              # doctor | serve
├── config.ts            # flags and env, no Effect
├── http/                # Streamable HTTP and bearer auth
├── droid/               # exec client, turn hub, prompts, daemon, REST and Context
├── tools/               # hand-written tools plus one generated tool per SDK method
├── generated/           # codegen output, do not edit
└── skill/droid/         # the skill markdown, embedded at build time
```

## License

MIT. See [LICENSE](LICENSE).
