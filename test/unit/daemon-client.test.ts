import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Duration, Effect, Fiber, Option, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { openDaemon } from "../../src/droid/daemon-client.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedHandler, ScriptedReply } from "../support/fake-daemon.ts"

const socketPath = (): string => join(mkdtempSync(join(tmpdir(), "droid-mcp-daemon-")), "d.sock")

let daemon: FakeDaemon | undefined

afterEach(async () => {
  if (daemon !== undefined) {
    await daemon.close()
    daemon = undefined
  }
})

const start = async (handler: ScriptedHandler): Promise<FakeDaemon> => {
  daemon = await startFakeDaemon(socketPath(), handler)

  return daemon
}

describe("daemon client", () => {
  it("sends the SDK identity when authenticating", async () => {
    const fake = await start({
      onRequest: (request): ScriptedReply =>
        request.method === "daemon.authenticate"
          ? { result: { userId: "user-1", orgId: "org-1" } }
          : { result: { sessions: [] } },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })
        const auth = yield* client.authenticate("secret-key")
        yield* client.close

        return auth
      }),
    )

    expect(result).toEqual({ userId: "user-1", orgId: "org-1" })
    const authRequest = fake.requests.find((request) => request.method === "daemon.authenticate")
    expect(authRequest?.params).toEqual({
      apiKey: "secret-key",
      caller: "sdk",
      metadata: { sdk: { language: "typescript", version: "0.1.0" } },
    })
    expect(authRequest?.factoryProtocolVersion).toBe("1.269.0")
  })

  it("maps a credential rejection to DaemonAuthRejected", async () => {
    const fake = await start({
      onRequest: () => ({ error: { code: -32001, message: "Internal error" } }),
    })

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })
        const failed = yield* Effect.flip(client.authenticate("bad-key"))
        yield* client.close

        return failed
      }),
    )

    expect(error._tag).toBe("DaemonAuthRejected")
    expect(error.message).toContain("Factory API key")
  })

  it("adopts the daemon protocol version and retries once", async () => {
    const fake = await start({
      onRequest: (request) => {
        if (request.factoryProtocolVersion !== "1.299.0") {
          return {
            error: {
              code: -32601,
              message: "Method not found",
              data: {
                protocolVersionMismatch: {
                  localFactoryProtocolVersion: "1.299.0",
                  peerFactoryProtocolVersion: request.factoryProtocolVersion,
                },
              },
            },
          }
        }

        return { result: { sessions: [{ id: "a" }, { id: "b" }] } }
      },
    })

    const program = Effect.gen(function* () {
      const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })
      const result = yield* client.request({ method: "daemon.list_opened_sessions", params: {} })
      const version = yield* client.protocolVersion
      yield* client.close

      return { result, version }
    })

    const outcome = await Effect.runPromise(program)
    expect(outcome.version).toBe("1.299.0")
    expect(outcome.result).toEqual({ sessions: [{ id: "a" }, { id: "b" }] })
    expect(fake.requests.map((request) => request.factoryProtocolVersion)).toEqual([
      "1.269.0",
      "1.299.0",
    ])
  })

  it("fails once when the adopted version is rejected too", async () => {
    const fake = await start({
      onRequest: (request) => ({
        error: {
          code: -32001,
          message: "Internal error",
          data: {
            protocolVersionMismatch: {
              localFactoryProtocolVersion: "9.9.9",
              peerFactoryProtocolVersion: request.factoryProtocolVersion,
            },
          },
        },
      }),
    })

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })

        const failed = yield* Effect.flip(
          client.request({ method: "daemon.list_opened_sessions", params: {} }),
        )

        yield* client.close

        return failed
      }),
    )

    expect(error._tag).toBe("DaemonProtocolError")
    expect(error.message).toContain("rejected the adopted protocol version")
    expect(fake.requests.length).toBe(2)
  })

  it("times out a request that never answers", async () => {
    const fake = await start({ onRequest: () => undefined })

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })

        const failed = yield* Effect.flip(
          client.request({ method: "daemon.list_opened_sessions", params: {}, timeoutMs: 100 }),
        )

        yield* client.close

        return failed
      }),
    )

    expect(error._tag).toBe("DaemonTimeout")
  })

  it("maps an unknown method to DaemonProtocolError", async () => {
    const fake = await start({
      onRequest: () => ({ error: { code: -32601, message: "Method not found" } }),
    })

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })
        const failed = yield* Effect.flip(client.request({ method: "daemon.nope", params: {} }))
        yield* client.close

        return failed
      }),
    )

    expect(error._tag).toBe("DaemonProtocolError")
    expect(error.message).toContain("daemon.nope")
  })

  it("routes daemon notifications to subscribers", async () => {
    const fake = await start({
      onRequest: (request): ScriptedReply =>
        request.method === "daemon.authenticate"
          ? { result: { userId: "u", orgId: "o" } }
          : { result: { sessions: [] } },
    })

    const program = Effect.gen(function* () {
      const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })
      yield* client.authenticate("secret-key")
      fake.push({
        jsonrpc: "2.0",
        type: "notification",
        method: "session.notification",
        params: { sessionId: "s-1" },
      })
      const received = yield* Stream.runHead(client.notifications).pipe(Effect.forkChild)
      const message = yield* Fiber.join(received)
      yield* client.close

      return message
    })

    const message = await Effect.runPromise(program)
    expect(Option.isSome(message)).toBe(true)

    if (Option.isSome(message)) {
      expect(message.value.method).toBe("session.notification")
      expect(message.value.params).toEqual({ sessionId: "s-1" })
    }
  })

  it("fails pending requests when the socket closes", async () => {
    const fake = await start({ onRequest: () => undefined })

    const program = Effect.gen(function* () {
      const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })

      const pendingRequest = yield* client
        .request({ method: "daemon.list_opened_sessions", params: {}, timeoutMs: 5_000 })
        .pipe(Effect.flip, Effect.forkChild)

      yield* Effect.sleep(50)
      yield* Effect.promise(() => fake.close())
      daemon = undefined

      return yield* Fiber.join(pendingRequest)
    })

    const error = await Effect.runPromise(program)
    expect(error._tag).toBe("DaemonUnavailable")
  })

  it("answers a later request after an earlier one is interrupted", async () => {
    let seen = 0

    const fake = await start({
      onRequest: () => {
        seen += 1

        if (seen === 1) return undefined

        return { result: { sessions: [{ id: "next" }] } }
      },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })

        const hanging = yield* client
          .request({ method: "daemon.list_opened_sessions", params: {}, timeoutMs: 5_000 })
          .pipe(Effect.forkChild)

        yield* Effect.sleep(Duration.millis(50))
        yield* Fiber.interrupt(hanging)

        const value = yield* client.request({
          method: "daemon.list_opened_sessions",
          params: {},
        })

        yield* client.close

        return value
      }),
    )

    expect(result).toEqual({ sessions: [{ id: "next" }] })
  })

  it("completes notification subscribers when the client closes", async () => {
    const fake = await start({
      onRequest: () => ({ result: { userId: "u", orgId: "o" } }),
    })

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* openDaemon({ socketPath: fake.socketPath, version: "0.1.0" })
        const fiber = yield* Stream.runCollect(client.notifications).pipe(Effect.forkChild)
        yield* client.close

        return yield* Fiber.join(fiber).pipe(Effect.timeout(Duration.seconds(2)))
      }),
    )

    expect([...collected]).toEqual([])
  })
})
