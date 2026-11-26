/**
 * The definition-building kit every hosted domain shares: input decoding
 * with Unicode and nested-id preflight, one round trip through the private
 * transport, the status-to-failure vocabulary, and the absent/empty/null
 * result distinction. Each domain file keeps its operations' own paths,
 * query names and body shapes; nothing here is a route template table.
 */
import { Buffer } from "node:buffer"

import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { EffectKind } from "../../authority/index.ts"
import type { TargetRef } from "../../caller/index.ts"
import {
  DeliveryUncertain,
  InvalidInput,
  MalformedPeerReply,
  OperationDenied,
  PeerFailure,
  TargetUnavailable,
} from "../../capabilities/index.ts"
import type {
  BoundOperation,
  CapabilitiesApi,
  Definition,
  JsonSchemaObject,
  OperationAnnotations,
  OperationFacts,
  OperationFailure,
  ReplayPolicy,
} from "../../capabilities/index.ts"
import { ReleasePayload } from "../../disclosure/index.ts"
import {
  decodeReplyJson,
  defaultFetch,
  errorDetailOf,
  buildTransport,
  RESPONSE_MAX_BYTES,
  scrubText,
} from "./http.ts"
import type { FetchLike, HostedHttpRequest, HostedTransport, SendFailure } from "./http.ts"
import { isJsonObject, JsonBody, unicodeProblem } from "./wire.ts"

// ---------------------------------------------------------------------------
// Installation view the operations close over
// ---------------------------------------------------------------------------

export interface OperationContext {
  readonly origin: string
  readonly timeoutMs: number
  readonly headers?: Readonly<Record<string, string>>
  readonly credential?: () => Effect.Effect<string | undefined>
  readonly fetch?: FetchLike
  /**
   * Static values disclosure must never publish. The per-request credential
   * is classified separately at perform time so even a credential minted
   * later is scrubbed.
   */
  readonly sensitiveValues: ReadonlyArray<string>
  readonly prerequisite?: { readonly edition: "droid-v1" }
}

type Failure = OperationFailure

export const hostedTransport = (ctx: OperationContext): HostedTransport =>
  buildTransport(ctx.origin, {
    fetch: ctx.fetch ?? defaultFetch,
    timeoutMs: ctx.timeoutMs,
    headers: ctx.headers,
    credential: ctx.credential,
    sensitiveValues: ctx.sensitiveValues,
  })

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const badReply = (operation: string, why: string): MalformedPeerReply =>
  new MalformedPeerReply({
    message: operation + " returned a malformed hosted API reply: " + why,
  })

/** Maps the transport failure vocabulary onto operation failures. */
const sendFailure = (operation: string, failure: SendFailure): Failure => {
  if (failure.kind === "oversized") {
    return new TargetUnavailable({
      message: operation + " returned more bytes than the response bound allows",
    })
  }

  if (failure.kind === "uncertain") {
    return new DeliveryUncertain({
      message:
        operation +
        (failure.timedOut
          ? " did not complete within the configured timeout; the request may have reached the hosted API"
          : " could not finish the exchange; the request may have reached the hosted API"),
    })
  }

  return new DeliveryUncertain({
    message: operation + " could not reach the hosted origin",
  })
}

/** Maps a non-2xx status onto the operation failure vocabulary. */
const statusFailure = (
  operation: string,
  status: number,
  bytes: Uint8Array,
  secrets: ReadonlyArray<string>,
): Failure => {
  const json = decodeReplyJson(bytes)
  const rawDetail = errorDetailOf(json)
  const detail = rawDetail === undefined ? undefined : scrubText(rawDetail, secrets, "[REDACTED]")
  const suffix = detail === undefined ? "" : ": " + detail

  if (status === 401 || status === 403) {
    return new OperationDenied({
      message: operation + " was denied by the hosted API (HTTP " + String(status) + ")" + suffix,
      reason: "http_" + String(status),
    })
  }

  if (status === 404) {
    return new TargetUnavailable({
      message: operation + " names a target the hosted API does not have (HTTP 404)" + suffix,
    })
  }

  if (status >= 300 && status < 400) {
    return new DeliveryUncertain({
      message:
        operation +
        " was redirected (HTTP " +
        String(status) +
        "); the hosted transport never follows redirects",
    })
  }

  if (status >= 400 && status < 500) {
    return new PeerFailure({
      code: "peer_rejected",
      message: operation + " was rejected by the hosted API (HTTP " + String(status) + ")" + suffix,
    })
  }

  return new TargetUnavailable({
    message:
      operation + " failed upstream in the hosted API (HTTP " + String(status) + ")" + suffix,
  })
}

