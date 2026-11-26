import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { Guidance } from "../../guidance/index.ts"
import { Mcp, mcpLayer } from "../../mcp/index.ts"
import type { McpEndpoint, McpFrame, McpReply } from "../../mcp/index.ts"
import { Presentation } from "../../presentation/index.ts"
import { Sessions } from "../../sessions/index.ts"
import type { Assembly } from "./assembly.ts"
import type { AssemblyOptions } from "./types.ts"

export const buildMcp = async (
  assembly: Assembly,
  options: AssemblyOptions,
): Promise<Mcp["Service"]> => {
  const live = Layer.provide(
    mcpLayer({
      serverName: options.serverName ?? "droid-mcp",
      serverVersion: options.serverVersion ?? "0.1.0",
    }),
    Layer.mergeAll(
      Layer.succeed(Presentation, assembly.presentation),
      Layer.succeed(Sessions, assembly.sessions),
      Layer.succeed(Guidance, assembly.guidance),
    ),
  )

  const context = await Effect.runPromise(Layer.buildWithScope(live, assembly.scope))

  return Context.get(context, Mcp)
}

export const rpcError = (
  id: string | number | null,
  code: number,
  message: string,
): Schema.Json => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
})

const encodeReply = (reply: McpReply): Schema.Json | undefined => {
  if (reply.kind === "ack") return undefined

  if (reply.kind === "error") {
    const fields = { code: reply.code, message: reply.message }
    const error = reply.data === undefined ? fields : { ...fields, data: reply.data }

    return { jsonrpc: "2.0", id: reply.id, error }
  }

  return { jsonrpc: "2.0", id: reply.id, result: reply.result }
}

type FrameCheck =
  | { readonly ok: true; readonly frame: McpFrame }
  | { readonly ok: false; readonly message: string }

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))

const checkWireFrame = (raw: Schema.Json): FrameCheck => {
  if (!isRecord(raw) || raw.jsonrpc !== "2.0") {
    return { ok: false, message: "frame must be a JSON-RPC 2.0 object" }
  }

  const method = raw.method

  if (!Schema.is(Schema.String)(method) || method.length === 0) {
    return { ok: false, message: "frame method must be a non-empty string" }
  }

  const params = raw.params

  if (params !== undefined && !isRecord(params)) {
    return { ok: false, message: "frame params must be an object when present" }
  }

  const normalizedParams: Schema.Json = params === undefined ? {} : params
  const id = raw.id

  if (id === undefined) {
    return { ok: true, frame: { kind: "notification", method, params: normalizedParams } }
  }

  if (!Schema.is(Schema.String)(id) && !(Schema.is(Schema.Number)(id) && Number.isFinite(id))) {
    return { ok: false, message: "frame id must be a string or finite number" }
  }

  return { ok: true, frame: { kind: "request", id, method, params: normalizedParams } }
}

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

export const receiveRpc = async (
  endpoint: McpEndpoint,
  text: string,
): Promise<Schema.Json | undefined> => {
  const parsed = decodeJson(text)

  if (Result.isFailure(parsed)) return rpcError(null, -32_700, "parse error")

  const check = checkWireFrame(parsed.success)

  if (!check.ok) return rpcError(null, -32_600, check.message)

  const reply = await Effect.runPromise(Effect.result(endpoint.receive(check.frame)))

  return Result.isFailure(reply)
    ? rpcError(null, -32_600, reply.failure.message)
    : encodeReply(reply.success)
}
