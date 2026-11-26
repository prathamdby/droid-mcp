/**
 * Level 1 `daemon-link` module: dialing, authenticating, negotiating,
 * handoff, reconnect and transport-level replay.
 *
 * Every RPC is dispatched through a reviewed `factory-dialect` `Binding`:
 * there is no raw method-string dispatch anywhere in the public API. Handoff
 * discipline is the module's core invariant. A failure before the request
 * frame reaches the peer transport is `NotDelivered`; a failure after
 * handoff — dropped socket, timeout, close — is `PossiblyDelivered` and is
 * never resent unless the caller's `ReplayPermission` for this binding and
 * invocation is `"idempotent_after_handoff"`. A malformed reply after
 * handoff is `BadReply` and never proves the request did not execute.
 *
 * Custody separates ownership. Attaching to an existing daemon registers the
 * connection through `Custody.borrow`: closing the link disconnects the
 * socket and never kills the external process. Spawning a daemon registers
 * the child through `Custody.acquire`: closing the link terminates the owned
 * process. `probeExisting` dials without ever spawning.
 *
 * `LinkHealth` is a released diagnostic, not a connection: every string that
 * can carry peer content is scrubbed through `Disclosure` for its audience,
 * and no socket, frame, PID, auth token or daemon path ever crosses the
 * boundary.
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"

import { Custody } from "../custody/index.ts"
import type { CustodyApi, Lease } from "../custody/index.ts"
import { Disclosure, ReleasePayload, releasedJson } from "../disclosure/index.ts"
import type { Audience, DisclosureApi } from "../disclosure/index.ts"
import { SDK_PROTOCOL_VERSION } from "../factory-dialect/index.ts"
import type { Binding } from "../factory-dialect/index.ts"
import type { DaemonEndpoint } from "./private/host.ts"
import { isListening, spawnManaged } from "./private/host.ts"
import type { ConnectError, ExchangeResult, LinkConnection } from "./private/session.ts"
import { authenticateConnection, openConnection, protocolMismatchOf } from "./private/session.ts"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Whether one invocation may be sent again, and when. This is a decision the
 * caller makes per binding and invocation: an advertised idempotency hint on
 * the binding is evidence, never permission. `"never"` forbids any resend,
 * `"before_handoff"` permits resend only while no frame has reached the
 * peer, and only `"idempotent_after_handoff"` permits one replay of a
 * provably idempotent invocation after an uncertain outcome.
 */
export type ReplayPermission = "never" | "before_handoff" | "idempotent_after_handoff"

/**
 * A released diagnostic about the link. Every free-text field has crossed
 * `Disclosure` for the `"client"` audience, so peer-controlled content
 * cannot smuggle secrets out. It is not a connection and grants nothing.
 */
