/**
 * Client-side RFC 6455 websocket transport over `node:net`, module-internal
 * to `daemon-link`. Handles the handshake, frame codec, fragmentation and
 * control frames. The connection value is opaque outside this module's own
 * private files: nothing here crosses the public boundary.
 */
import { createHash, randomBytes, randomFillSync } from "node:crypto"
import * as net from "node:net"

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"

export const MAX_FRAME_BYTES = 16 * 1024 * 1024
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/**
 * After a local close, destroy the socket if the peer never finishes its
 * half. The close frame is flushed first; this bound is only the backstop.
 */
const LOCAL_CLOSE_MS = 1_000
const MAX_HANDSHAKE_BYTES = 16 * 1024
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

export interface Frame {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Uint8Array
}

export type WsMessage =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ping"; readonly payload: Uint8Array }
  | { readonly kind: "pong"; readonly payload: Uint8Array }
  | { readonly kind: "close"; readonly code: number; readonly reason: string }

export interface DecodeResult {
  readonly frames: ReadonlyArray<Frame>
  readonly rest: Uint8Array
  readonly error?: string
}

export interface AssembledResult {
  readonly messages: ReadonlyArray<WsMessage>
  readonly error?: string
}

export class WsDialError {
  readonly message: string

  constructor(message: string) {
    this.message = message
  }
}

export const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)

  return out
}

/** Encode one client frame. Client frames are always masked. */
export const encodeFrame = (
  opcode: number,
  payload: Uint8Array,
  mask: Uint8Array,
  fin: boolean = true,
): Uint8Array => {
  const length = payload.length
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10
  const out = new Uint8Array(headerLength + 4 + length)
  out[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)

  if (length < 126) {
    out[1] = 0x80 | length
  } else if (length < 65536) {
    out[1] = 0x80 | 126
    out[2] = (length >>> 8) & 0xff
    out[3] = length & 0xff
  } else {
    out[1] = 0x80 | 127
    let remaining = length

    for (let i = 9; i >= 2; i--) {
      out[i] = remaining % 256
      remaining = Math.floor(remaining / 256)
    }
  }

  out[headerLength] = mask[0]
  out[headerLength + 1] = mask[1]
  out[headerLength + 2] = mask[2]
  out[headerLength + 3] = mask[3]

  for (let i = 0; i < length; i++) {
    out[headerLength + 4 + i] = payload[i] ^ mask[i % 4]
  }

  return out
}

/**
 * Decode every complete frame in `buffer`. An incomplete trailing frame
 * stays in `rest` so the caller can wait for more socket data.
 */
export const decodeFrames = (
  buffer: Uint8Array,
  maxFrameBytes: number = MAX_FRAME_BYTES,
): DecodeResult => {
  const frames: Array<Frame> = []
  let offset = 0

  for (;;) {
    if (buffer.length - offset < 2) break
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const rsv = first & 0x70
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2

    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = (buffer[cursor] << 8) | buffer[cursor + 1]
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      let wide = 0

      for (let i = 0; i < 8; i++) {
        wide = wide * 256 + buffer[cursor + i]
      }

      if (wide > Number.MAX_SAFE_INTEGER) {
        return { frames, rest: buffer.subarray(offset), error: "frame length overflow" }
      }

      length = wide
      cursor += 8
    }

    if (rsv !== 0) {
      return { frames, rest: buffer.subarray(offset), error: "reserved bits are not supported" }
    }

    if (length > maxFrameBytes) {
      return { frames, rest: buffer.subarray(offset), error: "frame exceeds the size cap" }
    }

    const maskLength = masked ? 4 : 0

    if (buffer.length - cursor < maskLength + length) break
    let payload = buffer.subarray(cursor + maskLength, cursor + maskLength + length)

    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4)
      const unmasked = new Uint8Array(length)

      for (let i = 0; i < length; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4]
      }

      payload = unmasked
    }

    frames.push({ fin, opcode, payload })
    offset = cursor + maskLength + length
  }

  return { frames, rest: offset === 0 ? buffer : buffer.subarray(offset) }
}

