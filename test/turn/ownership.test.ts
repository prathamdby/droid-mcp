import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Effect, Option } from "effect"
import * as Fiber from "effect/Fiber"
import { describe, expect, it } from "vitest"

import type { SessionHub } from "../../src/droid/turns.ts"
import { createSession, fakeHub, tempCwd } from "../support/hub.ts"

const track = () => {
  const dir = mkdtempSync(join(tmpdir(), "droid-mcp-pid-"))
  const pidfile = join(dir, "pid")

  const pid = (): number | undefined => {
    try {
      const value = Number(readFileSync(pidfile, "utf8"))

      if (!Number.isInteger(value) || value <= 0) return undefined

      return value
    } catch {
      return undefined
    }
  }

  const alive = (value: number): boolean => {
    try {
      process.kill(value, 0)

      return true
    } catch {
      return false
    }
  }

  return {
    pidfile,
    ready: () => {
      const value = pid()

      return value !== undefined && alive(value)
    },
    dead: () => {
      const value = pid()

      return value !== undefined && !alive(value)
    },
    kill: () => {
      const value = pid()

      if (value !== undefined) {
        try {
          process.kill(value, "SIGKILL")
        } catch {
          // The child has already exited.
        }
      }

      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const trackDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "droid-mcp-pids-"))

  const pids = (): Array<number> => {
    try {
      const found: Array<number> = []

      for (const name of readdirSync(dir)) {
        const value = Number(name)

        if (Number.isInteger(value) && value > 0) found.push(value)
      }

      return found
    } catch {
      return []
    }
  }

  const alive = (value: number): boolean => {
    try {
      process.kill(value, 0)

      return true
    } catch {
      return false
    }
  }

  return {
    dir,
    ready: (count: number) => {
      const values = pids()

      return values.length >= count && values.every(alive)
    },
    dead: (count: number) => {
      const values = pids()

      return values.length >= count && values.every((value) => !alive(value))
    },
    kill: () => {
      for (const value of pids()) {
        try {
          process.kill(value, "SIGKILL")
        } catch {
          // The child has already exited.
        }
      }

      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (predicate()) return true

      yield* Effect.sleep("25 millis")
    }

    return predicate()
  })

const scoped = <A, E>(
  hub: Effect.Effect<SessionHub>,
  run: (value: SessionHub) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.acquireRelease(hub, (value) => value.closeAll).pipe(
      Effect.flatMap((value) => run(value)),
    ),
  )

