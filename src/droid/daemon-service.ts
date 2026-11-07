import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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

/**
 * Replies that only read daemon state. A lost reply for one of these may be
 * fetched again. Every other method is treated as a mutation: once the socket
 * has accepted the bytes, a transport failure is returned as-is.
 */
const IDEMPOTENT_READS: ReadonlySet<string> = new Set([
  "daemon.list_available_sessions",
  "daemon.list_opened_sessions",
])

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
  connected: boolean,
  protocol: string | undefined,
): DaemonStatus => {
  const base = {
    endpoint: endpointOf(config),
    supervised: config.daemonUrl === undefined,
    connected,
  }

  const withPid = pid === undefined ? base : { ...base, pid }

  return protocol === undefined ? withPid : { ...withPid, protocol }
}

const unreachable = (detail: string): DaemonUnavailable =>
  new DaemonUnavailable({ message: "cannot reach the daemon", detail })

const connect = (config: Config, apiKey: string): Effect.Effect<DaemonClient, DaemonError> =>
  Effect.gen(function* () {
    const client = yield* openDaemon({
      version: VERSION,
      requestTimeoutMs: config.requestTimeoutMs,
      initializeTimeoutMs: config.initializeTimeoutMs,
      ...(config.daemonUrl === undefined
        ? { socketPath: config.socketPath }
        : tcpTarget(config.daemonUrl)),
    })

    // Auth and the open that preceded it own a socket. Failure or
    // interruption must close it; a rejected key is not a dead transport.
    return yield* client.authenticate(apiKey).pipe(
      Effect.as(client),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : client.close)),
    )
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
      const current = yield* Ref.make<DaemonClient | undefined>(undefined)
      const lock = yield* Semaphore.make(1)

      const drop = Effect.gen(function* () {
        const existing = yield* Ref.get(current)
        yield* Ref.set(current, undefined)

        if (existing !== undefined) yield* existing.close
      })

      const acquire: Effect.Effect<DaemonClient, DaemonError> = Effect.uninterruptibleMask(
        (restore) =>
          Effect.gen(function* () {
            const existing = yield* Ref.get(current)

            if (existing !== undefined) return existing

            if (apiKey === undefined) {
              return yield* Effect.fail(
                new FactoryApiKeyMissing({
                  message: "FACTORY_API_KEY is not set; daemon tools need it to authenticate",
                }),
              )
            }

            yield* restore(host.ensure)

            const client = yield* restore(
              connect(config, apiKey).pipe(
                Effect.catchTags({
                  WsError: (error) => Effect.fail(unreachable(error.message)),
                  DaemonUnavailable: (error) => Effect.fail(unreachable(error.message)),
                }),
              ),
            )

            yield* Ref.set(current, client)

            return client
          }),
      )

      const attempt = (options: DaemonRequest): Effect.Effect<JsonValue | undefined, DaemonError> =>
        Effect.gen(function* () {
          const client = yield* acquire

          return yield* client.request(options)
        })

      /**
       * Reconnect when the request never left the process, and once more for a
       * pure read whose reply was lost. A mutation that may already have run
       * is not sent again.
       */
      const request = (options: DaemonRequest): Effect.Effect<JsonValue | undefined, DaemonError> =>
        Semaphore.withPermit(lock)(
          Effect.suspend(() => {
            const once = attempt(options)

            return once.pipe(
              Effect.catchTag("DaemonUnavailable", (error) => {
                const retry = error.delivered !== true || IDEMPOTENT_READS.has(options.method)

                if (!retry) return drop.pipe(Effect.andThen(Effect.fail(error)))

                return drop.pipe(Effect.andThen(once))
              }),
            )
          }),
        )

      const status: Effect.Effect<DaemonStatus> = Effect.gen(function* () {
        const [client, pid] = yield* Effect.all([Ref.get(current), host.childPid])

        if (client === undefined) return describe(config, pid, false, undefined)
        const live = yield* client.connected

        if (!live) return describe(config, pid, false, undefined)
        const protocol = yield* client.protocolVersion

        return describe(config, pid, true, protocol)
      })

      const invalidate = Semaphore.withPermit(lock)(Effect.uninterruptible(drop))

      yield* Effect.addFinalizer(() =>
        Semaphore.withPermit(lock)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* drop
              yield* host.stop
            }),
          ),
        ),
      )

      return { request, status, reset: invalidate }
    }),
  )
