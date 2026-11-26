/**
 * Child-process spawn and line transport for the local executable. Everything
 * here is module-internal: the child handle, its pipes, the launch
 * environment and the stderr buffer never leave `private/`.
 *
 * Lines are enqueued as they arrive, before any consumer attaches, so a
 * completion or challenge that races a send reply is already captured. Exit
 * is an observed fact with an optional collected stderr tail.
 */
import { spawn } from "node:child_process"

import type { Done } from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"

export interface PeerExitFact {
  readonly code: number | null
  readonly signal: string | null
}

export class TransportWriteFailed extends Schema.TaggedError<TransportWriteFailed>()(
  "TransportWriteFailed",
  {
    message: Schema.String,
    detail: Schema.String,
  },
) {}

export class TransportSpawnFailed extends Schema.TaggedError<TransportSpawnFailed>()(
  "TransportSpawnFailed",
  {
    message: Schema.String,
    detail: Schema.String,
  },
) {}

export interface ExecTransportOptions {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Record<string, string>
  /** Cap for one stdout line; a peer past it is not speaking the protocol. */
  readonly lineLimitBytes: number
  /** Cap for the collected stderr tail. */
  readonly stderrLimitBytes: number
}

export interface ExecTransport {
  /** Writes one frame followed by a newline. Fails after the peer is gone. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, TransportWriteFailed>
  /**
   * Every complete stdout line, in arrival order. Reading starts at spawn,
   * before the first write, so fast peer output is never lost. The queue
   * ends when stdout closes.
   */
  readonly lines: Queue.Queue<string, Done>
  /** The bounded stderr tail; the caller scrubs it before disclosure. */
  readonly stderrTail: () => string
  /** The observed exit fact; completes exactly once. */
  readonly exit: Deferred.Deferred<PeerExitFact, never>
  /** True once the process exit has been observed. */
  readonly hasExited: () => boolean
  /** Closes stdin, then escalates SIGTERM/SIGKILL inside bounded windows. */
  readonly close: Effect.Effect<void>
}

/**
 * Spawns the executable and starts reading stdout immediately, so no peer
 * output produced between spawn and consumer attachment is ever dropped.
 */
