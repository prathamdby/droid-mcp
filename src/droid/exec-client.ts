import { spawn } from "node:child_process"

import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"

import type { Logger } from "../log.ts"
import { ExecFailed, ExecTimeout } from "./errors.ts"
import type { ExecError } from "./errors.ts"
import {
  EXEC_ARGS,
  errorResponseEnvelope,
  execEnvironment,
  responseEnvelope,
} from "./exec-protocol.ts"
import type { IncomingRequestEnvelope, JsonValue, NotificationEnvelope } from "./protocol.ts"
import { SDK_PROTOCOL_VERSION, parseServerMessage } from "./protocol.ts"

export interface ExecNotification {
  readonly method: string
  readonly params?: JsonValue
}

export interface ExecRequest {
  readonly id: string
  readonly method: string
  readonly params?: JsonValue
}

export interface ExecExit {
  readonly code: number | null
  readonly signal: string | null
  readonly stderr: string
}

export interface ExecRequestOptions {
  readonly method: string
  readonly params?: JsonValue
  readonly timeoutMs?: number
}

export interface ExecClient {
  readonly pid: number | undefined
  readonly notifications: Stream.Stream<ExecNotification>
  readonly requests: Stream.Stream<ExecRequest>
  readonly protocolVersion: Effect.Effect<string>
  readonly request: (options: ExecRequestOptions) => Effect.Effect<JsonValue | undefined, ExecError>
  readonly respond: (id: string, result: JsonValue) => Effect.Effect<void, ExecError>
  readonly respondError: (
    id: string,
    code: number,
    message: string,
  ) => Effect.Effect<void, ExecError>
  readonly exited: Effect.Effect<ExecExit>
  readonly close: Effect.Effect<void>
}

export interface ExecClientOptions {
  readonly droidPath: string
  readonly cwd: string
  readonly version: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Overrides the CLI arguments; tests point this at a script instead of `droid`. */
  readonly args?: ReadonlyArray<string>
  readonly requestTimeoutMs?: number
  readonly stderrLimitBytes?: number
  readonly shutdownTimeoutMs?: number
  readonly logger?: Logger
}

const STDERR_LIMIT_BYTES = 8 * 1024

/** After stdin closes, the CLI exits on its own; these bound how long we wait. */
const SHUTDOWN_TIMEOUT_MS = 2_000

const notificationOf = (message: NotificationEnvelope): ExecNotification =>
  message.params === undefined
    ? { method: message.method }
    : { method: message.method, params: message.params }

const requestOf = (message: IncomingRequestEnvelope): ExecRequest =>
  message.params === undefined
    ? { id: message.id, method: message.method }
    : { id: message.id, method: message.method, params: message.params }

