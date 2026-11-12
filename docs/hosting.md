# Hosting droid-mcp

This is the short version of running the server on a machine you keep: a
dedicated user, a keys file, a systemd unit, TLS in front, and one client entry.

## 1. Install

Node 24 is required; the sources run through Node's type stripping, so there is
no build step.

```sh
sudo useradd --create-home --shell /usr/sbin/nologin droid
sudo -u droid git clone <this repository> /home/droid/droid-mcp
sudo -u droid sh -c 'cd /home/droid/droid-mcp && pnpm install --frozen-lockfile'
```

The `droid` CLI must be on the service user's `PATH`; install it as that user and
check it:

```sh
sudo -u droid droid --version
```

Release surface checked on 2026-11-13: Droid CLI `1.9.0`, SDK `0.10.0`, and SDK
protocol `1.269.0`. The inventory remains 288 operations, advertised as 15 tools
in the default compact profile or 288 in the full profile.

Create the runtime directory the daemon socket lives in:

```sh
sudo install -d -o droid -g droid /var/lib/droid-mcp /run/droid-mcp
sudo -u droid sh -c 'echo "export XDG_RUNTIME_DIR=/run/droid-mcp" >> ~/.profile'
```

## 2. Keys

One key per line, no comments left unmarked:

```sh
sudo install -d -m 700 -o droid -g droid /etc/droid-mcp
sudo -u droid sh -c 'umask 077; openssl rand -hex 32 > /etc/droid-mcp/keys'
```

Use `--keys-file /etc/droid-mcp/keys`. The server refuses to start with no keys:
there is no unauthenticated mode.

`FACTORY_API_KEY` and the Factory origins go in the environment file, not the keys
file. The file holds secrets, so keep it readable by the service user only:

```sh
sudo -u droid sh -c 'umask 077; cat > /etc/droid-mcp/env' <<'EOF'
FACTORY_API_KEY=fk-...
FACTORY_BASE_URL=https://api.factory.ai
FACTORY_CONTEXT_BASE_URL=https://prem.example.com
FACTORY_CONTEXT_HEADERS={"x-factory-organization":"org-..."}
EOF
```

- `FACTORY_BASE_URL` is the hosted Factory API the `rest_*` tools call. It
  defaults to `https://api.factory.ai`, so leave it out unless you use another
  deployment.
- `FACTORY_CONTEXT_BASE_URL` is the Prem origin that serves the Context API.
  Without it the `context_*` tools fail with `context_base_url_missing` and
  everything else still works.
- `FACTORY_CONTEXT_HEADERS` is a JSON object of string values sent with every
  Context request. Use it for the organization header your Prem deployment
  expects; the header name is deployment-specific. It may not set
  `authorization`, `cookie`, `host`, or framing headers. Write the JSON on one
  line and do not wrap it in quotes.

Both base URLs must be bare origins: a scheme, a host, and an optional port,
with no path, query, fragment, or credentials. Use `https://` for anything that
leaves the machine, because every request carries `FACTORY_API_KEY` as a bearer
token and Context requests also carry the configured header values. Plain
`http://` is only for a local test server. An invalid value stops the service
at startup with exit code 2 and a `config_invalid` line in the journal that
names the variable but not its value.

## 3. Service

`/etc/systemd/system/droid-mcp.service`:

```ini
[Unit]
Description=droid-mcp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=droid
Group=droid
WorkingDirectory=/home/droid/droid-mcp
Environment=XDG_RUNTIME_DIR=/run/droid-mcp
EnvironmentFile=/etc/droid-mcp/env
ExecStart=/usr/bin/env node --experimental-strip-types src/main.ts serve \
  --host 127.0.0.1 \
  --port 7337 \
  --keys-file /etc/droid-mcp/keys \
  --max-autonomy medium \
  --log-level info
Restart=on-failure
RestartSec=2
RuntimeDirectory=droid-mcp
RuntimeDirectoryMode=0700

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now droid-mcp
journalctl -u droid-mcp -f
```

The server logs one JSON object per event to stderr. It never logs prompts, tool
arguments, the API key, or Context header values.

## 4. TLS

The server speaks plain HTTP and expects a proxy to terminate TLS. Caddy is the
shortest path:

```caddyfile
droid.example.com {
    reverse_proxy 127.0.0.1:7337
}
```

nginx needs the streaming parts spelled out, because MCP responses can be
`text/event-stream`:

```nginx
server {
    listen 443 ssl http2;
    server_name droid.example.com;

    ssl_certificate     /etc/letsencrypt/live/droid.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/droid.example.com/privkey.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:7337;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

If a browser-based client sends an `Origin`, list it with `--allow-origin` or the
request is rejected with `403`. Command-line and desktop clients send no
`Origin`, which is why the default (none) works.

## 5. Client

```json
{
  "mcpServers": {
    "droid": {
      "type": "http",
      "url": "https://droid.example.com/mcp",
      "headers": { "Authorization": "Bearer <key from /etc/droid-mcp/keys>" }
    }
  }
}
```

On the first request the client reads `initialize.instructions`, which names the
turn-loop tools and points at `skill://droid/SKILL.md`.

## 6. Verify

```sh
# The daemon, auth, and the session count, as one JSON object.
sudo -u droid env FACTORY_API_KEY=... node --experimental-strip-types src/main.ts doctor

# A key that is not on the list gets 401.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://droid.example.com/mcp \
  -H 'content-type: application/json' -d '{}'
```

Then ask the client for `server_info`: it reports the version, the tool count,
the autonomy cap, and whether the daemon is connected.

## Autonomy

`--max-autonomy` is the cap `session_create` enforces. `medium` is the default and
is what most unattended setups want: the agent can edit files and run tests, and
asks before the rest. Raise it to `high` only where the machine is disposable.

## Upgrades

```sh
sudo -u droid sh -c 'cd /home/droid/droid-mcp && git pull && pnpm install --frozen-lockfile'
sudo systemctl restart droid-mcp
```

`pnpm codegen:check` fails when the installed SDK changed shape and the generated
surface is stale, so run it after any `@factory/droid-sdk` bump.
Check `droid --version` against the [Factory changelog](https://docs.factory.com/changelog/release-notes)
too. A CLI release number is not a wire protocol version; the daemon client
adopts the version reported by its peer.
