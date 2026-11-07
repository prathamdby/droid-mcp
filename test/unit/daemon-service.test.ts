import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Duration, Effect, Fiber } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { daemonLayer, DaemonService } from "../../src/droid/daemon-service.ts"
import type { DaemonApi } from "../../src/droid/daemon-service.ts"
import { DaemonUnavailable } from "../../src/droid/errors.ts"
import type { DaemonError } from "../../src/droid/errors.ts"
import { testConfig } from "../support/config.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedHandler, ScriptedReply } from "../support/fake-daemon.ts"

const socketPath = (): string => join(mkdtempSync(join(tmpdir(), "droid-mcp-service-")), "d.sock")

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

const configFor = (fake: FakeDaemon) =>
  testConfig({
    socketPath: fake.socketPath,
    runtimeDir: dirname(fake.socketPath),
    factoryApiKey: "test-key",
    droidPath: "/bin/false",
    requestTimeoutMs: 2_000,
    initializeTimeoutMs: 2_000,
  })

const authenticated = (
  reply: (request: { method: string; factoryProtocolVersion: string }) => ScriptedReply,
): ScriptedHandler => ({
  onRequest: (request) => {
    if (request.method === "daemon.authenticate") {
      return { result: { userId: "user-1", orgId: "org-1" } }
    }

    return reply(request)
  },
})

const asUnavailable = (error: DaemonError): DaemonUnavailable => {
  if (!(error instanceof DaemonUnavailable)) {
    throw new Error(error._tag)
  }

  return error
}

const mismatch = (version: string): ScriptedReply => ({
  error: {
    code: -32601,
    message: "Method not found",
    data: {
      protocolVersionMismatch: {
        localFactoryProtocolVersion: "1.299.0",
        peerFactoryProtocolVersion: version,
      },
    },
  },
})

const withDaemon = <A, E>(fake: FakeDaemon, use: (api: DaemonApi) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* DaemonService

      return yield* use(api)
    }).pipe(Effect.provide(daemonLayer(configFor(fake)))),
  )

const count = (fake: FakeDaemon, method: string): number =>
  fake.requests.filter((request) => request.method === method).length

const settleSockets = async (fake: FakeDaemon): Promise<void> => {
  const started = Date.now()

  while (fake.openSockets() !== 0) {
    if (Date.now() - started > 1_000) {
      throw new Error("sockets still open: " + String(fake.openSockets()))
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const untilDisconnected = (api: DaemonApi) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = yield* api.status

      if (!status.connected) return

      yield* Effect.sleep(Duration.millis(20))
    }

    return yield* Effect.die("socket still looked connected")
  })

describe("daemon service", () => {
  it("does not replay a mutation whose reply was lost after execution", async () => {
    const fake = await start(
      authenticated((request) =>
        request.method === "daemon.create_session" ? { drop: true } : { result: {} },
      ),
    )

    const error = await withDaemon(fake, (api) =>
      api.request({ method: "daemon.create_session", params: { title: "once" } }).pipe(Effect.flip),
    )

    expect(asUnavailable(error).delivered).toBe(true)
    expect(count(fake, "daemon.create_session")).toBe(1)
    expect(count(fake, "daemon.authenticate")).toBe(1)
  })

  it("keeps a rejected key as an auth failure and closes the socket", async () => {
    const fake = await start({
      onRequest: () => ({ error: { code: -32001, message: "Internal error" } }),
    })

    const error = await withDaemon(fake, (api) =>
      api.request({ method: "daemon.list_opened_sessions", params: {} }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("DaemonAuthRejected")
    expect(error.message).not.toContain("cannot reach")
    expect(count(fake, "daemon.authenticate")).toBe(1)
    await settleSockets(fake)
  })

  it("reconnects once when the socket dies before the request is written", async () => {
    const fake = await start(
      authenticated(() => ({ result: { sessions: [], sessionId: "created" } })),
    )

    const result = await withDaemon(fake, (api) =>
      Effect.gen(function* () {
        yield* api.request({ method: "daemon.list_opened_sessions", params: {} })
        yield* Effect.sync(() => fake.dropSockets())
        yield* untilDisconnected(api)

        return yield* api.request({ method: "daemon.create_session", params: {} })
      }),
    )

    expect(result).toMatchObject({ sessionId: "created" })
    expect(count(fake, "daemon.create_session")).toBe(1)
    expect(count(fake, "daemon.authenticate")).toBe(2)
  })

  it("retries one idempotent read after a lost reply", async () => {
    let dropped = false

    const fake = await start(
      authenticated((request): ScriptedReply => {
        if (request.method !== "daemon.list_opened_sessions") return { result: {} }

        if (!dropped) {
          dropped = true

          return { drop: true }
        }

        return { result: { sessions: [{ id: "kept" }] } }
      }),
    )

    const result = await withDaemon(fake, (api) =>
      api.request({ method: "daemon.list_opened_sessions", params: {} }),
    )

    expect(result).toEqual({ sessions: [{ id: "kept" }] })
    expect(count(fake, "daemon.list_opened_sessions")).toBe(2)
  })

  it("reports the adopted protocol and a live socket", async () => {
    const fake = await start(
      authenticated((request) =>
        request.factoryProtocolVersion === "1.299.0"
          ? { result: { sessions: [] } }
          : mismatch(request.factoryProtocolVersion),
      ),
    )

    const seen = await withDaemon(fake, (api) =>
      Effect.gen(function* () {
        yield* api.request({ method: "daemon.list_opened_sessions", params: {} })
        const live = yield* api.status
        yield* Effect.sync(() => fake.dropSockets())
        yield* untilDisconnected(api)
        const dead = yield* api.status

        return { live, dead }
      }),
    )

    expect(seen.live.connected).toBe(true)
    expect(seen.live.protocol).toBe("1.299.0")
    expect(seen.dead.connected).toBe(false)
    expect(seen.dead.protocol).toBeUndefined()
    expect(count(fake, "daemon.list_opened_sessions")).toBe(2)
  })

  it("does not send a third time when the adopted mutation's reply is lost", async () => {
    const fake = await start(
      authenticated((request): ScriptedReply => {
        if (request.method !== "daemon.create_session") return { result: {} }

        if (request.factoryProtocolVersion !== "1.299.0") {
          return mismatch(request.factoryProtocolVersion)
        }

        return { drop: true }
      }),
    )

    const error = await withDaemon(fake, (api) =>
      api.request({ method: "daemon.create_session", params: {} }).pipe(Effect.flip),
    )

    expect(asUnavailable(error).delivered).toBe(true)
    expect(count(fake, "daemon.create_session")).toBe(2)
  })

  it("closes the socket when authentication is interrupted", async () => {
    const fake = await start({ onRequest: () => undefined })
    const config = configFor(fake)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.gen(function* () {
          const api = yield* DaemonService

          return yield* api.request({ method: "daemon.list_opened_sessions", params: {} })
        }).pipe(Effect.provide(daemonLayer(config)), Effect.forkChild)

        yield* Effect.sleep(Duration.millis(200))
        yield* Fiber.interrupt(fiber)
      }),
    )

    await settleSockets(fake)
    expect(count(fake, "daemon.authenticate")).toBe(1)
  })
})