/** Reassemble fragmented text messages and validate control frames. */
export const makeAssembler = (maxMessageBytes: number = MAX_MESSAGE_BYTES) => {
  let fragmentOpcode = -1
  let fragmentLength = 0
  const fragments: Array<Uint8Array> = []

  const reset = (): void => {
    fragmentOpcode = -1
    fragmentLength = 0
    fragments.length = 0
  }

  const push = (frame: Frame): AssembledResult => {
    if (frame.opcode === OPCODE.ping || frame.opcode === OPCODE.pong) {
      if (!frame.fin || frame.payload.length > 125) {
        return { messages: [], error: "invalid control frame" }
      }

      return {
        messages: [
          frame.opcode === OPCODE.ping
            ? { kind: "ping", payload: frame.payload }
            : { kind: "pong", payload: frame.payload },
        ],
      }
    }

    if (frame.opcode === OPCODE.close) {
      if (!frame.fin || frame.payload.length > 125) {
        return { messages: [], error: "invalid close frame" }
      }

      const code = frame.payload.length >= 2 ? (frame.payload[0] << 8) | frame.payload[1] : 1005

      const reason =
        frame.payload.length > 2 ? new TextDecoder().decode(frame.payload.subarray(2)) : ""

      return { messages: [{ kind: "close", code, reason }] }
    }

    if (frame.opcode === OPCODE.binary) {
      return { messages: [], error: "binary frames are not supported" }
    }

    if (frame.opcode === OPCODE.text) {
      if (fragmentOpcode !== -1) {
        reset()

        return { messages: [], error: "data frame inside a fragmented message" }
      }

      if (frame.payload.length > maxMessageBytes) {
        reset()

        return { messages: [], error: "message exceeds the size cap" }
      }

      if (frame.fin) {
        return { messages: [{ kind: "text", text: new TextDecoder().decode(frame.payload) }] }
      }

      fragmentOpcode = OPCODE.text
      fragments.push(frame.payload)
      fragmentLength = frame.payload.length

      return { messages: [] }
    }

    if (frame.opcode === OPCODE.continuation) {
      if (fragmentOpcode === -1) {
        return { messages: [], error: "continuation without a message" }
      }

      fragmentLength += frame.payload.length

      if (fragmentLength > maxMessageBytes) {
        reset()

        return { messages: [], error: "message exceeds the size cap" }
      }

      fragments.push(frame.payload)

      if (!frame.fin) return { messages: [] }
      const whole = new Uint8Array(fragmentLength)
      let at = 0

      for (const fragment of fragments) {
        whole.set(fragment, at)
        at += fragment.length
      }

      reset()

      return { messages: [{ kind: "text", text: new TextDecoder().decode(whole) }] }
    }

    return { messages: [], error: "unsupported opcode" }
  }

  return { push }
}

export const computeAccept = (key: string): string =>
  createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64")

const makeKey = (): string => randomBytes(16).toString("base64")

const nextMask = (): Uint8Array => {
  const mask = new Uint8Array(4)
  randomFillSync(mask)

  return mask
}

const buildHandshakeRequest = (key: string, path: string, host: string): string =>
  [
    "GET " + path + " HTTP/1.1",
    "Host: " + host,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: " + key,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n")

type HandshakeCheck =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: string }

const headerTokens = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)

const headerValues = (lines: ReadonlyArray<string>, name: string): ReadonlyArray<string> => {
  const values: Array<string> = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const colon = line.indexOf(":")

    if (colon < 0) continue

    if (line.slice(0, colon).trim().toLowerCase() !== name) continue

    values.push(line.slice(colon + 1).trim())
  }

  return values
}

