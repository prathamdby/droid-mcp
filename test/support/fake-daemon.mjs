import { rmSync } from "node:fs"
import { createServer } from "node:net"

/**
 * Stands in for `droid daemon` in supervisor tests. It parses the flags the
 * server passes and then behaves like the mode it was given:
 *
 * - `listen`: create the Unix socket and stay up until asked to exit.
 * - `crash`: exit immediately, as a broken install would.
 * - `silent`: stay alive without ever creating the socket.
 */

const flag = (name) => {
  const index = process.argv.indexOf(name)

  return index === -1 ? undefined : process.argv[index + 1]
}

const socketPath = flag("--unix") ?? ""
const mode = process.env["FAKE_DAEMON_MODE"] ?? "listen"

const server = createServer((socket) => {
  // The supervisor's health check connects and hangs up; that must not crash
  // the fake, and a real daemon would just read the next frame.
  socket.on("error", () => {})
})

if (mode === "crash") process.exit(1)

if (mode === "listen") {
  rmSync(socketPath, { force: true })
  server.listen(socketPath, () => {
    if (process.send !== undefined) process.send({ listening: socketPath })
  })
}

const shutdown = () => {
  if (mode === "listen") rmSync(socketPath, { force: true })
  server.close(() => {
    process.exit(0)
  })
}

process.on("SIGTERM", shutdown)

process.on("SIGINT", shutdown)
