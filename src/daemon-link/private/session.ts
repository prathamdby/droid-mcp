/**
 * Connection lifecycle and JSON-RPC correlation, module-internal to
 * `daemon-link`. One `LinkConnection` owns a websocket to the daemon, a
 * pending-request table keyed by correlation id, and the close handling
 * that settles every waiter. Handoff discipline lives here: a caller learns
 * whether the request bytes reached the peer transport (`handedOff`), and
 * failures after that point are never resent inside this module.
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { DaemonEndpoint } from "./host.ts"
import { connect } from "./ws.ts"
import type { WsConnection } from "./ws.ts"

export const JSONRPC_VERSION = "2.0"
export const LEGACY_FACTORY_API_VERSION = "1.0.0"

export type ConnectErrorKind =
  | "dial_failed"
  | "spawn_failed"
  | "auth_rejected"
  | "incompatible_version"
  | "handshake_failed"

export interface ConnectError {
  readonly kind: ConnectErrorKind
  readonly message: string
  readonly peerVersion?: string
}

export type Outcome =
  | { readonly kind: "result"; readonly result: Schema.Json }
  | {
      readonly kind: "peer_error"
      readonly code: number
      readonly message: string
      readonly data?: Schema.Json
    }
  | { readonly kind: "not_delivered"; readonly detail: string }
  | { readonly kind: "possibly_delivered"; readonly detail: string }
  | { readonly kind: "bad_reply"; readonly detail: string }

export interface ExchangeResult {
  readonly outcome: Outcome
  readonly handedOff: boolean
}

export interface LinkConnection {
  /**
   * Sends one encoded params payload under a fresh correlation id and waits
   * for the matching response. `handedOff` in the result records whether the
   * frame reached the peer transport; it never implies the request executed.
   */
  readonly exchange: (
    method: string,
    params: Schema.Json,
    protocolVersion: string,
    timeoutMs: number,
  ) => Effect.Effect<ExchangeResult>
  readonly closed: Effect.Effect<void>
  readonly isClosed: () => boolean
  readonly close: Effect.Effect<void>
}

export interface AuthOptions {
  readonly apiKey?: string
  readonly caller?: string
  readonly metadata?: Schema.Json
}

const ResponseEnvelopeSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  factoryProtocolVersion: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(Schema.Json),
    }),
  ),
})

const MismatchDataSchema = Schema.Struct({
  protocolVersionMismatch: Schema.Struct({
    localFactoryProtocolVersion: Schema.String,
    peerFactoryProtocolVersion: Schema.optional(Schema.String),
  }),
})

export interface ProtocolMismatch {
  readonly local: string
  readonly peer: string | undefined
}

/** The documented version-mismatch payload, present on `-32601` and `-32001`. */
export const protocolMismatchOf = (
  code: number,
  data: Schema.Json | undefined,
): ProtocolMismatch | undefined => {
  if (code !== -32601 && code !== -32001) return undefined

  if (data === undefined) return undefined

  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(MismatchDataSchema)(data))

  if (decoded === undefined) return undefined

  return {
    local: decoded.protocolVersionMismatch.localFactoryProtocolVersion,
    peer: decoded.protocolVersionMismatch.peerFactoryProtocolVersion,
  }
}

const parseFrame = (text: string) => {
  let parsed: Schema.Json

  try {
    // SAFETY: `JSON.parse` of a wire frame produces exactly the JSON value
    // domain — null, booleans, numbers, strings, arrays and plain objects;
    // anything outside that fails the envelope decode below.
    parsed = JSON.parse(text) as Schema.Json
  } catch {
    return undefined
  }

  return Option.getOrUndefined(Schema.decodeUnknownOption(ResponseEnvelopeSchema)(parsed))
}

let nextConnectionSequence = 0

/**
 * Wires correlation onto one open websocket. Notifications and server
 * requests from the peer are dropped here: `daemon-link` owns request/reply
 * exchange only, and notices belong to higher modules. An unparsable or
 * unknown-id frame is dropped, which leaves its waiter to the timeout/close
 * race in `exchange`.
 */
