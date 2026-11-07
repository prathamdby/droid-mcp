import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { rmSync, statSync } from "node:fs"
import { connect } from "node:net"

import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"

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

const isLive = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null

/**
 * A listening socket is the daemon's whole health signal: the socket file can
 * outlive the process that created it, so connecting is what counts.
 */
const isListening = (path: string, timeoutMs = 500): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ path })
    let settled = false

    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
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

    return Effect.sync(() => {
      if (settled) return
      settled = true
      socket.destroy()
    })
  })

const waitForExit = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!isLive(child)) {
      resume(Effect.void)

      return
    }

    const onExit = (): void => {
      resume(Effect.void)
    }

    child.once("exit", onExit)

    if (!isLive(child)) {
      child.removeListener("exit", onExit)
      resume(Effect.void)

      return
    }

    return Effect.sync(() => {
      child.removeListener("exit", onExit)
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
    let settled = false

    const succeed = (value: ChildProcess): void => {
      if (settled) return
      settled = true
      resume(Effect.succeed(value))
    }

    const fail = (detail: string): void => {
      if (settled) return
      settled = true
      resume(Effect.fail(unavailable(detail)))
    }

    try {
      child = spawn(config.droidPath, args, { detached: false, stdio: "ignore" })
    } catch {
      fail(config.droidPath)

      return
    }

    if (child.pid !== undefined) {
      succeed(child)

      return
    }

    // A missing or non-executable binary reports why on the next tick as an
    // 'error' event, which crashes the process unless a listener is already set.
    child.once("error", (cause) => {
      fail(cause.message)
    })

    return Effect.sync(() => {
      if (settled) return
      settled = true

      try {
        child.kill("SIGKILL")
      } catch {
        // The spawn never became a process.
      }
    })
  })
}

interface SocketIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

const statSocket = (path: string): SocketIdentity | undefined => {
  try {
    const stat = statSync(path, { bigint: true })

    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return undefined
  }
}

const sameSocket = (left: SocketIdentity | undefined, right: SocketIdentity | undefined): boolean =>
  left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino

const removeSocket = (path: string): void => {
  try {
    rmSync(path, { force: true })
  } catch {
    // Already gone.
  }
}

/**
 * Unlinks `path` only when it still names `recorded`.
 * stat and unlink are not one operation: a replacement created between them
 * can be removed, and a directory entry cannot be unlinked by inode. Inodes
 * can also be reused after the old socket is gone. This is not path ownership.
 */
const removeIdentity = (path: string, recorded: SocketIdentity | undefined): void => {
  if (!sameSocket(recorded, statSocket(path))) return
  removeSocket(path)
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
    const lock = yield* Semaphore.make(1)
    const supervised = config.daemonUrl === undefined
    let owned: ChildProcess | undefined
    let socketIdentity: SocketIdentity | undefined

    const assign = (next: ChildProcess | undefined): Effect.Effect<void> =>
      Effect.sync(() => {
        owned = next
      }).pipe(Effect.andThen(Ref.set(child, next)))

    const forgetOwned = (started: ChildProcess): void => {
      if (owned !== started) return
      owned = undefined
      Effect.runSync(Ref.set(child, undefined))
    }

    const rememberSocket = (): void => {
      if (socketIdentity !== undefined) return
      socketIdentity = statSocket(config.socketPath)
    }

    const withLock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Semaphore.withPermit(lock)(effect)

    const waitForSocket = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const deadline = Date.now() + timing.startTimeoutMs

        while (Date.now() < deadline) {
          if (yield* isListening(config.socketPath, timing.connectTimeoutMs)) {
            yield* Effect.sync(rememberSocket)

            return true
          }

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
        if (owned === started) yield* assign(undefined)
        yield* Effect.sync(() => {
          started.removeAllListeners()

          try {
            started.kill("SIGKILL")
          } catch {
            // Already exited.
          }

          // Not listening yet, so this path is not a live replacement. A
          // non-listening file still cannot be proved stale.
          if (owned !== undefined) return
          const recorded = socketIdentity
          socketIdentity = undefined

          if (recorded !== undefined) {
            removeIdentity(config.socketPath, recorded)

            return
          }

          removeSocket(config.socketPath)
        })
      })

    const noteExit = (started: ChildProcess): void => {
      started.once("exit", () => {
        // A newer child, or stop(), has already taken ownership of the ref.
        if (owned !== started) return
        const recorded = socketIdentity
        forgetOwned(started)
        socketIdentity = undefined
        removeIdentity(config.socketPath, recorded)
      })
    }

    const spawnUntilListening: Effect.Effect<void, DaemonUnavailable> = Effect.gen(function* () {
      for (let attempt = 1; attempt <= timing.retryAttempts; attempt++) {
        const current = yield* Ref.get(child)

        if (current !== undefined && isLive(current)) {
          if (yield* waitForSocket()) return
          yield* abandon(current)
        }

        // A listening socket is reused before this loop. A path that is not
        // accepting is removed so bind can succeed; that file may belong to
        // an owner that has not called listen yet.
        yield* Effect.sync(() => {
          socketIdentity = undefined
          removeSocket(config.socketPath)
        })

        const started = yield* spawnDaemon(config)

        yield* assign(started)
        noteExit(started)

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

    const ensure: Effect.Effect<void, DaemonUnavailable> = withLock(
      Effect.gen(function* () {
        if (!supervised) return

        // A reuse probe is cheap: one connect against a socket that should exist.
        if (yield* isListening(config.socketPath, timing.connectTimeoutMs)) return

        const current = yield* Ref.get(child)

        if (current !== undefined && isLive(current)) {
          if (yield* waitForSocket()) return
          yield* abandon(current)
        }

        yield* spawnUntilListening
      }),
    )

    const stop = withLock(
      Effect.gen(function* () {
        const current = yield* Ref.get(child)

        if (current === undefined) return

        const recorded = socketIdentity
        const exited = waitForExit(current)
        yield* assign(undefined)
        yield* Effect.sync(() => {
          socketIdentity = undefined

          try {
            current.kill("SIGTERM")
          } catch {
            // Already gone; nothing to stop.
          }
        })

        const graceful = yield* Effect.raceFirst(
          exited.pipe(Effect.as(true)),
          Effect.sleep(Duration.millis(timing.shutdownMs)).pipe(Effect.as(false)),
        )

        if (!graceful) {
          yield* Effect.sync(() => {
            try {
              current.kill("SIGKILL")
            } catch {
              // Exit is the expected outcome of the grace period.
            }
          })
          yield* waitForExit(current)
        }

        yield* Effect.sync(() => {
          current.removeAllListeners()
          removeIdentity(config.socketPath, recorded)
        })
      }),
    )

    return {
      ensure,
      childPid: Ref.get(child).pipe(
        Effect.map((value) => (value !== undefined && isLive(value) ? value.pid : undefined)),
      ),
      stop,
    }
  })
