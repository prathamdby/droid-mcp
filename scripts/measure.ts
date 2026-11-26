/**
 * Measures what an MCP client pays to connect: the `initialize` and
 * `tools/list` replies of the real `/mcp` layer, per tool profile. Prints a
 * JSON array with one entry per profile. Approximate tokens are UTF-8 bytes / 4.
 *
 *   node --experimental-strip-types scripts/measure.ts [compact|full ...]
 */
import type * as Schema from "effect/Schema"

import { httpServer } from "../src/products/index.ts"

const KEY = "measure-key"
const PROTOCOL = "2025-11-25"

const isProfile = (value: string): value is "compact" | "full" =>
  value === "compact" || value === "full"

const requested = process.argv.slice(2).filter(isProfile)

const profiles: ReadonlyArray<"compact" | "full"> =
  requested.length > 0 ? requested : ["compact", "full"]

interface AdvertisedTool {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema: Schema.Json
  readonly annotations?:
    | {
        readonly readOnlyHint?: boolean | undefined
        readonly destructiveHint?: boolean | undefined
      }
    | undefined
}

const measure = async (profile: "compact" | "full") => {
  const server = await httpServer({
    authTokens: [KEY],
    includeDaemon: true,
    factoryBaseUrl: "https://api.factory.ai",
    contextBaseUrl: "https://context.factory.ai",
    profile,
  })

  const endpoint = server.url + server.path

  const post = async (body: Schema.Json): Promise<string> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: "Bearer " + KEY,
      },
      body: JSON.stringify(body),
    })

    return response.text()
  }

  try {
    const initBody = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "measure", version: "1" },
      },
    })

    await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })

    const tools: Array<AdvertisedTool> = JSON.parse(list).result.tools

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
      profile,
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
    await server.close()
  }
}

const results = []

for (const profile of profiles) {
  results.push(await measure(profile))
}

console.log(JSON.stringify(results, null, 2))
