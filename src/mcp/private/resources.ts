/**
 * Resource URI parsing. `droid://sessions` URIs expose only what the caller
 * can see; `skill://droid` URIs name the embedded guide documents. Nothing
 * here grants access — a well-formed URI is input to lookup only.
 */
import { SESSIONS_URI, sessionUriOf } from "./wire.ts"

export const SKILL_ROOT_URI = "skill://droid/SKILL.md"

export const SKILL_URI_PREFIX = "skill://droid/"

export type ParsedResourceUri =
  | { readonly kind: "skill-root" }
  | { readonly kind: "skill-reference"; readonly part: string }
  | { readonly kind: "sessions-list" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "session-events"; readonly sessionId: string; readonly cursorText: string }
  | { readonly kind: "unknown" }

/** Parses one resource URI into its wire shape without granting access. */
export const parseResourceUri = (uri: string): ParsedResourceUri => {
  if (uri === SKILL_ROOT_URI) return { kind: "skill-root" }

  if (uri.startsWith(SKILL_URI_PREFIX)) {
    const part = uri.slice(SKILL_URI_PREFIX.length)

    if (part.length > 0 && !part.startsWith("/")) {
      return { kind: "skill-reference", part }
    }

    return { kind: "unknown" }
  }

  if (uri === SESSIONS_URI) return { kind: "sessions-list" }

  const sessionPrefix = SESSIONS_URI + "/"

  if (!uri.startsWith(sessionPrefix)) return { kind: "unknown" }

  const rest = uri.slice(sessionPrefix.length)

  const eventsMarker = "/events/"
  const markerIndex = rest.indexOf(eventsMarker)

  if (markerIndex === -1) {
    if (rest.length === 0 || rest.includes("/")) return { kind: "unknown" }

    return { kind: "session", sessionId: rest }
  }

  const sessionId = rest.slice(0, markerIndex)
  const cursorText = rest.slice(markerIndex + eventsMarker.length)

  if (sessionId.length === 0 || cursorText.length === 0 || cursorText.includes("/")) {
    return { kind: "unknown" }
  }

  return { kind: "session-events", sessionId, cursorText }
}

/** Validates an external numeric cursor: a non-negative integer text. */
export const parseCursor = (cursorText: string): number | undefined => {
  if (!/^[0-9]+$/.test(cursorText)) return undefined

  const cursor = Number(cursorText)

  if (!Number.isSafeInteger(cursor) || cursor < 0) return undefined

  return cursor
}

export { SESSIONS_URI, sessionUriOf }
