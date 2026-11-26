import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import { afterEach, describe, expect, it } from "vitest"

import { custodyLayer } from "../../src/custody/index.ts"
import {
  BadReply,
  DaemonLink,
  daemonLinkLayer,
  IncompatibleVersion,
  NotDelivered,
  PeerRejected,
  PossiblyDelivered,
  ProbeUnavailable,
} from "../../src/daemon-link/index.ts"
import type { DaemonLinkOptions } from "../../src/daemon-link/index.ts"
import { disclosureLayer } from "../../src/disclosure/index.ts"
import { Dialect, dialectLayer } from "../../src/factory-dialect/index.ts"
import type { Binding } from "../../src/factory-dialect/index.ts"
import { DAEMON_PROTOCOL_VERSION, startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply, SeenRequest } from "../support/fake-daemon.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const linkLayerFor = (options: DaemonLinkOptions) => {
  const disclosureLive = disclosureLayer()
  const custodyLive = custodyLayer
  const deps = Layer.merge(custodyLive, disclosureLive)

  return Layer.provideMerge(daemonLinkLayer(options), deps)
}

/**
 * Runs a program against a fresh `DaemonLink` built on `options` inside a
 * scoped layer build. When the scope closes at the end of the run the
 * layer's finalizer drains custody: borrowed sockets disconnect, owned
 * daemons terminate. The program receives the service directly.
 */
const withLink = <A, E>(
  options: DaemonLinkOptions,
  program: (
    link: import("../../src/daemon-link/index.ts").DaemonLinkService,
  ) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(linkLayerFor(options))
        const link = Context.getUnsafe(context, DaemonLink)

        return yield* program(link)
      }),
    ),
  )

const AUTH_RESULT = { userId: "user-1", orgId: "org-1" }

const authReply = (): ScriptedReply => ({ result: AUTH_RESULT })

/**
 * Replies to auth like a current daemon unless the test scripts auth itself;
 * every other method is scripted per test.
 */
const handler = (onRequest?: (request: SeenRequest) => ScriptedReply | undefined) => ({
  onRequest: (request: SeenRequest) => {
    const scripted = onRequest?.(request)

    if (scripted !== undefined) return scripted

    if (request.method === "daemon.authenticate") return authReply()

    return undefined
  },
})

const socketDir = (): string => mkdtempSync(join(tmpdir(), "daemon-link-test-"))

const bindingFor = (
  method: string,
): Effect.Effect<Binding<Schema.Json, Schema.Json>, never, Dialect> =>
  Effect.flatMap(Dialect, (dialect) =>
    dialect
      .reviewedBinding(method)
      .pipe(
        Effect.catchTag("UnsupportedBinding", () => Effect.die(new Error("binding must exist"))),
      ),
  )

const reviewedBinding = (method: string): Binding<Schema.Json, Schema.Json> =>
  Effect.runSync(Effect.provide(bindingFor(method), dialectLayer))

const openedSessionsBinding = (): Binding<Schema.Json, Schema.Json> =>
  reviewedBinding("daemon.list_opened_sessions")

const daemons: Array<FakeDaemon> = []
const dirs: Array<string> = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.close()
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const fakeDaemon = async (
  onRequest?: (request: SeenRequest) => ScriptedReply | undefined,
): Promise<FakeDaemon> => {
  const dir = socketDir()
  dirs.push(dir)
  const daemon = await startFakeDaemon(join(dir, "daemon.sock"), handler(onRequest))
  daemons.push(daemon)

  return daemon
}

/**
 * Captures the typed failure of an effect inside the same effect program, so
 * layer lifetime still wraps both the failure and whatever the test does
 * with it. `Effect.flip` cannot serve because a successful `undefined` is
 * ambiguous with failure there.
 */
const failureEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<E, never, R> =>
  Effect.flatMap(Effect.exit(effect), (exit) => {
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)

      if (Option.isSome(error)) return Effect.succeed(error.value)
    }

    return Effect.die(new Error("expected a typed failure"))
  })

