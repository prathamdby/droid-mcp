import { Buffer } from "node:buffer"

import { ContextApiError } from "@factory/droid-sdk"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import { ContextBaseUrlMissing, FactoryApiKeyMissing } from "./errors.ts"
import type { JsonValue } from "./protocol.ts"
import { protectedValues, redact, redactRecords } from "./redact.ts"
import {
  binaryEnvelope,
  decodeJsonText,
  errorDetail,
  isJsonContentType,
  safeDetail,
  scrubSecrets,
  serializeQuery,
} from "./rest-http.ts"

/**
 * The hosted Factory API is HTTPS with a bearer key and JSON bodies. Every
 * `rest_*` tool goes through `request`, which owns credentials, timeouts,
 * redirect refusal, status mapping, and redaction. Tool modules never fetch.
 *
 * Context lives on a separately configured Prem origin. `context` and
 * `contextBytes` reach it through the same transport, so a call is cancelled
 * with its fiber and its response is size-capped before it is buffered; they
 * map errors onto the same contract, keeping the Context API's conflict fields.
 */

export class RestRejected extends Schema.TaggedError<RestRejected>()("RestRejected", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
}) {}

export class RestUnavailable extends Schema.TaggedError<RestUnavailable>()("RestUnavailable", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
}) {}

export type RestError =
  | RestRejected
  | RestUnavailable
  | FactoryApiKeyMissing
  | ContextBaseUrlMissing

export type RestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/**
 * `json` parses the body; `empty` ignores it; `json-or-binary` parses JSON
 * content types and returns anything else as a base64 envelope.
 */
export type RestResponse = "json" | "empty" | "json-or-binary"

type Query = ReadonlyArray<readonly [string, string]>

export interface RestRequest {
  /** The upstream operation id, used in messages (e.g. `getComputer`). */
  readonly operation: string
  readonly method: RestMethod
  /** Already segment-encoded; starts with `/api/v0/`. */
  readonly path: string
  /** Repeated keys allowed. */
  readonly query: Query
  readonly body: JsonValue | undefined
  readonly response: RestResponse
  /** Per-call values to scrub from results and errors. */
  readonly secrets: ReadonlyArray<string>
}

/**
 * `json` checks and redacts the body; `empty` ignores it; `records` is JSON
 * whose `contentJsonl` member holds JSONL records, each redacted as JSON.
 */
export type ContextResponse = "json" | "empty" | "records"

export interface ContextRequest {
  /** The Context operation, used in messages (e.g. `getContextSpace`). */
  readonly operation: string
  readonly method: RestMethod
  /** Already segment-encoded; starts with `/api/context/`. */
  readonly path: string
  readonly query: Query
  /** JSON, or bytes sent as `application/octet-stream`. */
  readonly body: JsonValue | Uint8Array | undefined
  readonly response: ContextResponse
  /**
   * Checks the upstream body against its contract before redaction, and may
   * add members; `undefined` means it does not match. Absent accepts any JSON.
   */
  readonly parse?: (json: JsonValue) => JsonValue | undefined
}

export interface ContextBytesRequest {
  readonly operation: string
  /** Already segment-encoded; starts with `/api/context/`. */
  readonly path: string
  /** A larger body is refused before it is buffered. */
  readonly maxBytes: number
}

export type RestResult = JsonValue | undefined

export interface RestApi {
  readonly request: (request: RestRequest) => Effect.Effect<RestResult, RestError>
  /** One JSON request to `FACTORY_CONTEXT_BASE_URL`; `undefined` stands for an empty success. */
  readonly context: (request: ContextRequest) => Effect.Effect<RestResult, RestError>
  /**
   * One byte download from `FACTORY_CONTEXT_BASE_URL`. Bytes cannot be
   * redacted without corrupting them, so a body that contains a protected
   * value is refused instead.
   */
  readonly contextBytes: (request: ContextBytesRequest) => Effect.Effect<Uint8Array, RestError>
}

export class RestService extends Context.Service<RestService, RestApi>()("droid-mcp/RestService") {}

interface Received {
  readonly status: number
  readonly contentType: string | null
  readonly bytes: Uint8Array
}

