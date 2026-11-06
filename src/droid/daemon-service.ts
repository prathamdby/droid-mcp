import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

import type { Config } from "../config.ts"
import { VERSION } from "../version.ts"
import { openDaemon } from "./daemon-client.ts"
import type { DaemonClient } from "./daemon-client.ts"
import { daemonHost } from "./daemon-host.ts"
import type { DaemonHost } from "./daemon-host.ts"
import { DaemonUnavailable, FactoryApiKeyMissing } from "./errors.ts"
import type { DaemonError } from "./errors.ts"
import type { JsonValue } from "./protocol.ts"

/** What the daemon connection currently looks like, for `server_info`. */
export const DaemonStatusSchema = Schema.Struct({
  /** Where the client dials: a Unix socket path or a daemon URL. */
  endpoint: Schema.String,
  supervised: Schema.Boolean,
  connected: Schema.Boolean,
  pid: Schema.optional(Schema.Number),
  protocol: Schema.optional(Schema.String),
})

export type DaemonStatus = typeof DaemonStatusSchema.Type

export interface DaemonRequest {
  readonly method: string
  readonly params?: JsonValue
  readonly timeoutMs?: number
}

export interface DaemonApi {
  readonly request: (options: DaemonRequest) => Effect.Effect<JsonValue | undefined, DaemonError>
  readonly status: Effect.Effect<DaemonStatus>
  /** Drops the current connection; the next request dials again. */
  readonly reset: Effect.Effect<void>
}

/**
 * The host daemon: one connection, opened on first use, authenticated with
 * `FACTORY_API_KEY`. The Unix socket client covers what the SDK cannot reach,
 * and adopts the daemon's protocol version on the first request.
 */
export class DaemonService extends Context.Service<DaemonService, DaemonApi>()(
  "droid-mcp/DaemonService",
) {}

interface Connection {
  readonly client: DaemonClient
  readonly protocol: string
}

/** `ws://host:port` or `http://host:port` to a TCP target. */
const tcpTarget = (url: string) => {
  const parsed = new URL(url)

  return {
    host: parsed.hostname,
    port: parsed.port.length > 0 ? Number(parsed.port) : 7337,
  }
}

const endpointOf = (config: Config): string =>
  config.daemonUrl === undefined ? config.socketPath : config.daemonUrl

const describe = (
  config: Config,
  pid: number | undefined,
  connection: Connection | undefined,
): DaemonStatus => {
  const base = {
    endpoint: endpointOf(config),
    supervised: config.daemonUrl === undefined,
    connected: connection !== undefined,
  }

  const withPid = pid === undefined ? base : { ...base, pid }

  return connection === undefined ? withPid : { ...withPid, protocol: connection.protocol }
}

const connect = (config: Config, apiKey: string): Effect.Effect<Connection, DaemonError> =>
  Effect.gen(function* () {
    const client = yield* openDaemon({
      version: VERSION,
      requestTimeoutMs: config.requestTimeoutMs,
      initializeTimeoutMs: config.initializeTimeoutMs,
      ...(config.daemonUrl === undefined
        ? { socketPath: config.socketPath }
        : tcpTarget(config.daemonUrl)),
    })

    yield* client.authenticate(apiKey)
    const protocol = yield* client.protocolVersion

    return { client, protocol }
  })

/**
 * Builds the daemon service. Without `DROID_MCP_DAEMON_URL` the server owns the
 * daemon: a missing socket is spawned on first use. With it, the server only
 * dials.
 */
export const daemonLayer = (config: Config): Layer.Layer<DaemonService> =>
  Layer.effect(
    DaemonService,
    Effect.gen(function* () {
      const host: DaemonHost = yield* daemonHost(config)
      const apiKey = config.factoryApiKey
      const current = yield* Ref.make<Connection | undefined>(undefined)
      const lock = yield* Semaphore.make(1)

      const drop = Effect.gen(function* () {
        const existing = yield* Ref.get(current)
        yield* Ref.set(current, undefined)

        if (existing !== undefined) yield* existing.client.close
      })

      const acquire: Effect.Effect<Connection, DaemonError> = Effect.gen(function* () {
        const existing = yield* Ref.get(current)

        if (existing !== undefined) return existing

        if (apiKey === undefined) {
          return yield* Effect.fail(
            new FactoryApiKeyMissing({
              message: "FACTORY_API_KEY is not set; daemon tools need it to authenticate",
            }),
          )
        }

        yield* host.ensure

        const connection = yield* connect(config, apiKey).pipe(
          Effect.mapError(
            (error) =>
              new DaemonUnavailable({
                message: "cannot reach the daemon",
                detail: error.message,
              }),
          ),
        )

        yield* Ref.set(current, connection)

        return connection
      })

      /**
       * A daemon that died mid-call is replaced on the next attempt: the
       * connection is dropped, the host ensures a listener, and the request is
       * sent once more. A second failure is real and reaches the caller.
       */
      const attempt = (options: DaemonRequest): Effect.Effect<JsonValue | undefined, DaemonError> =>
        Effect.gen(function* () {
          const connection = yield* acquire

          return yield* connection.client.request(options)
        })

      const request = (options: DaemonRequest): Effect.Effect<JsonValue | undefined, DaemonError> =>
        Semaphore.withPermit(lock)(
          attempt(options).pipe(
            Effect.catchTag("DaemonUnavailable", () =>
              Effect.gen(function* () {
                yield* drop

                return yield* attempt(options)
              }),
            ),
          ),
        )

      const status: Effect.Effect<DaemonStatus> = Effect.gen(function* () {
        const [connection, pid] = yield* Effect.all([Ref.get(current), host.childPid])

        return describe(config, pid, connection)
      })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* drop
          yield* host.stop
        }),
      )

      return { request, status, reset: drop }
    }),
  )
