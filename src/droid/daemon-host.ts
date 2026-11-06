import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { rmSync } from "node:fs"
import { connect } from "node:net"

import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"

import type { Config } from "../config.ts"
import { DaemonUnavailable } from "./errors.ts"

/** How many times a spawned daemon is retried before a tool call gives up. */
export const HOST_RETRY_ATTEMPTS = 5

/** Startup window for a spawned daemon: it must accept on the socket by then. */
export const HOST_START_TIMEOUT = Duration.seconds(60)

/** Backoff before the next spawn: 1 s, 2 s, 4 s, 8 s, then 16 s. */
export const HOST_BACKOFF_BASE = Duration.seconds(1)

export const HOST_BACKOFF_MAX = Duration.seconds(16)

const SOCKET_POLL = Duration.millis(100)

/** How long a daemon gets to exit after `SIGTERM` before it is killed. */
const SHUTDOWN_GRACE = Duration.seconds(5)

export interface DaemonHost {
  /** Resolves once a daemon is listening, spawning one when needed. */
  readonly ensure: Effect.Effect<void, DaemonUnavailable>
  readonly childPid: Effect.Effect<number | undefined>
  readonly stop: Effect.Effect<void>
}

/** Timings, exposed so a test can run the supervisor in milliseconds. */
export interface DaemonHostOptions {
  readonly retryAttempts?: number
  readonly startTimeoutMs?: number
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  readonly socketPollMs?: number
  readonly shutdownMs?: number
  /** How long one connect attempt may take before it counts as not listening. */
  readonly connectTimeoutMs?: number
}

interface DaemonHostTiming {
  readonly retryAttempts: number
  readonly startTimeoutMs: number
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
  readonly socketPollMs: number
  readonly shutdownMs: number
  readonly connectTimeoutMs: number
}

const timingOf = (options: DaemonHostOptions): DaemonHostTiming => ({
  retryAttempts: options.retryAttempts ?? HOST_RETRY_ATTEMPTS,
  startTimeoutMs: options.startTimeoutMs ?? Duration.toMillis(HOST_START_TIMEOUT),
  backoffBaseMs: options.backoffBaseMs ?? Duration.toMillis(HOST_BACKOFF_BASE),
  backoffMaxMs: options.backoffMaxMs ?? Duration.toMillis(HOST_BACKOFF_MAX),
  socketPollMs: options.socketPollMs ?? Duration.toMillis(SOCKET_POLL),
  shutdownMs: options.shutdownMs ?? Duration.toMillis(SHUTDOWN_GRACE),
  connectTimeoutMs: options.connectTimeoutMs ?? 500,
})

/**
 * A listening socket is the daemon's whole health signal: the socket file can
 * outlive the process that created it, so connecting is what counts.
 */
const isListening = (path: string, timeoutMs = 500): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ path })

    const settle = (value: boolean): void => {
      socket.destroy()
      resume(Effect.succeed(value))
    }

    socket.setTimeout(timeoutMs)
    socket.once("connect", () => {
      settle(true)
    })
    socket.once("timeout", () => {
      settle(false)
    })
    socket.once("error", () => {
      settle(false)
    })
  })

const spawnDaemon = (config: Config): Effect.Effect<ChildProcess, DaemonUnavailable> => {
  const args = [
    "daemon",
    "--unix",
    config.socketPath,
    "--listen",
    "websocket",
    "--remote-control",
    "--parent-pid",
    String(process.pid),
  ]

  const unavailable = (detail: string): DaemonUnavailable =>
    new DaemonUnavailable({ message: "cannot spawn the droid daemon", detail })

  return Effect.callback<ChildProcess, DaemonUnavailable>((resume) => {
    let child: ChildProcess

    try {
      child = spawn(config.droidPath, args, { detached: false, stdio: "ignore" })
    } catch {
      resume(Effect.fail(unavailable(config.droidPath)))

      return
    }

    if (child.pid !== undefined) {
      resume(Effect.succeed(child))

      return
    }

    // A missing or non-executable binary reports why on the next tick as an
    // 'error' event, which crashes the process unless a listener is already set.
    child.once("error", (cause) => {
      resume(Effect.fail(unavailable(cause.message)))
    })
  })
}