const FACTORY_API = "Factory API"
const CONTEXT_API = "Context API"

const BINARY_ACCEPT = "application/json, application/octet-stream;q=0.9, */*;q=0.8"

/** A larger body is refused before it is buffered, and before a binary one is base64-encoded. */
const RESPONSE_MAX_BYTES = 32 * 1024 * 1024

/** The whole body, or `undefined` once it passes `maxBytes`. */
const readCapped = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> => {
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
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

interface RequestHeaders {
  [name: string]: string
}

/** One HTTP exchange: who it is for, and everything put on the wire. */
interface Outbound {
  readonly api: string
  readonly operation: string
  readonly method: RestMethod
  readonly url: string
  readonly headers: RequestHeaders
  readonly body: string | Uint8Array | undefined
  readonly maxBytes: number
}

const urlOf = (baseUrl: string, path: string, query: Query): string => {
  const serialized = serializeQuery(query)

  return baseUrl + path + (serialized.length === 0 ? "" : "?" + serialized)
}

/** Interrupting the calling fiber aborts the fetch and any body read still in flight. */
const send = (config: Config, outbound: Outbound): Effect.Effect<Received, RestUnavailable> =>
  Effect.suspend(() => {
    const timeout = AbortSignal.timeout(config.requestTimeoutMs)

    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(outbound.url, {
          method: outbound.method,
          headers: outbound.headers,
          body: outbound.body,
          redirect: "manual",
          signal: AbortSignal.any([signal, timeout]),
        })

        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          bytes: await readCapped(response, outbound.maxBytes),
        }
      },
      catch: () =>
        new RestUnavailable({
          message: timeout.aborted
            ? outbound.operation +
              " timed out after " +
              String(config.requestTimeoutMs) +
              " ms waiting for the " +
              outbound.api
            : outbound.operation + " could not reach the " + outbound.api,
        }),
    }).pipe(
      Effect.flatMap((read) =>
        read.bytes === undefined
          ? Effect.fail(
              new RestUnavailable({
                message:
                  outbound.operation +
                  " returned more than " +
                  String(outbound.maxBytes) +
                  " bytes (HTTP " +
                  String(read.status) +
                  ")",
                status: read.status,
              }),
            )
          : Effect.succeed({
              status: read.status,
              contentType: read.contentType,
              bytes: read.bytes,
            }),
      ),
    )
  })

const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const isSuccess = (status: number): boolean => status >= 200 && status < 300

const withDetail = (message: string, detail: string | undefined): string =>
  detail === undefined ? message : message + ": " + detail

/** The failure for a non-2xx status; `detail` is already scrubbed. */
const statusFailure = (
  operation: string,
  status: number,
  detail: string | undefined,
): RestRejected | RestUnavailable => {
  const label = " (HTTP " + String(status) + ")"

  if (status >= 300 && status < 400) {
    return new RestUnavailable({
      message: operation + " was redirected" + label + "; redirect refused",
      status,
    })
  }

  if (status >= 400 && status < 500) {
    return new RestRejected({
      message: withDetail(operation + " was rejected" + label, detail),
      status,
      detail,
    })
  }

  return new RestUnavailable({
    message: withDetail(operation + " failed upstream" + label, detail),
    status,
    detail,
  })
}

/** Whether the bytes contain any protected value in its UTF-8 form. */
const containsProtected = (bytes: Uint8Array, secrets: ReadonlyArray<string>): boolean => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  return secrets.some((secret) => buffer.includes(secret, 0, "utf8"))
}

const protectedBytes = (operation: string): RestUnavailable =>
  new RestUnavailable({
    message: operation + " returned binary content containing a protected value; refused",
  })

