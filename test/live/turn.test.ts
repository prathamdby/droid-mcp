import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { sessionHub } from "../../src/droid/turns.ts"

/**
 * One real turn against the installed CLI. It needs a model, so it only runs
 * when `DROID_MCP_LIVE=1` and `FACTORY_API_KEY` are both present:
 *
 *   DROID_MCP_LIVE=1 pnpm vitest run --project live test/live/turn.test.ts
 */

const live = process.env["DROID_MCP_LIVE"] === "1"
const apiKey = process.env["FACTORY_API_KEY"]
const droidPath = process.env["DROID_MCP_DROID_PATH"] ?? "droid"

const textOf = (events: ReadonlyArray<{ readonly kind: string; readonly text?: string }>): string =>
  events.flatMap((event) => (event.kind === "assistant_text" ? [event.text ?? ""] : [])).join("")

describe.skipIf(!live || apiKey === undefined)("live turn", () => {
  it("runs one prompt to completion and reads the reply", async () => {
    const hub = await Effect.runPromise(
      sessionHub({
        droidPath,
        version: "0.1.0",
        waitMs: 90_000,
        promptTimeoutMs: 30_000,
        env: apiKey === undefined ? process.env : { ...process.env, FACTORY_API_KEY: apiKey },
      }),
    )

    try {
      const created = await Effect.runPromise(
        hub.api.create({ cwd: process.cwd(), autonomyLevel: "low" }),
      )

      expect(created.sessionId.length).toBeGreaterThan(0)

      const first = await Effect.runPromise(
        hub.api.stream({
          sessionId: created.sessionId,
          prompt: "Reply with exactly the word: pong. Do not use any tools.",
          waitMs: 90_000,
        }),
      )

      let cursor = first.cursor
      let status = first.status
      const events = [...first.events]

      for (let poll = 0; poll < 20 && status === "running"; poll++) {
        const next = await Effect.runPromise(
          hub.api.events({ sessionId: created.sessionId, cursor, waitMs: 30_000 }),
        )

        cursor = next.cursor
        status = next.status
        events.push(...next.events)
      }

      expect(status).toBe("completed")
      expect(textOf(events).toLowerCase()).toContain("pong")

      const closed = await Effect.runPromise(
        hub.api.close(created.sessionId).pipe(Effect.map((value) => value.closed)),
      )

      expect(Schema.is(Schema.Boolean)(closed)).toBe(true)
    } finally {
      await Effect.runPromise(hub.closeAll)
    }
  }, 180_000)
})
