/**
 * Measures what an MCP client pays to connect: the `initialize` and
 * `tools/list` replies of the real `/mcp` layer, per tool profile. Prints a
 * JSON array with one entry per profile. Approximate tokens are UTF-8 bytes / 4.
 *
 *   node --experimental-strip-types scripts/measure.ts [compact|full ...]
 */
import * as HttpRouter from "effect/http/HttpRouter"
import * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"

import { parseConfig } from "../src/config.ts"
import * as auth from "../src/http/auth.ts"
import { mcpLayer } from "../src/http/server.ts"

const KEY = "measure-key"
const PROTOCOL = "2025-11-25"

const profiles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["compact", "full"]

const bodyOf = async (response: Response): Promise<string> => {
  const text = await response.text()

  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return text

  const data = text.split("\n").find((line) => line.startsWith("data:"))

  return data === undefined ? "" : data.slice(5).trim()
}

const measure = async (profile: string) => {
  const config = parseConfig(["serve"], {
    DROID_MCP_KEYS: KEY,
    DROID_MCP_TOOL_PROFILE: profile,
    DROID_MCP_LOG_LEVEL: "error",
  })

  const app = mcpLayer({ config, keys: [KEY] }).pipe(
    Layer.provide(auth.layer(auth.keyringFrom([KEY]))),
  )

  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

  const post = (body: Schema.Json, headers: Record<string, string>) =>
    handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer " + KEY,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    )

  try {
    const init = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "measure", version: "1" },
        },
      },
      {},
    )

    const initBody = await bodyOf(init)

    const session = {
      "mcp-session-id": init.headers.get("mcp-session-id") ?? "",
      "mcp-protocol-version": PROTOCOL,
    }

    const list = await bodyOf(
      await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session),
    )

    const tools: Array<{
      name: string
      description?: string
      inputSchema: unknown
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
    }> = JSON.parse(list).result.tools

    const minimal = tools.reduce(
      (sum, tool) =>
        sum +
        Buffer.byteLength(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }),
        ),
      0,
    )

    const listBytes = Buffer.byteLength(list)
    const initBytes = Buffer.byteLength(initBody)

    return {
      profile: config.toolProfile,
      tools: tools.length,
      toolsListBytes: listBytes,
      toolsListApproxTokens: Math.round(listBytes / 4),
      minimalToolBytes: minimal,
      initializeBytes: initBytes,
      connectBytes: listBytes + initBytes,
      connectApproxTokens: Math.round((listBytes + initBytes) / 4),
      readOnlyHints: tools.filter((tool) => tool.annotations?.readOnlyHint === true).length,
      destructiveHints: tools.filter((tool) => tool.annotations?.destructiveHint === true).length,
      nonFiniteLiterals: (list.match(/"NaN"/g) ?? []).length,
    }
  } finally {
    await dispose()
  }
}

const results = []

for (const profile of profiles) results.push(await measure(profile))

console.log(JSON.stringify(results, null, 2))
