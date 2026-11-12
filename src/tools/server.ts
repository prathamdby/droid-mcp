import * as Tool from "effect/ai/Tool"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { Config, ToolProfile } from "../config.ts"
import type { DaemonStatus } from "../droid/daemon-service.ts"
import { DaemonService } from "../droid/daemon-service.ts"
import { MCP_PROTOCOL_VERSIONS } from "../mcp-protocols.ts"
import { VERSION } from "../version.ts"

/** The tool that proves the server is reachable and correctly wired. */
export const Info = Tool.make("server_info", {
  description:
    "Report the server version, protocol revisions, tool profile and counts, autonomy cap, " +
    "and daemon connection. Call this first when a client needs to discover the server.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    version: Schema.String,
    protocols: Schema.Array(Schema.String),
    profile: Schema.Literals(["compact", "full"]),
    toolCount: Schema.Int,
    operationCount: Schema.Int,
    droidPath: Schema.String,
    maxAutonomy: Schema.String,
    daemon: Schema.Struct({
      socket: Schema.String,
      supervised: Schema.Boolean,
      endpoint: Schema.String,
      connected: Schema.Boolean,
      pid: Schema.optional(Schema.Int),
      protocol: Schema.optional(Schema.String),
    }),
  }),
  failure: Schema.Struct({ code: Schema.String, message: Schema.String }),
  dependencies: [DaemonService],
})

/** What `tools/list` advertises, and how many operations stay reachable. */
export interface Advertised {
  readonly profile: ToolProfile
  readonly toolCount: number
  readonly operationCount: number
}

export const serverInfo = (config: Config, advertised: Advertised, status: DaemonStatus) => ({
  version: VERSION,
  protocols: [...MCP_PROTOCOL_VERSIONS],
  profile: advertised.profile,
  toolCount: advertised.toolCount,
  operationCount: advertised.operationCount,
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

export const infoHandler = (config: Config, advertised: Advertised) => () =>
  DaemonService.use((daemon) =>
    Effect.map(daemon.status, (status) => serverInfo(config, advertised, status)),
  )
