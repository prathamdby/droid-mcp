import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import type { Logger } from "../log.ts"
import {
  DaemonAuthRejected,
  DaemonProtocolError,
  DaemonTimeout,
  DaemonUnavailable,
} from "./errors.ts"
import type { DaemonError } from "./errors.ts"
import {
  METHOD,
  isAuthenticationErrorCode,
  isMethodNotFoundCode,
  parseServerMessage,
  protocolMismatch,
  requestEnvelope,
  SDK_PROTOCOL_VERSION,
} from "./protocol.ts"
import type {
  IncomingRequestEnvelope,
  JsonValue,
  NotificationEnvelope,
  ResponseEnvelope,
} from "./protocol.ts"
import { connect } from "./ws.ts"
import type { WsConnectOptions } from "./ws.ts"

export interface DaemonNotification {
  readonly method: string
  readonly params?: JsonValue
}

export interface DaemonServerRequest {
  readonly id: string
  readonly method: string
  readonly params?: JsonValue
}

export interface DaemonAuthenticateResult {
  readonly userId: string
  readonly orgId: string
}

export interface DaemonRequestOptions {
  readonly method: string
  readonly params?: JsonValue
  readonly timeoutMs?: number
}

export interface DaemonClient {
  readonly notifications: Stream.Stream<DaemonNotification>
  readonly requests: Stream.Stream<DaemonServerRequest>
  readonly protocolVersion: Effect.Effect<string>
  readonly request: (
    options: DaemonRequestOptions,
  ) => Effect.Effect<JsonValue | undefined, DaemonError>
  readonly authenticate: (apiKey: string) => Effect.Effect<DaemonAuthenticateResult, DaemonError>
  readonly close: Effect.Effect<void>
}

export interface DaemonClientOptions {
  /** Unix socket path, or `host`/`port` for a TCP daemon. */
  readonly socketPath?: string
  readonly host?: string
  readonly port?: number
  readonly version: string
  readonly protocolVersion?: string
  readonly requestTimeoutMs?: number
  readonly initializeTimeoutMs?: number
  readonly keepaliveMs?: number
  readonly logger?: Logger
}

/** The payloads Phase 1 reads. Later phases add a validator per tool. */
export interface SessionsResult {
  readonly sessions: ReadonlyArray<JsonValue>
  readonly hasMore?: boolean
}

const AuthenticateResultSchema = Schema.Struct({
  userId: Schema.String,
  orgId: Schema.String,
})

const SessionsResultSchema = Schema.Struct({
  sessions: Schema.Array(Schema.Json),
  hasMore: Schema.optional(Schema.Boolean),
})

const unexpected = (method: string): DaemonProtocolError =>
  new DaemonProtocolError({ message: "unexpected daemon payload", detail: method })

export const decodeAuthenticateResult = (
  value: JsonValue | undefined,
): Effect.Effect<DaemonAuthenticateResult, DaemonProtocolError> =>
  Option.match(Schema.decodeUnknownOption(AuthenticateResultSchema)(value), {
    onNone: () => Effect.fail(unexpected("daemon.authenticate")),
    onSome: (result) => Effect.succeed({ userId: result.userId, orgId: result.orgId }),
  })

export const decodeSessionsResult = (
  value: JsonValue | undefined,
): Effect.Effect<SessionsResult, DaemonProtocolError> =>
  Option.match(Schema.decodeUnknownOption(SessionsResultSchema)(value), {
    onNone: () => Effect.fail(unexpected("daemon session listing")),
    onSome: (result) =>
      Effect.succeed(
        result.hasMore === undefined
          ? { sessions: result.sessions }
          : { sessions: result.sessions, hasMore: result.hasMore },
      ),
  })

const unwrap = (
  response: ResponseEnvelope,
  method: string,
): Effect.Effect<JsonValue | undefined, DaemonError> => {
  const error = response.error

  if (error === undefined) return Effect.succeed(response.result)

  if (isAuthenticationErrorCode(error.code)) {
    return Effect.fail(
      new DaemonAuthRejected({
        message: "daemon rejected the Factory API key",
        detail: error.message,
      }),
    )
  }

  if (isMethodNotFoundCode(error.code)) {
    return Effect.fail(
      new DaemonProtocolError({
        message: "daemon does not implement " + method,
        detail: error.message,
      }),
    )
  }

  return Effect.fail(
    new DaemonProtocolError({
      message: "daemon request failed",
      detail: error.code + ": " + error.message,
    }),
  )
}

const connectionOptions = (options: DaemonClientOptions): WsConnectOptions => {
  const target =
    options.socketPath === undefined
      ? { host: options.host ?? "127.0.0.1", port: options.port ?? 7337 }
      : { socketPath: options.socketPath }

  return options.keepaliveMs === undefined
    ? target
    : { ...target, keepaliveMs: options.keepaliveMs }
}

const notificationOf = (message: NotificationEnvelope): DaemonNotification =>
  message.params === undefined
    ? { method: message.method }
    : { method: message.method, params: message.params }

const serverRequestOf = (message: IncomingRequestEnvelope): DaemonServerRequest =>
  message.params === undefined
    ? { id: message.id, method: message.method }
    : { id: message.id, method: message.method, params: message.params }

