import * as Effect from "effect/Effect"

import { TargetUnavailable } from "../../capabilities/index.ts"
import type { BoundOperation, Capabilities } from "../../capabilities/index.ts"
import { ReleasePayload } from "../../disclosure/index.ts"
import { CURRENT_GUIDE_EDITION } from "../../guidance/index.ts"
import type { Guidance } from "../../guidance/index.ts"
import { decodeEmptyArgs } from "./server-info.ts"

export const bindSkillRead = (
  capabilities: Capabilities["Service"],
  guidance: Guidance["Service"],
): BoundOperation =>
  capabilities.bind({
    facts: {
      id: "skill_read",
      family: "skill",
      description: "Read the root guide for using the installed operations.",
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
    target: () => ({ kind: "system", id: "guidance" }),
    demand: () => ({ effect: "read", operation: "skill_read" }),
    // Only a direct carrier delivery records a receipt: dispatch callers can
    // select a subtree or get a continuation instead of the full root text.
    perform: () =>
      guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md").pipe(
        Effect.map(({ content }) => ({ uri: "skill://droid/SKILL.md", markdown: content })),
        Effect.mapError(
          () => new TargetUnavailable({ message: "the guide document is unavailable" }),
        ),
      ),
    classify: (_input, value) => ({ payload: ReleasePayload.JsonValue({ value }) }),
  })
