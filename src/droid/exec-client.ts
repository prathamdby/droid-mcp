import { spawn } from "node:child_process"

import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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
  /** Cap for one stdout line. A peer that never sends a newline cannot grow without bound. */
  readonly stdoutLineLimitBytes?: number
  readonly shutdownTimeoutMs?: number
  readonly logger?: Logger
}

const STDERR_LIMIT_BYTES = 8 * 1024

/** One JSON-RPC line. Past this the peer is not speaking the protocol. */
const STDOUT_LINE_LIMIT_BYTES = 1024 * 1024

/** After stdin closes, the CLI exits on its own; these bound how long we wait. */
const SHUTDOWN_TIMEOUT_MS = 2_000

interface BroadcastItem<A> {
  readonly kind: "item"
  readonly value: A
}

interface BroadcastEnd {
  readonly kind: "end"
}

type Broadcast<A> = BroadcastItem<A> | BroadcastEnd

const broadcast = <A>(pubsub: PubSub.PubSub<Broadcast<A>>): Stream.Stream<A> =>
  Stream.fromPubSub(pubsub).pipe(
    Stream.takeWhile((event): event is BroadcastItem<A> => event.kind === "item"),
    Stream.map((event) => event.value),
  )

const publishItem = <A>(pubsub: PubSub.PubSub<Broadcast<A>>, value: A): void => {
  PubSub.publishUnsafe(pubsub, { kind: "item", value })
}

const endBroadcast = <A>(pubsub: PubSub.PubSub<Broadcast<A>>): void => {
  PubSub.endUnsafe(pubsub, { kind: "end" })
}

const notificationOf = (message: NotificationEnvelope): ExecNotification =>
  message.params === undefined
    ? { method: message.method }
    : { method: message.method, params: message.params }

const requestOf = (message: IncomingRequestEnvelope): ExecRequest =>
  message.params === undefined
    ? { id: message.id, method: message.method }
    : { id: message.id, method: message.method, params: message.params }

