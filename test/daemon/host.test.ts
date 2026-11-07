import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { connect, createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Config } from "../../src/config.ts"
import { daemonHost } from "../../src/droid/daemon-host.ts"
import type { DaemonHost, DaemonHostOptions } from "../../src/droid/daemon-host.ts"
import { errorCode } from "../../src/droid/errors.ts"
import { testConfig } from "../support/config.ts"

const fake = join(process.cwd(), "test", "support", "fake-daemon.mjs")

const FAST: DaemonHostOptions = {
  retryAttempts: 2,
  startTimeoutMs: 1_500,
  backoffBaseMs: 20,
  backoffMaxMs: 50,
  socketPollMs: 20,
  shutdownMs: 200,
}

/** A `droid` that runs the fake daemon whatever the arguments are. */
const shim = (directory: string): string => {
  const path = join(directory, "droid")

  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
  chmodSync(path, 0o755)

  return path
}

const accepts = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ path: socketPath })

    socket.setTimeout(500)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })
  })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

const bindSocket = (socketPath: string): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on("error", () => {})
      socket.end()
    })

    server.listen(socketPath, () => resolve(server))
  })

const closeListening = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
  })

const waitUntilPidCleared = async (host: DaemonHost): Promise<number | undefined> => {
  const deadline = Date.now() + 1_000
  let pid = await Effect.runPromise(host.childPid)

  while (pid !== undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    pid = await Effect.runPromise(host.childPid)
  }

  return pid
}