export interface LinkHealth {
  readonly reachable: boolean
  readonly ownership: "borrowed" | "owned" | "none"
  readonly protocolVersion?: string
  readonly capabilities?: ReadonlyArray<string>
  readonly detail?: string
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

/**
 * The request definitely never reached the peer: dial, spawn, auth, encode
 * or write failed before transmission.
 */
export class NotDelivered extends Schema.TaggedError<NotDelivered>()("NotDelivered", {
  message: Schema.String,
  method: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

/**
 * The frame reached the peer transport, then the connection dropped, timed
 * out or closed before a valid reply arrived. The request may or may not
 * have executed; nothing ever resends on this failure class unless the
 * invocation's own `ReplayPermission` is `"idempotent_after_handoff"`.
 */
export class PossiblyDelivered extends Schema.TaggedError<PossiblyDelivered>()(
  "PossiblyDelivered",
  {
    message: Schema.String,
    method: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

/** The peer explicitly returned a JSON-RPC error response; the request did not run. */
export class PeerRejected extends Schema.TaggedError<PeerRejected>()("PeerRejected", {
  message: Schema.String,
  code: Schema.Number,
  method: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  protocolMismatch: Schema.optional(Schema.String),
}) {}

/**
 * A reply arrived after handoff but failed framing or the reviewed reply
 * codec. This never proves the request did not execute.
 */
export class BadReply extends Schema.TaggedError<BadReply>()("BadReply", {
  message: Schema.String,
  method: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {}

/** The peer cannot speak a protocol version this link supports. */
export class IncompatibleVersion extends Schema.TaggedError<IncompatibleVersion>()(
  "IncompatibleVersion",
  {
    message: Schema.String,
    peerVersion: Schema.String,
    supportedVersion: Schema.String,
  },
) {}

/** `probeExisting` found no reachable, authenticatable daemon at the configured endpoint. */
export class ProbeUnavailable extends Schema.TaggedError<ProbeUnavailable>()("ProbeUnavailable", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DaemonLinkOptions {
  /** Existing daemon endpoint. When nothing listens there and `spawn` is set, a daemon is spawned on first use. */
  readonly endpoint?: {
    readonly socketPath?: string
    readonly host?: string
    readonly port?: number
  }
  /** Command used to launch an owned daemon when no endpoint is reachable. */
  readonly spawn?: {
    readonly command: string
    readonly args: ReadonlyArray<string>
  }
  /** Credentials for the daemon handshake. */
  readonly auth?: {
    readonly apiKey?: string
    readonly caller?: string
    readonly metadata?: Schema.Json
  }
  /** Capabilities reported on `LinkHealth` after a successful handshake. */
  readonly capabilities?: ReadonlyArray<string>
  /** Values disclosure must never publish in health diagnostics or error detail. */
  readonly sensitiveValues?: ReadonlyArray<string>
  /** Recipient the health release is bound to. */
  readonly recipientId?: string
  /** Protocol version offered in the first handshake frame; the peer's adopted version supersedes it. */
  readonly protocolVersion?: string
  readonly requestTimeoutMs?: number
  readonly handshakeTimeoutMs?: number
  readonly startTimeoutMs?: number
  readonly socketPollMs?: number
  readonly connectTimeoutMs?: number
  readonly shutdownGraceMs?: number
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface DaemonLinkService {
  readonly exchange: <I, O>(
    binding: Binding<I, O>,
    args: I,
    replay: ReplayPermission,
  ) => Effect.Effect<
    O,
    NotDelivered | PossiblyDelivered | PeerRejected | BadReply | IncompatibleVersion
  >
  readonly probeExisting: () => Effect.Effect<LinkHealth, ProbeUnavailable>
  readonly health: () => Effect.Effect<LinkHealth>
}

export class DaemonLink extends Context.Service<DaemonLink, DaemonLinkService>()(
  "droid-mcp/daemon-link",
) {}

// ---------------------------------------------------------------------------
// Implementation internals
// ---------------------------------------------------------------------------

interface Acquired {
  readonly ownership: "borrowed" | "owned"
  readonly connection: LinkConnection
  readonly protocolVersion: string
  readonly terminate: Effect.Effect<void> | undefined
}

interface Established {
  readonly ownership: "borrowed" | "owned"
  readonly lease: Lease<Acquired>
  /**
   * Mutable within the module only: a documented mismatch adopts the peer's
   * version in place so the rejection retry — and every later exchange on
   * this connection — speaks the adopted version.
   */
  protocolVersion: string
}

type ExchangeError =
  | NotDelivered
  | PossiblyDelivered
  | PeerRejected
  | BadReply
  | IncompatibleVersion

type AttemptOutcome<O> =
  | { readonly status: "ok"; readonly value: O }
  | { readonly status: "retry_mismatch"; readonly version: string }
  | { readonly status: "failed"; readonly error: ExchangeError; readonly handedOff: boolean }

const scrubText = (
  disclosure: DisclosureApi,
  audience: Audience<"client">,
  sensitiveValues: ReadonlyArray<string>,
  text: string,
): Effect.Effect<string> =>
  Effect.map(
    Effect.orElseSucceed(
      disclosure.release(
        { payload: ReleasePayload.JsonValue({ value: text }), sensitiveValues },
        audience,
      ),
      () => null,
    ),
    (released) => {
      if (released === null) return "[diagnostic withheld by disclosure policy]"
      const json = releasedJson(released)

      return Option.isSome(json) && Schema.is(Schema.String)(json.value)
        ? json.value
        : "[diagnostic withheld by disclosure policy]"
    },
  )

const scrubOptional = (
  disclosure: DisclosureApi,
  audience: Audience<"client">,
  sensitiveValues: ReadonlyArray<string>,
  text: string | undefined,
): Effect.Effect<string | undefined> => {
  if (text === undefined) return Effect.succeed(undefined)

  return scrubText(disclosure, audience, sensitiveValues, text)
}

export const daemonLinkLayer = (
  options: DaemonLinkOptions,
): Layer.Layer<DaemonLink, never, Custody | Disclosure> =>
  Layer.effect(
    DaemonLink,
    Effect.gen(function* () {
      const custody = yield* Custody
      const disclosure = yield* Disclosure

      const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
      const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000
      const startTimeoutMs = options.startTimeoutMs ?? 30_000
      const socketPollMs = options.socketPollMs ?? 100
      const connectTimeoutMs = options.connectTimeoutMs ?? 500
      const shutdownGraceMs = options.shutdownGraceMs ?? 5_000
      const recipientId = options.recipientId ?? "operator"
      const sensitiveValues = options.sensitiveValues ?? []
      const offeredVersion = options.protocolVersion ?? SDK_PROTOCOL_VERSION

      const endpoint: DaemonEndpoint = {
        socketPath: options.endpoint?.socketPath,
        host: options.endpoint?.host,
        port: options.endpoint?.port,
      }

      const audience = yield* disclosure.audience("client", recipientId)
      const lifetime = yield* custody.createLifetime("daemon-link")
      const lock = yield* Semaphore.make(1)
      const leaseScope = Scope.makeUnsafe()

      const scrub = (text: string): Effect.Effect<string> =>
        scrubText(disclosure, audience, sensitiveValues, text)

      const scrubbed = (text: string | undefined): Effect.Effect<string | undefined> =>
        scrubOptional(disclosure, audience, sensitiveValues, text)

      const auth = {
        apiKey: options.auth?.apiKey,
        caller: options.auth?.caller,
        metadata: options.auth?.metadata,
      }

      // Closing the layer drains every lease adopted into the lifetime —
      // exactly one cleanup execution per lease, joined by any concurrent
      // release — and then closes the provisioning scope for anything never
      // adopted.
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          Effect.orElseSucceed(custody.drain(lifetime), () => undefined),
          Scope.close(leaseScope, Exit.void),
        ),
      )

      /**
       * Dial plus authenticate against an endpoint that already accepts
       * connections. Never spawns anything. A failed handshake closes the
       * socket it opened.
       */
      const dialAndAuthenticate = (): Effect.Effect<
        { readonly connection: LinkConnection; readonly protocolVersion: string },
        ConnectError
      > =>
        Effect.gen(function* () {
          const connection = yield* openConnection(endpoint, handshakeTimeoutMs)

          const negotiated = yield* Effect.matchEffect(
            authenticateConnection(connection, auth, offeredVersion, handshakeTimeoutMs),
            {
              onFailure: (error) => Effect.andThen(connection.close, Effect.fail(error)),
              onSuccess: (value) => Effect.succeed(value),
            },
          )

          return { connection, protocolVersion: negotiated.protocolVersion }
        })

      /**
       * Acquires one daemon connection together with its ownership facts.
       * An already-listening endpoint is borrowed — termination rights stay
       * with the external daemon — and only a spawn performed here is owned.
       */
      const acquireConnection: Effect.Effect<Acquired, ConnectError> = Effect.gen(function* () {
        const alreadyListening = yield* isListening(endpoint, connectTimeoutMs)

        if (alreadyListening) {
          const dialed = yield* dialAndAuthenticate()

          return {
            ownership: "borrowed" as const,
            connection: dialed.connection,
            protocolVersion: dialed.protocolVersion,
            terminate: undefined,
          }
        }

        if (options.spawn === undefined) {
          return yield* Effect.fail({
            kind: "dial_failed",
            message: "no daemon is listening at the configured endpoint",
          } satisfies ConnectError)
        }

        const managed = yield* Effect.mapError(
          spawnManaged({
            command: options.spawn.command,
            args: options.spawn.args,
            endpoint,
            startTimeoutMs,
            socketPollMs,
            connectTimeoutMs,
            shutdownGraceMs,
          }),
          (error): ConnectError => ({ kind: "spawn_failed", message: error.message }),
        )

        const dialed = yield* Effect.matchEffect(dialAndAuthenticate(), {
          onFailure: (error) => Effect.andThen(managed.terminate, Effect.fail(error)),
          onSuccess: (value) => Effect.succeed(value),
        })

        return {
          ownership: "owned" as const,
          connection: dialed.connection,
          protocolVersion: dialed.protocolVersion,
          terminate: managed.terminate,
        }
      })

      /**
       * Disposal matching ownership: a borrowed connection is only
       * disconnected; an owned child is disconnected and then terminated.
       * Failures inside disposal never escape custody's cleanup contract.
       */
      const disposeAcquired = (value: Acquired): Effect.Effect<void> =>
        Effect.andThen(
          value.connection.close,
          value.terminate === undefined ? Effect.void : value.terminate,
        ).pipe(Effect.orElseSucceed(() => undefined))

      let current: Established | undefined

      const dropCurrent = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          const found = current
          current = undefined

          if (found === undefined) return Effect.void

          return Effect.orElseSucceed(custody.release(found.lease), () => undefined)
        })

      /**
       * Leases one already-acquired connection under the custody kind that
       * matches its ownership. Acquisition ran first so the lease kind is
       * decided by facts, and exactly one dial happens per establish. A lease
       * that cannot be installed disposes the connection it wraps.
       */
      const leaseAcquired = (acquired: Acquired): Effect.Effect<Lease<Acquired>, ConnectError> => {
        const disconnect = (value: Acquired): Effect.Effect<void, never> => disposeAcquired(value)

        const leased =
          acquired.ownership === "borrowed"
            ? custody.borrow({
                name: "daemon-link:borrowed-daemon",
                connect: Effect.succeed(acquired),
                disconnect,
              })
            : custody.acquire({
                name: "daemon-link:owned-daemon",
                acquire: Effect.succeed(acquired),
                dispose: disconnect,
              })

        return leased.pipe(
          Scope.provide(leaseScope),
          Effect.mapError((error): ConnectError => ({
            kind: "dial_failed",
            message: error.message,
          })),
          Effect.matchEffect({
            onFailure: (error) => Effect.andThen(disposeAcquired(acquired), Effect.fail(error)),
            onSuccess: (lease) => Effect.succeed(lease),
          }),
        )
      }

      const connectionUsable = (
        custodyApi: CustodyApi,
        established: Established,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const active = yield* custodyApi.isActive(established.lease)

          if (!active) return false

          return yield* custodyApi
            .use(established.lease, (value) => Effect.succeed(!value.connection.isClosed()))
            .pipe(Effect.orElseSucceed(() => false))
        })

      /**
       * Establishes one authenticated connection under custody, adopting it
       * into the link lifetime and replacing any dead connection it
       * supersedes. Acquisition is serialized: concurrent exchangers share
       * one dial.
       */
      const establish = (): Effect.Effect<Established, ConnectError> =>
        Semaphore.withPermit(lock)(
          Effect.gen(function* () {
            if (current !== undefined) {
              const usable = yield* connectionUsable(custody, current)

              if (usable) return current

              yield* dropCurrent()
            }

            const acquired = yield* acquireConnection
            const lease = yield* leaseAcquired(acquired)

            yield* Effect.orElseSucceed(custody.adopt(lease, lifetime), () => undefined)

            const established: Established = {
              ownership: acquired.ownership,
              lease,
              protocolVersion: acquired.protocolVersion,
            }

            current = established

            return established
          }),
        )

      // -------------------------------------------------------------------
      // Health rendering
      // -------------------------------------------------------------------

      const renderHealth = (
        reachable: boolean,
        ownership: "borrowed" | "owned" | "none",
        protocolVersion: string | undefined,
        detail: string | undefined,
      ): Effect.Effect<LinkHealth> =>
        Effect.map(scrubbed(detail), (scrubbedDetail) => {
          const base = { reachable, ownership }
          const withVersion = protocolVersion === undefined ? base : { ...base, protocolVersion }

          const withCapabilities =
            options.capabilities === undefined
              ? withVersion
              : { ...withVersion, capabilities: options.capabilities }

          return scrubbedDetail === undefined
            ? withCapabilities
            : { ...withCapabilities, detail: scrubbedDetail }
        })

      const health: DaemonLinkService["health"] = () =>
        Effect.gen(function* () {
          if (current === undefined) {
            const listening = yield* isListening(endpoint, connectTimeoutMs)

            if (!listening) {
              return yield* renderHealth(
                false,
                "none",
                undefined,
                "no daemon connection is established",
              )
            }

            return yield* renderHealth(
              false,
              "none",
              undefined,
              "a daemon endpoint is listening but this link has not connected",
            )
          }

          const usable = yield* connectionUsable(custody, current)

          if (!usable) {
            return yield* renderHealth(false, "none", undefined, "the daemon connection is closed")
          }

          return yield* renderHealth(true, current.ownership, current.protocolVersion, undefined)
        })

      // -------------------------------------------------------------------
      // Probe: dials what exists, never spawns
      // -------------------------------------------------------------------

      const probeExisting: DaemonLinkService["probeExisting"] = () =>
        Effect.gen(function* () {
          const listening = yield* isListening(endpoint, connectTimeoutMs)

          if (!listening) {
            const detail = yield* scrub("no daemon is listening at the configured endpoint")

            return yield* Effect.fail(
              new ProbeUnavailable({ message: "no existing daemon is reachable", detail }),
            )
          }

          const dialedExit = yield* Effect.exit(dialAndAuthenticate())

          if (Exit.isFailure(dialedExit)) {
            const connectError = Cause.findErrorOption(dialedExit.cause)

            const mismatch =
              Option.isSome(connectError) && connectError.value.kind === "incompatible_version"

            const detail = yield* scrub(
              mismatch
                ? "the daemon speaks an incompatible protocol version"
                : "the daemon endpoint did not complete authentication",
            )

            return yield* Effect.fail(
              new ProbeUnavailable({
                message: "the existing daemon did not accept this link",
                detail,
              }),
            )
          }

          const connection = dialedExit.value.connection

          // A probe borrows the daemon only long enough to answer. The
          // borrowing is registered with custody so a concurrent drain can
          // never leak the socket, and it ends before the probe returns:
          // the external process is never killed. A borrow of an already-
          // succeeded connection cannot fail acquisition; any registration
          // failure still closes the probe socket rather than leaking it.
          const leaseExit = yield* Effect.exit(
            custody
              .borrow({
                name: "daemon-link:probe",
                connect: Effect.succeed(connection),
                disconnect: (value) => Effect.orElseSucceed(value.close, () => undefined),
              })
              .pipe(Scope.provide(leaseScope)),
          )

          if (Exit.isFailure(leaseExit)) {
            yield* connection.close
            const detail = yield* scrub("the probe could not register its borrowing")

            return yield* Effect.fail(
              new ProbeUnavailable({
                message: "the existing daemon did not accept this link",
                detail,
              }),
            )
          }

          const lease = leaseExit.value

          yield* Effect.orElseSucceed(custody.adopt(lease, lifetime), () => undefined)

          const healthValue = yield* renderHealth(
            true,
            "borrowed",
            dialedExit.value.protocolVersion,
            undefined,
          )

          yield* Effect.orElseSucceed(custody.release(lease), () => undefined)

          return healthValue
        })

      // -------------------------------------------------------------------
      // Exchange
      // -------------------------------------------------------------------

      /**
       * Classifies one wire outcome into the public failure taxonomy.
       * Version mismatches are the only outcome that loops back for a
       * resent frame, because a documented mismatch is a rejection before
       * execution, never execution.
       */
      const interpretOutcome = <I, O>(
        binding: Binding<I, O>,
        result: ExchangeResult,
        link: Established,
      ): Effect.Effect<AttemptOutcome<O>, never> =>
        Effect.gen(function* () {
          const outcome = result.outcome

          if (outcome.kind === "not_delivered") {
            yield* dropCurrent()
            const detail = yield* scrub(outcome.detail)

            return {
              status: "failed" as const,
              handedOff: result.handedOff,
              error: new NotDelivered({
                message: "the request never reached the daemon",
                method: binding.method,
                detail,
              }),
            }
          }

          if (outcome.kind === "possibly_delivered") {
            yield* dropCurrent()
            const detail = yield* scrub(outcome.detail)

            return {
              status: "failed" as const,
              handedOff: result.handedOff,
              error: new PossiblyDelivered({
                message: "the daemon may have received the request before the connection was lost",
                method: binding.method,
                detail,
              }),
            }
          }

          if (outcome.kind === "bad_reply") {
            const detail = yield* scrub(outcome.detail)

            return {
              status: "failed" as const,
              handedOff: result.handedOff,
              error: new BadReply({
                message:
                  "the daemon reply was malformed; this does not prove the request failed to execute",
                method: binding.method,
                detail,
              }),
            }
          }

          if (outcome.kind === "peer_error") {
            const mismatch = protocolMismatchOf(outcome.code, outcome.data)

            if (mismatch !== undefined && mismatch.local !== link.protocolVersion) {
              // A documented mismatch is a rejection before execution, never
              // execution: adopting the version in place lets the single
              // retry — and every later exchange on this connection — speak
              // the version the peer asked for.
              link.protocolVersion = mismatch.local

              return { status: "retry_mismatch" as const, version: mismatch.local }
            }

            const detail = yield* scrub(outcome.message)

            const rejectedBase = {
              message: "the daemon rejected the request",
              code: outcome.code,
              method: binding.method,
              detail,
            }

            return {
              status: "failed" as const,
              handedOff: result.handedOff,
              error: new PeerRejected(
                mismatch === undefined
                  ? rejectedBase
                  : { ...rejectedBase, protocolMismatch: mismatch.local },
              ),
            }
          }

          const decoded = Option.getOrUndefined(binding.decodeResult(outcome.result))

          if (decoded === undefined) {
            return {
              status: "failed" as const,
              handedOff: result.handedOff,
              error: new BadReply({
                message: "the daemon reply does not match the reviewed result schema",
                method: binding.method,
              }),
            }
          }

          return { status: "ok" as const, value: decoded }
        })

      /**
       * One dispatch attempt on the current connection: encode, send, wait,
       * classify. The result reports whether the frame was handed off so the
       * caller's replay permission decides what may happen next.
       */
      const attemptOnce = <I, O>(
        binding: Binding<I, O>,
        args: I,
      ): Effect.Effect<AttemptOutcome<O>, never> =>
        Effect.gen(function* () {
          const establishedExit = yield* Effect.exit(establish())

          if (Exit.isFailure(establishedExit)) {
            const connectError = Cause.findErrorOption(establishedExit.cause)

            if (Option.isSome(connectError) && connectError.value.kind === "incompatible_version") {
              return {
                status: "failed" as const,
                handedOff: false,
                error: new IncompatibleVersion({
                  message: "the daemon rejected every protocol version this link offers",
                  peerVersion: connectError.value.peerVersion ?? "unknown",
                  supportedVersion: offeredVersion,
                }),
              }
            }

            const detail = yield* scrub(
              Option.isSome(connectError)
                ? connectError.value.message
                : "cannot establish a daemon connection",
            )

            return {
              status: "failed" as const,
              handedOff: false,
              error: new NotDelivered({
                message: "the request never reached the daemon",
                method: binding.method,
                detail,
              }),
            }
          }

          const link = establishedExit.value
          const encoded = Option.getOrUndefined(binding.encodeParams(args))

          if (encoded === undefined) {
            return {
              status: "failed" as const,
              handedOff: false,
              error: new NotDelivered({
                message: "arguments do not match the reviewed schema",
                method: binding.method,
                detail: "encoding failed before any frame was written",
              }),
            }
          }

          const result = yield* custody
            .use(link.lease, (value) =>
              value.connection.exchange(
                binding.method,
                encoded,
                link.protocolVersion,
                requestTimeoutMs,
              ),
            )
            .pipe(
              Effect.orElseSucceed((): ExchangeResult => ({
                outcome: { kind: "not_delivered", detail: "the connection lease is closed" },
                handedOff: false,
              })),
            )

          return yield* interpretOutcome(binding, result, link)
        })

      /**
       * Sends at one protocol version, adopting the peer's version once when
       * it documents a mismatch. A second mismatch is incompatibility. The
       * adoption resend is a rejection-before-execution, so it does not count
       * against the invocation's replay permission.
       */
      const attemptWithNegotiation = <I, O>(
        binding: Binding<I, O>,
        args: I,
      ): Effect.Effect<AttemptOutcome<O>, never> =>
        Effect.gen(function* () {
          const first = yield* attemptOnce(binding, args)

          if (first.status !== "retry_mismatch") return first

          const adopted = yield* attemptOnce(binding, args)

          if (adopted.status === "retry_mismatch") {
            return {
              status: "failed" as const,
              handedOff: false,
              error: new IncompatibleVersion({
                message: "the daemon rejected the adopted protocol version",
                peerVersion: adopted.version,
                supportedVersion: offeredVersion,
              }),
            }
          }

          return adopted
        })

      const exchange: DaemonLinkService["exchange"] = (binding, args, replay) =>
        Effect.gen(function* () {
          const first = yield* attemptWithNegotiation(binding, args)

          if (first.status === "ok") return first.value

          if (first.status === "retry_mismatch") {
            return yield* Effect.die(new Error("unreachable: negotiation resolves mismatches"))
          }

          if (first.status === "failed") {
            const failure = first.error

            const mayReplayBeforeHandoff =
              !first.handedOff && replay !== "never" && failure instanceof NotDelivered

            // Only delivery uncertainty is ever replayable, and only for a
            // provably idempotent invocation. `BadReply` means the peer
            // answered — replaying after a reply is never transport recovery
            // — and `PeerRejected` means the peer refused before execution.
            const mayReplayAfterHandoff =
              first.handedOff &&
              replay === "idempotent_after_handoff" &&
              failure instanceof PossiblyDelivered

            if (!mayReplayBeforeHandoff && !mayReplayAfterHandoff) {
              return yield* Effect.fail(failure)
            }

            // Pre-handoff failures already dropped their connection inside
            // `interpretOutcome`; the retry dials fresh. Post-handoff the
            // invocation itself must be provably idempotent — permission came
            // from the caller, not from any hint on the binding.
            const second = yield* attemptWithNegotiation(binding, args)

            if (second.status === "ok") return second.value

            if (second.status === "failed") {
              return yield* Effect.fail(second.error)
            }

            return yield* Effect.die(new Error("unreachable: negotiation resolves mismatches"))
          }

          return yield* Effect.die(new Error("unreachable attempt state"))
        })

      return { exchange, probeExisting, health }
    }),
  )
