import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Config } from "../../src/config.ts"
import { daemonHost } from "../../src/droid/daemon-host.ts"
import type { DaemonHostOptions } from "../../src/droid/daemon-host.ts"
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
    await new Promise((resolve) => setTimeout(resolve, 300))

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
