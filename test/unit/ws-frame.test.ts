import { describe, expect, it } from "vitest"

import { decodeFrames, encodeFrame, makeAssembler, OPCODE } from "../../src/droid/ws.ts"
import type { Frame } from "../../src/droid/ws.ts"

const mask = new Uint8Array([0x12, 0x34, 0x56, 0x78])
const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const read = (value: Uint8Array): string => new TextDecoder().decode(value)

const roundTrip = (opcode: number, payload: Uint8Array): Frame => {
  const encoded = encodeFrame(opcode, payload, mask)
  const decoded = decodeFrames(encoded)
  expect(decoded.error).toBeUndefined()
  expect(decoded.rest.length).toBe(0)
  expect(decoded.frames.length).toBe(1)

  return decoded.frames[0]!
}

describe("frame codec", () => {
  it("masks small payloads and round-trips them", () => {
    const frame = roundTrip(OPCODE.text, text("hello"))
    expect(frame.opcode).toBe(OPCODE.text)
    expect(frame.fin).toBe(true)
    expect(read(frame.payload)).toBe("hello")
  })

  it("writes the 16-bit length for medium payloads", () => {
    const payload = new Uint8Array(300).fill(7)
    const encoded = encodeFrame(OPCODE.text, payload, mask)
    expect(encoded[1]).toBe(0x80 | 126)
    expect(encoded[2]).toBe(1)
    expect(encoded[3]).toBe(44)
    const frame = roundTrip(OPCODE.text, payload)
    expect(frame.payload.length).toBe(300)
  })

  it("writes the 64-bit length for large payloads", () => {
    const payload = new Uint8Array(70_000).fill(9)
    const encoded = encodeFrame(OPCODE.text, payload, mask)
    expect(encoded[1]).toBe(0x80 | 127)
    const frame = roundTrip(OPCODE.text, payload)
    expect(frame.payload.length).toBe(70_000)
    expect(frame.payload[69_999]).toBe(9)
  })

  it("keeps a partial frame in the remainder", () => {
    const encoded = encodeFrame(OPCODE.text, text("complete"), mask)
    const next = encodeFrame(OPCODE.text, text("partial"), mask)
    const joined = new Uint8Array(encoded.length + next.length)
    joined.set(encoded, 0)
    joined.set(next, 0 + encoded.length)

    const first = decodeFrames(joined.subarray(0, encoded.length + 3))
    expect(first.frames.length).toBe(1)
    expect(read(first.frames[0]!.payload)).toBe("complete")
    expect(first.rest.length).toBe(3)

    const second = decodeFrames(first.rest)
    expect(second.frames.length).toBe(0)
    expect(second.rest.length).toBe(3)

    const all = decodeFrames(joined)
    expect(all.frames.length).toBe(2)
    expect(read(all.frames[1]!.payload)).toBe("partial")
  })

  it("returns an error above the frame cap", () => {
    const encoded = encodeFrame(OPCODE.text, new Uint8Array(200), mask)
    const decoded = decodeFrames(encoded, 100)
    expect(decoded.error).toBe("frame exceeds the size cap")
  })
})

describe("message assembler", () => {
  it("reassembles a fragmented text message", () => {
    const assembler = makeAssembler()
    const first = assembler.push({ fin: false, opcode: OPCODE.text, payload: text("frag") })
    expect(first.messages.length).toBe(0)

    const second = assembler.push({
      fin: true,
      opcode: OPCODE.continuation,
      payload: text("mented"),
    })

    expect(second.error).toBeUndefined()
    expect(second.messages.length).toBe(1)
    expect(second.messages[0]).toEqual({ kind: "text", text: "fragmented" })
  })

  it("passes ping and pong through while a message is fragmented", () => {
    const assembler = makeAssembler()
    assembler.push({ fin: false, opcode: OPCODE.text, payload: text("a") })
    const ping = assembler.push({ fin: true, opcode: OPCODE.ping, payload: new Uint8Array([1]) })
    expect(ping.messages[0]).toEqual({ kind: "ping", payload: new Uint8Array([1]) })

    const done = assembler.push({
      fin: true,
      opcode: OPCODE.continuation,
      payload: text("b"),
    })

    expect(done.messages[0]).toEqual({ kind: "text", text: "ab" })
  })

  it("decodes close codes and reasons", () => {
    const assembler = makeAssembler()
    const payload = new Uint8Array([0x03, 0xe8, ...text("done")])
    const result = assembler.push({ fin: true, opcode: OPCODE.close, payload })
    expect(result.messages[0]).toEqual({ kind: "close", code: 1000, reason: "done" })
  })

  it("rejects binary frames", () => {
    const assembler = makeAssembler()

    const result = assembler.push({
      fin: true,
      opcode: OPCODE.binary,
      payload: new Uint8Array([1]),
    })

    expect(result.error).toBe("binary frames are not supported")
  })

  it("rejects a continuation without a message", () => {
    const assembler = makeAssembler()

    const result = assembler.push({
      fin: true,
      opcode: OPCODE.continuation,
      payload: new Uint8Array([1]),
    })

    expect(result.error).toBe("continuation without a message")
  })

  it("rejects a message above the cap", () => {
    const assembler = makeAssembler(5)
    assembler.push({ fin: false, opcode: OPCODE.text, payload: text("abc") })

    const result = assembler.push({
      fin: true,
      opcode: OPCODE.continuation,
      payload: text("def"),
    })

    expect(result.error).toBe("message exceeds the size cap")
  })
})
