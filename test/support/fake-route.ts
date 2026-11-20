import type { IncomingMessage } from "node:http"

export interface HeaderMap {
  [name: string]: string
}

export interface ParsedRoute<H> {
  readonly key: string
  readonly method: string
  readonly segments: ReadonlyArray<string>
  readonly literals: number
  readonly handler: H
}

/** `"METHOD /path/{id}"` becomes the segments the fake servers match against. */
export const routeOf = <H>(key: string, handler: H): ParsedRoute<H> => {
  const space = key.indexOf(" ")
  const segments = key.slice(space + 1).split("/")

  return {
    key,
    method: key.slice(0, space),
    segments,
    literals: segments.filter((segment) => !segment.startsWith("{")).length,
    handler,
  }
}

export const matchPath = (
  route: { readonly segments: ReadonlyArray<string> },
  segments: ReadonlyArray<string>,
): Record<string, string> | undefined => {
  if (route.segments.length !== segments.length) return undefined

  const params: Record<string, string> = {}

  for (const [index, pattern] of route.segments.entries()) {
    const segment = segments[index] ?? ""

    if (pattern.startsWith("{")) {
      if (segment.length === 0) return undefined

      params[pattern.slice(1, -1)] = decodeURIComponent(segment)
    } else if (pattern !== segment) {
      return undefined
    }
  }

  return params
}

export const headerRecord = (request: IncomingMessage): HeaderMap => {
  const headers: HeaderMap = {}

  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value
  }

  return headers
}