const decodeSuccess = (
  request: RestRequest,
  received: Received,
  secrets: ReadonlyArray<string>,
): Effect.Effect<RestResult, RestUnavailable> => {
  if (request.response === "empty" || received.status === 204 || received.bytes.byteLength === 0) {
    return Effect.succeed(undefined)
  }

  if (request.response === "json-or-binary" && !isJsonContentType(received.contentType)) {
    if (containsProtected(received.bytes, secrets)) {
      return Effect.fail(protectedBytes(request.operation))
    }

    return Effect.succeed(
      binaryEnvelope(
        received.bytes,
        scrubSecrets(received.contentType ?? "application/octet-stream", secrets),
      ),
    )
  }

  const json = decodeJsonText(textOf(received.bytes))

  if (json === undefined) {
    return Effect.fail(
      new RestUnavailable({
        message:
          request.operation +
          " returned a malformed response (HTTP " +
          String(received.status) +
          ")",
        status: received.status,
      }),
    )
  }

  return Effect.succeed(redact(json, secrets))
}

/** Maps one received response onto the error contract or a JSON result. */
const classify = (
  request: RestRequest,
  received: Received,
  secrets: ReadonlyArray<string>,
): Effect.Effect<RestResult, RestError> => {
  if (isSuccess(received.status)) return decodeSuccess(request, received, secrets)

  const text = textOf(received.bytes)

  // A key minted in a failed response is as secret as one in a success.
  return Effect.fail(
    statusFailure(
      request.operation,
      received.status,
      errorDetail(text, protectedValues(decodeJsonText(text), secrets)),
    ),
  )
}

