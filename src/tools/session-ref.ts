export const SESSIONS_URI = "droid://sessions"

export const sessionUri = (sessionId: string): string => SESSIONS_URI + "/" + sessionId

export const eventsUri = (sessionId: string, cursor: number): string =>
  sessionUri(sessionId) + "/events/" + String(cursor)
