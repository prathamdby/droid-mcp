import { mkdtempSync } from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Duration, Effect, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"

import {
  OPCODE,
  buildHandshakeRequest,
  computeAccept,
  connect,
  parseHandshakeResponse,
} from "../../src/droid/ws.ts"

const socketPath = (): string => join(mkdtempSync(join(tmpdir(), "droid-mcp-ws-")), "ws.sock")

const encodeServerFrame = (opcode: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(2 + payload.length)
  out[0] = 0x80 | opcode
  out[1] = payload.length
  out.set(payload, 2)

  return out
}

const serveOnce = (path: string, acceptOverride: string | undefined, status: string) =>
  new Promise<net.Server>((resolve) => {
    const server = net.createServer((socket) => {
      socket.once("data", (chunk: Uint8Array) => {
        const head = new TextDecoder("latin1").decode(chunk)
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? ""
        const accept = acceptOverride ?? computeAccept(key)
        socket.write(
          status +
            "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
            accept +
            "\r\n\r\n",
        )
        socket.write(encodeServerFrame(OPCODE.text, new TextEncoder().encode('{"hello":true}')))
      })
    })

    server.listen(path, () => resolve(server))
  })

const closeServer = (server: net.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
  })

const serve = (path: string, onSocket: (socket: net.Socket) => void): Promise<net.Server> =>
  new Promise((resolve) => {
    const server = net.createServer(onSocket)

    server.listen(path, () => resolve(server))
  })

const upgrade = (head: string): string => {
  const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? ""

  return (
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " +
    computeAccept(key) +
    "\r\n\r\n"
  )
}

const timeouts = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "Timeout").length

const pipeWraps = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "PipeWrap").length

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)

  return out
}

const expectFewerPipes = async (during: number): Promise<void> => {
  const deadline = Date.now() + 1_500
  let count = pipeWraps()

  while (count >= during && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15))
    count = pipeWraps()
  }

  expect(count).toBeLessThan(during)
}

const withHalfOpen = async (
  path: string,
  onSocket: (socket: net.Socket) => void,
  body: () => Promise<void>,
): Promise<void> => {
  const peers: Array<net.Socket> = []

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    peers.push(socket)
    socket.on("error", () => {})
    socket.resume()
    onSocket(socket)
  })

  await new Promise<void>((resolve) => {
    server.listen(path, () => resolve())
  })

  try {
    await body()
  } finally {
    for (const peer of peers) peer.destroy()
    await closeServer(server)
  }
}

describe("handshake codec", () => {
  it("matches the RFC 6455 accept vector", () => {
    expect(computeAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
  })

  it("builds an upgrade request with the required headers", () => {
    const request = buildHandshakeRequest("abc", "/", "localhost")
    expect(request.startsWith("GET / HTTP/1.1\r\n")).toBe(true)
    expect(request).toContain("Upgrade: websocket")
    expect(request).toContain("Connection: Upgrade")
    expect(request).toContain("Sec-WebSocket-Key: abc")
    expect(request).toContain("Sec-WebSocket-Version: 13")
    expect(request.endsWith("\r\n\r\n")).toBe(true)
  })

  it("accepts a correct 101 response", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ=="

    const head =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      computeAccept(key)

    expect(parseHandshakeResponse(head, key).kind).toBe("accepted")
  })

  it("rejects a wrong accept digest", () => {
    const result = parseHandshakeResponse(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: wrong",
      "key",
    )

    expect(result).toEqual({
      kind: "rejected",
      status: 101,
      reason: "Sec-WebSocket-Accept mismatch",
    })
  })

  it("rejects a non-101 response", () => {
    const result = parseHandshakeResponse("HTTP/1.1 403 Forbidden\r\n", "key")
    expect(result).toEqual({
      kind: "rejected",
      status: 403,
      reason: "expected 101 Switching Protocols",
    })
  })

  it("rejects a missing Upgrade header", () => {
    const result = parseHandshakeResponse(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x",
      "key",
    )

    expect(result).toEqual({
      kind: "rejected",
      status: 101,
      reason: "missing Upgrade header",
    })
  })

  it("does not treat a longer status token as 101", () => {
    const result = parseHandshakeResponse("HTTP/1.1 1011 Switching Protocols\r\n", "key")

    expect(result).toEqual({
      kind: "rejected",
      status: 0,
      reason: "malformed status line",
    })
  })
})