const LIST_REPLY: ScriptedReply = { result: { sessions: [] } }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon-link exchange", () => {
  it("dispatches through the reviewed binding and returns the decoded reply", async () => {
    const daemon = await fakeDaemon(() => LIST_REPLY)

    const result = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
        handshakeTimeoutMs: 5_000,
      },
      (link) => link.exchange(openedSessionsBinding(), {}, "never"),
    )

    expect(result).toEqual({ sessions: [] })
    const methods = daemon.requests.map((request) => request.method)

    expect(methods).toContain("daemon.authenticate")
    expect(methods).toContain("daemon.list_opened_sessions")

    // Exactly one application request: the auth handshake plus the call.
    const appRequests = daemon.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequests).toHaveLength(1)
  })

  it("encodes the exact JSON-RPC envelope the daemon protocol expects", async () => {
    const daemon = await fakeDaemon(() => LIST_REPLY)

    await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => link.exchange(openedSessionsBinding(), {}, "never"),
    )

    const appRequest = daemon.requests.find(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequest).toBeDefined()
    // The daemon accepted the offered version without a mismatch, so the link keeps it.
    expect(appRequest?.factoryProtocolVersion).toBe("1.269.0")
    expect(appRequest?.id.startsWith("link-")).toBe(true)
  })

  it("fails with PeerRejected when the peer returns a JSON-RPC error", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") {
        return { error: { code: -32602, message: "invalid params" } }
      }

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(PeerRejected)

    if (error instanceof PeerRejected) {
      expect(error.code).toBe(-32602)
    }
  })

  it("fails with BadReply when the reply does not match the reviewed result schema", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") {
        return { result: { unexpected: true } }
      }

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(BadReply)
  })

  it("never retries a mutation after a malformed reply", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") {
        return { result: { unexpected: true } }
      }

      return undefined
    })

    await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) =>
        failureEffect(link.exchange(openedSessionsBinding(), {}, "idempotent_after_handoff")),
    )

    const appRequests = daemon.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequests).toHaveLength(1)
  })
})

describe("handoff and replay discipline", () => {
  it("fails with PossiblyDelivered when the socket drops after handoff, and never resends with replay never", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") return { drop: true }

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(PossiblyDelivered)

    const appRequests = daemon.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequests).toHaveLength(1)
  })

  it("never resends after handoff even with replay before_handoff", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") return { drop: true }

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "before_handoff")),
    )

    expect(error).toBeInstanceOf(PossiblyDelivered)

    const appRequests = daemon.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequests).toHaveLength(1)
  })

  it("replays exactly once after handoff when permission is idempotent_after_handoff", async () => {
    let appCount = 0

    const daemon = await fakeDaemon((request) => {
      if (request.method !== "daemon.list_opened_sessions") return undefined
      appCount += 1

      if (appCount === 1) return { drop: true }

      return LIST_REPLY
    })

    const result = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => link.exchange(openedSessionsBinding(), {}, "idempotent_after_handoff"),
    )

    expect(result).toEqual({ sessions: [] })

    const appRequests = daemon.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequests).toHaveLength(2)
  })

  it("fails with PossiblyDelivered when the daemon never answers before the timeout", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") return undefined

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
        requestTimeoutMs: 300,
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(PossiblyDelivered)

    const appRequests = daemon.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequests).toHaveLength(1)
  })

  it("fails with NotDelivered when no daemon is listening and none can be spawned", async () => {
    const dir = socketDir()
    dirs.push(dir)

    const error = await withLink(
      {
        endpoint: { socketPath: join(dir, "absent.sock") },
        auth: { apiKey: "test-key" },
        handshakeTimeoutMs: 500,
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(NotDelivered)
  })
})

