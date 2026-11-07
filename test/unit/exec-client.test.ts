import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Duration, Effect, Fiber, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"

import type { ExecError } from "../../src/droid/errors.ts"
import { start } from "../../src/droid/exec-client.ts"
import type { ExecClient } from "../../src/droid/exec-client.ts"
import { EXEC_METHOD } from "../../src/droid/exec-protocol.ts"

const here = dirname(fileURLToPath(import.meta.url))
const fakePath = join(here, "..", "support", "fake-droid-exec.mjs")
const transportPath = join(here, "..", "support", "fake-exec-transport.mjs")
const version = "0.1.0"

const SessionNotificationWire = Schema.Struct({
  notification: Schema.Struct({ type: Schema.String }),
})

const withClient = <A, E>(
  run: (client: ExecClient) => Effect.Effect<A, E>,
): Effect.Effect<A, ExecError | E> =>
  Effect.scoped(
    Effect.acquireRelease(
      start({
        droidPath: process.execPath,
        args: [fakePath],
        cwd: here,
        version,
        requestTimeoutMs: 5_000,
      }),
      (client) => client.close,
    ).pipe(Effect.flatMap(run)),
  )

const initialize = (client: ExecClient): Effect.Effect<unknown, ExecError> =>
  client.request({ method: EXEC_METHOD.initialize, params: { machineId: "local", cwd: here } })