// ---------------------------------------------------------------------------
// Result vocabulary: absent, empty and null stay distinct
// ---------------------------------------------------------------------------

/**
 * The typed output of one hosted exchange. `"empty"` means the peer sent no
 * body (or the operation declared an empty response): it releases as the
 * `Empty` payload, never as JSON `null`. A literal JSON `null` body is the
 * `"null"` variant and releases as JSON `null`.
 */
export type HostedOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "null" }
  | { readonly kind: "json"; readonly value: Schema.Json }
  | { readonly kind: "binary"; readonly envelope: JsonBinaryEnvelope }

export interface JsonBinaryEnvelope {
  readonly encoding: "base64"
  readonly contentType: string
  readonly sizeBytes: number
  readonly data: string
}

const EMPTY: HostedOutcome = { kind: "empty" }
const NULL: HostedOutcome = { kind: "null" }

interface ExchangeReceived {
  readonly status: number
  readonly bytes: Uint8Array
  readonly contentType: string | null
}

/** One round trip, mapping transport and status onto the typed failure vocabulary. */
export const exchange = (
  transport: HostedTransport,
  operation: string,
  request: Omit<HostedHttpRequest, "acceptBinary"> & { readonly acceptBinary?: boolean },
): Effect.Effect<ExchangeReceived, Failure> =>
  transport.secretValues().pipe(
    Effect.flatMap((secrets) =>
      transport.send(request, RESPONSE_MAX_BYTES).pipe(
        Effect.mapError((failure) => sendFailure(operation, failure)),
        Effect.flatMap((received) =>
          received.status >= 200 && received.status < 300
            ? Effect.succeed(received)
            : Effect.fail(statusFailure(operation, received.status, received.bytes, secrets)),
        ),
      ),
    ),
  )

/**
 * Reads one successful JSON exchange into the result vocabulary. A `204` or
 * a zero-length body is `"empty"`; any other body must be valid JSON, with a
 * literal `null` kept distinct as the `"null"` variant.
 */
export const jsonOutcome = (
  transport: HostedTransport,
  operation: string,
  request: Omit<HostedHttpRequest, "acceptBinary">,
  options?: { readonly emptyResponse?: boolean },
): Effect.Effect<HostedOutcome, Failure> =>
  Effect.flatMap(
    exchange(transport, operation, request),
    (received): Effect.Effect<HostedOutcome, MalformedPeerReply> => {
      if (
        options?.emptyResponse === true ||
        received.status === 204 ||
        received.bytes.byteLength === 0
      ) {
        return Effect.succeed(EMPTY)
      }

      const json = decodeReplyJson(received.bytes)

      if (json === undefined) {
        return Effect.fail(badReply(operation, "the body is not valid JSON"))
      }

      return Effect.succeed(json === null ? NULL : { kind: "json", value: json })
    },
  )

/** Whether a content type carries a JSON document. */
const isJsonContentType = (contentType: string | null): boolean => {
  if (contentType === null) return false

  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? ""

  return base === "application/json" || base.endsWith("+json")
}

/**
 * Reads one successful `json-or-binary` exchange. JSON content types decode
 * exactly like `jsonOutcome`; anything else is a bounded binary body encoded
 * base64 with its content type, so bytes never pass through JSON redaction.
 */