const parseHandshakeResponse = (head: string, key: string): HandshakeCheck => {
  const lines = head.split("\r\n")
  const statusLine = lines.length > 0 ? lines[0] : ""
  const matched = /^HTTP\/1\.[0-9] ([0-9]{3})(?: (.*))?$/.exec(statusLine ?? "")

  if (matched === null) return { kind: "rejected", reason: "malformed status line" }
  const status = Number(matched[1])

  if (status !== 101) {
    return { kind: "rejected", reason: "expected 101 Switching Protocols, got " + String(status) }
  }

  const upgrade = headerValues(lines, "upgrade").flatMap((value) => headerTokens(value))

  if (!upgrade.includes("websocket")) return { kind: "rejected", reason: "missing Upgrade header" }

  const connection = headerValues(lines, "connection").flatMap((value) => headerTokens(value))

  if (!connection.includes("upgrade")) {
    return { kind: "rejected", reason: "missing Connection header" }
  }

  const accept = headerValues(lines, "sec-websocket-accept")[0] ?? ""

  if (accept.length === 0) return { kind: "rejected", reason: "missing Sec-WebSocket-Accept" }

  if (accept !== computeAccept(key)) {
    return { kind: "rejected", reason: "Sec-WebSocket-Accept mismatch" }
  }

  return { kind: "accepted" }
}

const findHeaderEnd = (buffer: Uint8Array): number => {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i
    }
  }

  return -1
}

export interface WsCloseInfo {
  readonly code: number
  readonly reason: string
}

/**
 * A live websocket connection. Message delivery and the closing signal are
 * module-internal wiring for `daemon-link`: the public service never exposes
 * any of this.
 */
export interface WsConnection {
  /** Registers the single text-message consumer. At most one is supported. */
  readonly onText: (consumer: (text: string) => void) => void
  /** Completes exactly once when the socket is gone. */
  readonly closed: Effect.Effect<WsCloseInfo>
  /** True once the socket has finished. Does not wait. */
  readonly isClosed: () => boolean
  readonly sendText: (text: string) => Effect.Effect<void, WsDialError>
  readonly close: Effect.Effect<void>
}

export interface WsConnectOptions {
  readonly socketPath?: string
  readonly host?: string
  readonly port?: number
  readonly handshakeTimeoutMs?: number
  readonly path?: string
  readonly maxMessageBytes?: number
}

const socketTarget = (options: WsConnectOptions): net.NetConnectOpts => {
  if (options.socketPath !== undefined) return { path: options.socketPath }

  return { host: options.host ?? "127.0.0.1", port: options.port ?? 0 }
}

