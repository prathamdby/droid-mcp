#!/usr/bin/env node
/**
 * Transport-only stand-in for `droid exec`. Session tests keep
 * fake-droid-exec.mjs; this script only reproduces pipe and signal edges.
 *
 * FAKE_EXEC_TRANSPORT_MODE:
 *   unterminated  one valid response without a trailing newline, then exit
 *   huge-line     one over-long stdout write and stay up
 *   stderr-bytes  three é bytes on stderr, then a normal response
 *   ignore-term   ignore SIGTERM and stay up until SIGKILL
 *   exit-now      exit before reading stdin
 */

const mode = process.env.FAKE_EXEC_TRANSPORT_MODE ?? "unterminated"

const response = (id, result) =>
  JSON.stringify({
    jsonrpc: "2.0",
    factoryApiVersion: "1.0.0",
    factoryProtocolVersion: "1.299.0",
    type: "response",
    id,
    result,
  })

if (mode === "exit-now") process.exit(0)

if (mode === "ignore-term") {
  process.on("SIGTERM", () => {})
  process.stdin.resume()
  setInterval(() => {}, 1_000)
}

if (mode === "stderr-bytes") process.stderr.write("ééé")

process.stdin.on("data", () => {
  if (mode === "unterminated") {
    process.stdout.write(response("droid-mcp-1", { sessionId: "tail" }), () => {
      setTimeout(() => process.exit(0), 50)
    })

    return
  }

  if (mode === "huge-line") {
    process.stdout.write("x".repeat(300))

    return
  }

  if (mode === "stderr-bytes") {
    process.stdout.write(response("droid-mcp-1", { sessionId: "bytes" }) + "\n", () => {
      setTimeout(() => process.exit(0), 30)
    })
  }
})
