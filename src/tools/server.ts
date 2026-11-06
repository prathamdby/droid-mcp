import * as Tool from "effect/ai/Tool"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import type { DaemonStatus } from "../droid/daemon-service.ts"
import { DaemonService } from "../droid/daemon-service.ts"
import { MCP_PROTOCOL_VERSIONS } from "../mcp-protocols.ts"
import { VERSION } from "../version.ts"

/** The tool that proves the server is reachable and correctly wired. */
export const Info = Tool.make("server_info", {
  description:
    "Report the server version, protocol revisions, tool count, autonomy cap, and daemon " +
    "connection. Call this first when a client needs to discover the server.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    version: Schema.String,
    protocols: Schema.Array(Schema.String),
    toolCount: Schema.Number,
    droidPath: Schema.String,
    maxAutonomy: Schema.String,
    daemon: Schema.Struct({
      socket: Schema.String,
      supervised: Schema.Boolean,
      endpoint: Schema.String,
      connected: Schema.Boolean,
      pid: Schema.optional(Schema.Number),
      protocol: Schema.optional(Schema.String),
    }),
  }),
  failure: Schema.Struct({ code: Schema.String, message: Schema.String }),
  dependencies: [DaemonService],
})

export const serverInfo = (config: Config, toolCount: number, status: DaemonStatus) => ({
  version: VERSION,
  protocols: [...MCP_PROTOCOL_VERSIONS],
  toolCount,
  droidPath: config.droidPath,
  maxAutonomy: config.maxAutonomy,
  daemon: {
    socket: config.socketPath,
    supervised: status.supervised,
    endpoint: status.endpoint,
    connected: status.connected,
    pid: status.pid,
    protocol: status.protocol,
  },
})

export const infoHandler = (config: Config, toolCount: number) => () =>
  DaemonService.use((daemon) =>
    Effect.map(daemon.status, (status) => serverInfo(config, toolCount, status)),
  )
