import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { presentFields, toJsonValue } from "../droid/protocol.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { SessionHubService } from "../droid/turns.ts"
import { ToolFailure } from "./failure.ts"
import { toolFailure } from "./guards.ts"

/**
 * The daemon's add-MCP oauth field: `false`, or a client config. `true` is
 * not a wire value (`AddMcpServerRequestParamsSchema`).
 */
const McpOAuthConfig = Schema.Struct({
  scopes: Schema.optional(Schema.Array(Schema.String)),
  resource: Schema.optional(Schema.Union([Schema.String, Schema.Literal(false)])),
  authorizationServerIssuer: Schema.optional(Schema.String),
  clientMetadataUrl: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  callbackPort: Schema.optional(Schema.Number),
  tokenEndpointAuthMethod: Schema.optional(
    Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
  ),
})

const McpOAuth = Schema.Union([Schema.Literal(false), McpOAuthConfig])

/** Remove and toggle accept only the user settings level (`ZodLiteral<SettingsLevel.User>`). */
const UserSettingsLevel = Schema.Literal("user")

/**
 * The wire requires `type`. Callers may omit it when `command` means stdio or
 * `url` means http. `sse` has no separate signal, and both signals at once do
 * not pick a transport.
 */
const mcpTransport = (input: {
  readonly type: "stdio" | "http" | "sse" | undefined
  readonly command: string | undefined
  readonly url: string | undefined
}): Effect.Effect<"stdio" | "http" | "sse", ToolFailure> => {
  if (input.type !== undefined) return Effect.succeed(input.type)

  if (input.command !== undefined && input.url === undefined) return Effect.succeed("stdio")

  if (input.url !== undefined && input.command === undefined) return Effect.succeed("http")

  return Effect.fail({
    code: "invalid_params",
    message:
      "MCP server type is missing or ambiguous; pass type, or only command for stdio, or only url for http",
  })
}

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
    "Add an MCP server to a live session. Pass type, or omit it to infer stdio from command " +
    "or http from url. sse must be explicit. oauth is false or an OAuth client config.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    name: Schema.String,
    type: Schema.optional(Schema.Literals(["stdio", "http", "sse"])),
    url: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    command: Schema.optional(Schema.String),
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    oauth: Schema.optional(McpOAuth),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const RemoveMcpServer = Tool.make("session_remove_mcp_server", {
  description:
    "Remove an MCP server from a live session. settingsLevel defaults to user; that is the " +
    "only level the daemon accepts.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    serverName: Schema.String,
    settingsLevel: Schema.optional(UserSettingsLevel),
  }),
  success: Schema.optional(Schema.Json),
  failure: ToolFailure,
  dependencies: [SessionHubService],
})

const ToggleMcpServer = Tool.make("session_toggle_mcp_server", {
  description:
    "Enable or disable an MCP server without removing it. settingsLevel defaults to user; " +
    "that is the only level the daemon accepts.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    serverName: Schema.String,
    enabled: Schema.Boolean,
    settingsLevel: Schema.optional(UserSettingsLevel),
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
  description: "Finish an MCP OAuth flow with the code and state the browser returned.",
  parameters: Schema.Struct({
    sessionId: Schema.String,
    serverName: Schema.String,
    code: Schema.String,
    state: Schema.String,
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
      Effect.gen(function* () {
        const type = yield* mcpTransport({
          type: params.type,
          command: params.command,
          url: params.url,
        })

        return yield* send(params.sessionId, "droid.add_mcp_server", {
          name: params.name,
          type,
          url: params.url,
          headers: params.headers,
          command: params.command,
          args: params.args,
          env: params.env,
          oauth: params.oauth === undefined ? undefined : toJsonValue(params.oauth),
        })
      }),
    session_remove_mcp_server: (params) =>
      send(params.sessionId, "droid.remove_mcp_server", {
        serverName: params.serverName,
        settingsLevel: params.settingsLevel ?? "user",
      }),
    session_toggle_mcp_server: (params) =>
      send(params.sessionId, "droid.toggle_mcp_server", {
        serverName: params.serverName,
        enabled: params.enabled,
        settingsLevel: params.settingsLevel ?? "user",
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