const wireConnection = (ws: WsConnection): LinkConnection => {
  nextConnectionSequence += 1
  const prefix = "link-" + String(nextConnectionSequence) + "-"
  const waiters = new Map<string, Deferred.Deferred<string, never>>()
  let nextId = 0
  let closed = false

  ws.onText((text) => {
    const frame = parseFrame(text)

    if (frame === undefined) return

    if (frame.id === undefined || frame.id === null) return
    const id = String(frame.id)
    const deferred = waiters.get(id)

    if (deferred === undefined) return

    waiters.delete(id)
    Deferred.doneUnsafe(deferred, Effect.succeed(text))
  })

  Effect.runFork(
    Effect.map(ws.closed, () => {
      closed = true
      waiters.clear()
    }),
  )

  const exchange: LinkConnection["exchange"] = (method, params, protocolVersion, timeoutMs) =>
    Effect.suspend(() => {
      if (closed || ws.isClosed()) {
        return Effect.succeed({
          outcome: { kind: "not_delivered", detail: "connection is closed" },
          handedOff: false,
        } satisfies ExchangeResult)
      }

      nextId += 1
      const id = prefix + String(nextId)
      const deferred = Deferred.makeUnsafe<string, never>()
      waiters.set(id, deferred)

      const envelope = {
        jsonrpc: JSONRPC_VERSION,
        factoryApiVersion: LEGACY_FACTORY_API_VERSION,
        factoryProtocolVersion: protocolVersion,
        type: "request",
        id,
        method,
        params,
      }

      return Effect.gen(function* () {
        const written = yield* Effect.exit(ws.sendText(JSON.stringify(envelope)))

        if (Exit.isFailure(written)) {
          waiters.delete(id)

          return {
            outcome: { kind: "not_delivered", detail: "write failed" },
            handedOff: false,
          } satisfies ExchangeResult
        }

        const handedOff = true

        type Race =
          | { readonly tag: "replied"; readonly text: string }
          | { readonly tag: "closed" }
          | { readonly tag: "timeout" }

        const replied: Effect.Effect<Race> = Effect.map(Deferred.await(deferred), (text): Race => ({
          tag: "replied",
          text,
        }))

        const connClosed: Effect.Effect<Race> = Effect.as(ws.closed, {
          tag: "closed",
        } satisfies Race)

        const timedOut: Effect.Effect<Race> = Effect.as(Effect.sleep(timeoutMs), {
          tag: "timeout",
        } satisfies Race)

        const race: Effect.Effect<Race> = Effect.raceFirst(
          replied,
          Effect.raceFirst(connClosed, timedOut),
        ).pipe(
          // The waiter id must never survive its exchange: a late reply after
          // timeout, close or interruption is unowned and dropped, so nothing
          // can be mis-correlated onto a reused id.
          Effect.ensuring(Effect.sync(() => waiters.delete(id))),
        )

        const result = yield* race

        if (result.tag === "replied") {
          return {
            outcome: outcomeOf(result.text),
            handedOff,
          } satisfies ExchangeResult
        }

        return {
          outcome: {
            kind: "possibly_delivered",
            detail:
              result.tag === "timeout"
                ? "request timed out after handoff"
                : "connection closed after handoff",
          },
          handedOff,
        } satisfies ExchangeResult
      })
    })

  return {
    exchange,
    closed: Effect.asVoid(ws.closed),
    isClosed: () => closed || ws.isClosed(),
    close: ws.close,
  }
}

/**
 * Classifies one settled reply. Anything unframed is a `bad_reply`: it
 * arrived after handoff and never proves the request did not execute.
 * A framed result is carried as its decoded JSON value so the caller can
 * apply the reviewed reply codec without re-parsing wire text.
 */
