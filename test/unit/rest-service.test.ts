import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Predicate from "effect/Predicate"
import { afterEach, describe, expect, it } from "vitest"

import { RestService, restLayer } from "../../src/droid/rest-service.ts"
import type { RestApi } from "../../src/droid/rest-service.ts"
import { testConfig } from "../support/config.ts"

/** A server that answers nothing, or only headers, and reports when the client goes away. */
interface Stalling {
  readonly baseUrl: string
  readonly received: Promise<void>
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
}

const startStalling = async (sendHeaders: boolean): Promise<Stalling> => {
  let onReceived = (): void => {}
  let onClosed = (): void => {}

  const received = new Promise<void>((resolve) => {
    onReceived = resolve
  })

  const closed = new Promise<void>((resolve) => {
    onClosed = resolve
  })

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume()
    response.on("close", onClosed)

    if (sendHeaders) {
      response.writeHead(200, { "content-type": "application/octet-stream" })
      response.write(new Uint8Array(16))
    }

    onReceived()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()

  if (address === null || Predicate.isString(address)) throw new Error("server did not bind")

  return {
    baseUrl: "http://127.0.0.1:" + String(address.port),
    received,
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}

const servers: Array<Stalling> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const SPACE = "/api/context/spaces/s-1"

const calls: ReadonlyArray<
  readonly [string, boolean, (rest: RestApi) => Effect.Effect<unknown, unknown>]
> = [
  [
    "a Context request waiting for headers",
    false,
    (rest) =>
      rest.context({
        operation: "getContextSpace",
        method: "GET",
        path: SPACE,
        query: [],
        body: undefined,
        response: "json",
      }),
  ],
  [
    "a Context byte read in the middle of its body",
    true,
    (rest) =>
      rest.contextBytes({
        operation: "readContextFilePart",
        path: SPACE + "/files/f-1/parts/0",
        maxBytes: 1024,
      }),
  ],
  [
    "a hosted request in the middle of its body",
    true,
    (rest) =>
      rest.request({
        operation: "getComputer",
        method: "GET",
        path: "/api/v0/computers/c-1",
        query: [],
        body: undefined,
        response: "json",
        secrets: [],
      }),
  ],
]

describe("RestService cancellation", () => {
  it.each(calls)("aborts %s when its fiber is interrupted", async (_label, sendHeaders, call) => {
    const server = await startStalling(sendHeaders)

    servers.push(server)

    const config = testConfig({
      factoryApiKey: "k",
      factoryBaseUrl: server.baseUrl,
      factoryContextBaseUrl: server.baseUrl,
    })

    const fiber = Effect.runFork(
      Effect.gen(function* () {
        return yield* call(yield* RestService)
      }).pipe(Effect.provide(restLayer(config))),
    )

    await server.received
    await Effect.runPromise(Fiber.interrupt(fiber))

    const outcome = await Promise.race([
      server.closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000)),
    ])

    expect(outcome).toBe("closed")
  })
})
