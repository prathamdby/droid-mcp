import { createServer } from "node:net"

import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { testConfig } from "../support/config.ts"
import { type Json, initialize, readBody, startServer } from "../support/mcp-http.ts"

const KEY = "generated-failure-key"

const FailureSchema = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Boolean,
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
})

const AddressSchema = Schema.Struct({ port: Schema.Number })

/** A port nothing listens on: the daemon layer fails fast instead of spawning. */
const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()

    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      Option.match(Schema.decodeUnknownOption(AddressSchema)(probe.address()), {
        onNone: () => reject(new Error("no port")),
        onSome: ({ port }) => probe.close(() => resolve(port)),
      })
    })
  })

/**
 * A generated tool has no hand-written handler, so its failure contract comes
 * from `Tool.dynamic`. Without a declared failure schema a typed failure turns
 * into a defect and the client sees "internal server error" instead of the
 * daemon's code, which is what this asserts never happens.
 */
describe("generated tool failures", () => {
  it("reports an unreachable daemon as a typed failure, not an internal error", async () => {
    const port = await closedPort()

    const config = testConfig({
      daemonUrl: "http://127.0.0.1:" + String(port),
      factoryApiKey: "test-key",
    })

    const server = await startServer({ config, keys: [KEY] })

    const call: Record<string, Json> =
      config.toolProfile === "compact"
        ? { name: "tool_call", arguments: { name: "daemon_list_models" } }
        : { name: "daemon_list_models", arguments: {} }

    try {
      const { sessionId } = await initialize(server, "2025-11-25", {
        authorization: "Bearer " + KEY,
      })

      const response = await server.post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: call,
        },
        {
          authorization: "Bearer " + KEY,
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-11-25",
        },
      )

      const body = Schema.decodeUnknownSync(FailureSchema)(await readBody(response))

      expect(body.result.isError).toBe(true)

      const text = body.result.content[0]?.text ?? ""

      expect(text).not.toContain("internal server error")

      const failure = Schema.decodeUnknownSync(
        Schema.Struct({ code: Schema.String, message: Schema.String }),
      )(JSON.parse(text))

      expect(failure.code).toBe("daemon_unavailable")
    } finally {
      await server.dispose()
    }
  })
})