export const jsonOrBinaryOutcome = (
  transport: HostedTransport,
  operation: string,
  request: Omit<HostedHttpRequest, "acceptBinary">,
): Effect.Effect<HostedOutcome, Failure> =>
  Effect.flatMap(
    exchange(transport, operation, { ...request, acceptBinary: true }),
    (received): Effect.Effect<HostedOutcome, MalformedPeerReply> => {
      if (received.status === 204 || received.bytes.byteLength === 0) {
        return Effect.succeed(EMPTY)
      }

      if (!isJsonContentType(received.contentType)) {
        return Effect.succeed({
          kind: "binary",
          envelope: {
            encoding: "base64",
            contentType: received.contentType ?? "application/octet-stream",
            sizeBytes: received.bytes.byteLength,
            data: Buffer.from(received.bytes).toString("base64"),
          },
        })
      }

      const json = decodeReplyJson(received.bytes)

      if (json === undefined) {
        return Effect.fail(badReply(operation, "the body is not valid JSON"))
      }

      return Effect.succeed(json === null ? NULL : { kind: "json", value: json })
    },
  )

// ---------------------------------------------------------------------------
// Input decoding
// ---------------------------------------------------------------------------

interface PlainFields {
  readonly [name: PropertyKey]: Schema.Top & { readonly DecodingServices: never }
}

/**
 * Combines schema decoding, Unicode well-formedness and cross-field preflight
 * checks. The struct carries its input type, so the decoded value reaches the
 * cross-field check — where nested target ids are rejected — fully typed,
 * and any failure precedes every other gate.
 */
export const checkedDecode =
  <const Fields extends PlainFields>(
    schema: Schema.Struct<Fields>,
    why: string,
    check?: (input: Schema.Struct<Fields>["Type"]) => string | undefined,
  ) =>
  (input: Schema.Json): Effect.Effect<Schema.Struct<Fields>["Type"], InvalidInput> => {
    const problem = unicodeProblem(input)

    if (problem !== undefined) return Effect.fail(new InvalidInput({ message: problem }))

    const decoded = Schema.decodeUnknownOption(schema)(input)

    if (!Option.isSome(decoded)) return Effect.fail(new InvalidInput({ message: why }))

    const typed = decoded.value
    const cross = check === undefined ? undefined : check(typed)

    return cross === undefined
      ? Effect.succeed(typed)
      : Effect.fail(new InvalidInput({ message: cross }))
  }

// ---------------------------------------------------------------------------
// Shared facts
// ---------------------------------------------------------------------------

export const readOnlyAnnotations: OperationAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

export const writeAnnotations: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}

export const idempotentWriteAnnotations: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

export const destructiveAnnotations: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

export const destructiveIdempotentAnnotations: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
}

/** Discovery schema placeholder; the typed codec is authoritative. */
export const schemaOf = (properties: {
  readonly [key: string]: Schema.Json
}): JsonSchemaObject => ({
  type: "object",
  properties,
})

/** Publishes the same input shape used by the operation's decoder. */
export const discoverySchema = (codec: Schema.Constraint): JsonSchemaObject => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(codec)

  return Schema.decodeUnknownSync(JsonBody)(
    Object.keys(definitions).length === 0 ? schema : { ...schema, $defs: definitions },
  )
}

/** A segment already validated as one nested id, encoded for the path. */
export const segment = (value: string): string => encodeURIComponent(value)

// ---------------------------------------------------------------------------
// Definition assembly helper
// ---------------------------------------------------------------------------

export interface OperationParts<I> {
  readonly id: string
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly annotations: OperationAnnotations
  readonly effect: EffectKind
  readonly replay: ReplayPolicy
  readonly decode: (input: Schema.Json) => Effect.Effect<I, InvalidInput>
  readonly target: (input: I) => TargetRef
  readonly perform: (input: I) => Effect.Effect<HostedOutcome, Failure>
  readonly demand?: (input: I) => { readonly effect: EffectKind }
  readonly sensitiveValues?: (input: I) => ReadonlyArray<string>
  /** Adds the minted-key notice to a JSON object reply; used for key minting operations. */
  readonly withKeyNotice?: boolean
}

/**
 * Builds one typed hosted operation definition. The perform step produces
 * the outcome vocabulary, and classification maps it onto release payloads:
 * `"empty"` releases as `Empty`, `"null"` as JSON `null`, binary downloads as
 * a base64 envelope object, and every other reply passes through as the JSON
 * the peer sent.
 */
