import { ContextApiError } from "@factory/droid-sdk"
import type { ContextApiOptions } from "@factory/droid-sdk"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import { ContextBaseUrlMissing, FactoryApiKeyMissing } from "./errors.ts"
import type { JsonValue } from "./protocol.ts"
import { redact } from "./redact.ts"
import {
  binaryEnvelope,
  decodeJsonText,
  errorDetail,
  isJsonContentType,
  safeDetail,
  serializeQuery,
} from "./rest-http.ts"

export type { ContextApiOptions }

/**
 * The hosted Factory API is HTTPS with a bearer key and JSON bodies. Every
 * `rest_*` tool goes through `request`, which owns credentials, timeouts,
 * redirect refusal, status mapping, and redaction. Tool modules never fetch.
 *
 * Context lives on a separately configured Prem origin and is reached through
 * the SDK's Context helpers; `context` supplies their options and maps their
 * errors onto the same contract.
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

export interface RestRequest {
  /** The upstream operation id, used in messages (e.g. `getComputer`). */
  readonly operation: string
  readonly method: RestMethod
  /** Already segment-encoded; starts with `/api/v0/`. */
  readonly path: string
  /** Repeated keys allowed. */
  readonly query: ReadonlyArray<readonly [string, string]>
  readonly body: JsonValue | undefined
  readonly response: RestResponse
  /** Per-call values to scrub from results and errors. */
  readonly secrets: ReadonlyArray<string>
}

export type RestResult = JsonValue | undefined

export interface RestApi {
  readonly request: (request: RestRequest) => Effect.Effect<RestResult, RestError>
  /**
   * Runs one SDK Context helper against `FACTORY_CONTEXT_BASE_URL`. The value
   * it resolves with is normalized to JSON and redacted; `undefined` stands
   * for an empty success. Helpers that return bytes must encode them first.
   */
  readonly context: <A>(
    operation: string,
    run: (options: ContextApiOptions) => Promise<A>,
  ) => Effect.Effect<RestResult, RestError>
}

export class RestService extends Context.Service<RestService, RestApi>()("droid-mcp/RestService") {}

interface Received {
  readonly status: number
  readonly contentType: string | null
  readonly bytes: Uint8Array
}

const BINARY_ACCEPT = "application/json, application/octet-stream;q=0.9, */*;q=0.8"

interface RequestHeaders {
  [name: string]: string
}

const headersFor = (apiKey: string, request: RestRequest): RequestHeaders => {
  const headers: RequestHeaders = {
    authorization: "Bearer " + apiKey,
    accept: request.response === "json-or-binary" ? BINARY_ACCEPT : "application/json",
  }

  if (request.body !== undefined) headers["content-type"] = "application/json"

  return headers
}

const urlFor = (baseUrl: string, request: RestRequest): string => {
  const query = serializeQuery(request.query)

  return baseUrl + request.path + (query.length === 0 ? "" : "?" + query)
}

const send = (
  config: Config,
  apiKey: string,
  request: RestRequest,
): Effect.Effect<Received, RestUnavailable> =>
  Effect.suspend(() => {
    const timeout = AbortSignal.timeout(config.requestTimeoutMs)

    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(urlFor(config.factoryBaseUrl, request), {
          method: request.method,
          headers: headersFor(apiKey, request),
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: "manual",
          signal: AbortSignal.any([signal, timeout]),
        })

        const bytes = new Uint8Array(await response.arrayBuffer())

        return { status: response.status, contentType: response.headers.get("content-type"), bytes }
      },
      catch: () =>
        new RestUnavailable({
          message: timeout.aborted
            ? request.operation +
              " timed out after " +
              String(config.requestTimeoutMs) +
              " ms waiting for the Factory API"
            : request.operation + " could not reach the Factory API",
        }),
    })
  })

const withDetail = (message: string, detail: string | undefined): string =>
  detail === undefined ? message : message + ": " + detail

