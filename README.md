# droid-mcp

droid-mcp is an MCP server that lets an AI assistant drive Factory Droid on your machine. You connect an MCP client to it, and the assistant can start Droid sessions, run turns, answer permission prompts, manage long-running daemon sessions, and reach the hosted Factory API and the Context API through tools.

## What it does

The server provides 287 tools in six families. 158 are generated from the Factory Droid SDK, one per wire method, and 129 are hand-written.

| Prefix     | Count | What the tools cover                                                                                            |
| ---------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `daemon_`  | 130   | Generated. The long-running `droid daemon`: its sessions, automations, worktrees, and MCP servers.              |
| `droid_`   | 28    | Generated. Session-scoped SDK methods that the `session_*` tools do not already own.                            |
| `session_` | 31    | The local turn loop, prompts, and per-session administration.                                                   |
| `rest_`    | 79    | The hosted Factory API: computers, Environments, hosted sessions, wiki, CI, organization, and service accounts. |
| `context_` | 18    | The Context API on a Prem origin: spaces, documents, files, and stored session records.                         |
| `server_`  | 1     | `server_info`.                                                                                                  |

The 79 `rest_*` tools cover the 77 operations of the published Factory OpenAPI document (version 0.1.0) plus the two machine-template operations the SDK still calls.

It also serves a `droid` skill and a `droid` prompt that teach the assistant the turn loop, so you do not have to explain it yourself.

A turn works like this.

1. `session_create` starts a Droid child process for a working directory and an autonomy level. The server rejects any autonomy level above the cap reported by `server_info`.
2. `session_stream` sends the prompt and waits up to `waitMs`, 20 seconds by default and 300 seconds at most.
3. If the turn is still running, call `session_events` with the cursor it returned. The cursor is the last event sequence number you have seen, so events do not repeat. Call it until the status is `completed`, `failed`, or `interrupted`.
4. While the turn runs, prompts such as `pending_permission`, `pending_question`, and `pending_options` appear, each with a deadline. Answer them with the matching tool.
5. `session_close` stops the process. Sessions idle for 30 minutes are closed automatically.

## Requirements

- Node.js 24 or newer. The server runs its TypeScript directly with Node's type stripping, so there is no build step.
- The `droid` CLI on your `PATH`.
- A Factory API key in `FACTORY_API_KEY`. Droid itself needs this key, and so do the `rest_*` and `context_*` tools.
- pnpm, to install dependencies.

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

Then ask the client to read the `droid` prompt or the skill at `skill://droid/SKILL.md`, and call `server_info` first. It reports the version, the tool count, the autonomy cap, and the daemon connection.

If you run the server on another machine, put a TLS proxy in front of it and keep the key required. `docs/hosting.md` has a systemd unit, a keys file layout, and TLS setup for that case.

## Configuration

Each flag also has an environment variable. The defaults work for a local install.

| Flag                 | Environment                 | Default                                             |
| -------------------- | --------------------------- | --------------------------------------------------- |
| `--host`             | `DROID_MCP_HOST`            | `127.0.0.1`                                         |
| `--port`             | `DROID_MCP_PORT`            | `7337`                                              |
| `--keys-file`        | `DROID_MCP_KEYS`            | none, startup fails without a key                   |
| `--max-autonomy`     | `DROID_MCP_MAX_AUTONOMY`    | `medium`                                            |
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
