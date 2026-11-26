# Host droid-mcp over HTTP

Complete [setup](../SETUP.md) through a successful foreground HTTP check before installing a service or proxy. This guide covers Linux with systemd and gives launch configuration notes for macOS. It does not provide a native Windows service recipe.

## Launch configuration

Keep the listener on `127.0.0.1`. Run as a non-root account that can read the checkout and has the intended access to each allowed workspace. Use the same options that passed foreground verification. Supply `DROID_MCP_KEYS` and `FACTORY_API_KEY` through the service environment or a private environment file readable by the service account (mode `0600`, in a private directory). Add provider origins only as needed. Keep secrets out of the service definition and diagnostics. Use absolute executable and checkout paths; service managers do not inherit your interactive shell's `PATH`.

### Linux systemd

For a user service, save `~/.config/systemd/user/droid-mcp.service`. Substitute absolute paths (below, `/home/alex` is illustrative). For a system service, use `/etc/systemd/system/droid-mcp.service`, add `User=` and `Group=` for the chosen unprivileged account, and change `WantedBy=` to `multi-user.target`. Get approval before installing a system unit.

```ini
[Unit]
Description=droid-mcp

[Service]
WorkingDirectory=/home/alex/droid-mcp
EnvironmentFile=/home/alex/.config/droid-mcp/env
ExecStart=/usr/bin/node --experimental-strip-types /home/alex/droid-mcp/src/products/private/cli.ts serve --http --host 127.0.0.1 --port 7337 --no-daemon --droid-path /home/alex/.local/bin/droid --workspace-root /home/alex/project
Restart=on-failure

[Install]
WantedBy=default.target
```

For paths containing spaces, quote the corresponding unit values or arguments. To install the user service, run `systemctl --user daemon-reload` and `systemctl --user enable --now droid-mcp`. Check `systemctl --user status droid-mcp` and `journalctl --user -u droid-mcp`. Use `systemctl --user disable --now droid-mcp` to stop and disable it. A user service normally starts with the user manager; enable lingering only if the user explicitly requests start before login. For a system service, use the system manager (drop `--user` and obtain permission for privileged commands).

### macOS launchd

Use a LaunchAgent if the server should start at login. In `~/Library/LaunchAgents`, set `ProgramArguments` to the absolute Node executable followed by each argument from the Linux `ExecStart` as a separate array element, substituting macOS paths. Set `WorkingDirectory` to the checkout, `RunAtLoad` to true, and use absolute, user-owned `StandardOutPath` and `StandardErrorPath`. To supply secrets without putting them in the plist, put Node's `--env-file=/absolute/private/env` argument before the script path. Use a Node-compatible env file, not shell code. Validate with `plutil -lint` before loading with `launchctl bootstrap "gui/$(id -u)" <plist>`. Check the job with `launchctl print` in that same domain and stop it with `launchctl bootout`. A system LaunchDaemon starts before login; use an explicitly approved non-root service account and administrator-managed paths. If you cannot validate that configuration, keep the foreground or login setup.

If using an owned daemon, remove `--no-daemon` and set `DROID_MCP_RUNTIME_DIR` to a short private directory that exists when the service starts. Repeat the full verification after starting through the service manager, including the test turn in the chosen workspace.

## Remote client

Keep the MCP listener private. Ask the user to approve the proxy hostname, TLS configuration, and network exposure before provisioning them. For example, use an existing Caddy host with working DNS and certificate provisioning:

```caddyfile
droid.example.com {
    reverse_proxy /mcp 127.0.0.1:7337
}
```

Use `https://droid.example.com/mcp` in the remote client with the same bearer header. Preserve the header through the proxy, and avoid logging it. Do not expose port `7337` directly. The proxy does not add support for browser CORS or GET-based streaming. Verify from the remote client: unauthenticated POST returns `401`, authenticated MCP calls succeed, and a turn in the selected workspace completes.