let directory: string
let config: Config

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "droid-mcp-host-"))
  config = testConfig({
    socketPath: join(directory, "daemon.sock"),
    runtimeDir: directory,
    droidPath: shim(directory),
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe("daemon supervisor", () => {
  it("spawns a daemon on first use and reports its pid", async () => {
    const host = await Effect.runPromise(daemonHost(config, FAST))

    expect(existsSync(config.socketPath)).toBe(false)

    await Effect.runPromise(host.ensure)

    expect(await accepts(config.socketPath)).toBe(true)

    const pid = await Effect.runPromise(host.childPid)

    expect(pid).toBeGreaterThan(0)
    await Effect.runPromise(host.stop)
    expect(alive(pid ?? 0)).toBe(false)
    expect(existsSync(config.socketPath)).toBe(false)
  })

  it("reuses a daemon that is already listening", async () => {
    const first = await Effect.runPromise(daemonHost(config, FAST))

    await Effect.runPromise(first.ensure)
    const spawned = await Effect.runPromise(first.childPid)

    const second = await Effect.runPromise(daemonHost(config, FAST))

    await Effect.runPromise(second.ensure)
    expect(await Effect.runPromise(second.childPid)).toBeUndefined()
    expect(await accepts(config.socketPath)).toBe(true)

    await Effect.runPromise(second.stop)
    expect(alive(spawned ?? 0)).toBe(true)

    await Effect.runPromise(first.stop)
  })

  it("spawns again after the daemon exits", async () => {
    const host = await Effect.runPromise(daemonHost(config, FAST))

    await Effect.runPromise(host.ensure)
    const first = await Effect.runPromise(host.childPid)

    if (first === undefined) throw new Error("no pid after ensure")

    process.kill(first, "SIGKILL")

    expect(await waitUntilPidCleared(host)).toBeUndefined()
    expect(existsSync(config.socketPath)).toBe(false)

    await Effect.runPromise(host.ensure)
    const second = await Effect.runPromise(host.childPid)

    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(await accepts(config.socketPath)).toBe(true)

    await Effect.runPromise(host.stop)
  })

  it("retries a daemon that never listens, then gives up", async () => {
    process.env["FAKE_DAEMON_MODE"] = "silent"

    try {
      const host = await Effect.runPromise(daemonHost(config, FAST))
      const error = await Effect.runPromise(host.ensure.pipe(Effect.flip))

      expect(errorCode(error)).toBe("daemon_unavailable")
      expect(error.detail).toContain("2 attempts")
      expect(existsSync(config.socketPath)).toBe(false)
    } finally {
      delete process.env["FAKE_DAEMON_MODE"]
    }
  })

  it("fails when the daemon crashes on start, and leaves no socket behind", async () => {
    process.env["FAKE_DAEMON_MODE"] = "crash"

    try {
      const host = await Effect.runPromise(daemonHost(config, FAST))
      const error = await Effect.runPromise(host.ensure.pipe(Effect.flip))

      expect(errorCode(error)).toBe("daemon_unavailable")
      expect(existsSync(config.socketPath)).toBe(false)
    } finally {
      delete process.env["FAKE_DAEMON_MODE"]
    }
  })

  it("fails without crashing when the droid binary is missing or not executable", async () => {
    const plain = join(directory, "plain")

    writeFileSync(plain, "#!/bin/sh\nexit 0\n")
    chmodSync(plain, 0o644)

    for (const [droidPath, cause] of [
      [join(directory, "missing"), "ENOENT"],
      [plain, "EACCES"],
    ]) {
      const host = await Effect.runPromise(daemonHost(testConfig({ ...config, droidPath }), FAST))
      const error = await Effect.runPromise(host.ensure.pipe(Effect.flip))

      expect(errorCode(error)).toBe("daemon_unavailable")
      expect(error.detail).toContain(cause)
    }
  })

  it("never spawns when told to dial a daemon URL", async () => {
    const remote = testConfig({
      ...config,
      daemonUrl: "http://127.0.0.1:7337",
    })

    const host = await Effect.runPromise(daemonHost(remote, FAST))

    await Effect.runPromise(host.ensure)

    expect(await Effect.runPromise(host.childPid)).toBeUndefined()
    expect(existsSync(config.socketPath)).toBe(false)
  })

  it("shuts the daemon down on stop, twice, without failing", async () => {
    const host = await Effect.runPromise(daemonHost(config, FAST))

    await Effect.runPromise(host.ensure)
    const pid = await Effect.runPromise(host.childPid)

    await Effect.runPromise(host.stop)
    await Effect.runPromise(host.stop)

    expect(alive(pid ?? 0)).toBe(false)
  })

  it("returns as soon as the child exits instead of waiting out the grace period", async () => {
    const host = await Effect.runPromise(daemonHost(config, { ...FAST, shutdownMs: 5_000 }))

    await Effect.runPromise(host.ensure)
    const started = Date.now()
    await Effect.runPromise(host.stop)

    expect(Date.now() - started).toBeLessThan(1_500)
    expect(existsSync(config.socketPath)).toBe(false)
  })

  it("keeps a single child when ensure runs twice at once", async () => {
    const host = await Effect.runPromise(daemonHost(config, FAST))

    await Effect.runPromise(Effect.all([host.ensure, host.ensure], { concurrency: "unbounded" }))

    const listing = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })

    const owned = listing
      .split("\n")
      .filter((line) => line.includes(config.socketPath) && line.includes("fake-daemon.mjs"))

    expect(owned).toHaveLength(1)
    expect(await accepts(config.socketPath)).toBe(true)

    await Effect.runPromise(host.stop)
    const after = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })

    const left = after
      .split("\n")
      .filter((line) => line.includes(config.socketPath) && line.includes("fake-daemon.mjs"))

    expect(left).toHaveLength(0)
  })

  it("replaces a killed daemon without losing the new socket", async () => {
    const host = await Effect.runPromise(daemonHost(config, FAST))

    for (let attempt = 0; attempt < 5; attempt++) {
      await Effect.runPromise(host.ensure)
      const pid = await Effect.runPromise(host.childPid)

      if (pid === undefined) throw new Error("no pid after ensure")

      process.kill(pid, "SIGKILL")
      await Effect.runPromise(host.ensure)
      expect(await accepts(config.socketPath)).toBe(true)
    }

    await Effect.runPromise(host.stop)
  })

  it("clears an exited child and does not unlink a replacement socket", async () => {
    const host = await Effect.runPromise(daemonHost(config, FAST))

    await Effect.runPromise(host.ensure)
    const pid = await Effect.runPromise(host.childPid)

    if (pid === undefined) throw new Error("no pid after ensure")

    const ownedIno = statSync(config.socketPath, { bigint: true }).ino
    rmSync(config.socketPath, { force: true })
    const replacement = await bindSocket(config.socketPath)
    const replacementIno = statSync(config.socketPath, { bigint: true }).ino

    expect(replacementIno).not.toBe(ownedIno)

    try {
      process.kill(pid, "SIGKILL")

      expect(await waitUntilPidCleared(host)).toBeUndefined()
      expect(statSync(config.socketPath, { bigint: true }).ino).toBe(replacementIno)
      expect(await accepts(config.socketPath)).toBe(true)
    } finally {
      await Effect.runPromise(host.stop)
      await closeListening(replacement)
    }
  })

  it("does not unlink a replacement socket on stop", async () => {
    const host = await Effect.runPromise(daemonHost(config, FAST))

    await Effect.runPromise(host.ensure)
    const pid = await Effect.runPromise(host.childPid)

    if (pid === undefined) throw new Error("no pid after ensure")

    rmSync(config.socketPath, { force: true })
    const replacement = await bindSocket(config.socketPath)
    const replacementIno = statSync(config.socketPath, { bigint: true }).ino

    try {
      await Effect.runPromise(host.stop)

      expect(alive(pid)).toBe(false)
      expect(existsSync(config.socketPath)).toBe(true)
      expect(statSync(config.socketPath, { bigint: true }).ino).toBe(replacementIno)
      expect(await accepts(config.socketPath)).toBe(true)
    } finally {
      await closeListening(replacement)
    }
  })

  it("keeps the fake's own restart loop honest", () => {
    // The fake must exit non-zero in crash mode; otherwise the crash test
    // above would pass for the wrong reason.
    expect(() =>
      execFileSync(process.execPath, [fake, "daemon", "--unix", join(directory, "x.sock")], {
        env: { ...process.env, FAKE_DAEMON_MODE: "crash" },
        stdio: "ignore",
      }),
    ).toThrow()
  })
})