describe("protocol negotiation", () => {
  it("adopts the daemon's protocol version once and retries the request", async () => {
    let mismatchSeen = false

    const daemon = await fakeDaemon((request) => {
      if (request.method !== "daemon.list_opened_sessions") return undefined

      if (!mismatchSeen) {
        mismatchSeen = true

        return {
          error: {
            code: -32601,
            message: "protocol version mismatch",
            data: {
              protocolVersionMismatch: {
                localFactoryProtocolVersion: DAEMON_PROTOCOL_VERSION,
                peerFactoryProtocolVersion: "1.269.0",
              },
            },
          },
        }
      }

      return LIST_REPLY
    })

    const result = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => link.exchange(openedSessionsBinding(), {}, "never"),
    )

    expect(result).toEqual({ sessions: [] })

    const appRequests = daemon.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    // One rejected pre-execution mismatch plus the adopted retry.
    expect(appRequests).toHaveLength(2)
    expect(appRequests[1]?.factoryProtocolVersion).toBe(DAEMON_PROTOCOL_VERSION)
  })
})

describe("probeExisting", () => {
  it("returns health for a reachable daemon without spawning anything", async () => {
    const daemon = await fakeDaemon(() => LIST_REPLY)

    const health = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
        capabilities: ["sessions"],
      },
      (link) => link.probeExisting(),
    )

    expect(health.reachable).toBe(true)
    expect(health.ownership).toBe("borrowed")
    expect(health.protocolVersion).toBe("1.269.0")
    expect(health.capabilities).toEqual(["sessions"])
  })

  it("fails with ProbeUnavailable when nothing is listening", async () => {
    const dir = socketDir()
    dirs.push(dir)

    const error = await withLink(
      {
        endpoint: { socketPath: join(dir, "absent.sock") },
        auth: { apiKey: "test-key" },
        handshakeTimeoutMs: 500,
      },
      (link) => failureEffect(link.probeExisting()),
    )

    expect(error).toBeInstanceOf(ProbeUnavailable)
  })
})

describe("health", () => {
  it("reports unreachable with ownership none before any connection", async () => {
    const dir = socketDir()
    dirs.push(dir)

    const health = await withLink(
      {
        endpoint: { socketPath: join(dir, "absent.sock") },
        auth: { apiKey: "test-key" },
      },
      (link) => link.health(),
    )

    expect(health.reachable).toBe(false)
    expect(health.ownership).toBe("none")
    expect(health.detail).toBeDefined()
  })

  it("reports reachable with borrowed ownership after a successful exchange", async () => {
    const daemon = await fakeDaemon(() => LIST_REPLY)

    const health = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) =>
        Effect.gen(function* () {
          yield* link.exchange(openedSessionsBinding(), {}, "never")

          return yield* link.health()
        }),
    )

    expect(health.reachable).toBe(true)
    expect(health.ownership).toBe("borrowed")
    expect(health.protocolVersion).toBe("1.269.0")
  })

  it("never leaks auth tokens in health details", async () => {
    const secret = "super-secret-token-value"
    const dir = socketDir()
    dirs.push(dir)

    const health = await withLink(
      {
        endpoint: { socketPath: join(dir, "absent.sock") },
        auth: { apiKey: secret },
        sensitiveValues: [secret],
      },
      (link) => link.health(),
    )

    expect(JSON.stringify(health)).not.toContain(secret)
  })
})

describe("incompatible version", () => {
  it("fails probeExisting with ProbeUnavailable when the daemon never accepts a version", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.authenticate") {
        return {
          error: {
            code: -32601,
            message: "protocol version mismatch",
            data: {
              protocolVersionMismatch: {
                localFactoryProtocolVersion: "9.9.9",
                peerFactoryProtocolVersion: "1.269.0",
              },
            },
          },
        }
      }

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => failureEffect(link.probeExisting()),
    )

    expect(error).toBeInstanceOf(ProbeUnavailable)
  })

  it("fails exchange with IncompatibleVersion when the daemon rejects the adopted version too", async () => {
    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.authenticate") {
        return {
          error: {
            code: -32601,
            message: "protocol version mismatch",
            data: {
              protocolVersionMismatch: {
                localFactoryProtocolVersion: "9.9.9",
                peerFactoryProtocolVersion: "1.269.0",
              },
            },
          },
        }
      }

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(IncompatibleVersion)
  })
})