describe("session process ownership", () => {
  it("kills a child whose initialize request times out", async () => {
    const tracker = track()

    try {
      const outcome = await Effect.runPromise(
        scoped(
          fakeHub({
            requestTimeoutMs: 300,
            env: { FAKE_DROID_PIDFILE: tracker.pidfile, FAKE_DROID_INIT: "hang" },
          }),
          (hub) =>
            Effect.gen(function* () {
              const failure = yield* hub.api
                .create({ cwd: tempCwd(), autonomyLevel: "low" })
                .pipe(Effect.flip)

              const died = yield* waitUntil(tracker.dead)
              const sessions = yield* hub.api.sessions

              return { failure, died, sessions }
            }),
        ),
      )

      expect(outcome.failure.code).toBe("exec_timeout")
      expect(outcome.died).toBe(true)
      expect(outcome.sessions).toHaveLength(0)
    } finally {
      tracker.kill()
    }
  })

  it("kills a child whose settings update is rejected", async () => {
    const tracker = track()

    try {
      const outcome = await Effect.runPromise(
        scoped(
          fakeHub({
            env: { FAKE_DROID_PIDFILE: tracker.pidfile, FAKE_DROID_SETTINGS: "reject" },
          }),
          (hub) =>
            Effect.gen(function* () {
              const failure = yield* hub.api
                .create({ cwd: tempCwd(), autonomyLevel: "low" })
                .pipe(Effect.flip)

              const died = yield* waitUntil(tracker.dead)

              return { failure, died }
            }),
        ),
      )

      expect(outcome.failure.code).toBe("exec_failed")
      expect(outcome.died).toBe(true)
    } finally {
      tracker.kill()
    }
  })

  it("kills a child when create is interrupted during initialize", async () => {
    const tracker = track()

    try {
      const outcome = await Effect.runPromise(
        scoped(
          fakeHub({
            requestTimeoutMs: 30_000,
            env: { FAKE_DROID_PIDFILE: tracker.pidfile, FAKE_DROID_INIT: "hang" },
          }),
          (hub) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.forkDetach(
                hub.api.create({ cwd: tempCwd(), autonomyLevel: "low" }),
              )

              const ready = yield* waitUntil(tracker.ready)

              yield* Effect.sleep("40 millis")
              yield* Fiber.interrupt(fiber)
              yield* Fiber.await(fiber)
              const died = yield* waitUntil(tracker.dead)

              return { ready, died }
            }),
        ),
      )

      expect(outcome.ready).toBe(true)
      expect(outcome.died).toBe(true)
    } finally {
      tracker.kill()
    }
  })

  it("shuts down an unregistered child when the hub closes during initialize", async () => {
    const tracker = track()

    try {
      const outcome = await Effect.runPromise(
        scoped(
          fakeHub({
            requestTimeoutMs: 30_000,
            env: { FAKE_DROID_PIDFILE: tracker.pidfile, FAKE_DROID_INIT: "hang" },
          }),
          (hub) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.forkDetach(
                hub.api.create({ cwd: tempCwd(), autonomyLevel: "low" }).pipe(
                  Effect.match({
                    onFailure: (error) => error.code,
                    onSuccess: () => "created",
                  }),
                ),
              )

              const ready = yield* waitUntil(tracker.ready)

              yield* Effect.sleep("40 millis")
              yield* hub.closeAll
              const settled = yield* Fiber.join(fiber)
              const died = yield* waitUntil(tracker.dead)
              const sessions = yield* hub.api.sessions

              return { ready, settled, died, sessions }
            }),
        ),
      )

      expect(outcome.ready).toBe(true)
      expect(outcome.settled).not.toBe("created")
      expect(outcome.died).toBe(true)
      expect(outcome.sessions).toHaveLength(0)
    } finally {
      tracker.kill()
    }
  })

  it("finishes an in-flight turn when the session is closed", async () => {
    const tracker = track()

    try {
      const outcome = await Effect.runPromise(
        scoped(fakeHub({ env: { FAKE_DROID_PIDFILE: tracker.pidfile } }), (hub) =>
          Effect.gen(function* () {
            const sessionId = yield* createSession(hub)

            const fiber = yield* Effect.forkDetach(
              hub.api.stream({ sessionId, prompt: "hang", waitMs: 15_000 }).pipe(
                Effect.match({
                  onFailure: (error) => ({ kind: "failure" as const, code: error.code }),
                  onSuccess: (turn) => ({ kind: "success" as const, status: turn.status }),
                }),
              ),
            )

            yield* Effect.sleep("150 millis")
            yield* hub.api.close(sessionId)
            const settled = yield* Fiber.join(fiber)
            const died = yield* waitUntil(tracker.dead)

            return { settled, died }
          }),
        ),
      )

      expect(outcome.died).toBe(true)

      if (outcome.settled.kind === "success") {
        expect(outcome.settled.status).not.toBe("running")
      } else {
        expect(["session_not_found", "session_closed"]).toContain(outcome.settled.code)
      }
    } finally {
      tracker.kill()
    }
  })

  it("closes sessions one after another without leaving them registered", async () => {
    const outcome = await Effect.runPromise(
      scoped(fakeHub(), (hub) =>
        Effect.gen(function* () {
          for (let index = 0; index < 8; index += 1) {
            const sessionId = yield* createSession(hub)

            yield* hub.api.close(sessionId)
          }

          return yield* hub.api.sessions
        }),
      ),
    )

    expect(outcome).toHaveLength(0)
  })

  it("kills a child when close is interrupted during the close rpc", async () => {
    const tracker = track()
    const marker = join(dirname(tracker.pidfile), "close-request")

    try {
      const outcome = await Effect.runPromise(
        scoped(
          fakeHub({
            requestTimeoutMs: 60_000,
            env: {
              FAKE_DROID_PIDFILE: tracker.pidfile,
              FAKE_DROID_CLOSE: "hang",
              FAKE_DROID_CLOSE_MARKER: marker,
            },
          }),
          (hub) =>
            Effect.gen(function* () {
              const sessionId = yield* createSession(hub)
              const fiber = yield* Effect.forkDetach(hub.api.close(sessionId))
              const pending = yield* waitUntil(() => tracker.ready() && existsSync(marker))
              const hidden = yield* hub.api.sessions

              yield* Fiber.interrupt(fiber)
              const died = tracker.dead()

              yield* hub.closeAll
              const sessions = yield* hub.api.sessions

              return {
                pending,
                hidden: hidden.length,
                died,
                sessions: sessions.length,
                stillDead: tracker.dead(),
              }
            }),
        ),
      )

      expect(outcome.pending).toBe(true)
      expect(outcome.hidden).toBe(0)
      expect(outcome.died).toBe(true)
      expect(outcome.sessions).toBe(0)
      expect(outcome.stillDead).toBe(true)
    } finally {
      tracker.kill()
    }
  })

  it("shuts down a child when closeAll overlaps an in-progress close", async () => {
    const tracker = track()
    const marker = join(dirname(tracker.pidfile), "close-request")

    try {
      const outcome = await Effect.runPromise(
        scoped(
          fakeHub({
            requestTimeoutMs: 60_000,
            env: {
              FAKE_DROID_PIDFILE: tracker.pidfile,
              FAKE_DROID_CLOSE: "hang",
              FAKE_DROID_CLOSE_MARKER: marker,
            },
          }),
          (hub) =>
            Effect.gen(function* () {
              const sessionId = yield* createSession(hub)
              const fiber = yield* Effect.forkDetach(hub.api.close(sessionId))
              const pending = yield* waitUntil(() => tracker.ready() && existsSync(marker))
              const hidden = yield* hub.api.sessions

              yield* hub.closeAll
              const died = tracker.dead()
              const settled = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("2 seconds"))
              const sessions = yield* hub.api.sessions

              return {
                pending,
                hidden: hidden.length,
                died,
                settled: Option.isSome(settled),
                sessions: sessions.length,
              }
            }),
        ),
      )

      expect(outcome.pending).toBe(true)
      expect(outcome.hidden).toBe(0)
      expect(outcome.died).toBe(true)
      expect(outcome.settled).toBe(true)
      expect(outcome.sessions).toBe(0)
    } finally {
      tracker.kill()
    }
  })

  it("keeps create cleanup local to each concurrent run of one effect", async () => {
    const tracker = trackDir()

    try {
      const outcome = await Effect.runPromise(
        scoped(
          fakeHub({
            requestTimeoutMs: 60_000,
            env: { FAKE_DROID_PIDDIR: tracker.dir, FAKE_DROID_INIT: "hang" },
          }),
          (hub) =>
            Effect.gen(function* () {
              const creating = hub.api.create({ cwd: tempCwd(), autonomyLevel: "low" })
              const fiberA = yield* Effect.forkDetach(creating)
              const fiberB = yield* Effect.forkDetach(creating)
              const ready = yield* waitUntil(() => tracker.ready(2))

              yield* Effect.sleep("100 millis")
              yield* Fiber.interrupt(fiberA)
              yield* Fiber.interrupt(fiberB)

              return { ready, died: tracker.dead(2), sessions: yield* hub.api.sessions }
            }),
        ),
      )

      expect(outcome.ready).toBe(true)
      expect(outcome.died).toBe(true)
      expect(outcome.sessions).toHaveLength(0)
    } finally {
      tracker.kill()
    }
  })
})
