import * as McpServer from "effect/ai/McpServer"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { SessionHubService } from "../droid/turns.ts"
import { SESSIONS_URI, sessionUri } from "./session-ref.ts"

const summaryOf = (session: {
  readonly sessionId: string
  readonly cwd: string
  readonly status: string
  readonly cursor: number
  readonly settings: unknown
  readonly worktree?: { readonly path: string; readonly branch: string; readonly lifecycle: string }
}) => ({
  uri: sessionUri(session.sessionId),
  sessionId: session.sessionId,
  cwd: session.cwd,
  status: session.status,
  cursor: session.cursor,
  settings: session.settings,
  worktree: session.worktree,
})

const listResource = McpServer.resource({
  uri: SESSIONS_URI,
  name: "sessions",
  description: "Live local Droid sessions. Read one session URI for its status.",
  mimeType: "application/json",
  content: SessionHubService.use((hub) =>
    Effect.map(hub.sessions, (sessions) => JSON.stringify({ sessions: sessions.map(summaryOf) })),
  ),
})

const sessionResource = McpServer.resource`droid://sessions/${Schema.String}`({
  name: "session",
  description: "One live local session: status, cursor, cwd, and worktree.",
  mimeType: "application/json",
  content: (uri, sessionId) =>
    SessionHubService.use((hub) =>
      Effect.map(hub.sessions, (sessions) => {
        const session = sessions.find((item) => item.sessionId === sessionId)

        return session === undefined
          ? JSON.stringify({ uri, error: "session_not_found", sessionId })
          : JSON.stringify(summaryOf(session))
      }),
    ),
})

const eventsResource =
  McpServer.resource`droid://sessions/${Schema.String}/events/${Schema.String}`({
    name: "session-events",
    description: "Events since a cursor. The cursor is the next sequence number.",
    mimeType: "application/json",
    content: (_uri, sessionId, cursorText) =>
      SessionHubService.use((hub) => {
        const cursor = Number(cursorText)

        if (!Number.isInteger(cursor) || cursor < 0) {
          return Effect.succeed(JSON.stringify({ error: "invalid_cursor" }))
        }

        return hub.events({ sessionId, cursor, waitMs: 0 }).pipe(
          Effect.map((result) => JSON.stringify(result)),
          Effect.catch((cause) =>
            Effect.succeed(JSON.stringify({ error: cause.code, message: cause.message })),
          ),
        )
      }),
  })

const notify = Layer.effectDiscard(
  Effect.gen(function* () {
    const hub = yield* SessionHubService
    const server = yield* McpServer.McpServer

    yield* hub.changes.pipe(
      Stream.runForEach((uri) =>
        server.notifications["notifications/resources/updated"]({ uri }).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    )
  }),
)

export const sessionResources = Layer.mergeAll(
  listResource,
  sessionResource,
  eventsResource,
  notify,
)
