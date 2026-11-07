# Set up droid-mcp

You are setting up droid-mcp for the user. It is an MCP server that lets an MCP client drive Factory Droid on this machine. The default endpoint is `http://127.0.0.1:7337/mcp`. The server exits with code 2 when no bearer key is set. It has no unauthenticated mode.
Do the sections in order. Ask the questions below before you install software, clone a repository, or write a file.

## Ask the user first

Ask this batch in one message. Wait for the answers. Offer the defaults in the questions. Do not change the machine until the user answers. Call their choices `<host>`, `<port>`, and `<autonomy>`, and use the defaults when they accept them.

1. Where should the source live? The user can use the current directory, an existing clone at an absolute path they name, or a new clone at an absolute path they name. Ask for that path and call it `<install-path>`. If no clone is there, you clone `https://github.com/prathamdby/droid-mcp.git` into it. Do not assume a clone is already on disk.
2. Should the server run once in the foreground, or as a service that starts again after a reboot? For a service, ask whether it is system-wide or per user, and confirm Linux or macOS.
3. Which host and port should the server bind? The default host is `127.0.0.1` and the default port is `7337`. The endpoint is `http://<host>:<port>/mcp`. Ask whether the MCP client is on this machine. A remote client needs a TLS reverse proxy in front of the localhost server. Follow `docs/hosting.md`. Do not publish the port to make the client connect.
4. What autonomy cap should the server enforce? The default is `medium`. At `medium` a session may edit files and run tests, and it asks before other actions. Use `high` only on a machine the user can discard.
5. Does the user have a Factory API key for `FACTORY_API_KEY`? Do they use a Prem Context origin, which needs `FACTORY_CONTEXT_BASE_URL` and sometimes `FACTORY_CONTEXT_HEADERS`? Never print the API key, repeat it in chat, or write it into this document.
6. Which MCP client will connect? Use the answer so the client config matches that client.

## Check this machine

Detect the operating system, the shell, and the package manager. Then check `git`, Node.js, `pnpm`, `droid`, and `openssl`. A missing command is not installed yet. Node.js must be version 24 or newer. Ask before any `sudo` command.

```sh
uname -s
printf '%s\n' "$SHELL"
command -v apt-get || command -v dnf || command -v pacman || command -v brew || true
git --version
node --version
pnpm --version
droid --version
openssl version
node -p "Number(process.versions.node.split('.')[0])"
```

## Install missing programs

Run only the group for the package manager you found. Skip the `nodesource` lines and any `nodejs` or `node@24` package when `node --version` is already 24 or newer. If it is still older, stop and show that version. The service runs `/usr/bin/env node`, so Node must be on the default `PATH`. Enable pnpm below, and use npm only when `pnpm` is still missing. The installer scripts below are downloaded to a file first. Show that file to the user and get approval before you run it. Do not pipe a remote script into a shell.

```sh
# Debian or Ubuntu
sudo apt-get update
sudo apt-get install -y git curl ca-certificates openssl xdg-utils
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.sh
# Show /tmp/nodesource-setup.sh, get approval, then run it.
sudo -E bash /tmp/nodesource-setup.sh
sudo apt-get install -y nodejs
# Fedora or RHEL
sudo dnf install -y git curl ca-certificates openssl xdg-utils
curl -fsSL https://rpm.nodesource.com/setup_24.x -o /tmp/nodesource-setup.sh
# Show /tmp/nodesource-setup.sh, get approval, then run it.
sudo bash /tmp/nodesource-setup.sh
sudo dnf install -y nodejs
# Arch
sudo pacman -S --needed git curl ca-certificates openssl xdg-utils nodejs npm
# macOS with Homebrew. Install openssl only when `openssl version` fails.
brew install git curl node@24
brew link --overwrite --force node@24
```

```sh
corepack enable
command -v pnpm >/dev/null || npm install -g pnpm
pnpm --version
```

Install `droid` with Factory's installer. The Linux groups above include `xdg-utils`, which that CLI needs on Linux. The binary is `$HOME/.local/bin/droid`. Add the `PATH` line the installer prints to the shell rc file. Use one install. Homebrew is `brew install --cask droid`. npm is `npm install -g droid`.