/** Every value that must never reach a client, minus empties that would match everything. */
const secretsFor = (
  config: Config,
  layerSecrets: ReadonlyArray<string>,
  callSecrets: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  [
    config.factoryApiKey ?? "",
    ...layerSecrets,
    ...Object.values(config.factoryContextHeaders),
    ...callSecrets,
  ].filter((secret) => secret.length > 0)

/** The conflict-resolution fields a `ContextApiError` carries, in message order. */
const CONTEXT_ERROR_FIELDS = [
  "code",
  "requestId",
  "expectedVersion",
  "currentVersion",
  "currentSequence",
] as const

/** The SDK's own message when the error body had no `detail`; it adds nothing to the status. */
const GENERIC_CONTEXT_DETAIL = /^Factory context API error \(status \d+\)$/

const contextDetail = (
  error: ContextApiError,
  secrets: ReadonlyArray<string>,
): string | undefined => {
  const detail = GENERIC_CONTEXT_DETAIL.test(error.message)
    ? undefined
    : safeDetail(error.message, secrets)

  const fields: Array<string> = []

  for (const field of CONTEXT_ERROR_FIELDS) {
    const value = error[field]

    if (value !== undefined && value.length > 0) {
      fields.push(field + ": " + safeDetail(value, secrets))
    }
  }

  if (fields.length === 0) return detail

  const listed = "(" + fields.join(", ") + ")"

  return detail === undefined || detail.length === 0 ? listed : detail + " " + listed
}

/** Upstream statuses keep the Context API's detail and conflict fields, read as the SDK reads them. */
const contextStatusFailure = (
  operation: string,
  received: Received,
  secrets: ReadonlyArray<string>,
): RestRejected | RestUnavailable => {
  const status = received.status

  if (status >= 300 && status < 400) return statusFailure(operation, status, undefined)

  const json = decodeJsonText(textOf(received.bytes))

  return statusFailure(
    operation,
    status,
    contextDetail(new ContextApiError(status, json), protectedValues(json, secrets)),
  )
}

const unexpectedContext = (operation: string): RestUnavailable =>
  new RestUnavailable({
    message: operation + " got an unexpected response from the Context API",
  })

const contextSuccess = (
  request: ContextRequest,
  received: Received,
  secrets: ReadonlyArray<string>,
): Effect.Effect<RestResult, RestUnavailable> => {
  if (request.response === "empty") return Effect.succeed(undefined)

  const json = decodeJsonText(textOf(received.bytes))
  const parsed = json === undefined || request.parse === undefined ? json : request.parse(json)

  if (parsed === undefined) return Effect.fail(unexpectedContext(request.operation))

  if (request.response === "json") return Effect.succeed(redact(parsed, secrets))

  const page = redactRecords(parsed, secrets)

  return page === undefined
    ? Effect.fail(unexpectedContext(request.operation))
    : Effect.succeed(page)
}

const contextHeaders = (
  config: Config,
  apiKey: string,
  accept: string,
  body: JsonValue | Uint8Array | undefined,
): RequestHeaders => {
  const headers: RequestHeaders = {
    ...config.factoryContextHeaders,
    authorization: "Bearer " + apiKey,
    accept,
  }

  if (body instanceof Uint8Array) {
    headers["content-type"] = "application/octet-stream"
  } else if (body !== undefined) {
    headers["content-type"] = "application/json"
  }

  return headers
}

const encodeBody = (body: JsonValue | Uint8Array | undefined): string | Uint8Array | undefined =>
  body === undefined || body instanceof Uint8Array ? body : JSON.stringify(body)

const missingFactoryKey = (): FactoryApiKeyMissing =>
  new FactoryApiKeyMissing({ message: "FACTORY_API_KEY is not set; Factory API tools need it" })

interface ContextOrigin {
  readonly apiKey: string
  readonly baseUrl: string
}

const contextOrigin = (
  config: Config,
): Effect.Effect<ContextOrigin, FactoryApiKeyMissing | ContextBaseUrlMissing> => {
  const apiKey = config.factoryApiKey

  if (apiKey === undefined || apiKey.length === 0) return Effect.fail(missingFactoryKey())

  const baseUrl = config.factoryContextBaseUrl

  if (baseUrl === undefined) {
    return Effect.fail(
      new ContextBaseUrlMissing({
        message:
          "FACTORY_CONTEXT_BASE_URL is not set; Context tools need the Prem origin that " +
          "serves /api/context",
      }),
    )
  }

  return Effect.succeed({ apiKey, baseUrl })
}

/** `secrets` are server-wide values to scrub, such as the MCP bearer keys. */
export const restLayer = (
  config: Config,
  secrets: ReadonlyArray<string> = [],
): Layer.Layer<RestService> => {
  const contextScrub = secretsFor(config, secrets, [])

  return Layer.succeed(RestService, {
    request: (request) => {
      const apiKey = config.factoryApiKey

      if (apiKey === undefined || apiKey.length === 0) return Effect.fail(missingFactoryKey())

      const scrub = secretsFor(config, secrets, request.secrets)

      const headers: RequestHeaders = {
        authorization: "Bearer " + apiKey,
        accept: request.response === "json-or-binary" ? BINARY_ACCEPT : "application/json",
      }

      if (request.body !== undefined) headers["content-type"] = "application/json"

      return send(config, {
        api: FACTORY_API,
        operation: request.operation,
        method: request.method,
        url: urlOf(config.factoryBaseUrl, request.path, request.query),
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        maxBytes: RESPONSE_MAX_BYTES,
      }).pipe(Effect.flatMap((received) => classify(request, received, scrub)))
    },
    context: (request) =>
      contextOrigin(config).pipe(
        Effect.flatMap(({ apiKey, baseUrl }) =>
          send(config, {
            api: CONTEXT_API,
            operation: request.operation,
            method: request.method,
            url: urlOf(baseUrl, request.path, request.query),
            headers: contextHeaders(config, apiKey, "application/json", request.body),
            body: encodeBody(request.body),
            maxBytes: RESPONSE_MAX_BYTES,
          }),
        ),
        Effect.flatMap((received) =>
          isSuccess(received.status)
            ? contextSuccess(request, received, contextScrub)
            : Effect.fail(contextStatusFailure(request.operation, received, contextScrub)),
        ),
      ),
    contextBytes: (request) =>
      contextOrigin(config).pipe(
        Effect.flatMap(({ apiKey, baseUrl }) =>
          send(config, {
            api: CONTEXT_API,
            operation: request.operation,
            method: "GET",
            url: baseUrl + request.path,
            headers: contextHeaders(config, apiKey, "application/octet-stream", undefined),
            body: undefined,
            maxBytes: request.maxBytes,
          }),
        ),
        Effect.flatMap((received) => {
          if (!isSuccess(received.status)) {
            return Effect.fail(contextStatusFailure(request.operation, received, contextScrub))
          }

          return containsProtected(received.bytes, contextScrub)
            ? Effect.fail(protectedBytes(request.operation))
            : Effect.succeed(received.bytes)
        }),
      ),
  })
}
