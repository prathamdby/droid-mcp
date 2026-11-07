import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { SessionHub, TurnEvent, TurnResult } from "../../src/droid/turns.ts"
import { CORRELATION_LIMIT, SEEN_KEY_LIMIT } from "../../src/droid/turns.ts"
import { createSession, fakeHub } from "../support/hub.ts"

const scoped = <A, E>(run: (hub: SessionHub) => Effect.Effect<A, E>, promptTimeoutMs?: number) =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub({ promptTimeoutMs }), (hub) => hub.closeAll).pipe(
      Effect.flatMap((hub) => run(hub)),
    ),
  )

const permissionEvent = (turn: TurnResult) => {
  const event = turn.events.find((candidate) => candidate.kind === "pending_permission")

  if (event?.requestId === undefined) throw new Error("missing pending permission")

  return event
}

const untilSettled = (hub: SessionHub, sessionId: string, cursor: number) =>
  Effect.gen(function* () {
    let current = yield* hub.api.events({ sessionId, cursor, waitMs: 1_000 })
    let waits = 0
    let steps = 0

    while (current.status === "running" && waits < 5 && steps < 200) {
      steps += 1
      const next = yield* hub.api.events({ sessionId, cursor: current.cursor, waitMs: 1_000 })

      if (next.events.length === 0 && next.cursor === current.cursor) waits += 1

      current = next
    }

    return current
  })

