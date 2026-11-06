import * as Effect from "effect/Effect"

import type { Config } from "../config.ts"
import { decodeSessionsResult, openDaemon } from "../droid/daemon-client.ts"
import { FactoryApiKeyMissing } from "../droid/errors.ts"
import { errorCode, errorMessage } from "../droid/errors.ts"
import { METHOD, SESSION_LIST_LIMIT } from "../droid/protocol.ts"
import { createLogger } from "../log.ts"
import { VERSION } from "../version.ts"

/**
 * `doctor` proves the transport phase: connect over the daemon's Unix socket,
 * authenticate, and read one listing. It prints exactly one JSON object:
 * success on stdout, failure on stderr with a non-zero exit code.
 */
export const runDoctor = (config: Config): Effect.Effect<number> => {
  const logger = createLogger(config.logLevel)

  const probe = Effect.gen(function* () {
    const apiKey = config.factoryApiKey

    if (apiKey === undefined) {
      return yield* Effect.fail(new FactoryApiKeyMissing({ message: "FACTORY_API_KEY is not set" }))
    }

    const client = yield* openDaemon({
      socketPath: config.socketPath,
      version: VERSION,
      logger,
      requestTimeoutMs: config.requestTimeoutMs,
      initializeTimeoutMs: config.initializeTimeoutMs,
    })

    return yield* Effect.gen(function* () {
      const auth = yield* client.authenticate(apiKey)

      const raw = yield* client.request({
        method: METHOD.listSessions,
        params: { limit: SESSION_LIST_LIMIT },
      })

      const sessions = yield* decodeSessionsResult(raw)
      const protocol = yield* client.protocolVersion

      return {
        socket: config.socketPath,
        userId: auth.userId,
        orgId: auth.orgId,
        sessions: sessions.sessions.length,
        protocol,
      }
    }).pipe(Effect.ensuring(client.close))
  })

  return probe.pipe(
    Effect.match({
      onSuccess: (result) => {
        process.stdout.write(JSON.stringify(result) + "\n")

        return 0
      },
      onFailure: (error) => {
        const code = errorCode(error)
        const message = errorMessage(error)
        process.stderr.write(
          JSON.stringify({ socket: config.socketPath, error: { code, message } }) + "\n",
        )

        return 1
      },
    }),
  )
}
