import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { Config } from "../../src/config.ts"
import { restLayer } from "../../src/droid/rest-service.ts"
import type { RestService } from "../../src/droid/rest-service.ts"
import { restTools } from "../../src/tools/rest.ts"
import { testConfig } from "../support/config.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi } from "../support/fake-factory-api.ts"

const buildConfig = (apiKey: string | undefined, baseUrl: string): Config =>
  testConfig({ factoryApiKey: apiKey, factoryBaseUrl: baseUrl })

describe("rest tools", () => {
  let api: FakeFactoryApi

  beforeAll(async () => {
    api = await startFakeFactoryApi()
  })

  afterAll(async () => {
    await api.close()
  })

  const withRest = <A, E>(
    apiKey: string | undefined,
    run: (handlers: ReturnType<typeof restTools>["handlers"]) => Effect.Effect<A, E, RestService>,
  ): Promise<A> => {
    const config = buildConfig(apiKey, api.baseUrl)
    const { handlers } = restTools(config)

    return Effect.runPromise(Effect.provide(run(handlers), restLayer(config)))
  }

  it("lists computers through the hosted API", async () => {
    const result = await withRest("secret-key", (handlers) => handlers.rest_list_computers())

    expect(result).toEqual({
      computers: [
        {
          id: "c-1",
          name: "box",
          hostname: "box.local",
          providerType: "byom",
          status: "active",
          createdAt: 1,
          relayClientUrl: "wss://relay.example/c-1",
          remoteUser: "dev",
        },
      ],
    })
    const call = api.calls.at(-1)

    expect(call?.method).toBe("GET")
    expect(call?.path).toBe("/api/v0/computers")
    expect(call?.authorization).toBe("Bearer secret-key")
  })

  it("reads one computer by id", async () => {
    const result = await withRest("secret-key", (handlers) =>
      handlers.rest_get_computer({ computerId: "c-1" }),
    )

    expect(result).toMatchObject({ id: "c-1", name: "box" })
    expect(api.calls.at(-1)?.path).toBe("/api/v0/computers/c-1")
  })

  it("creates a computer with the requested fields", async () => {
    await withRest("secret-key", (handlers) =>
      handlers.rest_create_computer({
        name: "box",
        remoteUser: "dev",
        repos: ["github.com/acme/app"],
      }),
    )
    const call = api.calls.at(-1)

    expect(call?.method).toBe("POST")
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({
      name: "box",
      remoteUser: "dev",
      repos: ["github.com/acme/app"],
    })
  })

  it("deletes and restarts by id", async () => {
    const deleted = await withRest("secret-key", (handlers) =>
      handlers.rest_delete_computer({ computerId: "c-9" }),
    )

    expect(deleted).toEqual({ deleted: true })
    expect(api.calls.at(-1)?.method).toBe("DELETE")

    const restarted = await withRest("secret-key", (handlers) =>
      handlers.rest_restart_computer({ computerId: "c-9" }),
    )

    expect(restarted).toEqual({ restarted: true })
    expect(api.calls.at(-1)?.path).toBe("/api/v0/computers/c-9/restart")
  })

  it("lists machine templates and reads one", async () => {
    const listed = await withRest("secret-key", (handlers) =>
      handlers.rest_list_machine_templates({ limit: 10 }),
    )

    expect(listed).toMatchObject({ templates: [{ templateId: "t-1" }] })
    expect(api.calls.at(-1)?.path).toBe("/api/v0/machines/templates?limit=10")

    const one = await withRest("secret-key", (handlers) =>
      handlers.rest_get_machine_template({ templateId: "t-1" }),
    )

    expect(one).toMatchObject({ templateId: "t-1", templateName: "app" })
    expect(api.calls.at(-1)?.path).toBe("/api/v0/machines/templates/t-1")
  })

  it("lists remote sessions for the account", async () => {
    const listed = await withRest("secret-key", (handlers) =>
      handlers.rest_list_remote_sessions({ computerId: "c-1" }),
    )

    expect(listed).toMatchObject({ sessions: [{ sessionId: "s-1" }] })
    expect(api.calls.at(-1)?.path).toBe("/api/v0/sessions?computerId=c-1")
  })

  it("fails with a clear code when the API key is missing", async () => {
    const error = await withRest(undefined, (handlers) => handlers.rest_list_computers()).catch(
      (cause: unknown) => cause,
    )

    expect(error).toMatchObject({ code: "factory_api_key_missing" })
  })
})
