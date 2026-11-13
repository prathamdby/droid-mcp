import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"

import type { Config } from "../config.ts"
import type { SessionHubService } from "../droid/turns.ts"
import { contextTools } from "./context.ts"
import type { ToolFailure } from "./failure.ts"
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
import { SkillGate, SkillRead, skillReadHandler } from "./skill.ts"

const gateSessionHandlers = (
  // SAFETY: each handler object is keyed by tool name with its own parameter
  // schema; erasing to `never` here lets one wrapper gate every session tool.
  handlers: Readonly<
    Record<string, (params: never) => Effect.Effect<unknown, ToolFailure, SessionHubService>>
  >,
) => {
  const gated: Record<
    string,
    (params: never) => Effect.Effect<unknown, ToolFailure, SkillGate | SessionHubService>
  > = {}

  for (const [name, handler] of Object.entries(handlers)) {
    gated[name] = (params: never) =>
      Effect.flatMap(
        SkillGate.use((gate) => gate.requireRead),
        () => handler(params),
      )
  }

  return gated
}

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
    SkillRead,
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
    skill_read: skillReadHandler,
    ...gateSessionHandlers(session.handlers),
    ...gateSessionHandlers(prompts.handlers),
    ...gateSessionHandlers(admin.handlers),
    ...gateSessionHandlers(mcp.handlers),
    ...gateSessionHandlers(history.handlers),
    ...gateSessionHandlers(discover.handlers),
    ...rest.handlers,
    ...context.handlers,
    ...generated.handlers,
  }

  // SAFETY: the record is keyed by every tool name above; the widened toolkit
  // key type cannot express each tool's parameter schema.
  const handlersLayer = toolkit.toLayer(handlers as Parameters<typeof toolkit.toLayer>[0])

  return { toolkit, handlers: handlersLayer, handlerRecord: handlers, tools, count }
}
