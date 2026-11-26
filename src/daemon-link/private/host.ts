/**
 * Owned-daemon process management, module-internal to `daemon-link`. Spawns
 * the configured command, waits until its socket accepts connections, and
 * terminates the child on disposal with a bounded grace period. Borrowed
 * daemons never come through this file: there is no scanning, no reaper and
 * no signal sent to anything this module did not spawn.
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { connect } from "node:net"

import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"

export interface DaemonEndpoint {
  readonly socketPath?: string
  readonly host?: string
  readonly port?: number
}

export class HostUnavailable {
  readonly message: string

  constructor(message: string) {
    this.message = message
  }
}

const isLive = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null

/**
 * A listening socket is the daemon's whole health signal: the socket file
 * can outlive the process that created it, so connecting is what counts.
 */
export const isListening = (endpoint: DaemonEndpoint, timeoutMs = 500): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const target =
      endpoint.socketPath === undefined
        ? { host: endpoint.host ?? "127.0.0.1", port: endpoint.port ?? 0 }
        : { path: endpoint.socketPath }

    const socket = connect(target)
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

export interface SpawnOptions {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly endpoint: DaemonEndpoint
  readonly startTimeoutMs: number
  readonly socketPollMs: number
  readonly connectTimeoutMs: number
  readonly shutdownGraceMs: number
}

/** A spawned daemon together with its idempotent termination effect. */
export interface ManagedDaemon {
  readonly endpoint: DaemonEndpoint
  readonly terminate: Effect.Effect<void>
}

const spawnChild = (options: SpawnOptions): Effect.Effect<ChildProcess, HostUnavailable> =>
  Effect.callback<ChildProcess, HostUnavailable>((resume) => {
    let spawned: ChildProcess
    let settled = false

    const fail = (detail: string): void => {
      if (settled) return
      settled = true
      resume(Effect.fail(new HostUnavailable(detail)))
    }

    const succeed = (value: ChildProcess): void => {
      if (settled) return
      settled = true
      resume(Effect.succeed(value))
    }

    try {
      spawned = spawn(options.command, [...options.args], { detached: false, stdio: "ignore" })
    } catch {
      fail(options.command + " could not be executed")

      return
    }

    if (spawned.pid !== undefined) {
      succeed(spawned)

      return
    }

    spawned.once("error", (cause) => {
      fail(cause.message)
    })

    return Effect.sync(() => {
      if (settled) return
      settled = true

      try {
        spawned.kill("SIGKILL")
      } catch {
        // The spawn never became a process.
      }
    })
  })

const terminateChild = (child: ChildProcess, shutdownGraceMs: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!isLive(child)) return

    yield* Effect.sync(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // Already gone; nothing to stop.
      }
    })

    const graceful = yield* Effect.raceFirst(
      waitForExit(child).pipe(Effect.as(true)),
      Effect.sleep(Duration.millis(shutdownGraceMs)).pipe(Effect.as(false)),
    )

    if (!graceful) {
      yield* Effect.sync(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // Exit is the expected outcome of the grace period.
        }
      })
      yield* waitForExit(child)
    }
  })

/**
 * Spawns the daemon command and waits until its endpoint accepts. A child
 * that exits or never listens within the startup window is terminated before
 * the failure is reported, so no orphan survives a failed acquisition.
 * `terminate` SIGTERMs the child, escalates to SIGKILL after the grace
 * window and waits for exit.
 */
export const spawnManaged = (
  options: SpawnOptions,
): Effect.Effect<ManagedDaemon, HostUnavailable> =>
  Effect.gen(function* () {
    const child = yield* spawnChild(options)
    const terminate = terminateChild(child, options.shutdownGraceMs)

    const deadline = Date.now() + options.startTimeoutMs
    let ready = false

    while (Date.now() < deadline) {
      if (!isLive(child)) break

      if (yield* isListening(options.endpoint, options.connectTimeoutMs)) {
        ready = true
        break
      }

      yield* Effect.sleep(Duration.millis(options.socketPollMs))
    }

    if (!ready) {
      yield* terminate

      return yield* Effect.fail(new HostUnavailable("the spawned daemon did not start listening"))
    }

    return { endpoint: options.endpoint, terminate }
  })
