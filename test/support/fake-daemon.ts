import { createHash } from "node:crypto"
import * as net from "node:net"

import * as Schema from "effect/Schema"

import type { JsonRpcError, JsonValue } from "../../src/droid/protocol.ts"
import { decodeFrames, OPCODE } from "../../src/droid/ws.ts"

export interface SeenRequest {
  readonly id: string
  readonly method: string
  readonly params: JsonValue | undefined
  readonly factoryProtocolVersion: string
}

export interface ScriptedReply {
  readonly result?: JsonValue
  readonly error?: JsonRpcError
  /** Record the request, then drop the socket without a reply. */
  readonly drop?: boolean
}

export interface ScriptedHandler {
  /**
   * Return a reply, or `undefined` to stay silent (which lets timeout tests
   * observe a daemon that never answers).
   */
  readonly onRequest?: (request: SeenRequest) => ScriptedReply | undefined
  readonly onOpen?: (push: (value: JsonValue) => void) => void
}

export interface FakeDaemon {
  readonly socketPath: string
  readonly requests: ReadonlyArray<SeenRequest>
  readonly push: (value: JsonValue) => void
  readonly openSockets: () => number
  readonly dropSockets: () => void
  readonly close: () => Promise<void>
}

/** The version a current daemon reports; the client adopts it on mismatch. */
export const DAEMON_PROTOCOL_VERSION = "1.299.0"

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const serverAccept = (key: string): string =>
  createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64")

const ClientFrameSchema = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.optional(Schema.Json),
  factoryProtocolVersion: Schema.String,
})

const encodeServerFrame = (opcode: number, payload: Uint8Array): Uint8Array => {
  const length = payload.length
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10
  const out = new Uint8Array(headerLength + length)
  out[0] = 0x80 | opcode

  if (length < 126) {
    out[1] = length
  } else if (length < 65536) {
    out[1] = 126
    out[2] = (length >>> 8) & 0xff
    out[3] = length & 0xff
  } else {
    out[1] = 127
    let remaining = length

    for (let i = 9; i >= 2; i--) {
      out[i] = remaining % 256
      remaining = Math.floor(remaining / 256)
    }
  }

  out.set(payload, headerLength)

  return out
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)

  return out
}

interface ReplyEnvelope {
  readonly jsonrpc: string
  readonly factoryApiVersion: string
  readonly factoryProtocolVersion: string
  readonly type: "response"
  readonly id: string
  readonly result?: JsonValue
  readonly error?: JsonRpcError
}

const replyEnvelope = (id: string, response: ScriptedReply): ReplyEnvelope => {
  const base = {
    jsonrpc: "2.0",
    factoryApiVersion: "1.0.0",
    factoryProtocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "response" as const,
    id,
  }

  if (response.error !== undefined) return { ...base, error: response.error }

  if (response.result !== undefined) return { ...base, result: response.result }

  return base
}

export const startFakeDaemon = async (
  socketPath: string,
  handler: ScriptedHandler,
): Promise<FakeDaemon> => {
  const requests: Array<SeenRequest> = []
  const sockets: Array<net.Socket> = []
  let open = 0
  const server = net.createServer()

  const push = (value: JsonValue): void => {
    const payload = new TextEncoder().encode(JSON.stringify(value))

    for (const socket of sockets) socket.write(encodeServerFrame(OPCODE.text, payload))
  }

  server.on("connection", (socket) => {
    sockets.push(socket)
    open += 1
    socket.on("close", () => {
      open -= 1
    })
    let buffer: Uint8Array = new Uint8Array(0)
    let upgraded = false

    const reply = (id: string, response: ScriptedReply): void => {
      if (response.drop === true) {
        socket.destroy()

        return
      }

      const payload = new TextEncoder().encode(JSON.stringify(replyEnvelope(id, response)))
      socket.write(encodeServerFrame(OPCODE.text, payload))
    }

    socket.on("data", (chunk: Uint8Array) => {
      buffer = concat(buffer, chunk)

      if (!upgraded) {
        const text = new TextDecoder("latin1").decode(buffer)
        const end = text.indexOf("\r\n\r\n")

        if (end < 0) return
        const head = text.slice(0, end)
        buffer = buffer.subarray(end + 4)
        const match = /sec-websocket-key:\s*(\S+)/i.exec(head)
        const accept = serverAccept(match?.[1] ?? "")
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " +
            accept +
            "\r\n\r\n",
        )
        upgraded = true
        handler.onOpen?.(push)
      }

      const decoded = decodeFrames(buffer)
      buffer = decoded.rest

      for (const frame of decoded.frames) {
        if (frame.opcode !== OPCODE.text) continue

        const text = new TextDecoder().decode(frame.payload)
        const parsed = Schema.decodeUnknownSync(ClientFrameSchema)(JSON.parse(text))

        const seen: SeenRequest = {
          id: parsed.id,
          method: parsed.method,
          params: parsed.params,
          factoryProtocolVersion: parsed.factoryProtocolVersion,
        }

        requests.push(seen)
        const response = handler.onRequest?.(seen)

        if (response !== undefined) reply(parsed.id, response)
      }
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => resolve())
  })

  return {
    socketPath,
    requests,
    push,
    openSockets: () => open,
    dropSockets: () => {
      for (const socket of sockets) socket.destroy()
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
