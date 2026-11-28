/**
 * The private HTTP transport for one validated hosted origin. Every request
 * is built only from this module's own constant operation paths plus the
 * origin fixed inside the installation: caller-controlled text only ever
 * enters percent-encoded inside one path segment or one query value, so no
 * path can become an authority. Redirects are never followed, so credentials
 * can never travel to another host. Interrupting the calling fiber aborts
 * the fetch; a timeout or connection failure after the request was handed
 * off is uncertain delivery, which nothing ever retries.
 */
import { Buffer } from "node:buffer"

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { serializeQuery } from "./wire.ts"

/** One HTTP exchange against the hosted origin, fully described. */
export interface HostedHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** The exact origin-relative path, already segment-encoded. */
  readonly path: string
  readonly query: ReadonlyArray<readonly [string, string]>
  readonly body?: Schema.Json
  readonly acceptBinary?: boolean
}

export interface Received {
  readonly status: number
  readonly contentType: string | null
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
    readonly body?: string
    readonly redirect: "manual"
    readonly signal: AbortSignal
  },
) => Promise<Response>

export interface HostedTransport {
  readonly send: (
    request: HostedHttpRequest,
    maxBytes: number,
  ) => Effect.Effect<Received, SendFailure>
  /**
   * The secret values currently in scope for this transport: the resolved
   * credential plus any static sensitive values. Error detail crossing back
   * from the peer is scrubbed against these before it enters a failure
   * message, so a peer echoing the credential cannot smuggle it into a
   * diagnostic.
   */
  readonly secretValues: () => Effect.Effect<ReadonlyArray<string>>
}

/** Responses are capped before they are buffered; nothing upstream needs more. */
export const RESPONSE_MAX_BYTES = 32 * 1024 * 1024

export const DEFAULT_TIMEOUT_MS = 30_000

const BINARY_ACCEPT = "application/json, application/octet-stream;q=0.9, */*;q=0.8"

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
 * operation template, and the query from `serializeQuery`. An origin-relative
 * path starting with `/` can never carry an authority, so the resolved URL
 * always keeps the configured origin.
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

/** Static installation headers may never override transport credentials or content negotiation. */
const RESERVED_HEADERS = new Set(["authorization", "content-type", "accept"])

/** Mutable wire headers for one request, built only inside this module. */
interface RequestHeaders {
  [name: string]: string
}

export interface TransportOptions {
  readonly fetch: FetchLike
  readonly timeoutMs: number
  readonly headers?: Readonly<Record<string, string>>
  readonly credential?: () => Effect.Effect<string | undefined>
  /** Static sensitive values (such as operator-configured header values) always in scope. */
  readonly sensitiveValues?: ReadonlyArray<string>
}

/** Replaces every occurrence of a non-empty secret. Longer secrets first, so one containing a shorter is replaced whole. */
export const scrubText = (text: string, secrets: ReadonlyArray<string>, marker: string): string => {
  let result = text

  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) result = result.split(secret).join(marker)
  }

  return result
}

/** Builds the transport for one validated origin; the origin is fixed at construction. */
export const buildTransport = (origin: string, options: TransportOptions): HostedTransport => {
  const staticHeaders: Record<string, string> = {}

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) staticHeaders[name] = value
  }

  return {
    secretValues: () =>
      Effect.map(
        options.credential === undefined ? Effect.succeed(undefined) : options.credential(),
        (credential) => {
          const values: Array<string> = [...(options.sensitiveValues ?? [])]

          if (credential !== undefined && credential.length > 0) values.push(credential)

          for (const value of Object.values(options.headers ?? {})) {
            if (value.length > 0) values.push(value)
          }

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

        const credential =
          options.credential === undefined ? undefined : yield* options.credential()

        const headers: RequestHeaders = {
          ...staticHeaders,
          accept: request.acceptBinary === true ? BINARY_ACCEPT : "application/json",
        }

        if (credential !== undefined && credential.length > 0) {
          headers.authorization = "Bearer " + credential
        }

        let body: string | undefined

        if (request.body !== undefined) {
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

            return {
              status: response.status,
              contentType: response.headers.get("content-type"),
              bytes: await readCapped(response, maxBytes),
            }
          },
          catch: (): SendFailure => ({ kind: "uncertain", timedOut: timeout.aborted }),
        })

        if (exchange.bytes === undefined) {
          return yield* Effect.fail<SendFailure>({ kind: "oversized", status: exchange.status })
        }

        return { status: exchange.status, contentType: exchange.contentType, bytes: exchange.bytes }
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

const DETAIL_MAX_LENGTH = 500

/** The human-readable detail of an upstream error body, capped for a failure message. */
export const errorDetailOf = (json: Schema.Json | undefined): string | undefined => {
  if (json === undefined || Array.isArray(json) || json === null) return undefined

  if (!Predicate.isObject(json)) return undefined

  const detail = json.detail

  if (!Predicate.isString(detail) || detail.trim().length === 0) return undefined

  const trimmed = detail.trim()

  return trimmed.length <= DETAIL_MAX_LENGTH
    ? trimmed
    : trimmed.slice(0, DETAIL_MAX_LENGTH - 1) + "…"
}
