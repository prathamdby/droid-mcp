import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../../authority/index.ts"
import { InvalidInput } from "../../capabilities/index.ts"
import type { BoundOperation, Capabilities } from "../../capabilities/index.ts"
import { ReleasePayload } from "../../disclosure/index.ts"
import type { View } from "../../presentation/index.ts"

const emptyArgs = Schema.decodeUnknownEffect(Schema.Struct({}), { onExcessProperty: "error" })

export const decodeEmptyArgs = (input: Schema.Json): Effect.Effect<void, InvalidInput> =>
  emptyArgs(input).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InvalidInput({ message: "expected empty arguments" })),
  )

export const bindServerInfo = (
  capabilities: Capabilities["Service"],
  maxAutonomy: AutonomyLevel,
  readView: () => View,
): BoundOperation =>
  capabilities.bind({
    facts: {
      id: "server_info",
      family: "server",
      description: "Report the active profile, installed operations and autonomy ceiling.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      replay: "safe_read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    decode: decodeEmptyArgs,
    target: () => ({ kind: "system", id: "server" }),
    demand: () => ({ effect: "read", operation: "server_info" }),
    perform: () =>
      Effect.sync(() => {
        const { serverName, profile, toolCount, operationCount, familyCounts, providerKinds } =
          readView()

        return {
          serverName,
          profile,
          toolCount,
          operationCount,
          familyCounts,
          providerKinds,
          maxAutonomy,
        }
      }),
    classify: (_input, value) => ({ payload: ReleasePayload.JsonValue({ value }) }),
  })
