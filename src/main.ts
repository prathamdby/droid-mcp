import { readFileSync } from "node:fs"

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { runDoctor } from "./commands/doctor.ts"
import { configError, parseConfig } from "./config.ts"
import type { Config } from "./config.ts"
import { errorCode, errorMessage } from "./droid/errors.ts"
import { serve } from "./http/server.ts"
import { createLogger } from "./log.ts"
import { VERSION } from "./version.ts"

const USAGE = `droid-mcp ${VERSION}

Usage:
  droid-mcp doctor [flags]
  droid-mcp serve [flags]

Subcommands:
  doctor     Connect to the daemon, authenticate, and print one JSON object
  serve      Serve the MCP endpoint on /mcp

Flags:
  --socket <path>              Daemon Unix socket (DROID_MCP_SOCKET)
  --runtime-dir <path>         Runtime directory (DROID_MCP_RUNTIME_DIR)
  --droid-path <path>          droid executable (DROID_MCP_DROID_PATH)
  --daemon-url <url>           Use an existing daemon instead of a socket
  --host <host>                Bind host (DROID_MCP_HOST)
  --port <port>                Bind port (DROID_MCP_PORT)
  --keys-file <path>           MCP keys, one per line
  --max-autonomy <level>       off | low | medium | high (default: medium)
  --allow-origin <origin>      Repeatable allowed Origin
  --factory-base-url <url>     Factory API base (FACTORY_BASE_URL)
  --log-level <level>          debug | info | warn | error (default: info)
  --prompt-timeout <ms>        Pending prompt deadline (default: 300000)
  --request-timeout <ms>       Request timeout (default: 30000)
  --require-skill <bool>       Require reading skill before session_* (default: true)
  -h, --help                   Show this help
  -v, --version                Show the version
`

/** Keys come from DROID_MCP_KEYS; `--keys-file` adds one per non-empty line. */
const resolveKeys = (config: Config): ReadonlyArray<string> => {
  const keys = [...config.keys]

  if (config.keysFile === undefined) return keys

  for (const line of readFileSync(config.keysFile, "utf8").split("\n")) {
    const key = line.trim()

    if (key.length > 0 && !key.startsWith("#")) keys.push(key)
  }

  return keys
}

const program = Effect.gen(function* () {
  const config = yield* Effect.try({
    try: () => parseConfig(process.argv.slice(2), process.env),
    catch: configError,
  })

  if (config.command === "help") {
    console.log(USAGE)

    return 0
  }

  if (config.command === "version") {
    console.log(VERSION)

    return 0
  }

  if (config.command === "doctor") {
    return yield* runDoctor(config)
  }

  const logger = createLogger(config.logLevel)
  const keys = resolveKeys(config)

  if (keys.length === 0) {
    logger.error("serve.keys_missing", { source: "DROID_MCP_KEYS or --keys-file" })

    return 2
  }

  logger.info("serve.starting", { host: config.host, port: config.port, keys: keys.length })

  return yield* Layer.launch(serve({ config, keys, allowedOrigins: config.allowedOrigins })).pipe(
    Effect.as(0),
  )
}).pipe(
  Effect.match({
    onSuccess: (code) => code,
    onFailure: (error) => {
      const code = errorCode(error)
      const message = errorMessage(error)
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          event: "cli.failed",
          code,
          message,
        }) + "\n",
      )

      return 2
    },
  }),
)

Effect.runPromise(program).then(
  (code) => {
    process.exitCode = code
  },
  () => {
    process.exitCode = 2
  },
)
