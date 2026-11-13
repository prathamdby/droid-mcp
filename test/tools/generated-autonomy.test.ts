import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"

import { DaemonService } from "../../src/droid/daemon-service.ts"
import type { DaemonApi, DaemonRequest, DaemonStatus } from "../../src/droid/daemon-service.ts"
import { DaemonUnavailable } from "../../src/droid/errors.ts"
import type { JsonValue } from "../../src/droid/protocol.ts"
import type { JsonSchemaObject } from "../../src/generated/surface.ts"
import { generatedSurface } from "../../src/tools/generated.ts"

const status: DaemonStatus = {
  endpoint: "/tmp/daemon.sock",
  supervised: true,
  connected: false,
}

const replyFor = (method: string): JsonValue => {
  if (method === "daemon.update_session_defaults") return { success: true, defaults: {} }

  return { ok: true }
}

const stub = (calls: Array<DaemonRequest>): DaemonApi => ({
  request: (request) =>
    Effect.sync(() => {
      calls.push(request)

      return replyFor(request.method)
    }),
  status: Effect.succeed(status),
  reset: Effect.void,
})

const run = <A, E>(effect: Effect.Effect<A, E, DaemonService>, api: DaemonApi) =>
  Effect.runPromise(Effect.provideService(effect, DaemonService, api))

