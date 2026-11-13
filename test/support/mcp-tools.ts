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
  readonly readSkill?: boolean
}

const Bounded = Schema.Struct({
  result: Schema.optional(Schema.Json),
  truncated: Schema.optional(Schema.Boolean),
  ref: Schema.optional(Schema.String),
})

const Chunk = Schema.Struct({ chunk: Schema.String, nextOffset: Schema.optional(Schema.Number) })

const SearchPage = Schema.Struct({
  nextOffset: Schema.optional(Schema.Number),
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
})

const Described = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, inputSchema: Schema.Json }),
  ),
})

const RESULT_BYTES_MAX = 262_144

/**
 * An authenticated MCP client over the real `/mcp` layer, in process.
 *
 * Under the compact profile, a call to an operation the server does not list
 * goes through `tool_call`, and `list` walks `tools_search` and
 * `tools_describe`. The returned outcome has the shape a direct call would
 * have, so every test written against the full profile also exercises the
 * compact dispatch path when `DROID_MCP_TEST_PROFILE=compact`.
 */
export const connect = async (options: ConnectOptions): Promise<ToolClient> => {
  const server = await startServer({ config: options.config, keys: [MCP_KEY] })
  const authorization = "Bearer " + MCP_KEY
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

  const direct = async (name: string, args: Json = {}): Promise<ToolCall> => {
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

  const listed = async (): Promise<ReadonlyArray<ListedTool>> => {
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
  }

  const compact = options.config.toolProfile === "compact"
  let advertised: ReadonlySet<string> | undefined

  const isAdvertised = async (name: string): Promise<boolean> => {
    advertised ??= new Set((await listed()).map((tool) => tool.name))

    return advertised.has(name)
  }

  const okOf = async (name: string, args: Json): Promise<Json | undefined> => {
    const outcome = await direct(name, args)

    if (outcome.isError || outcome.rpcError !== undefined) {
      throw new Error(name + " failed: " + (outcome.rpcError?.message ?? outcome.text))
    }

    return outcome.structured
  }

  if (options.readSkill !== false) await okOf("skill_read", {})

  /** Reassembles a stored result by following `nextOffset` to the end. */
  const readAll = async (ref: string): Promise<Json> => {
    let text = ""
    let offset: number | undefined = 0

    while (offset !== undefined) {
      const page = Schema.decodeUnknownSync(Chunk)(
        await okOf("result_read", { ref, offset, length: RESULT_BYTES_MAX }),
      )

      text += page.chunk
      offset = page.nextOffset
    }

    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text))
  }

  const dispatched = async (name: string, args: Json): Promise<ToolCall> => {
    const outcome = await direct("tool_call", { name, arguments: args, maxBytes: RESULT_BYTES_MAX })

    if (outcome.rpcError !== undefined) return outcome

    if (outcome.isError) {
      const failure = Schema.decodeUnknownSync(Failure)(JSON.parse(outcome.text))

      // A direct call reports arguments that fail the schema as plain text, not { code, message }.
      if (failure.code === "invalid_arguments") return { ...outcome, text: failure.message }

      return outcome
    }

    const bounded = Schema.decodeUnknownSync(Bounded)(outcome.structured)

    const structured =
      bounded.truncated === true && bounded.ref !== undefined
        ? await readAll(bounded.ref)
        : bounded.result

    return {
      isError: false,
      structured,
      text: structured === undefined ? "" : JSON.stringify(structured),
      rpcError: undefined,
    }
  }

  const call = async (name: string, args: Json = {}): Promise<ToolCall> =>
    compact && !(await isAdvertised(name)) ? dispatched(name, args) : direct(name, args)

  /** Every operation, through search and describe, in catalog order. */
  const catalog = async (): Promise<ReadonlyArray<ListedTool>> => {
    const names: Array<string> = []
    let offset: number | undefined = 0

    while (offset !== undefined) {
      const page = Schema.decodeUnknownSync(SearchPage)(
        await okOf("tools_search", { limit: 50, offset }),
      )

      names.push(...page.tools.map((tool) => tool.name))
      offset = page.nextOffset
    }

    const tools: Array<ListedTool> = []

    for (let start = 0; start < names.length; start += 20) {
      const described = Schema.decodeUnknownSync(Described)(
        await okOf("tools_describe", { names: names.slice(start, start + 20) }),
      )

      tools.push(...described.tools)
    }

    return tools
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
    list: () => (compact ? catalog() : listed()),
    dispose: () => server.dispose(),
  }
}