```sh
curl -fsSL https://app.factory.ai/cli -o /tmp/factory-cli.sh
# Show /tmp/factory-cli.sh, get approval, then run it.
sh /tmp/factory-cli.sh
export PATH="$HOME/.local/bin:$PATH"
droid --version
```

## Get the source

If the user chose the current directory, set `<install-path>` to the output of `pwd`. For a system-wide service, create the account before the clone, and prefer `/home/droid/droid-mcp` when the user accepts it.

```sh
sudo useradd --create-home --shell /usr/sbin/nologin droid
sudo curl -fsSL https://app.factory.ai/cli -o /tmp/factory-cli.sh
sudo chmod 644 /tmp/factory-cli.sh
# Show /tmp/factory-cli.sh, get approval, then run it as the service user.
sudo -H -u droid sh /tmp/factory-cli.sh
sudo -H -u droid sh -c 'export PATH="$HOME/.local/bin:$PATH"; droid --version'
sudo -u droid git clone https://github.com/prathamdby/droid-mcp.git /home/droid/droid-mcp
```

Otherwise clone only when `<install-path>` does not exist. If it exists, the `node` command must print `droid-mcp`. If it does not, stop and ask. Do not delete the directory.

```sh
git clone https://github.com/prathamdby/droid-mcp.git <install-path>
git -C <install-path> rev-parse --is-inside-work-tree
node -e "process.stdout.write(require(process.argv[1]).name + '\n')" <install-path>/package.json
```

## Install project dependencies

There is no build step. Node runs the TypeScript with type stripping. Run the commented system line only for a system service. That user must be able to read the directory.

```sh
cd <install-path>
pnpm install --frozen-lockfile
# System service only. Replace the path when it is not /home/droid/droid-mcp.
sudo -u droid sh -c 'cd /home/droid/droid-mcp && pnpm install --frozen-lockfile'
```

## Store the keys

The bearer key authenticates the MCP client. `FACTORY_API_KEY` authenticates Factory. If the bearer key is lost, generate a new one and update the MCP client. Foreground and per-user services use `$HOME/.config/droid-mcp`. A system service uses `/etc/droid-mcp`. Mode `600` comes from `umask 077`. Do not print the files.

```sh
install -d -m 700 "$HOME/.config/droid-mcp"
umask 077
openssl rand -hex 32 > "$HOME/.config/droid-mcp/keys"
chmod 600 "$HOME/.config/droid-mcp/keys"
# System service only.
sudo install -d -m 700 -o droid -g droid /etc/droid-mcp
sudo -u droid sh -c 'umask 077; openssl rand -hex 32 > /etc/droid-mcp/keys'
sudo chmod 600 /etc/droid-mcp/keys
sudo chown droid:droid /etc/droid-mcp/keys
```

`read -s` does not echo and does not store the line in shell history. Do not pass the API key as an argument, and do not `echo` or `cat` the env file.

```sh
read -r -s FACTORY_API_KEY
printf '\n'
umask 077
printf 'FACTORY_API_KEY=%s\n' "$FACTORY_API_KEY" > "$HOME/.config/droid-mcp/env"
chmod 600 "$HOME/.config/droid-mcp/env"
unset FACTORY_API_KEY
```

For a system service, move that file so only one copy remains. Ask before the delete.

```sh
sudo cp "$HOME/.config/droid-mcp/env" /etc/droid-mcp/env
sudo chown droid:droid /etc/droid-mcp/env
sudo chmod 600 /etc/droid-mcp/env
rm -f "$HOME/.config/droid-mcp/env"
```

Add optional lines to the same env file only when the user needs them. Leave `FACTORY_BASE_URL` unset unless their API is not the default `https://api.factory.ai`. Set `FACTORY_CONTEXT_BASE_URL` to the Prem origin. Without it, `context_*` tools fail with `context_base_url_missing`, and other tools still work. `FACTORY_CONTEXT_HEADERS` is one JSON object of string values, for example `{"x-factory-organization":"org-..."}`. Do not wrap that JSON in extra quotes. It must not set `authorization`, `cookie`, `host`, or a framing header such as `content-type`.
Each base URL is a bare origin, with a scheme, a host, and an optional port, and with no path, query, fragment, or credentials. Use `https` when the request leaves the machine, because each request sends `FACTORY_API_KEY` as a bearer token. Use plain `http` only for a local test server. An invalid value makes the process exit 2. The log names the variable and does not print the value. Treat Context header values as secrets. If you cannot open an editor for those lines, ask the user to save the file and tell you when it exists. Do not ask them to paste secrets into chat.

