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

`FACTORY_API_KEY` goes in the environment file, not the keys file.

```sh
sudo -u droid sh -c 'umask 077; printf "FACTORY_API_KEY=%s\n" "fk-..." > /etc/droid-mcp/env'
```

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
arguments, or the API key.

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