export const spawnTransport = (
  options: ExecTransportOptions,
): Effect.Effect<ExecTransport, TransportSpawnFailed> =>
  Effect.gen(function* () {
    const env = { ...options.env }

    const child = yield* Effect.callback<ReturnType<typeof spawn>, TransportSpawnFailed>(
      (resume) => {
        let spawned: ReturnType<typeof spawn>

        try {
          spawned = spawn(options.executable, [...options.args], {
            cwd: options.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          })
        } catch (cause) {
          resume(
            Effect.fail(
              new TransportSpawnFailed({
                message: "the local executable could not be started",
                detail: cause instanceof Error ? cause.message : "spawn failed",
              }),
            ),
          )

          return
        }

        if (spawned.pid !== undefined) {
          resume(Effect.succeed(spawned))

          return
        }

        spawned.once("error", (cause) => {
          resume(
            Effect.fail(
              new TransportSpawnFailed({
                message: "the local executable could not be started",
                detail: cause.message,
              }),
            ),
          )
        })

        // If the error event never fires the callback suspends; the caller's
        // own timeout bounds initialization.
      },
    )

    // SAFETY: the spawn options above fix `stdio` to pipes for all three
    // streams, so these handles are never null.
    const stdin = child.stdin!
    const stdout = child.stdout!
    const stderr = child.stderr!

    stdin.on("error", () => {})
    stdout.on("error", () => {})
    stderr.on("error", () => {})

    const exit = Deferred.makeUnsafe<PeerExitFact, never>()
    const stderrChunks: Array<Buffer> = []

    let stderrBytes = 0
    let buffered = ""
    let exited = false

    const lines = yield* Queue.unbounded<string, Done>()

    const stderrTail = (): string => Buffer.concat(stderrChunks).toString("utf8")

    const pushStderr = (chunk: Buffer): void => {
      if (chunk.length === 0 || options.stderrLimitBytes <= 0) return

      stderrChunks.push(chunk)
      stderrBytes += chunk.length

      while (stderrBytes > options.stderrLimitBytes && stderrChunks.length > 0) {
        const head = stderrChunks[0]

        if (head === undefined) break

        const overflow = stderrBytes - options.stderrLimitBytes

        if (head.length <= overflow) {
          stderrChunks.shift()
          stderrBytes -= head.length
        } else {
          stderrChunks[0] = head.subarray(overflow)
          stderrBytes = options.stderrLimitBytes
        }
      }
    }

    const acceptLine = (line: string): void => {
      if (line.trim().length === 0) return

      if (Buffer.byteLength(line, "utf8") > options.lineLimitBytes) return

      Queue.offerUnsafe(lines, line)
    }

    const flushTail = (): void => {
      const line = buffered
      buffered = ""

      acceptLine(line)
    }

    const consume = (chunk: string): void => {
      buffered += chunk
      const parts = buffered.split("\n")
      buffered = parts.pop() ?? ""

      for (const line of parts) acceptLine(line)
    }

    stdout.setEncoding("utf8")
    stdout.on("data", (chunk: string) => {
      consume(chunk)
    })
    stdout.on("end", () => {
      flushTail()
      Queue.endUnsafe(lines)
    })
    stderr.on("data", (chunk: Buffer) => {
      pushStderr(chunk)
    })

    const recordExit = (code: number | null, signal: string | null): void => {
      if (exited) return
      exited = true
      flushTail()
      Deferred.doneUnsafe(exit, Effect.succeed({ code, signal }))
    }

    child.on("exit", (code, signal) => {
      recordExit(code, signal)
    })
    child.on("error", () => {
      recordExit(null, null)
    })

    const write = (bytes: Uint8Array): Effect.Effect<void, TransportWriteFailed> =>
      Effect.suspend(() => {
        if (exited) {
          return Effect.fail(
            new TransportWriteFailed({
              message: "the local executable is not running",
              detail: "peer exited",
            }),
          )
        }

        if (stdin.destroyed || !stdin.writable) {
          return Effect.fail(
            new TransportWriteFailed({
              message: "cannot write to the local executable",
              detail: "stdin closed",
            }),
          )
        }

        const payload = Buffer.concat([Buffer.from(bytes), Buffer.from("\n")])

        return Effect.callback<void, TransportWriteFailed>((resume) => {
          try {
            stdin.write(payload, (error) => {
              if (error !== undefined && error !== null) {
                resume(
                  Effect.fail(
                    new TransportWriteFailed({
                      message: "cannot write to the local executable",
                      detail: error.message,
                    }),
                  ),
                )

                return
              }

              resume(Effect.void)
            })
          } catch {
            resume(
              Effect.fail(
                new TransportWriteFailed({
                  message: "cannot write to the local executable",
                  detail: "write failed",
                }),
              ),
            )
          }
        })
      })

    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        if (!exited && !stdin.destroyed && stdin.writable) stdin.end()

        const graceful = yield* Effect.raceFirst(
          Deferred.await(exit).pipe(Effect.as(true)),
          Effect.sleep("2 seconds").pipe(Effect.as(false)),
        )

        if (!graceful) {
          try {
            child.kill("SIGTERM")
          } catch {
            // Already exited.
          }

          const terminated = yield* Effect.raceFirst(
            Deferred.await(exit).pipe(Effect.as(true)),
            Effect.sleep("2 seconds").pipe(Effect.as(false)),
          )

          if (!terminated) {
            try {
              child.kill("SIGKILL")
            } catch {
              // Already exited.
            }
          }
        }

        yield* Deferred.await(exit)
      }),
    )

    return {
      write,
      lines,
      stderrTail,
      exit,
      hasExited: () => exited,
      close,
    }
  })