## Prepare the runtime directory

The daemon writes its socket to `$XDG_RUNTIME_DIR/droid-mcp/daemon.sock`. Nothing creates that directory, and the daemon fails with `ENOENT` when it is missing. Create it before you start the server. When `XDG_RUNTIME_DIR` is unset, which is normal on macOS, the server falls back to `/tmp/droid-mcp`. The system service uses `/run/droid-mcp`, which its install step creates.

```sh
mkdir -p "${XDG_RUNTIME_DIR:-/tmp}/droid-mcp"
```

## Run once in the foreground

Load the env file in the shell that starts the server. Substitute `<host>`, `<port>`, and `<autonomy>`. The `cat` below does not print the bearer key.

```sh
cd <install-path>
set -a
. "$HOME/.config/droid-mcp/env"
set +a
export DROID_MCP_KEYS="$(cat "$HOME/.config/droid-mcp/keys")"
export DROID_MCP_HOST="<host>"
export DROID_MCP_PORT="<port>"
export DROID_MCP_MAX_AUTONOMY="<autonomy>"
export DROID_MCP_LOG_LEVEL=info
pnpm start
```

`pnpm start` runs `node --experimental-strip-types src/main.ts serve`. Leave that terminal open. Stderr is one JSON object per line. A healthy start includes `serve.starting` with the chosen host and port and with `keys` at least 1.

```json
{
  "ts": "2026-01-01T00:00:00.000Z",
  "level": "info",
  "event": "serve.starting",
  "host": "127.0.0.1",
  "port": 7337,
  "keys": 1
}
```

Wait until the verify request prints `401`. A `503` body of `{"error":"starting"}` means the process is still starting. Connection refused means it is not listening. Stop it with Ctrl+C. If stderr contains `serve.keys_missing`, the process exits 2. Fix the key file and start again. Do not start with an empty key.

## Install a persistent service

Use `--host`, `--port`, `--keys-file`, `--max-autonomy`, and `--log-level` only. The units use the defaults from `docs/hosting.md`. Change those values when the user did not accept the defaults. Do not invent other flags.

### Linux system service

Create the runtime directory from `docs/hosting.md`, then write `/etc/systemd/system/droid-mcp.service`. The `PATH` line is required because the installer puts `droid` in `/home/droid/.local/bin`. Set `WorkingDirectory` to `<install-path>` when that is not `/home/droid/droid-mcp`.

```sh
sudo install -d -o droid -g droid /var/lib/droid-mcp /run/droid-mcp
sudo -u droid sh -c 'echo "export XDG_RUNTIME_DIR=/run/droid-mcp" >> ~/.profile'
```

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
Environment=PATH=/home/droid/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/etc/droid-mcp/env
ExecStart=/usr/bin/env node --experimental-strip-types src/main.ts serve --host 127.0.0.1 --port 7337 --keys-file /etc/droid-mcp/keys --max-autonomy medium --log-level info
Restart=on-failure
RestartSec=2
RuntimeDirectory=droid-mcp
RuntimeDirectoryMode=0700
[Install]
WantedBy=multi-user.target
```

`disable --now` stops the service and removes it from boot. To uninstall, disable it, delete the unit file, and run `daemon-reload` again. Ask before you delete `/etc/droid-mcp`, the clone, or the `droid` user.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now droid-mcp
sudo systemctl status droid-mcp
journalctl -u droid-mcp -f
sudo systemctl restart droid-mcp
sudo systemctl stop droid-mcp
sudo systemctl disable --now droid-mcp
```

### Linux user service

Write `$HOME/.config/systemd/user/droid-mcp.service`. `%h` is the home directory. Do not set `XDG_RUNTIME_DIR` to `/run/droid-mcp` here. The user manager already sets it. Substitute `<install-path>` before you save the file.