const scrubFailure = (failure: Failure, secrets: ReadonlyArray<string>): Failure => {
  if (secrets.length === 0) return failure

  const clean = (value: string): string => scrubText(value, secrets, "[REDACTED]")

  const cleanOpt = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : clean(value)

  return Match.value(failure).pipe(
    Match.tag(
      "PeerFailure",
      (err) =>
        new PeerFailure({
          code: err.code,
          message: clean(err.message),
          detail: cleanOpt(err.detail),
        }),
    ),
    Match.tag(
      "OperationDenied",
      (err) => new OperationDenied({ message: clean(err.message), reason: err.reason }),
    ),
    Match.tag(
      "TargetUnavailable",
      (err) => new TargetUnavailable({ message: clean(err.message), code: err.code }),
    ),
    Match.tag(
      "MalformedPeerReply",
      (err) =>
        new MalformedPeerReply({ message: clean(err.message), detail: cleanOpt(err.detail) }),
    ),
    Match.tag(
      "DeliveryUncertain",
      (err) => new DeliveryUncertain({ message: clean(err.message), detail: cleanOpt(err.detail) }),
    ),
    Match.tag(
      "InvalidInput",
      (err) => new InvalidInput({ message: clean(err.message), detail: cleanOpt(err.detail) }),
    ),
    Match.orElse((err) => err),
  )
}

export const hostedOperation = <I>(
  ctx: OperationContext,
  parts: OperationParts<I>,
): Definition<I, HostedOutcome> => {
  const baseFacts: OperationFacts = {
    id: parts.id,
    family: "rest",
    description: parts.description,
    inputSchema: parts.inputSchema,
    effect: parts.effect,
    replay: parts.replay,
    annotations: parts.annotations,
  }

  const facts: OperationFacts =
    ctx.prerequisite === undefined ? baseFacts : { ...baseFacts, prerequisite: ctx.prerequisite }

  return {
    facts,
    decode: parts.decode,
    target: parts.target,
    demand: parts.demand ?? (() => ({ effect: parts.effect })),
    perform: (_grant, input) => {
      const declared = parts.sensitiveValues === undefined ? [] : parts.sensitiveValues(input)

      return parts.perform(input).pipe(Effect.mapError((err) => scrubFailure(err, declared)))
    },
    classify: (input, output) => {
      const declared = parts.sensitiveValues === undefined ? [] : parts.sensitiveValues(input)
      const sensitiveValues = [...ctx.sensitiveValues, ...declared]

      if (output.kind === "empty") {
        return { payload: ReleasePayload.Empty(), sensitiveValues }
      }

      if (output.kind === "null") {
        return { payload: ReleasePayload.JsonValue({ value: null }), sensitiveValues }
      }

      if (output.kind === "binary") {
        const envelope: Schema.Json = {
          encoding: output.envelope.encoding,
          contentType: output.envelope.contentType,
          sizeBytes: output.envelope.sizeBytes,
          data: output.envelope.data,
        }

        return { payload: ReleasePayload.JsonValue({ value: envelope }), sensitiveValues }
      }

      if (parts.withKeyNotice === true && isJsonObject(output.value)) {
        const noticed: Schema.Json = { ...output.value, notice: KEY_NOTICE }

        return { payload: ReleasePayload.JsonValue({ value: noticed }), sensitiveValues }
      }

      return { payload: ReleasePayload.JsonValue({ value: output.value }), sensitiveValues }
    },
  }
}

/** States that disclosure dropped the one-time minted key value. */
export const KEY_NOTICE =
  "The one-time key value was not exposed and cannot be recovered through this operation."

/**
 * A thunk that binds one typed operation against a supplied `Capabilities`.
 * The thunk keeps the input type in scope at the exact point where `bind` is
 * called, so no heterogeneous collection ever widens it.
 */
export type BindOperation = (capabilities: CapabilitiesApi) => BoundOperation

/** The canonical binder combinator every domain file uses. */
export const binderOf =
  <I>(definition: Definition<I, HostedOutcome>): BindOperation =>
  (capabilities) =>
    capabilities.bind(definition)