export const openDaemon = (
  options: DaemonClientOptions,
): Effect.Effect<DaemonClient, DaemonError> =>
  Effect.gen(function* () {
    const logger = options.logger

    const ws = yield* connect(connectionOptions(options)).pipe(
      Effect.mapError(
        (cause) =>
          new DaemonUnavailable({
            message: "cannot open the daemon socket",
            detail: cause.message,
          }),
      ),
    )

    const pending = new Map<string, Deferred.Deferred<ResponseEnvelope, DaemonError>>()
    const protocolVersion = yield* Ref.make(options.protocolVersion ?? SDK_PROTOCOL_VERSION)
    const notifications = yield* PubSub.unbounded<DaemonNotification>({ replay: 1 })
    const requests = yield* PubSub.unbounded<DaemonServerRequest>({ replay: 1 })
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    const initializeTimeoutMs = options.initializeTimeoutMs ?? 60_000
    let nextId = 1
    let closed = false

    const failPending = (error: DaemonError): void => {
      for (const deferred of pending.values()) {
        Deferred.doneUnsafe(deferred, Effect.fail(error))
      }

      pending.clear()
    }

    const route = (line: string): void => {
      const message = parseServerMessage(line)

      if (message === undefined) {
        logger?.warn("daemon.message.unparsed")

        return
      }

      if (message.type === "response") {
        if (message.id === null) {
          logger?.warn("daemon.response.uncorrelated")

          return
        }

        const deferred = pending.get(message.id)

        if (deferred === undefined) {
          logger?.warn("daemon.response.unknown_id")

          return
        }

        pending.delete(message.id)
        Deferred.doneUnsafe(deferred, Effect.succeed(message))

        return
      }

      if (message.type === "notification") {
        PubSub.publishUnsafe(notifications, notificationOf(message))

        return
      }

      PubSub.publishUnsafe(requests, serverRequestOf(message))
    }

    const reader = yield* ws.messages.pipe(
      Stream.runForEach((message) =>
        Effect.sync(() => {
          if (message.kind === "text") route(message.text)
        }),
      ),
      Effect.forkDetach,
    )

    const watcher = yield* ws.closed.pipe(
      Effect.flatMap((info) =>
        Effect.sync(() => {
          closed = true
          failPending(
            new DaemonUnavailable({
              message: "daemon connection closed",
              detail: String(info.code) + (info.reason.length > 0 ? ": " + info.reason : ""),
            }),
          )
        }),
      ),
      Effect.forkDetach,
    )

    const exchange = (
      method: string,
      params: JsonValue | undefined,
      version: string,
      timeoutMs: number,
    ): Effect.Effect<ResponseEnvelope, DaemonError> =>
      Effect.gen(function* () {
        const id = "droid-mcp-" + String(nextId)
        nextId += 1
        const deferred = Deferred.makeUnsafe<ResponseEnvelope, DaemonError>()
        pending.set(id, deferred)
        const envelope = requestEnvelope(id, method, params, version)
        yield* ws.sendText(JSON.stringify(envelope)).pipe(
          Effect.mapError(
            (cause) =>
              new DaemonUnavailable({
                message: "cannot write to the daemon socket",
                detail: cause.message,
              }),
          ),
        )

        const waiting = Deferred.await(deferred).pipe(
          Effect.timeout(Duration.millis(timeoutMs)),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new DaemonTimeout({
                message: "daemon request timed out",
                detail: method + " after " + String(timeoutMs) + "ms",
              }),
            ),
          ),
        )

        const closedFailure = ws.closed.pipe(
          Effect.flatMap((info) =>
            Effect.fail(
              new DaemonUnavailable({
                message: "daemon connection closed",
                detail: String(info.code),
              }),
            ),
          ),
        )

        return yield* Effect.raceFirst(waiting, closedFailure).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        )
      })

    const request = (
      requestOptions: DaemonRequestOptions,
    ): Effect.Effect<JsonValue | undefined, DaemonError> =>
      Effect.gen(function* () {
        const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs
        const firstVersion = yield* Ref.get(protocolVersion)

        const first = yield* exchange(
          requestOptions.method,
          requestOptions.params,
          firstVersion,
          timeoutMs,
        )

        const mismatch = protocolMismatch(first.error)

        if (mismatch === undefined) {
          return yield* unwrap(first, requestOptions.method)
        }

        logger?.info("daemon.protocol.adopted", { offered: firstVersion, adopted: mismatch.local })
        yield* Ref.set(protocolVersion, mismatch.local)

        const second = yield* exchange(
          requestOptions.method,
          requestOptions.params,
          mismatch.local,
          timeoutMs,
        )

        const secondMismatch = protocolMismatch(second.error)

        if (secondMismatch !== undefined) {
          return yield* Effect.fail(
            new DaemonProtocolError({
              message: "daemon rejected the adopted protocol version",
              detail:
                "daemon wants " + secondMismatch.local + ", client offered " + secondMismatch.peer,
            }),
          )
        }

        return yield* unwrap(second, requestOptions.method)
      })

    return {
      notifications: Stream.fromPubSub(notifications),
      requests: Stream.fromPubSub(requests),
      protocolVersion: Ref.get(protocolVersion),
      request,
      authenticate: (apiKey: string) =>
        Effect.gen(function* () {
          const result = yield* request({
            method: METHOD.authenticate,
            params: {
              apiKey,
              caller: "sdk",
              metadata: {
                sdk: {
                  language: "typescript",
                  version: options.version,
                },
              },
            },
            timeoutMs: initializeTimeoutMs,
          })

          return yield* decodeAuthenticateResult(result)
        }),
      close: Effect.gen(function* () {
        if (closed) return
        closed = true
        yield* Effect.sync(() =>
          failPending(new DaemonUnavailable({ message: "daemon client closed" })),
        )
        yield* ws.close
        yield* Fiber.interrupt(reader)
        yield* Fiber.interrupt(watcher)
      }),
    }
  })