```ini
[Unit]
Description=droid-mcp
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=<install-path>
Environment=PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=%h/.config/droid-mcp/env
ExecStart=/usr/bin/env node --experimental-strip-types src/main.ts serve --host 127.0.0.1 --port 7337 --keys-file %h/.config/droid-mcp/keys --max-autonomy medium --log-level info
Restart=on-failure
RestartSec=2
[Install]
WantedBy=default.target
```

A user service does not start at boot until lingering is on. Ask, then run `sudo loginctl enable-linger "$USER"`. Uninstall with `disable --now`, delete the unit, and run `daemon-reload` again.

```sh
systemctl --user daemon-reload
systemctl --user enable --now droid-mcp
systemctl --user status droid-mcp
journalctl --user -u droid-mcp -f
systemctl --user restart droid-mcp
systemctl --user stop droid-mcp
systemctl --user disable --now droid-mcp
```

### macOS launchd service

A per-user agent is `~/Library/LaunchAgents/com.droid-mcp.plist`. A system daemon is `/Library/LaunchDaemons/com.droid-mcp.plist`. The two need different scripts, because a daemon runs as root and must never execute a file the service account can rewrite.

#### Per-user agent

Write `$HOME/.config/droid-mcp/run.sh`, run `chmod 700` on it, and put the real install path in it. Logs are `$HOME/Library/Logs/droid-mcp.out.log` and `$HOME/Library/Logs/droid-mcp.err.log`.

```sh
#!/bin/sh
set -a
. "$HOME/.config/droid-mcp/env"
set +a
cd "<install-path>"
exec /usr/bin/env node --experimental-strip-types src/main.ts serve --host 127.0.0.1 --port 7337 --keys-file "$HOME/.config/droid-mcp/keys" --max-autonomy medium --log-level info
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.droid-mcp</string>
<key>Program</key><string>/Users/REPLACE/.config/droid-mcp/run.sh</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/Users/REPLACE/Library/Logs/droid-mcp.out.log</string>
<key>StandardErrorPath</key><string>/Users/REPLACE/Library/Logs/droid-mcp.err.log</string>
</dict></plist>
```

Replace `/Users/REPLACE` with the user's home directory. `bootstrap` loads the job, `print` shows it, `kickstart -k` restarts it, and `bootout` stops it.

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.droid-mcp.plist"
launchctl print "gui/$(id -u)/com.droid-mcp"
launchctl kickstart -k "gui/$(id -u)/com.droid-mcp"
launchctl bootout "gui/$(id -u)/com.droid-mcp"
```

#### System daemon

A daemon plist without a `UserName` key runs the program as root. Set `UserName` to a non-root account so launchd drops privileges before it runs the script. Keep the script owned by root as well, so the account cannot rewrite a file that starts at boot. Call that account `<service-account>` and use an existing non-root account, such as the user's own login account, when the machine has no dedicated one. `GroupName` is that account's primary group, which `id -gn <service-account>` prints. A daemon expands no `~` and no `$HOME`, so every path below is absolute.

```sh
sudo install -d -m 700 -o "<service-account>" -g "$(id -gn <service-account>)" /etc/droid-mcp
sudo install -d -m 755 -o root -g wheel /usr/local/libexec/droid-mcp
```

```sh
#!/bin/sh
set -a
. /etc/droid-mcp/env
set +a
cd "<install-path>"
exec /usr/bin/env node --experimental-strip-types src/main.ts serve --host 127.0.0.1 --port 7337 --keys-file /etc/droid-mcp/keys --max-autonomy medium --log-level info
```

Save that script as `run.sh` in the current directory, then install it as root. Check the result before you load the daemon, because root ownership is what stops the service account from editing code that runs at boot.

```sh
sudo install -m 755 -o root -g wheel run.sh /usr/local/libexec/droid-mcp/run.sh
ls -l /usr/local/libexec/droid-mcp/run.sh
# Expect root wheel, mode 755, and no write bit for the service account.
```

Create the keys and the env file as the service account. The directory is mode 700 and owned by that account, so only it can read them. Build the env file with the `read -s` pattern from the earlier section, then install it:

```sh
sudo -H -u "<service-account>" sh -c 'umask 077; openssl rand -hex 32 > /etc/droid-mcp/keys'
sudo install -m 600 -o "<service-account>" -g "$(id -gn <service-account>)" "$HOME/.config/droid-mcp/env" /etc/droid-mcp/env
sudo rm -f "$HOME/.config/droid-mcp/env"
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.droid-mcp</string>
<key>Program</key><string>/usr/local/libexec/droid-mcp/run.sh</string>
<key>UserName</key><string>&lt;service-account&gt;</string>
<key>GroupName</key><string>&lt;primary-group&gt;</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/var/log/droid-mcp.out.log</string>
<key>StandardErrorPath</key><string>/var/log/droid-mcp.err.log</string>
</dict></plist>
```

Replace `<service-account>` with the account name and `<primary-group>` with the group `id -gn <service-account>` printed. Save the file as `/Library/LaunchDaemons/com.droid-mcp.plist`, owned by root with mode 644, then load it.

```sh
sudo install -m 644 -o root -g wheel com.droid-mcp.plist /Library/LaunchDaemons/com.droid-mcp.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.droid-mcp.plist
sudo launchctl print system/com.droid-mcp
sudo launchctl kickstart -k system/com.droid-mcp
sudo launchctl bootout system/com.droid-mcp
```

Uninstall with `bootout`, then delete the plist. Ask before that delete, and before you delete `/etc/droid-mcp` or the `droid` account.

### Other platforms

On any other operating system, use the foreground commands. If the user already runs a process manager, give it the same `node` arguments as `run.sh`. Do not invent a service file.

## Connect the MCP client

Give the user this JSON. Put their host and port in the URL. `<key>` is the bearer key in the keys file, not `FACTORY_API_KEY`. The user pastes that line into the MCP client. Do not print it in chat or in a log. A remote URL is `https://<their-host>/mcp` with the same header. `docs/hosting.md` shows the proxy. Keep `url` and `Authorization` if the client uses another file format. Tell the user to call `server_info` first and to read the `droid` prompt or `skill://droid/SKILL.md`. The first response includes `initialize.instructions`, which points at that skill. A browser `Origin` gets `403` until `--allow-origin` lists it. Desktop and command-line clients send no `Origin`, so leave the allowlist empty.

