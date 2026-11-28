/**
 * The live exec peer session: frame routing, request/response correlation
 * and challenge reply endpoints. Everything here is module-internal.
 *
 * Capture invariant: the transport starts reading lines at spawn, and the
 * consumer drains them before any outbound frame is written, so peer output
 * racing a send reply is already routed when the reply arrives.
 *
 * Challenge settlement: peer-initiated request ids are not trustworthy across
 * reuse. Every inbound challenge is assigned a strictly-increasing internal
 * epoch at arrival, and its reply closure settles that epoch at most once.
 * A reused peer id opens a fresh epoch, so a stale reply can never reach a
 * newer challenge sharing the id.
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type {
  ChallengeEndpoint,
  ChallengeKind,
  DialectApi,
  DialectVersion,
  PeerNotice,
} from "../../factory-dialect/index.ts"
import { createChallengeEndpoint, PeerRejected } from "../../factory-dialect/index.ts"
import type { ExecTransport, PeerExitFact } from "./process.ts"

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

const EnvelopeFrameSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Json),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(Schema.Json),
    }),
  ),
})

export type EnvelopeFrame = typeof EnvelopeFrameSchema.Type

export const decodeFrame = (line: string): EnvelopeFrame | undefined => {
  let parsed: Schema.Json | undefined

  try {
    parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(JSON.parse(line)))
  } catch {
    return undefined
  }

  if (parsed === undefined) return undefined

  return Option.getOrUndefined(Schema.decodeUnknownOption(EnvelopeFrameSchema)(parsed))
}

// ---------------------------------------------------------------------------
// Outbound exchanges
// ---------------------------------------------------------------------------

export type ExchangeOutcome =
  | { readonly kind: "result"; readonly result: Schema.Json }
  | { readonly kind: "rejected"; readonly code: number; readonly message: string }
  | { readonly kind: "lost" }

// ---------------------------------------------------------------------------
// Session core
// ---------------------------------------------------------------------------

export interface SessionCore {
  /** Routes one inbound line. Called in exact arrival order. */
  readonly route: (line: string) => void
  /**
   * Registers a pending exchange for `correlationId`. Registration must
   * happen before the frame is written, so a racing reply is never missed.
   */
  readonly expectReply: (correlationId: string) => Effect.Effect<ExchangeOutcome, never>
  /** Drops a pending exchange; returns whether it was still registered. */
  readonly unexpect: (correlationId: string) => boolean
  /** Marks every pending exchange lost because the peer is gone. */
  readonly failPending: () => void
  /** The observed exit fact. */
  readonly exit: Deferred.Deferred<PeerExitFact, never>
  /** The bounded stderr tail; the caller scrubs it before disclosure. */
  readonly stderrTail: () => string
  /** The dialect version, adopting the newest protocol the peer reports. */
  readonly currentVersion: () => DialectVersion
}

interface CoreOptions {
  readonly transport: ExecTransport
  readonly version: DialectVersion
  readonly dialect: DialectApi
  /** Emits every interpreted notice, in arrival order. */
  readonly emit: (notice: PeerNotice) => void
}

let nextCorrelationSequence = 0

/** A fresh correlation id, unique to this process and strictly increasing. */
export const nextCorrelationId = (sessionLabel: string): string => {
  nextCorrelationSequence += 1

  return "local-exec:" + sessionLabel + ":" + String(nextCorrelationSequence)
}

const encoder = new TextEncoder()

export const openSessionCore = (options: CoreOptions): SessionCore => {
  const pending = new Map<string, Deferred.Deferred<ExchangeOutcome, never>>()

  let protocolVersion = options.version.protocolVersion

  const currentVersion = (): DialectVersion => ({
    protocolVersion,
    legacyApiVersion: options.version.legacyApiVersion,
  })

  const adoptVersion = (line: string): void => {
    const match = /"factoryProtocolVersion":"([^"]+)"/.exec(line)

    if (match === null) return

    const reported = match[1]

    if (reported === undefined) return

    protocolVersion = reported
  }

  const routeServerChallenge = (frame: EnvelopeFrame): void => {
    const id = frame.id

    if (id === null || id === undefined) return

    if (frame.method === undefined) return

    // Settlement is per-challenge: the closure captures this challenge's own
    // cell, so answering an earlier challenge never touches a newer one even
    // when the peer reuses the wire id. The cell is the internal correlation
    // epoch: it is minted fresh at arrival and settles exactly once.
    const settled = { value: false }

    const makeEndpoint = (requestId: string, kind: ChallengeKind): ChallengeEndpoint =>
      createChallengeEndpoint(kind, (payload) =>
        Effect.suspend(() => {
          if (settled.value) {
            return Effect.fail(
              new PeerRejected({
                message: "challenge already resolved or revoked",
                code: -32000,
              }),
            )
          }

          settled.value = true

          const replyFrame = {
            jsonrpc: "2.0",
            factoryApiVersion: currentVersion().legacyApiVersion,
            factoryProtocolVersion: currentVersion().protocolVersion,
            type: "response" as const,
            id: requestId,
            result: payload,
          }

          return options.transport.write(encoder.encode(JSON.stringify(replyFrame))).pipe(
            Effect.mapError(
              (failure) =>
                new PeerRejected({
                  message: "the challenge reply could not be delivered",
                  code: -32000,
                  detail: failure.detail,
                }),
            ),
          )
        }),
      )

    const wire = JSON.stringify({
      jsonrpc: "2.0",
      factoryApiVersion: currentVersion().legacyApiVersion,
      factoryProtocolVersion: currentVersion().protocolVersion,
      type: "request",
      id,
      method: frame.method,
      params: frame.params ?? null,
    })

    const decoded = Effect.runSync(
      Effect.exit(options.dialect.notice(currentVersion(), encoder.encode(wire), makeEndpoint)),
    )

    if (Exit.isFailure(decoded)) return

    options.emit(decoded.value)
  }

  const route = (line: string): void => {
    adoptVersion(line)

    const frame = decodeFrame(line)

    if (frame === undefined) return

    if (frame.type === "response") {
      const id = frame.id

      if (id === null || id === undefined) return

      const correlationId = String(id)
      const completion = pending.get(correlationId)

      if (completion === undefined) return

      pending.delete(correlationId)

      if (frame.error !== undefined) {
        Deferred.doneUnsafe(
          completion,
          Effect.succeed({
            kind: "rejected",
            code: frame.error.code,
            message: frame.error.message,
          }),
        )

        return
      }

      Deferred.doneUnsafe(
        completion,
        Effect.succeed({ kind: "result", result: frame.result ?? null }),
      )

      return
    }

    if (frame.type === "request") {
      routeServerChallenge(frame)

      return
    }

    if (frame.type === "notification") {
      const decoded = Effect.runSync(
        Effect.exit(options.dialect.notice(currentVersion(), encoder.encode(line))),
      )

      if (Exit.isFailure(decoded)) return

      options.emit(decoded.value)
    }
  }

  return {
    route,
    expectReply: (correlationId) => {
      const completion = Deferred.makeUnsafe<ExchangeOutcome, never>()
      pending.set(correlationId, completion)

      return Deferred.await(completion)
    },
    unexpect: (correlationId) => pending.delete(correlationId),
    failPending: () => {
      for (const completion of pending.values()) {
        Deferred.doneUnsafe(completion, Effect.succeed({ kind: "lost" }))
      }

      pending.clear()
    },
    exit: options.transport.exit,
    stderrTail: options.transport.stderrTail,
    currentVersion,
  }
}
