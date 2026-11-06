import * as Schema from "effect/Schema"

import type { Config } from "../../src/config.ts"
import { initialize, readBody, startServer } from "./mcp-http.ts"
import type { Json } from "./mcp-http.ts"

export const MCP_KEY = "mcp-test-key"

const PROTOCOL = "2025-11-25"

const CallEnvelope = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.optional(Schema.Json),
      content: Schema.optional(
        Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})

const ListedTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Json,
})

export type ListedTool = typeof ListedTool.Type

const ListEnvelope = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(ListedTool),
    nextCursor: Schema.optional(Schema.String),
  }),
})

const Failure = Schema.Struct({ code: Schema.String, message: Schema.String })

export type ToolFailure = typeof Failure.Type

export interface RpcError {
  readonly code: number
  readonly message: string
}

/** One `tools/call` outcome: a result envelope, or a JSON-RPC error such as invalid params. */
export interface ToolCall {
  readonly isError: boolean
  readonly structured: Json | undefined
  readonly text: string
  readonly rpcError: RpcError | undefined
}

export interface ToolClient {
  readonly call: (name: string, args?: Json) => Promise<ToolCall>
  /** The structured result of a successful call; throws on any failure. */
  readonly ok: (name: string, args?: Json) => Promise<Json | undefined>
  /** The `{ code, message }` of a declared tool failure; throws otherwise. */
  readonly fail: (name: string, args?: Json) => Promise<ToolFailure>
  readonly list: () => Promise<ReadonlyArray<ListedTool>>
  readonly dispose: () => Promise<void>
}

export interface ConnectOptions {
  readonly config: Config
  readonly keys?: ReadonlyArray<string>
}

/** An authenticated MCP client over the real `/mcp` layer, in process. */
export const connect = async (options: ConnectOptions): Promise<ToolClient> => {
  const keys = options.keys ?? [MCP_KEY]
  const server = await startServer({ config: options.config, keys })
  const authorization = "Bearer " + (keys[0] ?? "")
  const { sessionId } = await initialize(server, PROTOCOL, { authorization })
  let id = 1

  const headers = {
    authorization,
    "mcp-session-id": sessionId ?? "",
    "mcp-protocol-version": PROTOCOL,
  }

  const rpc = async (method: string, params: Json): Promise<Json | undefined> => {
    id += 1

    const response = await server.post({ jsonrpc: "2.0", id, method, params }, headers)

    return readBody(response)
  }

  const call = async (name: string, args: Json = {}): Promise<ToolCall> => {
    const envelope = Schema.decodeUnknownSync(CallEnvelope)(
      await rpc("tools/call", { name, arguments: args }),
    )

    return {
      isError: envelope.result?.isError === true,
      structured: envelope.result?.structuredContent,
      text: envelope.result?.content?.[0]?.text ?? "",
      rpcError: envelope.error,
    }
  }

  return {
    call,
    ok: async (name, args) => {
      const outcome = await call(name, args)

      if (outcome.isError || outcome.rpcError !== undefined) {
        throw new Error(name + " failed: " + (outcome.rpcError?.message ?? outcome.text))
      }

      return outcome.structured
    },
    fail: async (name, args) => {
      const outcome = await call(name, args)

      if (!outcome.isError) {
        throw new Error(name + " did not fail with a tool failure: " + JSON.stringify(outcome))
      }

      return Schema.decodeUnknownSync(Failure)(JSON.parse(outcome.text))
    },
    list: async () => {
      const tools: Array<ListedTool> = []
      let cursor: string | undefined

      do {
        const envelope = Schema.decodeUnknownSync(ListEnvelope)(
          await rpc("tools/list", cursor === undefined ? {} : { cursor }),
        )

        tools.push(...envelope.result.tools)
        cursor = envelope.result.nextCursor
      } while (cursor !== undefined)

      return tools
    },
    dispose: () => server.dispose(),
  }
}
