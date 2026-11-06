import { mkdtempSync } from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Option, Stream } from "effect"
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
      "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: wrong",
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
})