const decodeSuccess = (
  request: RestRequest,
  received: Received,
  secrets: ReadonlyArray<string>,
): Effect.Effect<RestResult, RestUnavailable> => {
  if (request.response === "empty" || received.status === 204 || received.bytes.byteLength === 0) {
    return Effect.succeed(undefined)
  }

  if (request.response === "json-or-binary" && !isJsonContentType(received.contentType)) {
    return Effect.succeed(
      binaryEnvelope(received.bytes, received.contentType ?? "application/octet-stream"),
    )
  }

  const json = decodeJsonText(new TextDecoder().decode(received.bytes))

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
  const status = received.status
  const label = " (HTTP " + String(status) + ")"

  if (status >= 200 && status < 300) return decodeSuccess(request, received, secrets)

  if (status >= 300 && status < 400) {
    return Effect.fail(
      new RestUnavailable({
        message: request.operation + " was redirected" + label + "; redirect refused",
        status,
      }),
    )
  }

  const detail = errorDetail(new TextDecoder().decode(received.bytes), secrets)

  if (status >= 400 && status < 500) {
    return Effect.fail(
      new RestRejected({
        message: withDetail(request.operation + " was rejected" + label, detail),
        status,
        detail,
      }),
    )
  }

  return Effect.fail(
    new RestUnavailable({
      message: withDetail(request.operation + " failed upstream" + label, detail),
      status,
      detail,
    }),
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

/**
 * Upstream statuses keep the API's detail and conflict fields. Every other
 * failure gets a fixed message: SDK transport errors embed the underlying
 * cause, which may name hosts or echo response text.
 */
const contextFailure = (
  config: Config,
  operation: string,
  cause: unknown,
  secrets: ReadonlyArray<string>,
): RestRejected | RestUnavailable => {
  if (cause instanceof ContextApiError) {
    const status = cause.status
    const label = " (HTTP " + String(status) + ")"
    const detail = contextDetail(cause, secrets)

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

  const name = cause instanceof Error ? cause.name : ""

  if (name === "TimeoutError") {
    return new RestUnavailable({
      message:
        operation +
        " timed out after " +
        String(config.requestTimeoutMs) +
        " ms waiting for the Context API",
    })
  }

  if (name === "ConnectionError") {
    return new RestUnavailable({ message: operation + " could not reach the Context API" })
  }

  return new RestUnavailable({
    message: operation + " got an unexpected response from the Context API",
  })
}

/** A JSON round trip drops `undefined` members, which `Schema.Json` would reject. */
const contextJson = <A>(
  operation: string,
  value: A,
  secrets: ReadonlyArray<string>,
): Effect.Effect<RestResult, RestUnavailable> => {
  if (value === undefined) return Effect.succeed(undefined)

  const text = JSON.stringify(value)
  const json = text === undefined ? undefined : decodeJsonText(text)

  if (json === undefined) {
    return Effect.fail(
      new RestUnavailable({
        message: operation + " got an unexpected response from the Context API",
      }),
    )
  }

  return Effect.succeed(redact(json, secrets))
}

const missingFactoryKey = (): FactoryApiKeyMissing =>
  new FactoryApiKeyMissing({ message: "FACTORY_API_KEY is not set; Factory API tools need it" })

/** `secrets` are server-wide values to scrub, such as the MCP bearer keys. */
export const restLayer = (
  config: Config,
  secrets: ReadonlyArray<string> = [],
): Layer.Layer<RestService> =>
  Layer.succeed(RestService, {
    request: (request) => {
      const apiKey = config.factoryApiKey

      if (apiKey === undefined || apiKey.length === 0) return Effect.fail(missingFactoryKey())

      const scrub = secretsFor(config, secrets, request.secrets)

      return send(config, apiKey, request).pipe(
        Effect.flatMap((received) => classify(request, received, scrub)),
      )
    },
    context: (operation, run) => {
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

      const scrub = secretsFor(config, secrets, [])

      return Effect.tryPromise({
        try: () =>
          run({
            apiKey,
            baseUrl,
            headers: { ...config.factoryContextHeaders },
            timeoutMs: config.requestTimeoutMs,
          }),
        catch: (cause) => contextFailure(config, operation, cause, scrub),
      }).pipe(Effect.flatMap((value) => contextJson(operation, value, scrub)))
    },
  })