describe("generated autonomy cap", () => {
  it("does not call the daemon when a settings change exceeds the cap", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "low" })

    const failure = await run(
      surface.handlers
        .daemon_update_session_settings({ sessionId: "s-1", autonomyLevel: "medium" })
        .pipe(Effect.flip),
      stub(calls),
    )

    expect(failure).toMatchObject({ code: "autonomy_exceeds_cap" })
    expect(calls).toHaveLength(0)
  })

  it("sends a settings change the cap allows", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "low" })

    const result = await run(
      surface.handlers.daemon_update_session_settings({
        sessionId: "s-1",
        autonomyLevel: "low",
        modelId: "gpt-6.1-sol",
      }),
      stub(calls),
    )

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        method: "daemon.update_session_settings",
        params: { sessionId: "s-1", autonomyLevel: "low", modelId: "gpt-6.1-sol" },
      },
    ])
  })

  it("uses medium when the caller does not pass a cap", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface()

    const blocked = await run(
      surface.handlers
        .daemon_update_session_settings({ sessionId: "s-1", autonomyLevel: "high" })
        .pipe(Effect.flip),
      stub(calls),
    )

    const allowed = await run(
      surface.handlers.daemon_update_session_settings({
        sessionId: "s-1",
        autonomyLevel: "medium",
      }),
      stub(calls),
    )

    expect(blocked).toMatchObject({ code: "autonomy_exceeds_cap" })
    expect(allowed).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })

  it("allows high only when the cap is high", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "high" })

    const result = await run(
      surface.handlers.daemon_initialize_session({
        machineId: "m-1",
        cwd: "/tmp/app",
        token: "t",
        autonomyLevel: "high",
        skipPermissionsUnsafe: true,
      }),
      stub(calls),
    )

    expect(result).toEqual({ ok: true })
    expect(calls.map((call) => call.method)).toEqual([
      "daemon.get_default_settings",
      "daemon.initialize_session",
    ])
    expect(calls[1]?.params).toEqual({
      machineId: "m-1",
      cwd: "/tmp/app",
      token: "t",
      autonomyLevel: "high",
      autonomyMode: "normal",
      skipPermissionsUnsafe: true,
    })
  })

  it("blocks auto-high, subagent high, and skipPermissionsUnsafe under the cap", async () => {
    const surface = generatedSurface({ maxAutonomy: "medium" })

    const cases: ReadonlyArray<readonly [string, JsonSchemaObject]> = [
      ["daemon_update_session_settings", { sessionId: "s-1", autonomyMode: "auto-high" }],
      ["daemon_update_session_defaults", { subagentAutonomyLevel: "high" }],
      ["daemon_load_session", { sessionId: "s-1", token: "t", skipPermissionsUnsafe: true }],
      [
        "daemon_initialize_session",
        {
          machineId: "m-1",
          cwd: "/tmp/app",
          token: "t",
          autonomyLevel: "low",
          skipPermissionsUnsafe: true,
        },
      ],
    ]

    for (const [tool, params] of cases) {
      const calls: Array<DaemonRequest> = []
      const handler = surface.handlers[tool]

      if (handler === undefined) throw new Error("missing " + tool)

      const failure = await run(handler(params).pipe(Effect.flip), stub(calls))

      expect(failure, tool).toMatchObject({ code: "autonomy_exceeds_cap" })
      expect(calls, tool).toHaveLength(0)
    }
  })

  it("allows spec, normal, and inherit without treating them as a higher level", async () => {
    const surface = generatedSurface({ maxAutonomy: "low" })

    const cases: ReadonlyArray<readonly [string, JsonSchemaObject]> = [
      ["daemon_update_session_settings", { sessionId: "s-1", autonomyMode: "spec" }],
      ["daemon_update_session_settings", { sessionId: "s-1", autonomyMode: "normal" }],
      [
        "daemon_update_session_defaults",
        { subagentAutonomyLevel: "inherit", autonomyLevel: "low" },
      ],
    ]

    for (const [tool, params] of cases) {
      const calls: Array<DaemonRequest> = []
      const handler = surface.handlers[tool]

      if (handler === undefined) throw new Error("missing " + tool)

      await run(handler(params), stub(calls))

      expect(calls, tool).toHaveLength(1)
      expect(calls[0]?.params).toMatchObject(params)
    }
  })

  it("omits unserved tool queries and does not cap tag text that mentions autonomy", async () => {
    const surface = generatedSurface({ maxAutonomy: "off" })
    const calls: Array<DaemonRequest> = []

    expect(surface.handlers.droid_list_tools).toBeUndefined()

    await run(
      surface.handlers.daemon_update_session_settings({
        sessionId: "s-1",
        tags: [{ name: "note", metadata: { autonomyLevel: "high" } }],
      }),
      stub(calls),
    )

    expect(calls.map((call) => call.method)).toEqual(["daemon.update_session_settings"])
  })

  it("still sends initialize and load when authority fields are omitted", async () => {
    const surface = generatedSurface({ maxAutonomy: "off" })
    const calls: Array<DaemonRequest> = []

    await run(
      surface.handlers.daemon_initialize_session({
        machineId: "m-1",
        cwd: "/work",
        token: "tok",
      }),
      stub(calls),
    )

    await run(surface.handlers.daemon_load_session({ sessionId: "s-1", token: "tok" }), stub(calls))

    expect(calls.map((call) => call.method)).toEqual([
      "daemon.get_default_settings",
      "daemon.initialize_session",
      "daemon.load_session",
    ])
    expect(calls[0]?.params).toEqual({ cwd: "/work" })
    expect(calls[1]?.params).toEqual({
      machineId: "m-1",
      cwd: "/work",
      token: "tok",
      autonomyLevel: "off",
      autonomyMode: "normal",
      skipPermissionsUnsafe: false,
    })
    expect(calls[2]?.params).toEqual({ sessionId: "s-1", token: "tok" })
  })

  it("lowers only an initialize request when daemon defaults exceed the cap", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "low" })

    const api: DaemonApi = {
      request: (request) =>
        Effect.sync(() => {
          calls.push(request)

          if (request.method === "daemon.get_default_settings") {
            return { autonomyLevel: "high", autonomyMode: "auto-high" }
          }

          return replyFor(request.method)
        }),
      status: Effect.succeed(status),
      reset: Effect.void,
    }

    const result = await run(
      surface.handlers.daemon_initialize_session({
        machineId: "m-1",
        cwd: "/work",
        token: "tok",
      }),
      api,
    )

    expect(result).toEqual({ ok: true })
    expect(calls.map((call) => call.method)).toEqual([
      "daemon.get_default_settings",
      "daemon.initialize_session",
    ])
    expect(calls[1]?.params).toEqual({
      machineId: "m-1",
      cwd: "/work",
      token: "tok",
      autonomyLevel: "low",
      autonomyMode: "auto-low",
      skipPermissionsUnsafe: false,
    })
  })

  it("pins a within-cap observed default onto the initialize request", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "medium" })

    const api: DaemonApi = {
      request: (request) =>
        Effect.sync(() => {
          calls.push(request)

          if (request.method === "daemon.get_default_settings") return { autonomyLevel: "low" }

          return replyFor(request.method)
        }),
      status: Effect.succeed(status),
      reset: Effect.void,
    }

    await run(
      surface.handlers.daemon_initialize_session({
        machineId: "m-1",
        cwd: "/work",
        token: "tok",
        autonomyMode: "normal",
      }),
      api,
    )

    expect(calls.map((call) => call.method)).toEqual([
      "daemon.get_default_settings",
      "daemon.initialize_session",
    ])
    expect(calls[1]?.params).toEqual({
      machineId: "m-1",
      cwd: "/work",
      token: "tok",
      autonomyMode: "normal",
      autonomyLevel: "low",
      skipPermissionsUnsafe: false,
    })
  })

  it("pins the first settings snapshot when defaults change before initialize", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "medium" })
    let reads = 0

    const api: DaemonApi = {
      request: (request) =>
        Effect.sync(() => {
          calls.push(request)

          if (request.method === "daemon.get_default_settings") {
            reads += 1

            if (reads === 1) return { autonomyLevel: "low", autonomyMode: "spec" }

            return { autonomyLevel: "high", autonomyMode: "auto-high" }
          }

          return replyFor(request.method)
        }),
      status: Effect.succeed(status),
      reset: Effect.void,
    }

    const result = await run(
      surface.handlers.daemon_initialize_session({
        machineId: "m-1",
        cwd: "/work",
        token: "tok",
      }),
      api,
    )

    expect(result).toEqual({ ok: true })
    expect(reads).toBe(1)
    expect(calls.map((call) => call.method)).toEqual([
      "daemon.get_default_settings",
      "daemon.initialize_session",
    ])
    expect(calls[1]?.params).toEqual({
      machineId: "m-1",
      cwd: "/work",
      token: "tok",
      autonomyLevel: "low",
      autonomyMode: "spec",
      skipPermissionsUnsafe: false,
    })
  })

  it("sets omitted skipPermissionsUnsafe to false only under a cap below high", async () => {
    const below = generatedSurface({ maxAutonomy: "medium" })
    const belowCalls: Array<DaemonRequest> = []

    await run(
      below.handlers.daemon_initialize_session({
        machineId: "m-1",
        cwd: "/work",
        token: "tok",
        autonomyLevel: "low",
        autonomyMode: "normal",
      }),
      stub(belowCalls),
    )

    expect(belowCalls.map((call) => call.method)).toEqual(["daemon.initialize_session"])
    expect(belowCalls[0]?.params).toEqual({
      machineId: "m-1",
      cwd: "/work",
      token: "tok",
      autonomyLevel: "low",
      autonomyMode: "normal",
      skipPermissionsUnsafe: false,
    })

    const high = generatedSurface({ maxAutonomy: "high" })
    const highCalls: Array<DaemonRequest> = []

    const highParams = {
      machineId: "m-1",
      cwd: "/work",
      token: "tok",
      autonomyLevel: "high",
      autonomyMode: "auto-high",
    }

    await run(high.handlers.daemon_initialize_session(highParams), stub(highCalls))

    expect(highCalls).toEqual([{ method: "daemon.initialize_session", params: highParams }])
  })

  it("does not initialize when default settings cannot be read", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "low" })

    const api: DaemonApi = {
      request: (request) => {
        calls.push(request)

        return Effect.fail(new DaemonUnavailable({ message: "socket down" }))
      },
      status: Effect.succeed(status),
      reset: Effect.void,
    }

    const failure = await run(
      surface.handlers
        .daemon_initialize_session({ machineId: "m-1", cwd: "/work", token: "tok" })
        .pipe(Effect.flip),
      api,
    )

    expect(failure).toMatchObject({ code: "daemon_unavailable" })
    expect(calls.map((call) => call.method)).toEqual(["daemon.get_default_settings"])
  })

  it("still rejects a level the SDK schema does not define", async () => {
    const calls: Array<DaemonRequest> = []
    const surface = generatedSurface({ maxAutonomy: "high" })

    const failure = await run(
      surface.handlers
        .daemon_update_session_settings({ sessionId: "s-1", autonomyLevel: "highest" })
        .pipe(Effect.flip),
      stub(calls),
    )

    expect(failure).toMatchObject({ code: "invalid_params" })
    expect(calls).toHaveLength(0)
  })
})