export const connect = (options: WsConnectOptions): Effect.Effect<WsConnection, WsDialError> =>
  Effect.gen(function* () {
    const closedDeferred = yield* Deferred.make<WsCloseInfo>()
    const assembler = makeAssembler(options.maxMessageBytes ?? MAX_MESSAGE_BYTES)
    const key = makeKey()
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000

    let buffer: Uint8Array = new Uint8Array(0)
    let upgraded = false
    let closed = false
    let releasing = false
    let textConsumer: ((text: string) => void) | undefined
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined

    const clearHandshakeTimer = (): void => {
      if (handshakeTimer === undefined) return
      clearTimeout(handshakeTimer)
      handshakeTimer = undefined
    }

    const finish = (code: number, reason: string): void => {
      if (closed) return
      closed = true
      clearHandshakeTimer()
      buffer = new Uint8Array(0)
      setImmediate(() => {
        Deferred.doneUnsafe(closedDeferred, Effect.succeed({ code, reason }))
      })
    }

    const releaseLocalSocket = (target: net.Socket): void => {
      if (releasing || target.destroyed) return
      releasing = true

      const timer = setTimeout(() => {
        if (!target.destroyed) target.destroy()
      }, LOCAL_CLOSE_MS)

      timer.unref()
      target.once("close", () => {
        clearTimeout(timer)
      })

      if (target.writableEnded) return

      target.end(() => {
        clearTimeout(timer)

        if (!target.destroyed) target.destroy()
      })
    }

    const socket = yield* Effect.callback<net.Socket, WsDialError>((resume) => {
      const connection = net.connect(socketTarget(options))
      let settled = false

      const fail = (message: string): void => {
        clearHandshakeTimer()
        buffer = new Uint8Array(0)

        if (!settled) {
          settled = true
          finish(1006, message)
          connection.destroy()
          resume(Effect.fail(new WsDialError(message)))

          return
        }

        finish(1006, message)
        connection.destroy()
      }

      const write = (frame: Uint8Array): void => {
        if (!closed) connection.write(frame)
      }

      const handleMessages = (chunk: Uint8Array): void => {
        if (closed) return
        buffer = concat(buffer, chunk)

        if (!upgraded) {
          const end = findHeaderEnd(buffer)

          if (end < 0) {
            if (buffer.length > MAX_HANDSHAKE_BYTES) fail("handshake response too large")

            return
          }

          if (end + 4 > MAX_HANDSHAKE_BYTES) {
            fail("handshake response too large")

            return
          }

          const head = new TextDecoder("latin1").decode(buffer.subarray(0, end))
          buffer = buffer.subarray(end + 4)
          const check = parseHandshakeResponse(head, key)

          if (check.kind === "rejected") {
            fail("handshake rejected: " + check.reason)

            return
          }

          upgraded = true
          settled = true
          clearHandshakeTimer()
          resume(Effect.succeed(connection))
        }

        if (closed) return
        const decoded = decodeFrames(buffer)

        if (decoded.error !== undefined) {
          fail(decoded.error)

          return
        }

        buffer = decoded.rest

        for (const frame of decoded.frames) {
          const assembled = assembler.push(frame)

          if (assembled.error !== undefined) {
            fail(assembled.error)

            return
          }

          for (const message of assembled.messages) {
            if (message.kind === "ping") {
              write(encodeFrame(OPCODE.pong, message.payload, nextMask()))
            } else if (message.kind === "close") {
              write(encodeFrame(OPCODE.close, new Uint8Array(0), nextMask()))
              finish(message.code, message.reason)
              releaseLocalSocket(connection)

              return
            } else if (message.kind === "text") {
              textConsumer?.(message.text)
            }
          }
        }
      }

      connection.on("connect", () => {
        if (closed || connection.destroyed) {
          connection.destroy()

          return
        }

        connection.write(buildHandshakeRequest(key, options.path ?? "/", "localhost"))
      })
      connection.on("data", (chunk: Uint8Array) => {
        if (closed) return
        handleMessages(chunk)
      })
      connection.on("error", (cause: Error) => {
        fail("socket error: " + cause.message)
      })
      connection.on("end", () => {
        if (!settled) {
          fail("socket ended")

          return
        }

        finish(1006, "socket ended")
        releaseLocalSocket(connection)
      })
      connection.on("close", () => {
        if (!settled) {
          fail("socket closed")

          return
        }

        finish(1006, "socket closed")
      })

      handshakeTimer = setTimeout(() => {
        if (!upgraded) fail("handshake timed out")
      }, handshakeTimeoutMs)

      return Effect.sync(() => {
        clearHandshakeTimer()
        connection.destroy()
      })
    })

    return {
      onText: (consumer) => {
        textConsumer = consumer
      },
      closed: Deferred.await(closedDeferred),
      isClosed: () => closed,
      sendText: (text: string) =>
        Effect.suspend(() => {
          if (closed) {
            return Effect.fail(new WsDialError("connection is closed"))
          }

          return Effect.try({
            try: () => {
              socket.write(encodeFrame(OPCODE.text, new TextEncoder().encode(text), nextMask()))
            },
            catch: () => new WsDialError("write failed"),
          })
        }),
      close: Effect.sync(() => {
        if (closed) return

        if (!socket.destroyed) {
          socket.write(encodeFrame(OPCODE.close, new Uint8Array(0), nextMask()))
        }

        finish(1000, "closed by client")
        releaseLocalSocket(socket)
      }),
    }
  })