describe("prompt lifetime", () => {
  it("drops a permission prompt when the turn is interrupted", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission",
            waitMs: 200,
          })

          const event = permissionEvent(running)

          yield* hub.api.interrupt(sessionId)
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const pending = yield* hub.api.pendingPrompt(sessionId, event.requestId ?? "")

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId: event.requestId ?? "",
              result: { selectedOption: "proceed_once" },
            })
            .pipe(Effect.flip)

          return { settled, pending, stale }
        }),
      ),
    )

    expect(outcome.settled.status).toBe("interrupted")
    expect(outcome.settled.result?.reason).toBe("cancelled")
    expect(outcome.pending).toBeUndefined()
    expect(outcome.stale.code).toBe("prompt_not_found")
  })

  it("rejects a stale public id when the CLI reuses a request id", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const first = yield* hub.api.stream({
            sessionId,
            prompt: "permission:reuse",
            waitMs: 200,
          })

          const firstId = permissionEvent(first).requestId ?? ""

          yield* hub.api.interrupt(sessionId)
          yield* untilSettled(hub, sessionId, first.cursor)

          const second = yield* hub.api.stream({
            sessionId,
            prompt: "permission:reuse",
            waitMs: 200,
          })

          const secondEvent = permissionEvent(second)
          const secondId = secondEvent.requestId ?? ""

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId: firstId,
              result: { selectedOption: "cancel" },
            })
            .pipe(Effect.flip)

          yield* hub.api.answer({
            sessionId,
            requestId: secondId,
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, second.cursor)

          const replay = yield* hub.api.events({
            sessionId,
            cursor: secondEvent.seq,
            waitMs: 50,
          })

          return { firstId, secondId, stale, settled, replay }
        }),
      ),
    )

    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.firstId).not.toBe(outcome.secondId)
    expect(outcome.stale.code).toBe("prompt_not_found")
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
    expect(resolved?.requestId).toBe(outcome.secondId)
    expect(resolved?.requestId?.startsWith("hub-")).toBe(true)
    expect(JSON.stringify(resolved)).not.toContain("prompt-same")
  })

  it("keeps only the newest prompt when one CLI id is sent twice", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:dup",
            waitMs: 300,
          })

          const first = yield* hub.api.pendingPrompt(sessionId, "hub-1")
          const second = yield* hub.api.pendingPrompt(sessionId, "hub-2")

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId: "hub-1",
              result: { selectedOption: "proceed_once" },
            })
            .pipe(Effect.flip)

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-2",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { first, second, stale, settled, replay }
        }),
      ),
    )

    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.first).toBeUndefined()
    expect(outcome.second?.kind).toBe("permission")

    if (outcome.second?.kind === "permission") {
      expect(outcome.second.toolUses[0]?.toolUse?.name).toBe("Second")
    }

    expect(outcome.stale.code).toBe("prompt_not_found")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
    expect(resolved?.requestId).toBe("hub-2")
    expect(JSON.stringify(resolved)).not.toContain("prompt-dup")
  })

  it("keeps a huge permission prompt answerable after the ring bounds the event", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:huge",
            waitMs: 300,
          })

          const event = permissionEvent(running)
          const pending = yield* hub.api.pendingPrompt(sessionId, event.requestId ?? "")

          yield* hub.api.answer({
            sessionId,
            requestId: event.requestId ?? "",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)

          return { running, event, pending, settled }
        }),
      ),
    )

    expect(outcome.running.truncated).toBe(false)
    expect(outcome.running.events.length).toBeGreaterThan(0)
    expect(outcome.event.options).toEqual(["proceed_once", "cancel"])
    expect(outcome.event.requestId?.startsWith("hub-")).toBe(true)
    expect(JSON.stringify(outcome.running.events).includes("x".repeat(10_000))).toBe(false)
    expect(outcome.pending?.kind).toBe("permission")

    if (outcome.pending?.kind === "permission") {
      expect(JSON.stringify(outcome.pending.toolUses[0]?.toolUse?.input)).toContain(
        "x".repeat(300_000),
      )
    }

    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
  })

  it("survives answering and closing the same prompt together", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission",
            waitMs: 200,
          })

          const event = permissionEvent(running)

          const answered = hub.api
            .answer({
              sessionId,
              requestId: event.requestId ?? "",
              result: { selectedOption: "proceed_once" },
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error.code,
                onSuccess: () => "resolved",
              }),
            )

          const closed = hub.api.close(sessionId).pipe(
            Effect.match({
              onFailure: (error) => error.code,
              onSuccess: () => "closed",
            }),
          )

          const both = yield* Effect.all([answered, closed], { concurrency: 2 })
          const sessions = yield* hub.api.sessions

          return { both, sessions }
        }),
      ),
    )

    expect(outcome.sessions).toHaveLength(0)
    expect(["resolved", "prompt_not_found", "session_not_found", "exec_failed"]).toContain(
      outcome.both[0],
    )
    expect(outcome.both[1]).toBe("closed")
  })

  const evictedPermission = (hub: SessionHub, sessionId: string) =>
    Effect.gen(function* () {
      yield* hub.api.stream({ sessionId, prompt: "permission:flood", waitMs: 50 })

      let view = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 200 })

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const permission = view.events.find((event) => event.kind === "pending_permission")
        const later = view.events[1]

        if (
          view.truncated &&
          permission !== undefined &&
          view.events[0]?.seq === permission.seq &&
          later !== undefined &&
          later.seq > permission.seq + 1
        ) {
          return { view, permission }
        }

        yield* Effect.sleep("25 millis")
        view = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 200 })
      }

      return {
        view,
        permission: view.events.find((event) => event.kind === "pending_permission"),
      }
    })

  it("rescues a pending permission after the ring evicts its event", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const found = yield* evictedPermission(hub, sessionId)
          const permission = found.permission
          const requestId = permission?.requestId ?? ""

          const later = yield* hub.api.events({
            sessionId,
            cursor: (permission?.seq ?? 0) + 1,
            waitMs: 50,
          })

          yield* hub.api.answer({
            sessionId,
            requestId,
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, found.view.cursor)

          const replay = yield* hub.api.events({
            sessionId,
            cursor: permission?.seq ?? 1,
            waitMs: 50,
          })

          return { found, later, settled, replay, requestId }
        }),
      ),
    )

    const permission = outcome.found.permission
    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.found.view.truncated).toBe(true)
    expect(permission?.kind).toBe("pending_permission")
    expect(outcome.found.view.events[0]?.seq).toBe(permission?.seq)
    expect(outcome.found.view.events[1]?.seq).toBeGreaterThan((permission?.seq ?? 0) + 1)
    expect(outcome.later.truncated).toBe(true)
    expect(outcome.later.events.some((event) => event.seq === permission?.seq)).toBe(false)
    expect(outcome.later.events.some((event) => event.kind === "pending_permission")).toBe(false)
    expect(outcome.later.events.length).toBeGreaterThan(0)
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
    expect(resolved?.requestId).toBe(outcome.requestId)
    expect(resolved?.requestId?.startsWith("hub-")).toBe(true)
    expect(resolved?.toolUseId).toBe("tool-1")
  })

  it("does not rescue a cancelled permission after the ring evicts it", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)
          const found = yield* evictedPermission(hub, sessionId)
          const requestId = found.permission?.requestId ?? ""

          yield* hub.api.interrupt(sessionId)
          const settled = yield* untilSettled(hub, sessionId, found.view.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })
          const pending = yield* hub.api.pendingPrompt(sessionId, requestId)

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId,
              result: { selectedOption: "proceed_once" },
            })
            .pipe(Effect.flip)

          return { found, settled, replay, pending, stale }
        }),
      ),
    )

    expect(outcome.found.view.truncated).toBe(true)
    expect(outcome.found.permission?.kind).toBe("pending_permission")
    expect(outcome.settled.status).toBe("interrupted")
    expect(outcome.replay.truncated).toBe(true)
    expect(outcome.replay.events.some((event) => event.kind === "pending_permission")).toBe(false)
    expect(outcome.replay.events.some((event) => event.seq === outcome.found.permission?.seq)).toBe(
      false,
    )
    expect(outcome.pending).toBeUndefined()
    expect(outcome.stale.code).toBe("prompt_not_found")
  })

  it("does not rescue a cancelled prompt that the ring already evicted", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          yield* hub.api.stream({ sessionId, prompt: "permission:flood-drop", waitMs: 50 })

          let rescuedSeq: number | undefined
          let dropped = false
          let view = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 100 })

          for (let attempt = 0; attempt < 50 && !dropped; attempt += 1) {
            const first = view.events.find(
              (event) => event.kind === "pending_permission" && event.requestId === "hub-1",
            )

            const second = view.events.find(
              (event) => event.kind === "pending_permission" && event.requestId === "hub-2",
            )

            const later = view.events[1]

            if (
              rescuedSeq === undefined &&
              view.truncated &&
              first?.seq !== undefined &&
              later !== undefined &&
              later.seq > first.seq + 1 &&
              second === undefined
            ) {
              rescuedSeq = first.seq
            }

            if (
              rescuedSeq !== undefined &&
              second !== undefined &&
              !view.events.some((event) => event.seq === rescuedSeq)
            ) {
              dropped = true
            } else {
              yield* Effect.sleep("25 millis")
              view = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 100 })
            }
          }

          const firstPrompt = yield* hub.api.pendingPrompt(sessionId, "hub-1")
          const secondPrompt = yield* hub.api.pendingPrompt(sessionId, "hub-2")

          const stale = yield* hub.api
            .answer({
              sessionId,
              requestId: "hub-1",
              result: { selectedOption: "proceed_once" },
            })
            .pipe(Effect.flip)

          return { rescuedSeq, dropped, view, firstPrompt, secondPrompt, stale }
        }),
      ),
    )

    expect(outcome.dropped).toBe(true)
    expect(outcome.rescuedSeq).toBeGreaterThan(0)
    expect(outcome.view.truncated).toBe(true)
    expect(outcome.view.events.some((event) => event.seq === outcome.rescuedSeq)).toBe(false)
    expect(outcome.view.events.some((event) => event.requestId === "hub-1")).toBe(false)
    expect(outcome.view.events.some((event) => event.requestId === "hub-2")).toBe(true)
    expect(outcome.firstPrompt).toBeUndefined()
    expect(outcome.secondPrompt?.kind).toBe("permission")
    expect(outcome.stale.code).toBe("prompt_not_found")
  })

  it("keeps a delayed resolution on the answered public id when the CLI id is reused", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:late",
            waitMs: 300,
          })

          const firstId = permissionEvent(running).requestId ?? ""

          yield* hub.api.answer({
            sessionId,
            requestId: firstId,
            result: { selectedOption: "proceed_once" },
          })

          let second = yield* hub.api.pendingPrompt(sessionId, "hub-2")

          for (let attempt = 0; second === undefined && attempt < 40; attempt += 1) {
            yield* Effect.sleep("20 millis")
            second = yield* hub.api.pendingPrompt(sessionId, "hub-2")
          }

          let cursor = running.cursor

          let firstResolved:
            | { readonly requestId?: string; readonly toolUseId?: string }
            | undefined

          for (let attempt = 0; firstResolved === undefined && attempt < 8; attempt += 1) {
            const polled = yield* hub.api.events({ sessionId, cursor, waitMs: 500 })
            const notice = polled.events.find((event) => event.kind === "prompt_resolved")

            if (notice !== undefined) {
              firstResolved = { requestId: notice.requestId, toolUseId: notice.toolUseId }
            } else if (polled.cursor !== cursor) {
              cursor = polled.cursor
            }
          }

          const stillSecond = yield* hub.api.pendingPrompt(sessionId, "hub-2")

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-2",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { firstId, second, firstResolved, stillSecond, settled, replay }
        }),
      ),
    )

    const notices = outcome.replay.events.filter((event) => event.kind === "prompt_resolved")

    expect(outcome.firstId).toBe("hub-1")
    expect(outcome.second?.kind).toBe("permission")
    expect(outcome.stillSecond?.kind).toBe("permission")
    expect(outcome.firstResolved?.requestId).toBe("hub-1")
    expect(outcome.firstResolved?.toolUseId).toBe("tool-1")
    expect(outcome.settled.status).toBe("completed")
    expect(outcome.settled.result?.structuredOutput).toEqual({ selectedOption: "proceed_once" })
    expect(notices.map((event) => event.requestId)).toEqual(["hub-1", undefined])
    expect(JSON.stringify(notices)).not.toContain("prompt-same")
    expect(JSON.stringify(notices)).not.toContain("hub-2")
  })

  it("maps a resolution that names only the permission tool use id", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:toolid",
            waitMs: 300,
          })

          const event = permissionEvent(running)

          yield* hub.api.answer({
            sessionId,
            requestId: event.requestId ?? "",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)

          const replay = yield* hub.api.events({
            sessionId,
            cursor: event.seq,
            waitMs: 50,
          })

          return { event, settled, replay }
        }),
      ),
    )

    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.settled.status).toBe("completed")
    expect(resolved?.requestId).toBe(outcome.event.requestId)
    expect(resolved?.requestId?.startsWith("hub-")).toBe(true)
    expect(resolved?.toolUseId).toBe("tool-1")
    expect(JSON.stringify(resolved)).not.toContain("prompt-")
  })

  it("drops a cli correlation when the turn ends so the next prompt keeps its own id", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const first = yield* hub.api.stream({
            sessionId,
            prompt: "permission:reuse",
            waitMs: 300,
          })

          const firstId = permissionEvent(first).requestId ?? ""

          yield* hub.api.answer({
            sessionId,
            requestId: firstId,
            result: { selectedOption: "cancel" },
          })
          yield* untilSettled(hub, sessionId, first.cursor)

          const second = yield* hub.api.stream({
            sessionId,
            prompt: "permission:reuse",
            waitMs: 300,
          })

          const secondEvent = permissionEvent(second)

          yield* hub.api.answer({
            sessionId,
            requestId: secondEvent.requestId ?? "",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, second.cursor)

          const replay = yield* hub.api.events({
            sessionId,
            cursor: secondEvent.seq,
            waitMs: 50,
          })

          return { firstId, secondId: secondEvent.requestId, settled, replay }
        }),
      ),
    )

    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.firstId).toBe("hub-1")
    expect(outcome.secondId).toBe("hub-2")
    expect(outcome.settled.status).toBe("completed")
    expect(resolved?.requestId).toBe("hub-2")
    expect(JSON.stringify(resolved)).not.toContain("prompt-same")
    expect(JSON.stringify(resolved)).not.toContain("hub-1")
  })

  const waitPending = (hub: SessionHub, sessionId: string, requestId: string) =>
    Effect.gen(function* () {
      let pending = yield* hub.api.pendingPrompt(sessionId, requestId)

      for (let attempt = 0; pending === undefined && attempt < 50; attempt += 1) {
        yield* Effect.sleep("20 millis")
        pending = yield* hub.api.pendingPrompt(sessionId, requestId)
      }

      return pending
    })

  const resolvedNotices = (events: ReadonlyArray<TurnEvent>) =>
    events.filter((event) => event.kind === "prompt_resolved")

  it("maps a batch resolution that names only tool use ids", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:batch-ids",
            waitMs: 300,
          })

          const event = permissionEvent(running)

          yield* hub.api.answer({
            sessionId,
            requestId: event.requestId ?? "",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: event.seq, waitMs: 50 })

          return { event, settled, replay }
        }),
      ),
    )

    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.event.toolUses).toHaveLength(2)
    expect(outcome.settled.status).toBe("completed")
    expect(resolved?.requestId).toBe(outcome.event.requestId)
    expect(JSON.stringify(resolved)).not.toContain("prompt-")
  })

  it("does not treat an unmatched hub- prefix as a public prompt id", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:opaque",
            waitMs: 300,
          })

          const event = permissionEvent(running)

          yield* hub.api.answer({
            sessionId,
            requestId: event.requestId ?? "",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: event.seq, waitMs: 50 })

          return { event, settled, replay }
        }),
      ),
    )

    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.settled.status).toBe("completed")
    expect(outcome.event.requestId).not.toBe("hub-99")
    expect(resolved?.requestId).toBeUndefined()
    expect(JSON.stringify(resolved)).not.toContain("hub-99")
  })

  it("does not record a question answer as a permission correlation", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "ask:stray",
            waitMs: 300,
          })

          const event = running.events.find((candidate) => candidate.kind === "pending_question")

          yield* hub.api.answer({
            sessionId,
            requestId: event?.requestId ?? "",
            result: {
              answers: [
                { index: 0, answer: "vitest" },
                { index: 1, answer: "lint" },
              ],
            },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { event, settled, replay }
        }),
      ),
    )

    const resolved = outcome.replay.events.find((event) => event.kind === "prompt_resolved")

    expect(outcome.event?.requestId?.startsWith("hub-")).toBe(true)
    expect(outcome.settled.status).toBe("completed")
    expect(resolved?.requestId).toBeUndefined()
    expect(resolved?.requestId).not.toBe(outcome.event?.requestId)
  })

  it("omits the public id when two answered prompts share a cli id and tool id", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:ambiguous",
            waitMs: 300,
          })

          const firstId = permissionEvent(running).requestId ?? ""

          yield* hub.api.answer({
            sessionId,
            requestId: firstId,
            result: { selectedOption: "proceed_once" },
          })
          const second = yield* waitPending(hub, sessionId, "hub-2")

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-2",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { firstId, second, settled, replay }
        }),
      ),
    )

    const notices = resolvedNotices(outcome.replay.events)

    expect(outcome.firstId).toBe("hub-1")
    expect(outcome.second?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(notices).toHaveLength(2)

    for (const notice of notices) {
      expect(notice.requestId).toBeUndefined()
    }

    expect(JSON.stringify(notices)).not.toContain("hub-1")
    expect(JSON.stringify(notices)).not.toContain("hub-2")
    expect(JSON.stringify(notices)).not.toContain("prompt-same")
  })

  it("drops correlations past the cap without giving the evicted notice a newer id", async () => {
    const count = CORRELATION_LIMIT + 1

    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:queue:" + String(count),
            waitMs: 1_000,
          })

          const lastId = "hub-" + String(count)
          const last = yield* waitPending(hub, sessionId, lastId)

          for (let index = 1; index <= count; index += 1) {
            yield* hub.api.answer({
              sessionId,
              requestId: "hub-" + String(index),
              result: { selectedOption: "proceed_once" },
            })
          }

          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { last, settled, replay, count }
        }),
      ),
    )

    const notices = resolvedNotices(outcome.replay.events)
    const oldest = notices.find((event) => event.toolUseId === "tool-q-1")
    const newest = notices.find((event) => event.toolUseId === "tool-q-" + String(outcome.count))

    expect(outcome.last?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(notices).toHaveLength(outcome.count)
    expect(oldest?.toolUseId).toBe("tool-q-1")
    expect(oldest?.requestId).toBeUndefined()
    expect(JSON.stringify(oldest)).not.toContain("hub-")
    expect(JSON.stringify(oldest)).not.toContain("prompt-q-")
    expect(newest?.requestId).toBe("hub-" + String(outcome.count))
  })

  it("does not attach a late reused id to the newer prompt after the cap drops the old one", async () => {
    const cap = CORRELATION_LIMIT

    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:stale:" + String(cap),
            waitMs: 1_000,
          })

          const firstId = permissionEvent(running).requestId ?? ""

          yield* hub.api.answer({
            sessionId,
            requestId: firstId,
            result: { selectedOption: "proceed_once" },
          })

          const reuserId = "hub-" + String(cap + 1)
          const reuser = yield* waitPending(hub, sessionId, reuserId)

          for (let index = 2; index <= cap + 1; index += 1) {
            yield* hub.api.answer({
              sessionId,
              requestId: "hub-" + String(index),
              result: { selectedOption: "proceed_once" },
            })
          }

          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { firstId, reuserId, reuser, settled, replay }
        }),
      ),
    )

    const notices = resolvedNotices(outcome.replay.events)
    const reused = notices.filter((event) => event.toolUseId === "tool-1")
    const filler = notices.find((event) => event.toolUseId === "tool-fill-1")

    expect(outcome.firstId).toBe("hub-1")
    expect(outcome.reuserId).toBe("hub-" + String(cap + 1))
    expect(outcome.reuser?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(reused).toHaveLength(2)

    for (const notice of reused) {
      expect(notice.requestId).toBeUndefined()
    }

    expect(JSON.stringify(reused)).not.toContain(outcome.reuserId)
    expect(JSON.stringify(reused)).not.toContain("hub-1")
    expect(filler?.requestId).toBe("hub-2")
  })

  it("does not give a third shared key the id removed from the first", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:triple",
            waitMs: 300,
          })

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-1",
            result: { selectedOption: "proceed_once" },
          })
          const second = yield* waitPending(hub, sessionId, "hub-2")

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-2",
            result: { selectedOption: "proceed_once" },
          })
          const third = yield* waitPending(hub, sessionId, "hub-3")

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-3",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { second, third, settled, replay }
        }),
      ),
    )

    const notices = resolvedNotices(outcome.replay.events)

    expect(outcome.second?.kind).toBe("permission")
    expect(outcome.third?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(notices).toHaveLength(1)
    expect(notices[0]?.toolUseId).toBe("tool-1")
    expect(notices[0]?.requestId).toBeUndefined()
    expect(JSON.stringify(notices)).not.toContain("hub-3")
    expect(JSON.stringify(notices)).not.toContain("hub-1")
    expect(JSON.stringify(notices)).not.toContain("prompt-same")
  })

  it("does not give a reused key to a prompt opened after the old record was evicted", async () => {
    const fill = CORRELATION_LIMIT

    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:evicted:" + String(fill),
            waitMs: 1_000,
          })

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-1",
            result: { selectedOption: "proceed_once" },
          })
          const lastFill = "hub-" + String(fill + 1)
          const filled = yield* waitPending(hub, sessionId, lastFill)

          for (let index = 2; index <= fill + 1; index += 1) {
            yield* hub.api.answer({
              sessionId,
              requestId: "hub-" + String(index),
              result: { selectedOption: "proceed_once" },
            })
          }

          const reuserId = "hub-" + String(fill + 2)
          const reuser = yield* waitPending(hub, sessionId, reuserId)

          yield* hub.api.answer({
            sessionId,
            requestId: reuserId,
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { filled, reuserId, reuser, settled, replay }
        }),
      ),
    )

    const late = resolvedNotices(outcome.replay.events).find(
      (event) => event.toolUseId === "tool-1",
    )

    expect(outcome.filled?.kind).toBe("permission")
    expect(outcome.reuser?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(late?.toolUseId).toBe("tool-1")
    expect(late?.requestId).toBeUndefined()
    expect(JSON.stringify(late)).not.toContain(outcome.reuserId)
    expect(JSON.stringify(late)).not.toContain("hub-1")
    expect(JSON.stringify(late)).not.toContain("prompt-same")
  })

  it("does not attach a late resolution to a prompt that reused a timed-out key", async () => {
    const outcome = await Effect.runPromise(
      scoped(
        (hub) =>
          Effect.gen(function* () {
            const sessionId = yield* createSession(hub)

            const running = yield* hub.api.stream({
              sessionId,
              prompt: "permission:after-timeout",
              waitMs: 100,
            })

            let timedOut: TurnEvent | undefined
            let cursor = running.cursor

            for (let attempt = 0; timedOut === undefined && attempt < 20; attempt += 1) {
              const polled = yield* hub.api.events({ sessionId, cursor, waitMs: 500 })
              timedOut = polled.events.find(
                (event) => event.kind === "prompt_resolved" && event.reason === "timeout",
              )

              if (polled.cursor !== cursor) cursor = polled.cursor
            }

            const second = yield* waitPending(hub, sessionId, "hub-2")

            yield* hub.api.answer({
              sessionId,
              requestId: "hub-2",
              result: { selectedOption: "proceed_once" },
            })
            const settled = yield* untilSettled(hub, sessionId, cursor)
            const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

            return { timedOut, second, settled, replay }
          }),
        200,
      ),
    )

    const late = resolvedNotices(outcome.replay.events).find(
      (event) => event.toolUseId === "tool-1",
    )

    expect(outcome.timedOut?.requestId).toBe("hub-1")
    expect(outcome.timedOut?.reason).toBe("timeout")
    expect(outcome.second?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(late?.requestId).toBeUndefined()
    expect(JSON.stringify(late)).not.toContain("hub-2")
    expect(JSON.stringify(late)).not.toContain("prompt-same")
    expect(
      resolvedNotices(outcome.replay.events).filter((event) => event.requestId === "hub-2"),
    ).toHaveLength(0)
  })

  it("does not attach a late resolution to a prompt that reused a cancelled key", async () => {
    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:after-cancel",
            waitMs: 300,
          })

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-1",
            result: { selectedOption: "cancel" },
          })
          const second = yield* waitPending(hub, sessionId, "hub-2")

          yield* hub.api.answer({
            sessionId,
            requestId: "hub-2",
            result: { selectedOption: "proceed_once" },
          })
          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { second, settled, replay }
        }),
      ),
    )

    const late = resolvedNotices(outcome.replay.events).find(
      (event) => event.toolUseId === "tool-1",
    )

    expect(outcome.second?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(late?.requestId).toBeUndefined()
    expect(JSON.stringify(late)).not.toContain("hub-1")
    expect(JSON.stringify(late)).not.toContain("hub-2")
    expect(JSON.stringify(late)).not.toContain("prompt-same")
  })

  it("stops naming resolutions once the seen-key set is full", async () => {
    const count = Math.floor(SEEN_KEY_LIMIT / 2) + 1

    const outcome = await Effect.runPromise(
      scoped((hub) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(hub)

          const running = yield* hub.api.stream({
            sessionId,
            prompt: "permission:queue:" + String(count),
            waitMs: 1_000,
          })

          const last = yield* waitPending(hub, sessionId, "hub-" + String(count))

          for (let index = 1; index <= count; index += 1) {
            yield* hub.api.answer({
              sessionId,
              requestId: "hub-" + String(index),
              result: { selectedOption: "proceed_once" },
            })
          }

          const settled = yield* untilSettled(hub, sessionId, running.cursor)
          const replay = yield* hub.api.events({ sessionId, cursor: 1, waitMs: 50 })

          return { last, settled, replay, count }
        }),
      ),
    )

    const notices = resolvedNotices(outcome.replay.events)
    const oldest = notices.find((event) => event.toolUseId === "tool-q-1")
    const newest = notices.find((event) => event.toolUseId === "tool-q-" + String(outcome.count))

    expect(outcome.last?.kind).toBe("permission")
    expect(outcome.settled.status).toBe("completed")
    expect(notices).toHaveLength(outcome.count)
    expect(oldest?.requestId).toBeUndefined()
    expect(newest?.requestId).toBeUndefined()
    expect(JSON.stringify(notices)).not.toContain("hub-")
  })
})
