/**
 * The private HTTP transport for the configured Context origin. Every
 * request is built only from this module's own operation paths plus the
 * validated origin inside the installation: `new URL` never sees a string
 * the caller controls, so a path can never become an authority, redirects
 * are never followed, and there is no hosted-origin fallback. Interrupting
 * the calling fiber aborts the fetch; a timeout or connection failure after
 * the request was handed off is uncertain delivery, which is never retried.
 */
import { Buffer } from "node:buffer"

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { isJsonObject, serializeQuery } from "./wire.ts"

/** One HTTP exchange against the Context origin, fully described. */
export interface ContextHttpRequest {
  readonly operation: string
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
  /** The exact origin-relative path, already segment-encoded. */
  readonly path: string
  readonly query: ReadonlyArray<readonly [string, string]>
  /** JSON for a JSON body; bytes are sent as `application/octet-stream`. */
  readonly body?: Schema.Json | Uint8Array
}

export interface Received {
  readonly status: number
  readonly bytes: Uint8Array
}

export type SendFailure =
  | { readonly kind: "oversized"; readonly status: number }
  | { readonly kind: "uncertain"; readonly timedOut: boolean }
  | { readonly kind: "unreachable" }

export type FetchLike = (
  input: string,
  init: {
    readonly method: string
    readonly headers: Readonly<Record<string, string>>
    readonly body?: string | Uint8Array
    readonly redirect: "manual"
    readonly signal: AbortSignal
  },
) => Promise<Response>

export interface ContextTransport {
  /** Normalized static header values that operations must never publish. */
  readonly staticSensitiveValues: ReadonlyArray<string>
  /** Static header values plus the credential used for this installation. */
  readonly secretValues: () => Effect.Effect<ReadonlyArray<string>>
  readonly send: (
    request: ContextHttpRequest,
    maxBytes: number,
  ) => Effect.Effect<Received, SendFailure>
}

/** Responses are capped before they are buffered; nothing upstream needs more. */
export const RESPONSE_MAX_BYTES = 32 * 1024 * 1024

export const DEFAULT_TIMEOUT_MS = 30_000

/** Fetch strips surrounding spaces and tabs before sending, so the stored value matches the wire. */
const HEADER_WHITESPACE = /^[ \t]+|[ \t]+$/g

/** Headers this transport owns or that would break routing, authentication or framing. */
const RESERVED_HEADERS = new Set([
  "accept",
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "te",
  "upgrade",
  "keep-alive",
  "expect",
  "trailer",
])

/** Replaces every occurrence of a non-empty secret. Longer secrets first, so one containing a shorter is replaced whole. */
export const scrubText = (text: string, secrets: ReadonlyArray<string>, marker: string): string => {
  let result = text

  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) result = result.split(secret).join(marker)
  }

  return result
}

/** The default fetch implementation; tests inject a recording one. */
export const defaultFetch: FetchLike = (input, init) =>
  fetch(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: init.redirect,
    signal: init.signal,
  })