const outcomeOf = (text: string): Outcome => {
  const frame = parseFrame(text)

  if (frame === undefined) {
    return { kind: "bad_reply", detail: "reply is not a response envelope" }
  }

  if (frame.error !== undefined) {
    return {
      kind: "peer_error",
      code: frame.error.code,
      message: frame.error.message,
      data: frame.error.data,
    }
  }

  if (frame.result === undefined) {
    return { kind: "bad_reply", detail: "reply carries neither result nor error" }
  }

  return { kind: "result", result: frame.result }
}

/**
 * Opens one websocket to `endpoint` and wires correlation.
 */
export const openConnection = (
  endpoint: DaemonEndpoint,
  handshakeTimeoutMs: number,
): Effect.Effect<LinkConnection, ConnectError> =>
  connect({
    socketPath: endpoint.socketPath,
    host: endpoint.host,
    port: endpoint.port,
    handshakeTimeoutMs,
  }).pipe(
    Effect.map(wireConnection),
    Effect.mapError((error): ConnectError => ({ kind: "dial_failed", message: error.message })),
  )

const authErrorOf = (code: number, message: string): ConnectError => {
  if (code === -32001) {
    return { kind: "auth_rejected", message: "daemon rejected the credentials" }
  }

  return { kind: "handshake_failed", message: "authentication was rejected: " + message }
}

const incompleteAuth = (detail: string): ConnectError => ({
  kind: "handshake_failed",
  message: "authentication did not complete: " + detail,
})

/**
 * Authenticates one open connection. Auth is itself an exchange, so the
 * handshake outcome reuses the same correlation path. A documented version
 * mismatch is not execution: the auth request is resent exactly once with
 * the adopted version, and never a third time. Every other failure is
 * reported with its exact delivery certainty and never retried.
 */
export const authenticateConnection = (
  connection: LinkConnection,
  auth: AuthOptions,
  protocolVersion: string,
  timeoutMs: number,
): Effect.Effect<{ readonly protocolVersion: string }, ConnectError> =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, Schema.Json]> = [["caller", auth.caller ?? "sdk"]]

    if (auth.apiKey !== undefined) entries.push(["apiKey", auth.apiKey])

    if (auth.metadata !== undefined) entries.push(["metadata", auth.metadata])

    const params: Schema.Json = Object.fromEntries(entries)

    const attempt = (version: string) =>
      connection.exchange("daemon.authenticate", params, version, timeoutMs)

    const first = yield* attempt(protocolVersion)

    if (first.outcome.kind === "result") {
      return { protocolVersion }
    }

    if (first.outcome.kind === "not_delivered") {
      return yield* Effect.fail(incompleteAuth(first.outcome.detail))
    }

    if (first.outcome.kind === "possibly_delivered") {
      return yield* Effect.fail(incompleteAuth(first.outcome.detail))
    }

    if (first.outcome.kind === "bad_reply") {
      return yield* Effect.fail({
        kind: "handshake_failed",
        message: "authentication reply was malformed: " + first.outcome.detail,
      } satisfies ConnectError)
    }

    const mismatch = protocolMismatchOf(first.outcome.code, first.outcome.data)

    if (mismatch === undefined) {
      return yield* Effect.fail(authErrorOf(first.outcome.code, first.outcome.message))
    }

    const second = yield* attempt(mismatch.local)

    if (second.outcome.kind === "result") {
      return { protocolVersion: mismatch.local }
    }

    if (second.outcome.kind === "peer_error") {
      const secondMismatch = protocolMismatchOf(second.outcome.code, second.outcome.data)

      if (secondMismatch !== undefined) {
        return yield* Effect.fail({
          kind: "incompatible_version",
          message: "daemon rejected the adopted protocol version",
          peerVersion: secondMismatch.local,
        } satisfies ConnectError)
      }

      return yield* Effect.fail(authErrorOf(second.outcome.code, second.outcome.message))
    }

    if (second.outcome.kind === "bad_reply") {
      return yield* Effect.fail({
        kind: "handshake_failed",
        message: "authentication reply was malformed: " + second.outcome.detail,
      } satisfies ConnectError)
    }

    return yield* Effect.fail(incompleteAuth(second.outcome.detail))
  })
