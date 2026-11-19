import type { TurnEvent, TurnResult } from "../droid/turns.ts"
import { sessionUri } from "./session-ref.ts"

export const DELIVERIES = ["detach", "block"] as const

const pending = (event: TurnEvent): boolean => event.kind.startsWith("pending_")

/**
 * `detach` and `block` keep prompts, status, and the last assistant text.
 * The event dump stays on the default poll path, where the caller asked for it.
 */
export const presentTurn = (result: TurnResult): TurnResult => {
  let summary: string | undefined

  for (let index = result.events.length - 1; index >= 0; index -= 1) {
    const event = result.events[index]

    if (event?.kind === "assistant_text" && event.text !== undefined) {
      summary = event.text
      break
    }
  }

  const prompts = result.events.filter(pending)
  const omitted = prompts.length !== result.events.length

  return {
    sessionId: result.sessionId,
    status: result.status,
    cursor: result.cursor,
    events: prompts,
    truncated: result.truncated,
    result: result.result,
    uri: sessionUri(result.sessionId),
    summary,
    eventsOmitted: omitted ? true : undefined,
  }
}