describe("websocket connection", () => {
  it("connects, upgrades, and reads a server frame", async () => {
    const path = socketPath()
    const server = await serveOnce(path, undefined, "HTTP/1.1 101 Switching Protocols")

    try {
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const ws = yield* connect({ socketPath: path, keepaliveMs: 0 })
          const message = yield* Stream.runHead(ws.messages)
          yield* ws.close

          return message
        }),
      )

      Option.match(first, {
        onNone: () => expect.unreachable("expected one message"),
        onSome: (message) => {
          expect(message.kind).toBe("text")

          if (message.kind === "text") {
            expect(JSON.parse(message.text)).toEqual({ hello: true })
          }
        },
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("fails when the accept digest is wrong", async () => {
    const path = socketPath()
    const server = await serveOnce(path, "not-the-digest", "HTTP/1.1 101 Switching Protocols")

    try {
      const error = await Effect.runPromise(
        Effect.flip(connect({ socketPath: path, keepaliveMs: 0 })),
      )

      expect(error._tag).toBe("WsError")
      expect(error.message).toContain("Sec-WebSocket-Accept")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("fails on a non-101 response", async () => {
    const path = socketPath()
    const server = await serveOnce(path, undefined, "HTTP/1.1 500 Server Error")

    try {
      const error = await Effect.runPromise(
        Effect.flip(connect({ socketPath: path, keepaliveMs: 0 })),
      )

      expect(error._tag).toBe("WsError")
      expect(error.message).toContain("handshake rejected")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("destroys the peer when the handshake grows without an end", async () => {
    const path = socketPath()
    let destroyed = false
    const peers: Array<net.Socket> = []

    const server = await serve(path, (socket) => {
      peers.push(socket)
      socket.on("error", () => {})
      socket.on("close", () => {
        destroyed = true
      })
      // Reading lets the peer observe the client's destroy. A paused socket
      // holds the unread handshake and delays the close event.
      socket.resume()
      socket.write(Buffer.alloc(20_000, 0x61))
    })

    try {
      const started = Date.now()

      const error = await Effect.runPromise(
        Effect.flip(connect({ socketPath: path, keepaliveMs: 0, handshakeTimeoutMs: 3_000 })),
      )

      expect(error.message).toContain("handshake response too large")
      expect(Date.now() - started).toBeLessThan(1_000)

      const deadline = Date.now() + 400

      while (!destroyed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      expect(destroyed).toBe(true)
    } finally {
      for (const peer of peers) peer.destroy()
      await closeServer(server)
    }
  })

  it("clears the handshake timer after a successful upgrade", async () => {
    const path = socketPath()
    const server = await serveOnce(path, undefined, "HTTP/1.1 101 Switching Protocols")

    try {
      const before = timeouts()

      const during = await Effect.runPromise(
        Effect.gen(function* () {
          const ws = yield* connect({
            socketPath: path,
            keepaliveMs: 0,
            handshakeTimeoutMs: 60_000,
          })

          const active = timeouts()
          yield* ws.close

          return active
        }),
      )

      expect(during).toBe(before)
    } finally {
      await closeServer(server)
    }
  })

  it("closes with a keepalive timeout when the peer never pongs", async () => {
    const path = socketPath()

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      socket.once("data", (chunk: Uint8Array) => {
        socket.write(upgrade(new TextDecoder("latin1").decode(chunk)))
      })
    })

    try {
      const info = await Effect.runPromise(
        Effect.gen(function* () {
          const ws = yield* connect({
            socketPath: path,
            keepaliveMs: 40,
            handshakeTimeoutMs: 2_000,
          })

          return yield* ws.closed
        }),
      )

      expect(info).toEqual({ code: 1001, reason: "keepalive timeout" })
    } finally {
      await closeServer(server)
    }
  })

  it("reports a server close frame", async () => {
    const path = socketPath()
    const reason = new TextEncoder().encode("bye")
    const payload = new Uint8Array(2 + reason.length)
    payload[0] = 0x03
    payload[1] = 0xe8
    payload.set(reason, 2)

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      socket.once("data", (chunk: Uint8Array) => {
        socket.write(upgrade(new TextDecoder("latin1").decode(chunk)))
        socket.write(encodeServerFrame(OPCODE.close, payload))
      })
    })

    try {
      const info = await Effect.runPromise(
        Effect.gen(function* () {
          const ws = yield* connect({ socketPath: path, keepaliveMs: 0 })

          return yield* ws.closed
        }),
      )

      expect(info).toEqual({ code: 1000, reason: "bye" })
    } finally {
      await closeServer(server)
    }
  })

  it("answers a server ping with a pong", async () => {
    const path = socketPath()
    const frames: Array<number> = []

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      let upgraded = false
      socket.on("data", (chunk: Uint8Array) => {
        if (!upgraded) {
          socket.write(upgrade(new TextDecoder("latin1").decode(chunk)))
          socket.write(encodeServerFrame(OPCODE.ping, new Uint8Array([7])))
          upgraded = true

          return
        }

        frames.push(chunk[0] ?? 0)
      })
    })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ws = yield* connect({ socketPath: path, keepaliveMs: 0 })
          yield* Effect.sleep(100)
          yield* ws.close
        }),
      )

      expect(frames).toContain(0x8a)
    } finally {
      await closeServer(server)
    }
  })

  it("rejects status 1011 on the socket instead of treating it as 101", async () => {
    const path = socketPath()
    let destroyed = false

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      socket.on("close", () => {
        destroyed = true
      })
      socket.once("data", () => {
        socket.write("HTTP/1.1 1011 Switching Protocols\r\n\r\n")
      })
    })

    try {
      const error = await Effect.runPromise(
        Effect.flip(connect({ socketPath: path, keepaliveMs: 0, handshakeTimeoutMs: 2_000 })),
      )

      expect(error.message).toContain("malformed status line")

      const deadline = Date.now() + 400

      while (!destroyed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      expect(destroyed).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it("fails the handshake when the peer ends before upgrade", async () => {
    const path = socketPath()

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      socket.once("data", () => {
        socket.end()
      })
    })

    try {
      const started = Date.now()

      const error = await Effect.runPromise(
        connect({ socketPath: path, keepaliveMs: 0, handshakeTimeoutMs: 50 }).pipe(
          Effect.timeout(Duration.millis(200)),
          Effect.flip,
        ),
      )

      expect(error._tag).toBe("WsError")
      expect(error.message).toContain("socket ended")
      expect(Date.now() - started).toBeLessThan(180)
    } finally {
      await closeServer(server)
    }
  })

  it("rejects a finished handshake whose headers exceed the cap", async () => {
    const path = socketPath()

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      socket.once("data", (chunk: Uint8Array) => {
        const head = new TextDecoder("latin1").decode(chunk)
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? ""
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " +
            computeAccept(key) +
            "\r\nX-Pad: " +
            "x".repeat(20_000) +
            "\r\n\r\n",
        )
      })
    })

    try {
      const error = await Effect.runPromise(
        Effect.flip(connect({ socketPath: path, keepaliveMs: 0, handshakeTimeoutMs: 1_000 })),
      )

      expect(error._tag).toBe("WsError")
      expect(error.message).toContain("handshake response too large")
    } finally {
      await closeServer(server)
    }
  })

  it("does not count bytes after the header delimiter toward the cap", async () => {
    const path = socketPath()

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      socket.once("data", (chunk: Uint8Array) => {
        const head = new TextDecoder("latin1").decode(chunk)
        socket.write(upgrade(head) + "A".repeat(20_000))
      })
    })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ws = yield* connect({ socketPath: path, keepaliveMs: 0, handshakeTimeoutMs: 1_000 })
          yield* ws.close
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  it("delivers a text frame that shares a chunk with close", async () => {
    const path = socketPath()
    const reason = new TextEncoder().encode("bye")
    const closePayload = new Uint8Array(2 + reason.length)
    closePayload[0] = 0x03
    closePayload[1] = 0xe8
    closePayload.set(reason, 2)

    const frames = concatBytes(
      encodeServerFrame(OPCODE.text, new TextEncoder().encode('{"final":true}')),
      encodeServerFrame(OPCODE.close, closePayload),
    )

    const server = await serve(path, (socket) => {
      socket.on("error", () => {})
      socket.once("data", (chunk: Uint8Array) => {
        const head = new TextDecoder("latin1").decode(chunk)
        socket.cork()
        socket.write(upgrade(head))
        socket.write(frames)
        socket.uncork()
      })
    })

    try {
      const seen: Array<string> = []

      const info = await Effect.runPromise(
        Effect.gen(function* () {
          const ws = yield* connect({ socketPath: path, keepaliveMs: 0 })

          yield* ws.messages.pipe(
            Stream.runForEach((message) =>
              Effect.sync(() => {
                if (message.kind === "text") seen.push(message.text)
              }),
            ),
            Effect.forkDetach,
          )

          return yield* ws.closed
        }),
      )

      expect(seen).toEqual(['{"final":true}'])
      expect(info).toEqual({ code: 1000, reason: "bye" })
    } finally {
      await closeServer(server)
    }
  })

  it("destroys the local socket after close when the peer stays half-open", async () => {
    const path = socketPath()

    await withHalfOpen(
      path,
      (socket) => {
        socket.on("data", (chunk: Uint8Array) => {
          const text = new TextDecoder("latin1").decode(chunk)

          if (!text.includes("Sec-WebSocket-Key")) return
          socket.write(upgrade(text))
        })
      },
      async () => {
        const during = await Effect.runPromise(
          Effect.gen(function* () {
            const ws = yield* connect({ socketPath: path, keepaliveMs: 0 })
            const active = pipeWraps()
            yield* ws.close

            return active
          }),
        )

        await expectFewerPipes(during)
      },
    )
  })

  it("destroys the local socket when a close frame leaves the peer half-open", async () => {
    const path = socketPath()
    const reason = new TextEncoder().encode("bye")
    const payload = new Uint8Array(2 + reason.length)
    payload[0] = 0x03
    payload[1] = 0xe8
    payload.set(reason, 2)

    await withHalfOpen(
      path,
      (socket) => {
        socket.once("data", (chunk: Uint8Array) => {
          const head = new TextDecoder("latin1").decode(chunk)
          socket.write(upgrade(head))
          socket.write(encodeServerFrame(OPCODE.close, payload))
        })
      },
      async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const ws = yield* connect({ socketPath: path, keepaliveMs: 0 })
            const active = pipeWraps()
            const info = yield* ws.closed

            return { active, info }
          }),
        )

        expect(result.info).toEqual({ code: 1000, reason: "bye" })
        await expectFewerPipes(result.active)
      },
    )
  })

  it("destroys the local socket when keepalive expires and the peer stays half-open", async () => {
    const path = socketPath()

    await withHalfOpen(
      path,
      (socket) => {
        socket.once("data", (chunk: Uint8Array) => {
          socket.write(upgrade(new TextDecoder("latin1").decode(chunk)))
        })
      },
      async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const ws = yield* connect({
              socketPath: path,
              keepaliveMs: 30,
              handshakeTimeoutMs: 2_000,
            })

            const active = pipeWraps()
            const info = yield* ws.closed

            return { active, info }
          }),
        )

        expect(result.info).toEqual({ code: 1001, reason: "keepalive timeout" })
        await expectFewerPipes(result.active)
      },
    )
  })
})
