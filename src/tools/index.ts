import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"

import type { Config } from "../config.ts"
import { contextTools } from "./context.ts"
import { generatedSurface } from "./generated.ts"
import { annotate } from "./policy.ts"
import { restTools } from "./rest.ts"
import { Info, infoHandler } from "./server.ts"
import type { Advertised } from "./server.ts"
import { sessionAdminTools } from "./session-admin.ts"
import { sessionDiscoverTools } from "./session-discover.ts"
import { sessionHistoryTools } from "./session-history.ts"
import { sessionMcpTools } from "./session-mcp.ts"
import { sessionPromptTools } from "./session-prompts.ts"
import { sessionTools } from "./session.ts"

/**
 * One toolkit holding every operation: the hand-written tools first, then one
 * generated tool per SDK wire method, each annotated with its MCP hints. The
 * full profile advertises it as is; the compact profile dispatches into it.
 * `advertised` is what `server_info` reports, the full list by default.
 */
export const toolsFor = (config: Config, advertised?: Omit<Advertised, "operationCount">) => {
  const generated = generatedSurface(config)
  const session = sessionTools(config)
  const prompts = sessionPromptTools(config)
  const admin = sessionAdminTools(config)
  const mcp = sessionMcpTools()
  const history = sessionHistoryTools()
  const discover = sessionDiscoverTools(config)
  const rest = restTools()
  const context = contextTools()

  const tools: Array<Tool.Any> = [
    Info,
    ...session.tools,
    ...prompts.tools,
    ...admin.tools,
    ...mcp.tools,
    ...history.tools,
    ...discover.tools,
    ...rest.tools,
    ...context.tools,
    ...generated.tools,
  ].map(annotate)

  const count = tools.length
  // SAFETY: `Toolkit.make` keys its record by the tool names it is given; the
  // annotation widens that key type so one layer can serve a runtime list.
  const toolkit = Toolkit.make(...tools) as Toolkit.Toolkit<Record<string, Tool.Any>>

  const handlers = {
    server_info: infoHandler(config, {
      profile: advertised?.profile ?? "full",
      toolCount: advertised?.toolCount ?? count,
      operationCount: count,
    }),
    ...session.handlers,
    ...prompts.handlers,
    ...admin.handlers,
    ...mcp.handlers,
    ...history.handlers,
    ...discover.handlers,
    ...rest.handlers,
    ...context.handlers,
    ...generated.handlers,
  }

  // SAFETY: the record is keyed by every tool name above; the widened toolkit
  // key type cannot express each tool's parameter schema.
  const handlersLayer = toolkit.toLayer(handlers as Parameters<typeof toolkit.toLayer>[0])

  return { toolkit, handlers: handlersLayer, handlerRecord: handlers, tools, count }
}
