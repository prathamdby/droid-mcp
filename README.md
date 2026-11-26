# droid-mcp

droid-mcp is an MCP server that lets an AI assistant drive Factory Droid on your machine. You connect an MCP client to it, and the assistant can start Droid sessions, run turns, answer permission prompts, manage long-running daemon sessions, and reach the hosted Factory API and the Context API through tools.

## Getting Started

Paste this into your coding agent:

```text
Read https://raw.githubusercontent.com/prathamdby/droid-mcp/main/SETUP.md and follow it to set up droid-mcp on this machine. Ask me the questions it lists first.
```

## What it does

The server exposes operations in seven families. The available operations depend on the installed providers.

| Prefix     | What the tools cover                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `daemon_`  | The long-running `droid daemon`: sessions, automations, worktrees, and MCP servers.                                      |
| `droid_`   | Session-scoped SDK methods served by the daemon.                                                                         |
| `session_` | The local turn loop, prompts, and per-session administration.                                                            |
| `rest_`    | The hosted Factory API: computers, Environments, hosted sessions, wiki, CI, billing, organization, and service accounts. |
| `context_` | The Context API on a Prem origin: spaces, documents, files, and stored session records.                                  |
| `server_`  | `server_info`.                                                                                                           |
| `skill_`   | `skill_read`.                                                                                                            |

Call `server_info` for the active installation's operation counts, including counts by family.

### Tool profiles

By default the server runs the `compact` profile. `tools/list` advertises 16 tools:

- The turn loop as first-class tools: `server_info`, `skill_read`, `session_create`, `session_stream`, `session_events`, `session_interrupt`, `session_close`, `session_list`, and the three prompt answers.
- `tools_search` finds installed operations by keyword, family, or read-only hint, and `tools_describe` returns the full description and input schema of up to 20 of them.
- `tool_call` runs one operation by name with its arguments. It uses the same handler, validation, autonomy cap, and `{ code, message }` failures as the operation's own tool in the full profile.
- `batch` runs up to 20 operations in order in one call. An argument `{ "$from": "<step id>", "path": "/json/pointer" }` takes part of an earlier step's result, so intermediate results never return to the client.
- A result larger than `maxBytes` (16 KB by default) returns a preview and a `ref`. `result_read` reads the stored result by byte range or by JSON Pointer, so no data is lost. Refs expire 15 minutes after their last use and only the key that created a ref can read it.

If `select` fails after an operation completes, `tool_call` or the batch step returns `invalid_select` with a `ref` to its full result. Read that ref instead of repeating the operation. Byte offsets for `result_read` must fall on UTF-8 character boundaries; use `nextOffset` to page, or expect `invalid_offset` for an offset inside a character.

`--profile full` advertises one tool per installed operation. Tools carry MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) to help the client decide when to confirm an action.

`node --experimental-strip-types scripts/measure.ts` prints the `initialize` and `tools/list` sizes for both profiles.

It also serves a `droid` skill and a `droid` prompt that teach the assistant the turn loop, so you do not have to explain it yourself.

A turn works like this.

1. `session_create` starts a Droid child process for a working directory and an autonomy level. The server rejects any autonomy level above the cap reported by `server_info`. Set `worktree: true` to run in a new git worktree. Ephemeral worktrees are removed on close. `worktreeLifecycle: "persistent"` keeps the checkout.
2. `session_stream` sends the prompt. Omit `delivery` to wait up to `waitMs` (20 seconds by default, 300 seconds at most) and receive events. `delivery: "detach"` returns at once with a `droid://sessions/{id}` URI and no event dump. `delivery: "block"` holds the call until the turn ends, a prompt the client cannot answer, or 5 minutes. On the 2025 protocol revisions, a client that advertises elicitation gets that prompt as a form. A 2026-07-28 client gets the pending prompt in the result and answers with the session tools, because that revision does not allow the server to start a request.
3. If the turn is still running, read the session resource or call `session_events` with the cursor it returned. The cursor is the next sequence number, one past the last event, so pass it back unchanged and events do not repeat. A client that opens `subscriptions/listen` for that URI is notified when it changes. Call until the status is `completed`, `failed`, or `interrupted`. A `running` result keeps the session; close it when you are done. `session_run` closes the session itself unless it returns `running`, in which case poll, answer prompts, and then `session_close`.
4. While the turn runs, prompts such as `pending_permission`, `pending_question`, and `pending_options` appear, each with a deadline. Answer them with the matching tool, unless the client already answered a form.
5. `session_close` stops the process. Sessions idle for 30 minutes are closed automatically.

## Requirements

- Node.js 24 or newer. The server runs its TypeScript directly with Node's type stripping, so there is no build step.
- The `droid` CLI on your `PATH`.
- A Factory API key in `FACTORY_API_KEY`. Droid itself needs this key, and so do the `rest_*` and `context_*` tools.
- pnpm, to install dependencies.

### Droid compatibility