describe("exec client", () => {
  it("initializes a session and adopts the CLI protocol version", async () => {
    const result = await Effect.runPromise(
      withClient((client) =>
        Effect.gen(function* () {
          const initialized = yield* initialize(client)
          const protocol = yield* client.protocolVersion

          return { initialized, protocol, pid: client.pid }
        }),
      ),
    )

    expect(result.initialized).toMatchObject({ sessionId: "fake-session" })
    expect(result.protocol).toBe("1.299.0")
    expect(result.pid).toBeGreaterThan(0)
  })

  it("correlates concurrent requests by id", async () => {
    const results = await Effect.runPromise(
      withClient((client) =>
        Effect.all(
          [
            initialize(client),
            client.request({
              method: EXEC_METHOD.updateSettings,
              params: { autonomyLevel: "low" },
            }),
            client.request({ method: EXEC_METHOD.addUserMessage, params: { text: "echo:one" } }),
          ],
          { concurrency: "unbounded" },
        ),
      ),
    )

    expect(results[0]).toMatchObject({ sessionId: "fake-session" })
    expect(results[1]).toMatchObject({ method: "droid.update_session_settings" })
    expect(results[2]).toEqual({})
  })

  it("delivers notifications and reassembles lines split across writes", async () => {
    const notification = await Effect.runPromise(
      withClient((client) =>
        Effect.gen(function* () {
          yield* initialize(client)
          const fiber = yield* Stream.runHead(client.notifications).pipe(Effect.forkChild)
          yield* client.request({ method: EXEC_METHOD.addUserMessage, params: { text: "split" } })

          return yield* Fiber.join(fiber)
        }),
      ),
    )

    const decoded = Option.flatMap(notification, (value) =>
      Schema.decodeUnknownOption(SessionNotificationWire)(value.params),
    )

    expect(Option.map(decoded, (value) => value.notification.type)).toEqual(
      Option.some("assistant_text_delta"),
    )
  })

  it("surfaces a prompt request to the caller", async () => {
    const request = await Effect.runPromise(
      withClient((client) =>
        Effect.gen(function* () {
          yield* initialize(client)
          const fiber = yield* Stream.runHead(client.requests).pipe(Effect.forkChild)
          yield* client.request({
            method: EXEC_METHOD.addUserMessage,
            params: { text: "permission" },
          })

          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(Option.map(request, (value) => value.method)).toEqual(
      Option.some(EXEC_METHOD.requestPermission),
    )
    expect(Option.map(request, (value) => value.id)).toEqual(Option.some("prompt-1"))
  })

  it("captures stderr and fails a pending request when the child exits", async () => {
    const outcome = await Effect.runPromise(
      withClient((client) =>
        Effect.gen(function* () {
          yield* initialize(client)

          const failure = yield* client
            .request({ method: EXEC_METHOD.addUserMessage, params: { text: "crash" } })
            .pipe(Effect.flip)

          const exit = yield* client.exited

          return { failure, exit }
        }),
      ),
    )

    expect(outcome.failure._tag).toBe("ExecFailed")
    expect(outcome.exit.code).toBe(3)
    expect(outcome.exit.stderr).toContain("boom")
  })

  it("fails without crashing when the droid binary is missing", async () => {
    const failure = await Effect.runPromise(
      start({ droidPath: join(here, "missing-droid"), cwd: here, version }).pipe(Effect.flip),
    )

    expect(failure._tag).toBe("ExecFailed")
    expect(failure.detail).toContain("ENOENT")
  })

  it("times out a request that never answers", async () => {
    const outcome = await Effect.runPromise(
      withClient((client) =>
        Effect.gen(function* () {
          yield* initialize(client)

          const failure = yield* client
            .request({ method: "droid.silent", timeoutMs: 50 })
            .pipe(Effect.flip)

          return failure
        }),
      ),
    )

    expect(outcome._tag).toBe("ExecTimeout")
  })

  it("accepts one valid final line that has no newline", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* start({
          droidPath: process.execPath,
          args: [transportPath],
          cwd: here,
          version,
          env: { FAKE_EXEC_TRANSPORT_MODE: "unterminated" },
          requestTimeoutMs: 2_000,
        })

        const value = yield* client.request({ method: "droid.initialize", params: {} })
        yield* client.close

        return value
      }),
    )

    expect(result).toEqual({ sessionId: "tail" })
  })

  it("fails a line that grows past the stdout cap", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* start({
          droidPath: process.execPath,
          args: [transportPath],
          cwd: here,
          version,
          env: { FAKE_EXEC_TRANSPORT_MODE: "huge-line" },
          stdoutLineLimitBytes: 64,
          requestTimeoutMs: 2_000,
        })

        const error = yield* client
          .request({ method: "droid.initialize", params: {} })
          .pipe(Effect.flip)

        yield* client.close

        return error
      }),
    )

    expect(failure._tag).toBe("ExecFailed")
    expect(failure.message).toContain("line cap")
  })

  it("records the exit before close returns when SIGTERM is ignored", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* start({
          droidPath: process.execPath,
          args: [transportPath],
          cwd: here,
          version,
          env: { FAKE_EXEC_TRANSPORT_MODE: "ignore-term" },
          shutdownTimeoutMs: 100,
        })

        yield* Effect.all([client.close, client.close], { concurrency: "unbounded" })

        return yield* client.exited.pipe(Effect.timeoutOption(Duration.millis(0)))
      }),
    )

    expect(Option.isSome(exit)).toBe(true)

    if (Option.isSome(exit)) expect(exit.value.signal).toBe("SIGKILL")
  })

  it("fails a write after the child has already exited", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* start({
          droidPath: process.execPath,
          args: [transportPath],
          cwd: here,
          version,
          env: { FAKE_EXEC_TRANSPORT_MODE: "exit-now" },
          requestTimeoutMs: 1_000,
        })

        const error = yield* client
          .request({ method: "droid.initialize", params: {} })
          .pipe(Effect.flip)

        yield* client.close

        return error
      }),
    )

    expect(failure._tag).toBe("ExecFailed")
  })

  it("keeps only the trailing stderr bytes", async () => {
    const stderr = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* start({
          droidPath: process.execPath,
          args: [transportPath],
          cwd: here,
          version,
          env: { FAKE_EXEC_TRANSPORT_MODE: "stderr-bytes" },
          stderrLimitBytes: 4,
          requestTimeoutMs: 2_000,
        })

        yield* client.request({ method: "droid.initialize", params: {} })
        const exit = yield* client.exited
        yield* client.close

        return exit.stderr
      }),
    )

    expect(stderr).not.toBe("ééé")
    expect(Buffer.byteLength(stderr, "utf8")).toBeLessThanOrEqual(8)
  })

  it("completes notification subscribers when the child closes", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* start({
          droidPath: process.execPath,
          args: [fakePath],
          cwd: here,
          version,
          requestTimeoutMs: 2_000,
        })

        const fiber = yield* Stream.runCollect(client.notifications).pipe(Effect.forkChild)
        yield* client.close

        return yield* Fiber.join(fiber).pipe(Effect.timeout(Duration.seconds(2)))
      }),
    )

    expect([...collected]).toEqual([])
  })

  it("drops an interrupted request before the next one", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* start({
          droidPath: process.execPath,
          args: [fakePath],
          cwd: here,
          version,
          requestTimeoutMs: 5_000,
        })

        const hanging = yield* client
          .request({ method: "droid.silent", timeoutMs: 5_000 })
          .pipe(Effect.forkChild)

        yield* Effect.sleep(Duration.millis(50))
        yield* Fiber.interrupt(hanging)
        const initialized = yield* initialize(client)
        yield* client.close

        return initialized
      }),
    )

    expect(result).toMatchObject({ sessionId: "fake-session" })
  })
})