export const start = (options: ExecClientOptions): Effect.Effect<ExecClient, ExecFailed> =>
  Effect.gen(function* () {
    const logger = options.logger
    const environment = execEnvironment(options.env ?? {}, options.version)

    const child = spawn(options.droidPath, [...(options.args ?? EXEC_ARGS)], {
      cwd: options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    })

    if (child.pid === undefined) {
      return yield* Effect.fail(
        new ExecFailed({
          message: "cannot start droid exec",
          detail: options.droidPath,
        }),
      )
    }

    const pending = new Map<string, Deferred.Deferred<JsonValue | undefined, ExecError>>()
    const notifications = yield* PubSub.unbounded<ExecNotification>({ replay: 1 })
    const requests = yield* PubSub.unbounded<ExecRequest>({ replay: 1 })
    const exit = Deferred.makeUnsafe<ExecExit>()
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
    const stderrLimit = options.stderrLimitBytes ?? STDERR_LIMIT_BYTES

    let nextId = 1
    let stderr = ""
    let exitInfo: ExecExit | undefined
    let protocolVersion = SDK_PROTOCOL_VERSION

    const stderrTail = (): string => stderr.slice(-stderrLimit)

    const failPending = (error: ExecError): void => {
      for (const deferred of pending.values()) {
        Deferred.doneUnsafe(deferred, Effect.fail(error))
      }

      pending.clear()
    }

    const settled = (): Effect.Effect<ExecExit> => {
      if (exitInfo === undefined) return Deferred.await(exit)

      return Effect.succeed(exitInfo)
    }

    const route = (line: string): void => {
      const message = parseServerMessage(line)

      if (message === undefined) {
        logger?.warn("exec.message.unparsed")

        return
      }

      if (message.type === "response") {
        if (message.id === null) {
          logger?.warn("exec.response.uncorrelated")

          return
        }

        const deferred = pending.get(message.id)

        if (deferred === undefined) {
          logger?.warn("exec.response.unknown_id")

          return
        }

        pending.delete(message.id)
        Deferred.doneUnsafe(
          deferred,
          message.error === undefined
            ? Effect.succeed(message.result)
            : Effect.fail(
                new ExecFailed({
                  message: message.error.message,
                  detail: "json-rpc " + String(message.error.code),
                }),
              ),
        )

        return
      }

      if (message.type === "notification") {
        PubSub.publishUnsafe(notifications, notificationOf(message))

        return
      }

      PubSub.publishUnsafe(requests, requestOf(message))
    }

    // The CLI reports the protocol it speaks on every envelope; adopt the newest.
    const adoptVersion = (line: string): void => {
      const match = /"factoryProtocolVersion":"([^"]+)"/.exec(line)

      if (match === null) return

      const version = match[1]

      if (version === undefined) return

      protocolVersion = version
    }

    let buffered = ""

    const consume = (chunk: string): void => {
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""

      for (const line of lines) {
        if (line.trim().length === 0) continue

        adoptVersion(line)
        route(line)
      }
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      consume(chunk)
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk

      if (stderr.length > stderrLimit * 4) stderr = stderrTail()
    })

    const recordExit = (code: number | null, signal: string | null): void => {
      if (exitInfo !== undefined) return

      exitInfo = { code, signal, stderr: stderrTail() }
      failPending(
        new ExecFailed({
          message: "droid exec exited",
          detail:
            "code " +
            String(code) +
            (signal === null ? "" : " signal " + signal) +
            (stderrTail().length === 0 ? "" : ": " + stderrTail()),
        }),
      )
      Deferred.doneUnsafe(exit, Effect.succeed(exitInfo))
    }

    child.on("exit", (code, signal) => {
      recordExit(code, signal)
    })
    child.on("error", (cause) => {
      logger?.error("exec.child.error", { message: cause.message })
      recordExit(null, null)
    })

    const write = (value: JsonValue): Effect.Effect<void, ExecFailed> => {
      if (exitInfo !== undefined) {
        return Effect.fail(
          new ExecFailed({
            message: "droid exec is not running",
            detail: "code " + String(exitInfo.code),
          }),
        )
      }

      if (child.stdin.destroyed || !child.stdin.writable) {
        return Effect.fail(
          new ExecFailed({ message: "cannot write to droid exec", detail: "stdin closed" }),
        )
      }

      return Effect.sync(() => {
        child.stdin.write(JSON.stringify(value) + "\n")
      })
    }

    const exchange = (
      requestOptions: ExecRequestOptions,
    ): Effect.Effect<JsonValue | undefined, ExecError> =>
      Effect.gen(function* () {
        const id = "droid-mcp-" + String(nextId)
        nextId += 1
        const deferred = Deferred.makeUnsafe<JsonValue | undefined, ExecError>()
        pending.set(id, deferred)

        const envelope = {
          jsonrpc: "2.0",
          factoryApiVersion: "1.0.0",
          factoryProtocolVersion: protocolVersion,
          type: "request",
          id,
          method: requestOptions.method,
        }

        const message: JsonValue =
          requestOptions.params === undefined
            ? envelope
            : { ...envelope, params: requestOptions.params }

        yield* write(message).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              pending.delete(id)
            }),
          ),
        )

        return yield* Deferred.await(deferred).pipe(
          Effect.timeout(Duration.millis(requestOptions.timeoutMs ?? requestTimeoutMs)),
          Effect.catchTag("TimeoutError", () => {
            pending.delete(id)

            return Effect.fail(
              new ExecTimeout({
                message: requestOptions.method + " timed out",
                detail: String(requestOptions.timeoutMs ?? requestTimeoutMs) + " ms",
              }),
            )
          }),
        )
      })

    const respond = (id: string, result: JsonValue): Effect.Effect<void, ExecFailed> =>
      Effect.gen(function* () {
        yield* write(responseEnvelope(id, result, protocolVersion))
      })

    const respondError = (
      id: string,
      code: number,
      message: string,
    ): Effect.Effect<void, ExecFailed> =>
      Effect.gen(function* () {
        yield* write(errorResponseEnvelope(id, code, message, protocolVersion))
      })

    const close: Effect.Effect<void> = Effect.gen(function* () {
      if (exitInfo !== undefined) return

      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end()

      const graceful = yield* Effect.raceFirst(
        settled().pipe(Effect.as(true)),
        Effect.sleep(Duration.millis(shutdownTimeoutMs)).pipe(Effect.as(false)),
      )

      if (graceful) return

      child.kill("SIGTERM")

      const terminated = yield* Effect.raceFirst(
        settled().pipe(Effect.as(true)),
        Effect.sleep(Duration.millis(shutdownTimeoutMs)).pipe(Effect.as(false)),
      )

      if (!terminated) child.kill("SIGKILL")
    })

    return {
      pid: child.pid,
      notifications: Stream.fromPubSub(notifications),
      requests: Stream.fromPubSub(requests),
      protocolVersion: Effect.sync(() => protocolVersion),
      request: exchange,
      respond,
      respondError,
      exited: settled(),
      close,
    } satisfies ExecClient
  })
