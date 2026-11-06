import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { presentFields, toJsonValue } from "../droid/protocol.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { SessionHubService } from "../droid/turns.ts"
import { ToolFailure } from "./failure.ts"
import { toolFailure } from "./guards.ts"

const SettingsLevelSchema = Schema.Literals(["user", "project", "local"])

const send = (
  sessionId: string,
  method: string,
  payload: Record<string, JsonValue | undefined>,
): Effect.Effect<JsonValue | undefined, ToolFailure, SessionHubService> =>
  SessionHubService.use((hub) =>
    hub
      .command({ sessionId, method, params: toJsonValue({ sessionId, ...presentFields(payload) }) })
      .pipe(Effect.mapError(toolFailure)),
  )

const AddMcpServer = Tool.make("session_add_mcp_server", {
  description:
    "Add an MCP server to a live session. stdio servers need command and args; http servers " +
    "need url and optional headers.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    name: Schema.String,
    type: Schema.optional(Schema.Literals(["stdio", "http", "sse"])),
    url: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    command: Schema.optional(Schema.String),
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    oauth: Schema.optional(Schema.Boolean),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const RemoveMcpServer = Tool.make("session_remove_mcp_server", {
  description: "Remove an MCP server from a live session.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    serverName: Schema.String,
    settingsLevel: Schema.optional(SettingsLevelSchema),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ToggleMcpServer = Tool.make("session_toggle_mcp_server", {
  description: "Enable or disable an MCP server without removing it.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    serverName: Schema.String,
    enabled: Schema.Boolean,
    settingsLevel: Schema.optional(SettingsLevelSchema),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ListMcpServers = Tool.make("session_list_mcp_servers", {
  description: "List the MCP servers a live session knows about, with their status.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ListMcpTools = Tool.make("session_list_mcp_tools", {
  description: "List the tools the session's MCP servers expose.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const RefreshConnectorCatalog = Tool.make("session_refresh_connector_tool_catalog", {
  description: "Ask the session to refresh its connector tool catalog.",
  parameters: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const AuthenticateMcpServer = Tool.make("session_authenticate_mcp_server", {
  description:
    "Start the OAuth flow for an MCP server. The session reports the URL to open; finish it " +
    "with session_submit_mcp_auth_code.",
  parameters: Schema.Struct({ sessionId: Schema.String, serverName: Schema.String }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const SubmitMcpAuthCode = Tool.make("session_submit_mcp_auth_code", {
  description: "Finish an MCP OAuth flow with the code the browser returned.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    serverName: Schema.String,
    code: Schema.String,
    state: Schema.optional(Schema.String),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

export const sessionMcpTools = () => {
  const list: Array<Tool.Any> = [
    AddMcpServer,
    RemoveMcpServer,
    ToggleMcpServer,
    ListMcpServers,
    ListMcpTools,
    RefreshConnectorCatalog,
    AuthenticateMcpServer,
    SubmitMcpAuthCode,
  ]

  const McpTools = Toolkit.make(
    AddMcpServer,
    RemoveMcpServer,
    ToggleMcpServer,
    ListMcpServers,
    ListMcpTools,
    RefreshConnectorCatalog,
    AuthenticateMcpServer,
    SubmitMcpAuthCode,
  )

  const handlers = McpTools.of({
    session_add_mcp_server: (params) =>
      send(params.sessionId, "droid.add_mcp_server", {
        name: params.name,
        type: params.type,
        url: params.url,
        headers: params.headers,
        command: params.command,
        args: params.args,
        env: params.env,
        oauth: params.oauth,
      }),
    session_remove_mcp_server: (params) =>
      send(params.sessionId, "droid.remove_mcp_server", {
        serverName: params.serverName,
        settingsLevel: params.settingsLevel,
      }),
    session_toggle_mcp_server: (params) =>
      send(params.sessionId, "droid.toggle_mcp_server", {
        serverName: params.serverName,
        enabled: params.enabled,
        settingsLevel: params.settingsLevel,
      }),
    session_list_mcp_servers: (params) => send(params.sessionId, "droid.list_mcp_servers", {}),
    session_list_mcp_tools: (params) => send(params.sessionId, "droid.list_mcp_tools", {}),
    session_refresh_connector_tool_catalog: (params) =>
      send(params.sessionId, "droid.refresh_connector_tool_catalog", {}),
    session_authenticate_mcp_server: (params) =>
      send(params.sessionId, "droid.authenticate_mcp_server", {
        serverName: params.serverName,
      }),
    session_submit_mcp_auth_code: (params) =>
      send(params.sessionId, "droid.submit_mcp_auth_code", {
        serverName: params.serverName,
        code: params.code,
        state: params.state,
      }),
  })

  return { tools: list, handlers }
}