describe("custody separation", () => {
  it("draining the link disconnects a borrowed daemon but never kills it", async () => {
    const daemon = await fakeDaemon(() => LIST_REPLY)

    await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => link.exchange(openedSessionsBinding(), {}, "never"),
    )

    // withLink's scope has closed: the borrowed socket is disconnected. The
    // close frame is flushed before teardown; the server's close event is
    // asynchronous, so the assertion polls briefly rather than assuming a tick.
    let observed = daemon.openSockets()

    for (let attempt = 0; attempt < 50 && observed !== 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      observed = daemon.openSockets()
    }

    expect(observed).toBe(0)

    // The external daemon itself is still alive and serving: a fresh link
    // can attach to it, proving close never killed the borrowed host.
    const result = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: "test-key" },
      },
      (link) => link.exchange(openedSessionsBinding(), {}, "never"),
    )

    expect(result).toEqual({ sessions: [] })
  })

  it("spawns an owned daemon when nothing is listening and terminates it on drain", async () => {
    const dir = socketDir()
    dirs.push(dir)
    const socketPath = join(dir, "owned.sock")
    const helperPath = join(dir, "spawn-helper.mjs")

    // The spawn helper is a tiny Node program that runs the same fake-daemon
    // wire server the tests use, proving the owned path end to end: spawn,
    // readiness wait, handshake, exchange, terminate.
    const { writeFileSync } = await import("node:fs")

    writeFileSync(
      helperPath,
      [
        "import { startFakeDaemon } from " +
          JSON.stringify(
            pathToFileURL(join(import.meta.dirname, "../support/fake-daemon.ts")).href,
          ),
        "const socketPath = process.argv[2]",
        "await startFakeDaemon(socketPath, {",
        "  onRequest: (request) => {",
        '    if (request.method === "daemon.authenticate") return { result: { userId: "u", orgId: "o" } }',
        '    if (request.method === "daemon.list_opened_sessions") return { result: { sessions: [] } }',
        "    return undefined",
        "  },",
        "})",
        "setInterval(() => {}, 60_000)",
        "",
      ].join("\n"),
    )

    const health = await withLink(
      {
        endpoint: { socketPath },
        auth: { apiKey: "test-key" },
        spawn: {
          command: process.execPath,
          args: ["--experimental-strip-types", helperPath, socketPath],
        },
        startTimeoutMs: 10_000,
      },
      (link) =>
        Effect.gen(function* () {
          const result = yield* link.exchange(openedSessionsBinding(), {}, "never")

          expect(result).toEqual({ sessions: [] })

          return yield* link.health()
        }),
    )

    expect(health.reachable).toBe(true)
    expect(health.ownership).toBe("owned")

    // After the scope closed, the owned child is terminated: nothing listens
    // on the socket any more, so a fresh link without spawn rights cannot
    // connect.
    const error = await withLink(
      {
        endpoint: { socketPath },
        auth: { apiKey: "test-key" },
        handshakeTimeoutMs: 500,
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(NotDelivered)
  })
})

describe("disclosure discipline", () => {
  it("scrubs secrets out of PeerRejected details", async () => {
    const secret = "super-secret-token-value"

    const daemon = await fakeDaemon((request) => {
      if (request.method === "daemon.list_opened_sessions") {
        return { error: { code: -32602, message: "rejected because " + secret + " is invalid" } }
      }

      return undefined
    })

    const error = await withLink(
      {
        endpoint: { socketPath: daemon.socketPath },
        auth: { apiKey: secret },
        sensitiveValues: [secret],
      },
      (link) => failureEffect(link.exchange(openedSessionsBinding(), {}, "never")),
    )

    expect(error).toBeInstanceOf(PeerRejected)
    expect(JSON.stringify(error)).not.toContain(secret)
  })
})