```json
{
  "mcpServers": {
    "droid": {
      "type": "http",
      "url": "http://127.0.0.1:7337/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

## Verify

Confirm each item. Show the command output when one fails.

- The foreground process is running, or the service status says it is active.
- `pnpm run doctor` exits 0. Run it from `<install-path>` after `set -a` and `. <env-file>`. Doctor needs `FACTORY_API_KEY` and `droid` on `PATH`. It does not use the bearer key. Success prints one JSON object with `socket`, `userId`, `orgId`, `sessions`, and `protocol`. A missing API key makes it exit 1, and stderr includes `FACTORY_API_KEY is not set`. For the system user, prefix the command with `sudo -u droid` and load `/etc/droid-mcp/env`.
- This request sends no secret and must print `401`. Change the URL when the host or port is not the default. Do not add `Authorization`. Do not remove authentication because you want a different code.

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:7337/mcp" -H 'content-type: application/json' -d '{}'
```

- The MCP client lists a server named `droid`. `server_info` returns `version` `0.1.0`, a numeric `toolCount`, `maxAutonomy` equal to `<autonomy>`, and `daemon.connected` true. `README.md` lists 287 tools in this release. If `package.json` has a newer `version`, expect that version.

## Hand the setup to the user

Tell the user these facts. Do not include the bearer key or `FACTORY_API_KEY`.

- State the install path, foreground or service, and for a service whether it is system-wide or per user.
- State the endpoint URL, the keys file path, and the env file path.
- State the stop, start, and log commands from the section you used.
- To upgrade, run `git pull` and `pnpm install --frozen-lockfile` in `<install-path>`, then restart or run `pnpm start` again. If `@factory/droid-sdk` changed, `pnpm codegen:check` fails while generated files are stale. Stop and report that failure.
- To uninstall, disable the service or boot it out, delete the unit or plist, and reload systemd when you removed a unit. Delete the clone and the key directory only after the user agrees.

## When a step fails

Show the command and its full output verbatim. Ask before a command that needs new privileges, deletes a file, creates a user, or changes ownership. Do not retry a failed command on your own.
Do not drop the bearer key check, bind a public host, or skip TLS because a client cannot connect. Keep the server on `127.0.0.1` and use the proxy in `docs/hosting.md`. A `401` from the empty request is success.
