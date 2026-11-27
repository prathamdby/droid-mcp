# Set up droid-mcp

You are setting up an MCP server that lets a client run Factory Droid in selected local workspaces. Follow these steps in order. Stop at the first blocked step and report what the user needs to do.

## 1. Choose the setup with the user

Ask in one batch before changing the machine:

- Which MCP client will connect, and is it on this machine? Prefer client-managed **stdio** when the local client supports launching a command. Use **HTTP** when the client needs a URL. Ask whether HTTP should run in the foreground or persist as a service. For a remote client, read [Hosting](docs/hosting.md) before changing the network.
- Where should the source live, and which existing directories may Droid work in? Ask for absolute paths. The checkout and the allowed workspaces are separate choices. Admit only the directories the user names.
- Which features are needed: local turns, daemon operations, hosted Factory API, or Prem Context? Does the user have a Factory API key available to the process that will launch the server? Ask for confirmation, not the key. Default to local turns and the `medium` autonomy ceiling. For HTTP, confirm the port (use `7337` unless the user picks another).

Proceed when the transport, launch method, paths, features, and autonomy ceiling are agreed.

## 2. Check the launch environment

Detect the OS and shell. Run `git --version`, `node --version`, `pnpm --version`, and `droid --version` in the environment that will launch the server, not just in your own shell. Install missing prerequisites using the platform's trusted package manager and [Factory's Droid CLI instructions](https://docs.factory.com/droid-cli/quickstart). Use Node 24 or newer and pnpm 12 (the CI baseline). Get approval before installing software, running a downloaded installer, or requesting elevated privileges. Download and inspect installer scripts before running them.

- **Linux and macOS:** Use the foreground or client-managed path below. For a service, use the relevant platform notes in [Hosting](docs/hosting.md).
- **Windows:** Native droid-mcp is not verified. Prefer WSL if the user approves it and the client can launch a command inside WSL or reach the WSL listener. Install prerequisites and run the remaining steps inside WSL, using Linux paths. Verify from the actual client, not just from the WSL shell. If WSL is unavailable and the user needs native Windows, stop and report that setup as unsupported by this guide; installing the native Droid CLI alone does not verify this server.

Reuse a checkout only after confirming it is the intended repository. Otherwise clone `https://github.com/prathamdby/droid-mcp.git` into the approved path. Leave unrelated directories and existing changes untouched. From the checkout run:

```sh
pnpm install --frozen-lockfile
pnpm start --help
```

Proceed when both commands succeed. Use the help output from that checkout to resolve configuration differences. There is no build step.

## 3. Configure credentials and providers

Have the user make `FACTORY_API_KEY` available to the launch process through a client secret store, the service environment, or a private environment file. Keep credentials out of chat, shell history, command arguments, and the checkout. Check presence, not value. A shell export is not inherited by an already-running desktop client or service; configure that launcher directly. Use a separate, randomly generated `DROID_MCP_KEYS` bearer key for HTTP and store it in the client and server secret settings. Stdio uses no bearer key.

Start with `--no-daemon` for local turns only. If daemon operations are needed, omit it. For the default owned daemon on Linux/macOS, create a private, launcher-owned directory and set `DROID_MCP_RUNTIME_DIR` to its absolute path before launching. The daemon uses `daemon.sock` inside it; keep the path short. For an existing daemon, use `--daemon-url` with its approved endpoint instead.

Set `FACTORY_BASE_URL=https://api.factory.ai` only when the hosted Factory API is wanted (or use the user's approved Factory origin). Set `FACTORY_CONTEXT_BASE_URL` only for Prem Context. Both must be bare origins; use HTTPS for any nonlocal origin. Providers without a configured origin are omitted. When the Prem deployment requires extra headers, set `FACTORY_CONTEXT_HEADERS` to one JSON object of string values, such as `{"x-factory-organization":"org-..."}`. Do not wrap that JSON in extra quotes. It must not set `authorization`, `cookie`, `host`, `accept`, or framing headers such as `content-type`. Invalid JSON, non-string values, duplicate header names under different cases, and prohibited headers stop startup with exit code 2. Header values are treated as secrets; neither values nor offending header names are echoed in client responses or diagnostics. If one appears inside a protocol identifier, cursor, counter, document path or non-string JSON scalar, that reply is refused instead of corrupted; very short or tenant-like values can therefore make list pages and path reads undeliverable. Oversized upstream error details are omitted whole rather than clipped. When a write reply collides, the write may already have committed and the call reports `delivery_uncertain`; when a conflict continuation collides, the continuation fields are stripped and the conflict message becomes opaque.

Proceed when the launcher can read the required credentials and each requested provider has a supported configuration.

## 4. Launch and connect

Use the named client's configuration format, not a generic JSON snippet. Replace paths and ports before running these examples. Repeat `--workspace-root` for each approved workspace. If the launcher cannot resolve `droid` on its own `PATH`, set `--droid-path` to the absolute executable path.

### Client-managed stdio

Configure the client to launch the absolute Node executable with these arguments, each passed separately:

```sh
node --experimental-strip-types "/absolute/path/to/droid-mcp/src/products/private/cli.ts" serve --no-daemon --max-autonomy medium --workspace-root "/absolute/path/to/project"
```

If using a private Node-compatible env file, insert `--env-file=/absolute/private/env` before the script path. Let the client own the process. Use Node rather than the package script here so stdout contains only MCP frames.

### HTTP

From the checkout and with the credentials already loaded, run:

```sh
pnpm start --http --host 127.0.0.1 --port 7337 --no-daemon --max-autonomy medium --workspace-root "/absolute/path/to/project"
```

Expect `listening on http://127.0.0.1:7337/mcp`. Configure the client to send `Authorization: Bearer <MCP key>` to that URL. Keep the listener on loopback. Use [Hosting](docs/hosting.md) for persistence or a TLS proxy. The HTTP carrier uses POST requests with JSON replies; it does not provide a GET event stream or a cross-origin allowlist. If the client's required transport is incompatible, switch to supported stdio if available or report the incompatibility.

To load a private Node-compatible env file instead of inheriting the shell environment, use the direct Node command from the stdio section with `--env-file` and the HTTP flags above.

## 5. Verify and hand off

1. **HTTP only:** POST `{}` without a bearer key to the actual endpoint and expect `401`. For the default endpoint: `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:7337/mcp`. This checks the auth boundary, not client login. `pnpm run doctor --http --port 7337` checks reachability and reports the response status; exit 0 alone is not an authentication check.
2. **Actual client:** Connect and call `server_info`. Check the selected profile, autonomy ceiling, and provider list against the choices above. Operation counts vary with installed providers; neither a count nor provider presence proves it can do work.
3. **Work in the selected project:** Call `skill_read`, then `session_create` with the chosen workspace as `cwd` and `autonomyLevel: "off"`. Use `session_stream` to ask Droid to reply `READY` without using tools or changing files. If the turn is running, continue with `session_events` using the returned cursor. Require a completed reply, then call `session_close`. For a requested daemon or network provider, also run an authorized, non-mutating operation discovered via `tools_search`; report provider failures separately. Daemon `doctor` only probes an existing daemon and does not spawn one.
4. **Handoff:** Report the checkout, admitted workspaces, transport, endpoint if any, how to start/stop and read logs, and which checks passed or were blocked. Report only redacted diagnostics. For upgrades, update the checkout with the user's approval, rerun the frozen install, restart the launcher, and repeat verification. Remove service definitions, checkout files, and stored credentials only with approval.