/** The whole body, or `undefined` once it passes `maxBytes` — refused before buffering. */
const readCapped = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> => {
  const declared = Number(response.headers.get("content-length") ?? "0")

  if (declared > maxBytes) {
    await response.body?.cancel()

    return undefined
  }

  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  let next = await reader.read()

  while (!next.done) {
    total += next.value.byteLength

    if (total > maxBytes) {
      await reader.cancel()

      return undefined
    }

    chunks.push(next.value)
    next = await reader.read()
  }

  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * A URL whose scheme, host and path shape this module alone controls: the
 * authority comes from the validated origin, the path from a constant
 * operation template, and the query from `serializeQuery`. Caller-controlled
 * text only ever enters percent-encoded inside a segment or a query value.
 * An origin-relative path starting with `/` can never carry an authority, so
 * the resolved URL always keeps the configured origin.
 */
const urlFor = (
  origin: string,
  path: string,
  query: ReadonlyArray<readonly [string, string]>,
): string | undefined => {
  if (!path.startsWith("/")) return undefined

  const serialized = serializeQuery(query)
  const resolved = new URL(path + (serialized.length === 0 ? "" : "?" + serialized), origin)

  return resolved.origin === origin ? resolved.href : undefined
}

export interface TransportOptions {
  readonly fetch: FetchLike
  readonly timeoutMs: number
  readonly headers?: Readonly<Record<string, string>>
  readonly token?: () => Effect.Effect<string | undefined>
}

/** Mutable wire headers for one request, built only inside this module. */
interface RequestHeaders {
  [name: string]: string
}

/** Builds the transport for one validated origin; the origin is fixed at construction. */
export const openTransport = (origin: string, options: TransportOptions): ContextTransport => {
  const staticHeaders: Record<string, string> = {}

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) {
      staticHeaders[name] = value.replace(HEADER_WHITESPACE, "")
    }
  }

  const staticSensitiveValues = Object.values(staticHeaders).filter((value) => value.length > 0)

  return {
    staticSensitiveValues,

    secretValues: () =>
      Effect.map(
        options.token === undefined ? Effect.succeed(undefined) : options.token(),
        (token) => {
          const values = [...staticSensitiveValues]

          if (token !== undefined && token.length > 0) values.push(token)

          return values
        },
      ),

    send: (request, maxBytes) =>
      Effect.gen(function* () {
        const url = urlFor(origin, request.path, request.query)

        if (url === undefined) {
          // Unreachable in practice: paths are constants built inside this module.
          return yield* Effect.fail<SendFailure>({ kind: "unreachable" })
        }

        const token = options.token === undefined ? undefined : yield* options.token()

        const headers: RequestHeaders = { ...staticHeaders, accept: "application/json" }

        if (token !== undefined && token.length > 0) headers.authorization = "Bearer " + token

        let body: string | Uint8Array | undefined

        if (request.body instanceof Uint8Array) {
          headers["content-type"] = "application/octet-stream"
          body = request.body
        } else if (request.body !== undefined) {
          headers["content-type"] = "application/json"
          body = JSON.stringify(request.body)
        }

        const timeout = AbortSignal.timeout(options.timeoutMs)

        /*
         * A DNS or connection refusal can happen either before or after the
         * peer received the request, so a network failure is uncertain
         * delivery, never a silent retry.
         */
        const exchange = yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await options.fetch(url, {
              method: request.method,
              headers,
              body,
              redirect: "manual",
              signal: AbortSignal.any([signal, timeout]),
            })

            return { status: response.status, bytes: await readCapped(response, maxBytes) }
          },
          catch: (): SendFailure => ({ kind: "uncertain", timedOut: timeout.aborted }),
        })

        if (exchange.bytes === undefined) {
          return yield* Effect.fail<SendFailure>({ kind: "oversized", status: exchange.status })
        }

        return { status: exchange.status, bytes: exchange.bytes }
      }),
  }
}

// ---------------------------------------------------------------------------
// Reply decoding helpers
// ---------------------------------------------------------------------------

/** Parses bytes as checked JSON without exception-driven control flow. */
export const decodeReplyJson = (bytes: Uint8Array): Schema.Json | undefined => {
  try {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Json)(JSON.parse(new TextDecoder().decode(bytes))),
    )
  } catch {
    return undefined
  }
}

/** The conflict fields an upstream error body carries, decimal strings kept exact. */
export interface ConflictFields {
  readonly currentVersion?: string
  readonly currentSequence?: string
}

const ConflictReplyFields = Schema.Struct({
  currentVersion: Schema.optional(Schema.String),
  currentSequence: Schema.optional(Schema.String),
})

export const conflictFieldsOf = (json: Schema.Json | undefined): ConflictFields => {
  if (json === undefined || !isJsonObject(json)) return {}

  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ConflictReplyFields)(json))

  if (decoded === undefined) return {}

  if (decoded.currentVersion !== undefined && decoded.currentSequence !== undefined) {
    return { currentVersion: decoded.currentVersion, currentSequence: decoded.currentSequence }
  }

  if (decoded.currentVersion !== undefined) return { currentVersion: decoded.currentVersion }

  if (decoded.currentSequence !== undefined) return { currentSequence: decoded.currentSequence }

  return {}
}

const DETAIL_MAX_LENGTH = 500

/** The human-readable detail of an upstream error body, capped for a failure message. */
const ErrorDetailFields = Schema.Struct({ detail: Schema.optional(Schema.String) })

export const errorDetailOf = (json: Schema.Json | undefined): string | undefined => {
  if (json === undefined || !isJsonObject(json)) return undefined

  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorDetailFields)(json))
  const detail = decoded?.detail

  if (detail === undefined || detail.trim().length === 0) return undefined

  const trimmed = detail.trim()

  return trimmed.length <= DETAIL_MAX_LENGTH
    ? trimmed
    : trimmed.slice(0, DETAIL_MAX_LENGTH - 1) + "…"
}
