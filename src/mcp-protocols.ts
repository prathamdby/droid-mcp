import * as McpProtocol from "effect/ai/McpProtocol"

/**
 * The protocol revisions this server speaks, in the order the design chose:
 * `2025-11-25` first because it binds `initialize`, and `2026-07-28` last
 * because it is sessionless. `server_info` reports the same list, so the two
 * cannot drift.
 */
export const MCP_PROTOCOLS = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2026_07_28,
] as const

export const MCP_PROTOCOL_VERSIONS: ReadonlyArray<string> = MCP_PROTOCOLS.map(
  (protocol) => protocol.protocolVersion,
)