Release surface checked on 2026-11-13: [Droid CLI 1.9.0](https://www.npmjs.com/package/@factory/cli)
and [Droid SDK 0.10.0](https://www.npmjs.com/package/@factory/droid-sdk) are current.
The SDK declares 165 wire methods and protocol `1.269.0`.
CLI versions and wire protocol versions are separate.
The daemon client adopts the peer's protocol version and retries once on a mismatch.
`droid_list_skills`, `droid_list_tools`, `droid_list_mcp_tools`, and
`droid_list_mcp_registry` are not advertised. `tool_call` and `batch` return `unknown_tool`
with supported replacements: `session_list_skills` or `daemon_list_skills`,
`session_list_tools`, `session_list_mcp_tools` or `daemon_list_mcp_tools`, and
`daemon_list_mcp_registry`, respectively. These replacements require a session id.
`tools_describe` lists removed names in `unknown` without discarding valid descriptions.
Other methods rejected as unimplemented return `daemon_method_unsupported` with
the method and peer protocol version. Transport failures retain their codes;
malformed replies and schema failures remain `daemon_protocol_error`.
See the [Factory changelog](https://docs.factory.com/changelog/release-notes).

## Set it up

Follow [the setup guide](SETUP.md) for prerequisites, credentials, workspace selection, and verification. `pnpm start` defaults to stdio. Use `pnpm start --http --port 7337` for a loopback HTTP endpoint, with a bearer key supplied through `DROID_MCP_KEYS`. See [Hosting](docs/hosting.md) for services and TLS.

## Connect a client

For an HTTP client that accepts this configuration format:

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

Call `server_info` to confirm the tool profile, installed providers, and autonomy ceiling. Call `skill_read` before starting a session. The setup guide describes how to verify the client can complete a turn.

If you run the server on another machine, put a TLS proxy in front of it and keep the key required. See [Hosting](docs/hosting.md).

## Configuration

Run `pnpm start --help` for the flags and environment variables supported by your checkout. HTTP defaults to an ephemeral port if you omit `--port`. Repeat `--workspace-root` for each approved workspace; when omitted, only the launch directory is admitted. See [the setup guide](SETUP.md#3-configure-credentials-and-providers) for provider configuration.

## Security

- Keep the MCP keys secret. Anyone who has a key can drive Droid on the host.
- The server binds to localhost by default. Do not expose the port without TLS and a required key.
- HTTP rejects requests from an `Origin` other than the listener's own origin. There is no CLI origin allowlist.
- The REST and Context tools redact secrets from results and errors. A minted service-account key value is never returned, and secret values sent to the organization secrets tool are never echoed back.
- `--max-autonomy` bounds local `session_create` and `session_run`, the permission outcomes those sessions offer, and any authority field a generated tool sends explicitly (`autonomyLevel`, `autonomyMode`, `subagentAutonomyLevel`, and `skipPermissionsUnsafe: true`).
- `daemon_initialize_session` and `droid_initialize_session` copy an omitted `autonomyLevel` or `autonomyMode` from one `daemon_get_default_settings` snapshot onto that request. A snapshot value inside the cap is kept. A snapshot value above the cap is sent as the cap. A missing level is sent as `off`, and a missing mode as `normal`. When the cap is below `high`, an omitted `skipPermissionsUnsafe` is sent as `false`. The snapshot is read for that request only; persistent defaults are left unchanged. Initialize has no `subagentAutonomyLevel` field.
- `daemon_load_session` and `droid_load_session` send no saved authority, and work already queued on that session can be running. Use `session_create` and `session_run` when the cap has to bound the work.
- `daemon_initialize_session` copies an omitted `autonomyLevel`, `autonomyMode`, and, when `--max-autonomy` is below `high`, `skipPermissionsUnsafe` from one `daemon_get_default_settings` snapshot onto that request. A lower observed default is kept. A missing field becomes `off`, `normal`, or `false`. The call does not change persistent defaults.
- `daemon_load_session` and `droid_load_session` open a saved session at the authority stored with it. List and message reads do not show that authority, and `daemon_initialize_session` has no `subagentAutonomyLevel` field. Use local `session_create` or `session_run` when the work must stay inside `--max-autonomy`.

## Development

| Command              | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| `pnpm start`         | Serve MCP over stdio; add `--http` for `/mcp`                    |
| `pnpm run doctor`    | Probe an existing daemon; add `--http` to probe an HTTP listener |
| `pnpm typecheck`     | Run `tsc --noEmit`                                               |
| `pnpm lint`          | oxlint, with the anti-slop plugin in `tools/oxlint`              |
| `pnpm fmt:check`     | Check formatting with oxfmt                                      |
| `pnpm test`          | Run every test project that needs no model                       |
| `pnpm codegen`       | Regenerate the pinned Factory SDK codecs                         |
| `pnpm codegen:check` | Fail if a generated file is stale                                |

The `unit` and `proofs` test projects do not need a live model.

Codegen uses TypeScript 6's compiler API. TypeScript 7 replaces that API and is
not a drop-in upgrade. Node type definitions stay on the Node 24 runtime baseline.
Optional tool inputs must be omitted when unused; `null` is accepted only where
the schema explicitly allows it, such as clearing an Environment's setup script.

The [CLI entry point](src/products/private/cli.ts) lives in [`src/products/`](src/products/), alongside configuration, product assembly, and the HTTP and stdio transports. [`src/mcp/`](src/mcp/) owns the MCP protocol, [`src/presentation/`](src/presentation/) owns tool profiles and dispatch, and [`src/guidance/`](src/guidance/) owns the embedded skill. The generated SDK codecs live in [`src/factory-dialect/`](src/factory-dialect/). See [the module roster](AGENTS.md#module-roster-and-hidden-secrets) for the rest of the source tree.

## License

MIT. See [LICENSE](LICENSE).