export const start = (options: ExecClientOptions): Effect.Effect<ExecClient, ExecFailed> => {
  let spawnedChild: ReturnType<typeof spawn> | undefined

  return Effect.gen(function* () {
    const logger = options.logger
    const environment = execEnvironment(options.env ?? {}, options.version)

    const child = spawn(options.droidPath, [...(options.args ?? EXEC_ARGS)], {
      cwd: options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    })

    spawnedChild = child

    if (child.pid === undefined) {
      // A missing or non-executable binary reports why on the next tick as an
      // 'error' event, which crashes the process unless a listener is already set.
      const failed = Deferred.makeUnsafe<never, ExecFailed>()

      child.once("error", (cause) => {
        Deferred.doneUnsafe(
          failed,
          Effect.fail(
            new ExecFailed({ message: "cannot start droid exec", detail: cause.message }),
          ),
        )
      })

      return yield* Deferred.await(failed).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => {
                try {
                  child.kill("SIGKILL")
                } catch {
                  // The binary never became a process.
                }
              }),
        ),
      )
    }

    child.stdin.on("error", (cause: Error) => {
      logger?.error("exec.stdin.error", { message: cause.message })
    })
    child.stdout.on("error", (cause: Error) => {
      logger?.error("exec.stdout.error", { message: cause.message })
    })
    child.stderr.on("error", (cause: Error) => {
      logger?.error("exec.stderr.error", { message: cause.message })
    })

    const pending = new Map<string, Deferred.Deferred<JsonValue | undefined, ExecError>>()
    const notifications = yield* PubSub.unbounded<Broadcast<ExecNotification>>({ replay: 1 })
    const requests = yield* PubSub.unbounded<Broadcast<ExecRequest>>({ replay: 1 })
    const exit = Deferred.makeUnsafe<ExecExit>()
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
    const stderrLimit = options.stderrLimitBytes ?? STDERR_LIMIT_BYTES
    const stdoutLimit = options.stdoutLineLimitBytes ?? STDOUT_LINE_LIMIT_BYTES

    let nextId = 1
    const stderrChunks: Array<Buffer> = []
    let stderrBytes = 0
    let exitInfo: ExecExit | undefined
    let outputFailed = false
    let protocolVersion = SDK_PROTOCOL_VERSION

    const stderrTail = (): string => Buffer.concat(stderrChunks).toString("utf8")

    const pushStderr = (chunk: Buffer): void => {
      if (chunk.length === 0 || stderrLimit <= 0) return
      stderrChunks.push(chunk)
      stderrBytes += chunk.length

      while (stderrBytes > stderrLimit && stderrChunks.length > 0) {
        const head = stderrChunks[0]

        if (head === undefined) break
        const overflow = stderrBytes - stderrLimit

        if (head.length <= overflow) {
          stderrChunks.shift()
          stderrBytes -= head.length
        } else {
          stderrChunks[0] = head.subarray(overflow)
          stderrBytes = stderrLimit
        }
      }
    }

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
        publishItem(notifications, notificationOf(message))

        return
      }

      publishItem(requests, requestOf(message))
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

    const failOutput = (): void => {
      if (outputFailed) return
      outputFailed = true
      buffered = ""
      failPending(new ExecFailed({ message: "droid exec output exceeded the line cap" }))

      try {
        child.kill("SIGKILL")
      } catch {
        // The process has already gone.
      }
    }

    const acceptLine = (line: string): void => {
      if (line.trim().length === 0) return

      if (Buffer.byteLength(line, "utf8") > stdoutLimit) {
        failOutput()

        return
      }

      adoptVersion(line)
      route(line)
    }

    /** A final JSON-RPC object with no trailing newline is still a message. */
    const flushTail = (): void => {
      if (outputFailed) return
      const line = buffered
      buffered = ""

      if (line.trim().length === 0) return

      if (parseServerMessage(line) === undefined) return
      acceptLine(line)
    }

    const consume = (chunk: string): void => {
      if (outputFailed) return

      if (
        !chunk.includes("\n") &&
        Buffer.byteLength(buffered, "utf8") + Buffer.byteLength(chunk, "utf8") > stdoutLimit
      ) {
        failOutput()

        return
      }

      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""

      if (Buffer.byteLength(buffered, "utf8") > stdoutLimit) {
        failOutput()

        return
      }

      for (const line of lines) acceptLine(line)
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      consume(chunk)
    })
    child.stdout.on("end", () => {
      flushTail()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      pushStderr(chunk)
    })

    const recordExit = (code: number | null, signal: string | null): void => {
      flushTail()

      if (exitInfo !== undefined) return
      const stderrText = stderrTail()

      exitInfo = { code, signal, stderr: stderrText }
      failPending(
        new ExecFailed({
          message: "droid exec exited",
          detail:
            "code " +
            String(code) +
            (signal === null ? "" : " signal " + signal) +
            (stderrText.length === 0 ? "" : ": " + stderrText),
        }),
      )
      endBroadcast(notifications)
      endBroadcast(requests)
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

      const payload = JSON.stringify(value) + "\n"

      return Effect.callback((resume) => {
        let settled = false

        const finish = (effect: Effect.Effect<void, ExecFailed>): void => {
          if (settled) return
          settled = true
          resume(effect)
        }

        try {
          child.stdin.write(payload, (error) => {
            if (error !== undefined && error !== null) {
              finish(
                Effect.fail(
                  new ExecFailed({ message: "cannot write to droid exec", detail: error.message }),
                ),
              )

              return
            }

            finish(Effect.void)
          })
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : "write failed"

          finish(Effect.fail(new ExecFailed({ message: "cannot write to droid exec", detail })))
        }
      })
    }

    const exchange = (
      requestOptions: ExecRequestOptions,
    ): Effect.Effect<JsonValue | undefined, ExecError> =>
      Effect.suspend(() => {
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

        const sent = write(message).pipe(
          Effect.andThen(
            Deferred.await(deferred).pipe(
              Effect.timeout(Duration.millis(requestOptions.timeoutMs ?? requestTimeoutMs)),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  new ExecTimeout({
                    message: requestOptions.method + " timed out",
                    detail: String(requestOptions.timeoutMs ?? requestTimeoutMs) + " ms",
                  }),
                ),
              ),
            ),
          ),
        )

        return sent.pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))))
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

    const closeGate = Deferred.makeUnsafe<void>()
    let closeStarted = false

    const shutdown = Effect.gen(function* () {
      if (exitInfo !== undefined) return

      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end()

      const graceful = yield* Effect.raceFirst(
        settled().pipe(Effect.as(true)),
        Effect.sleep(Duration.millis(shutdownTimeoutMs)).pipe(Effect.as(false)),
      )

      if (graceful) return
      yield* Effect.sync(() => {
        try {
          child.kill("SIGTERM")
        } catch {
          // Already exited.
        }
      })

      const terminated = yield* Effect.raceFirst(
        settled().pipe(Effect.as(true)),
        Effect.sleep(Duration.millis(shutdownTimeoutMs)).pipe(Effect.as(false)),
      )

      if (terminated) return
      yield* Effect.sync(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // Already exited.
        }
      })
      yield* settled()
    })

    const close = Effect.uninterruptible(
      Effect.suspend(() => {
        if (closeStarted) return Deferred.await(closeGate)
        closeStarted = true

        return shutdown.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(closeGate, Effect.void)
            }),
          ),
        )
      }),
    )

    return {
      pid: child.pid,
      notifications: broadcast(notifications),
      requests: broadcast(requests),
      protocolVersion: Effect.sync(() => protocolVersion),
      request: exchange,
      respond,
      respondError,
      exited: settled(),
      close,
    } satisfies ExecClient
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.sync(() => {
            if (spawnedChild === undefined) return

            try {
              spawnedChild.kill("SIGKILL")
            } catch {
              // The process is already gone.
            }
          }),
    ),
  )
}