/**
 * Owns the daemon process for the local socket. A daemon that is already
 * listening is reused; otherwise one is spawned, and a daemon that never starts
 * is retried with exponential backoff. `DROID_MCP_DAEMON_URL` disables this
 * entirely: the server never spawns a daemon it was told to dial.
 */
export const daemonHost = (
  config: Config,
  options: DaemonHostOptions = {},
): Effect.Effect<DaemonHost> =>
  Effect.gen(function* () {
    const timing = timingOf(options)
    const child = yield* Ref.make<ChildProcess | undefined>(undefined)
    const supervised = config.daemonUrl === undefined

    const clear = Effect.gen(function* () {
      const current = yield* Ref.get(child)

      if (current !== undefined) yield* Effect.sync(() => current.removeAllListeners())

      yield* Ref.set(child, undefined)
    })

    const waitForSocket = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const deadline = Date.now() + timing.startTimeoutMs

        while (Date.now() < deadline) {
          if (yield* isListening(config.socketPath, timing.connectTimeoutMs)) return true
          yield* Effect.sleep(Duration.millis(timing.socketPollMs))
        }

        return false
      })

    const backoff = (attempt: number): Effect.Effect<void> =>
      Effect.sleep(
        Duration.millis(
          Math.min(timing.backoffBaseMs * Math.pow(2, attempt - 1), timing.backoffMaxMs),
        ),
      )

    /** Ends a spawn attempt that did not produce a daemon, and its stale socket. */
    const abandon = (started: ChildProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          started.kill("SIGKILL")
          rmSync(config.socketPath, { force: true })
        })
        yield* clear
      })

    const spawnUntilListening: Effect.Effect<void, DaemonUnavailable> = Effect.gen(function* () {
      for (let attempt = 1; attempt <= timing.retryAttempts; attempt++) {
        yield* Effect.sync(() => rmSync(config.socketPath, { force: true }))

        const started = yield* spawnDaemon(config)

        yield* Ref.set(child, started)
        started.once("exit", () => {
          // A daemon that exits stops owning the socket; the next call respawns.
          rmSync(config.socketPath, { force: true })
        })

        if (yield* waitForSocket()) return

        yield* abandon(started)

        if (attempt < timing.retryAttempts) yield* backoff(attempt)
      }

      return yield* Effect.fail(
        new DaemonUnavailable({
          message: "the daemon did not start listening",
          detail: config.socketPath + " after " + String(timing.retryAttempts) + " attempts",
        }),
      )
    })

    const ensure: Effect.Effect<void, DaemonUnavailable> = Effect.gen(function* () {
      // A reuse probe is cheap: one connect against a socket that should exist.
      if (supervised && (yield* isListening(config.socketPath, timing.connectTimeoutMs))) return

      if (!supervised) return

      yield* spawnUntilListening
    })

    const stop = Effect.gen(function* () {
      const current = yield* Ref.get(child)

      if (current === undefined) return

      yield* clear
      yield* Effect.sync(() => {
        try {
          current.kill("SIGTERM")
        } catch {
          // Already gone; nothing to stop.
        }
      })
      yield* Effect.sleep(Duration.millis(timing.shutdownMs))
      yield* Effect.sync(() => {
        try {
          current.kill("SIGKILL")
        } catch {
          // Exit is the expected outcome of the grace period.
        }
      })
      yield* Effect.sync(() => rmSync(config.socketPath, { force: true }))
    })

    return { ensure, childPid: Ref.get(child).pipe(Effect.map((value) => value?.pid)), stop }
  })
