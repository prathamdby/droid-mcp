import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"

import { DaemonService } from "../../src/droid/daemon-service.ts"
import type { DaemonApi, DaemonRequest, DaemonStatus } from "../../src/droid/daemon-service.ts"
import { DaemonUnavailable } from "../../src/droid/errors.ts"
import type { JsonValue } from "../../src/droid/protocol.ts"
import { generatedSurface } from "../../src/tools/generated.ts"

const status: DaemonStatus = {
  endpoint: "/tmp/daemon.sock",
  supervised: true,
  connected: false,
}

const stub = (
  calls: Array<DaemonRequest>,
  reply: (request: DaemonRequest) => Effect.Effect<JsonValue | undefined, DaemonUnavailable> = () =>
    Effect.succeed({ ok: true }),
): DaemonApi => ({
  request: (request) =>
    Effect.gen(function* () {
      calls.push(request)

      return yield* reply(request)
    }),
  status: Effect.succeed(status),
  reset: Effect.void,
})

const surface = generatedSurface()

const run = <A, E>(effect: Effect.Effect<A, E, DaemonService>, api: DaemonApi) =>
  Effect.runPromise(Effect.provideService(effect, DaemonService, api))

describe("generated daemon tools", () => {
  it("sends the SDK method and the validated params", async () => {
    const calls: Array<DaemonRequest> = []
    const handler = surface.handlers.daemon_list_crons
    const result = await run(handler({ sessionId: "s-1", includeInactive: true }), stub(calls))

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method: "daemon.list_crons",
      params: { sessionId: "s-1", includeInactive: true },
    })
  })

  it("rejects params that do not match the SDK schema without calling the daemon", async () => {
    const calls: Array<DaemonRequest> = []

    const failure = await run(
      surface.handlers.daemon_list_crons({ includeInactive: "yes" }).pipe(Effect.flip),
      stub(calls),
    )

    expect(failure).toMatchObject({ code: "invalid_params" })
    expect(calls).toHaveLength(0)
  })

  it("maps a daemon failure to the tool error contract", async () => {
    const failure = await run(
      surface.handlers.daemon_list_crons({ sessionId: "s-1" }).pipe(Effect.flip),
      stub([], () => Effect.fail(new DaemonUnavailable({ message: "no socket" }))),
    )

    expect(failure).toMatchObject({ code: "daemon_unavailable", message: "no socket" })
  })

  it("sends params unchanged for a method with only required fields", async () => {
    const calls: Array<DaemonRequest> = []
    await run(surface.handlers.daemon_list_models({}), stub(calls))

    expect(calls[0]?.method).toBe("daemon.list_models")
  })

  it("gives every daemon method a handler", () => {
    for (const [name, handler] of Object.entries(surface.handlers)) {
      expect(handler).toBeTypeOf("function")
      expect(name.startsWith("daemon_") || name.startsWith("droid_")).toBe(true)
    }

    expect(Object.keys(surface.handlers)).toHaveLength(surface.count)
  })
})