describe("pre-handoff replay", () => {
  it("fails with NotDelivered when reconnect is impossible and replay is never", async () => {
    const dir = socketDir()
    dirs.push(dir)
    const socketPath = join(dir, "daemon.sock")

    const first = await startFakeDaemon(
      socketPath,
      handler(() => LIST_REPLY),
    )

    daemons.push(first)

    const error = await withLink(
      {
        endpoint: { socketPath },
        auth: { apiKey: "test-key" },
        handshakeTimeoutMs: 500,
      },
      (link) =>
        Effect.gen(function* () {
          yield* link.exchange(openedSessionsBinding(), {}, "never")

          // Kill the daemon entirely: the connection drops and every later
          // dial fails before a byte is written, so the exchange can never
          // reach the peer.
          yield* Effect.promise(() => first.close())
          yield* Effect.sleep(50)

          return yield* failureEffect(link.exchange(openedSessionsBinding(), {}, "never"))
        }),
    )

    expect(error).toBeInstanceOf(NotDelivered)
  })

  it("retries pre-handoff exactly once when replay is before_handoff and the daemon returns", async () => {
    const dir = socketDir()
    dirs.push(dir)
    const socketPath = join(dir, "daemon.sock")

    const first = await startFakeDaemon(
      socketPath,
      handler(() => LIST_REPLY),
    )

    daemons.push(first)

    const result = await withLink(
      {
        endpoint: { socketPath },
        auth: { apiKey: "test-key" },
        handshakeTimeoutMs: 2_000,
      },
      (link) =>
        Effect.gen(function* () {
          yield* link.exchange(openedSessionsBinding(), {}, "never")
          yield* Effect.promise(() => first.close())
          yield* Effect.sleep(50)

          // The daemon returns before the reconnect dials: the first attempt
          // fails before handoff (the dead connection is dropped), and the
          // permitted retry reaches the restarted daemon exactly once.
          const second = yield* Effect.promise(() =>
            startFakeDaemon(
              socketPath,
              handler(() => LIST_REPLY),
            ),
          )

          daemons.push(second)

          return yield* Effect.zip(
            link.exchange(openedSessionsBinding(), {}, "before_handoff"),
            Effect.succeed(second),
          )
        }),
    )

    expect(result[0]).toEqual({ sessions: [] })

    const appRequests = result[1].requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    expect(appRequests).toHaveLength(1)
  })

  it("sends exactly one frame on the restarted daemon even when replay is before_handoff and the first attempt succeeds", async () => {
    const dir = socketDir()
    dirs.push(dir)
    const socketPath = join(dir, "daemon.sock")

    const first = await startFakeDaemon(
      socketPath,
      handler(() => LIST_REPLY),
    )

    daemons.push(first)

    const outcome = await withLink(
      {
        endpoint: { socketPath },
        auth: { apiKey: "test-key" },
        handshakeTimeoutMs: 2_000,
      },
      (link) =>
        Effect.gen(function* () {
          yield* link.exchange(openedSessionsBinding(), {}, "never")
          yield* Effect.promise(() => first.close())
          yield* Effect.sleep(50)

          const second = yield* Effect.promise(() =>
            startFakeDaemon(
              socketPath,
              handler(() => LIST_REPLY),
            ),
          )

          daemons.push(second)

          yield* link.exchange(openedSessionsBinding(), {}, "before_handoff")

          return second
        }),
    )

    const appRequests = outcome.requests.filter(
      (request) => request.method === "daemon.list_opened_sessions",
    )

    // The pre-handoff retry budget is spent once, never twice: a successful
    // retry is the end of the exchange, not the start of a loop.
    expect(appRequests).toHaveLength(1)
  })
})
