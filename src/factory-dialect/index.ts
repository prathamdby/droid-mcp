/**
 * Level 0 module: exec and daemon versions, encodings and peer correlation.
 *
 * Owns the reviewed wire dialect only. A `Binding` pairs one reviewed argument
 * codec with its reply codec; it is wire evidence, never product support,
 * replay permission or authority. Inbound peer traffic normalizes into
 * `PeerNotice`; a challenge carries a revocable, single-use typed reply
 * endpoint. No public string-method dispatch: `reviewedBinding` fails with
 * `UnsupportedBinding` for anything the reviewed manifest does not serve.
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as JsonSchema from "effect/JsonSchema"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

import { GENERATED_CODECS } from "./private/generated-codecs.ts"
import type { GeneratedCodec } from "./private/generated-codecs.ts"

export const JSONRPC_VERSION = "2.0"
export const LEGACY_FACTORY_API_VERSION = "1.0.0"

/** The protocol version the pinned SDK declares; adopted until a peer reports its own. */
export const SDK_PROTOCOL_VERSION = "1.269.0"

/** Arguments that put the local executable into stream-jsonrpc mode. */
export const EXEC_ARGS = [
  "exec",
  "--input-format",
  "stream-jsonrpc",
  "--output-format",
  "stream-jsonrpc",
] as const

/** Session wire methods a local executable speaks. */
export const EXEC_METHOD = {
  initialize: "droid.initialize_session",
  loadSession: "droid.load_session",
  addUserMessage: "droid.add_user_message",
  interrupt: "droid.interrupt_session",
  killWorkerSession: "droid.kill_worker_session",
  updateSettings: "droid.update_session_settings",
  close: "droid.close_session",
  requestPermission: "droid.request_permission",
  askUser: "droid.ask_user",
  pickOptions: "droid.pick_options",
  sessionNotification: "droid.session_notification",
} as const

/** Connection and session-store methods the daemon speaks. */
export const DAEMON_METHOD = {
  authenticate: "daemon.authenticate",
  listAvailableSessions: "daemon.list_available_sessions",
  listOpenedSessions: "daemon.list_opened_sessions",
} as const

/** The 16 permission outcomes the peer accepts on a review reply. */
export const PERMISSION_OUTCOMES = [
  "proceed_once",
  "proceed_always",
  "proceed_always_file",
  "proceed_auto_run",
  "proceed_auto_run_low",
  "proceed_auto_run_medium",
  "proceed_auto_run_high",
  "proceed_new_session",
  "proceed_new_session_low",
  "proceed_new_session_medium",
  "proceed_new_session_high",
  "proceed_edit",
  "proceed_always_tools",
  "proceed_always_server",
  "proceed_report_false_positive",
  "cancel",
] as const

export type PermissionOutcome = (typeof PERMISSION_OUTCOMES)[number]

/** A JSON Schema document as the reviewed codecs carry it: no `unknown`. */
export type JsonSchemaDocument =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonSchemaDocument>
  | { readonly [key: string]: JsonSchemaDocument }

/** Every extracted schema has an object root. */
export type JsonSchemaObject = { readonly [key: string]: JsonSchemaDocument }

export interface PeerVersion {
  readonly protocolVersion: string
  readonly legacyApiVersion?: string
}

export interface DialectVersion {
  readonly protocolVersion: string
  readonly legacyApiVersion: string
}

export type BindingDirection = "request" | "notification" | "server_request"

/**
 * An opaque wire binding: one reviewed method with its argument and reply
 * codecs. The brand keeps a hand-built object from standing in for reviewed
 * evidence; only this module constructs bindings.
 */
export interface Binding<I, O> {
  readonly method: string
  readonly direction: BindingDirection
  readonly paramsSchema: JsonSchemaObject
  readonly resultSchema: JsonSchemaObject
  readonly decodeParams: (input: Schema.Json) => Option.Option<I>
  readonly encodeParams: (input: I) => Option.Option<Schema.Json>
  readonly decodeResult: (input: Schema.Json) => Option.Option<O>
  readonly brand: "ReviewedBinding"
}

export type ChallengeKind = "permission" | "question" | "options"

/**
 * The typed reply right for one peer-initiated challenge. `reply` succeeds at
 * most once across all callers and never after `revoke`.
 */
export interface ChallengeEndpoint {
  readonly kind: ChallengeKind
  readonly reply: (payload: Schema.Json) => Effect.Effect<void, PeerRejected>
  readonly revoke: () => Effect.Effect<void>
}

export type PeerNotice = Data.TaggedEnum<{
  readonly SessionDelta: {
    readonly sessionId: string
    readonly kind: string
    readonly payload: Schema.Json
  }
  readonly TurnCompleted: { readonly sessionId: string; readonly summary: Schema.Json }
  readonly TurnInterrupted: { readonly sessionId: string; readonly reason: string }
  readonly TurnFailed: {
    readonly sessionId: string
    readonly code: string
    readonly message: string
  }
  readonly PermissionChallenge: {
    readonly peerRequestId: string
    readonly toolUses: Schema.Json
    readonly options: Schema.Json
    readonly endpoint: ChallengeEndpoint
  }
  readonly QuestionChallenge: {
    readonly peerRequestId: string
    readonly questions: Schema.Json
    readonly endpoint: ChallengeEndpoint
  }
  readonly OptionsChallenge: {
    readonly peerRequestId: string
    readonly title: string
    readonly options: Schema.Json
    readonly multiSelect: boolean
    readonly endpoint: ChallengeEndpoint
  }
  readonly ChallengeResolved: {
    readonly peerRequestId: string
    readonly toolUseIds: ReadonlyArray<string>
  }
  readonly ModelCatalog: { readonly models: Schema.Json }
  readonly SettingsChanged: { readonly settings: Schema.Json }
  readonly OtherNotice: { readonly method: string; readonly payload: Schema.Json }
}>

export const PeerNotice = Data.taggedEnum<PeerNotice>()

export interface ProtocolMismatchInfo {
  readonly expectedVersion: string
}

export class IncompatibleVersion extends Schema.TaggedError<IncompatibleVersion>()(
  "IncompatibleVersion",
  {
    message: Schema.String,
    peerVersion: Schema.String,
    supportedVersion: Schema.String,
  },
) {}

export class InvalidArguments extends Schema.TaggedError<InvalidArguments>()("InvalidArguments", {
  message: Schema.String,
  method: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class BadReply extends Schema.TaggedError<BadReply>()("BadReply", {
  message: Schema.String,
  method: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {}

export class PeerRejected extends Schema.TaggedError<PeerRejected>()("PeerRejected", {
  message: Schema.String,
  code: Schema.Number,
  method: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  protocolMismatch: Schema.optional(Schema.String),
}) {}

export class UnsupportedBinding extends Schema.TaggedError<UnsupportedBinding>()(
  "UnsupportedBinding",
  {
    message: Schema.String,
    method: Schema.String,
  },
) {}

export interface DialectApi {
  negotiate(peer: PeerVersion): Effect.Effect<DialectVersion, IncompatibleVersion>
  encode<I, O>(binding: Binding<I, O>, args: I): Effect.Effect<Uint8Array, InvalidArguments>
  reply<I, O>(binding: Binding<I, O>, bytes: Uint8Array): Effect.Effect<O, BadReply | PeerRejected>
  notice(
    version: DialectVersion,
    bytes: Uint8Array,
    makeEndpoint?: (peerRequestId: string, kind: ChallengeKind) => ChallengeEndpoint,
  ): Effect.Effect<PeerNotice, BadReply | UnsupportedBinding>
  reviewedBinding(
    method: string,
  ): Effect.Effect<Binding<Schema.Json, Schema.Json>, UnsupportedBinding>
  reviewedMethods(): ReadonlyArray<string>
  jsonRpcRequest(
    id: string | number,
    binding: Binding<Schema.Json, Schema.Json>,
    params: Schema.Json,
    version: DialectVersion,
  ): Effect.Effect<Uint8Array, InvalidArguments>
  jsonRpcResponse(id: string | number, result: Schema.Json): Uint8Array
  jsonRpcError(id: string | number, code: number, message: string): Uint8Array
}

export class Dialect extends Context.Service<Dialect, DialectApi>()("droid-mcp-v2/Dialect") {}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const bytesOf = (value: Schema.Json): Uint8Array => encoder.encode(JSON.stringify(value))

const asDocument = (value: JsonSchemaObject): JsonSchema.JsonSchema =>
  // SAFETY: the document was extracted from the SDK's own declarations by the
  // build-time extractor, so it is a JSON Schema object; the cast only drops
  // the wider recursive value type this module carries for rendering.
  value as JsonSchema.JsonSchema

const schemaOf = (value: JsonSchemaObject): Schema.Codec<Schema.Json> =>
  // SAFETY: `fromJsonSchemaDocument` builds a schema with no decoding services;
  // a decoded JSON Schema value is always `Schema.Json`.
  SchemaRepresentation.fromJsonSchemaDocument({
    dialect: "draft-2020-12",
    schema: asDocument(value),
    definitions: {},
  }) as Schema.Codec<Schema.Json>

/** Compiles a codec once per binding; schema compilation is the expensive part. */
const compiledCache = new WeakMap<JsonSchemaObject, Schema.Codec<Schema.Json>>()

const compiledOf = (document: JsonSchemaObject): Schema.Codec<Schema.Json> => {
  const cached = compiledCache.get(document)

  if (cached !== undefined) return cached

  const compiled = schemaOf(document)

  compiledCache.set(document, compiled)

  return compiled
}

const decodeWith =
  (document: JsonSchemaObject) =>
  (input: Schema.Json): Option.Option<Schema.Json> =>
    Schema.decodeUnknownOption(compiledOf(document))(input)

const makeBinding = (codec: GeneratedCodec): Binding<Schema.Json, Schema.Json> => {
  // SAFETY: both schema documents are emitted by the build-time extractor as
  // object-rooted JSON Schema; the generated type is structurally identical
  // and the cast only crosses the module boundary.
  const paramsSchema = codec.params as JsonSchemaObject
  // SAFETY: see paramsSchema above; the same extraction guarantees the shape.
  const resultSchema = codec.result as JsonSchemaObject
  const decode = decodeWith(paramsSchema)
  const decodeResult = decodeWith(resultSchema)

  return {
    method: codec.method,
    direction: codec.direction,
    paramsSchema,
    resultSchema,
    decodeParams: decode,
    encodeParams: (input) => decode(input),
    decodeResult,
    brand: "ReviewedBinding",
  }
}

const codecIndex = new Map(GENERATED_CODECS.map((codec) => [codec.method, codec]))

const bindingCache = new Map<string, Binding<Schema.Json, Schema.Json>>()

const servedBindingOf = (method: string): Binding<Schema.Json, Schema.Json> | undefined => {
  const codec = codecIndex.get(method)

  if (codec === undefined || !codec.served) return undefined

  const cached = bindingCache.get(method)

  if (cached !== undefined) return cached

  const binding = makeBinding(codec)

  bindingCache.set(method, binding)

  return binding
}

const protocolVersionPattern = /^\d+\.\d+\.\d+$/

const negotiateImpl = (peer: PeerVersion): Effect.Effect<DialectVersion, IncompatibleVersion> => {
  if (!protocolVersionPattern.test(peer.protocolVersion)) {
    return Effect.fail(
      new IncompatibleVersion({
        message: "peer reported a malformed protocol version",
        peerVersion: peer.protocolVersion,
        supportedVersion: SDK_PROTOCOL_VERSION,
      }),
    )
  }

  if (peer.legacyApiVersion !== undefined && peer.legacyApiVersion !== LEGACY_FACTORY_API_VERSION) {
    return Effect.fail(
      new IncompatibleVersion({
        message: "peer requires an unsupported legacy api version",
        peerVersion: peer.legacyApiVersion,
        supportedVersion: LEGACY_FACTORY_API_VERSION,
      }),
    )
  }

  return Effect.succeed({
    protocolVersion: peer.protocolVersion,
    legacyApiVersion: LEGACY_FACTORY_API_VERSION,
  })
}

const encodeImpl = <I, O>(
  binding: Binding<I, O>,
  args: I,
): Effect.Effect<Uint8Array, InvalidArguments> =>
  Option.match(binding.encodeParams(args), {
    onNone: () =>
      Effect.fail(
        new InvalidArguments({
          message: "arguments do not match the reviewed schema",
          method: binding.method,
        }),
      ),
    onSome: (encoded) => Effect.succeed(bytesOf(encoded)),
  })

const ErrorDataSchema = Schema.Struct({
  protocolVersionMismatch: Schema.Struct({
    localFactoryProtocolVersion: Schema.String,
    peerFactoryProtocolVersion: Schema.optional(Schema.String),
  }),
})

const ResponseFrameSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(Schema.Json),
    }),
  ),
})

const parseBytes = (bytes: Uint8Array): Option.Option<Schema.Json> => {
  try {
    // SAFETY: `JSON.parse` of a wire frame produces exactly the JSON value
    // domain — null, booleans, numbers, strings, arrays and plain objects —
    // which is what `Schema.Json` denotes.
    return Option.some(JSON.parse(decoder.decode(bytes)) as Schema.Json)
  } catch {
    return Option.none()
  }
}

const replyImpl = <I, O>(
  binding: Binding<I, O>,
  bytes: Uint8Array,
): Effect.Effect<O, BadReply | PeerRejected> =>
  Effect.gen(function* () {
    const parsed = yield* Option.match(parseBytes(bytes), {
      onNone: () =>
        Effect.fail(
          new BadReply({
            message: "reply is not valid JSON",
            method: binding.method,
          }),
        ),
      onSome: (value) => Effect.succeed(value),
    })

    const frame = Option.getOrUndefined(Schema.decodeUnknownOption(ResponseFrameSchema)(parsed))

    if (frame === undefined) {
      return yield* Effect.fail(
        new BadReply({
          message: "reply is not a response envelope",
          method: binding.method,
        }),
      )
    }

    if (frame.error !== undefined) {
      const mismatch = Option.getOrUndefined(
        Schema.decodeUnknownOption(ErrorDataSchema)(frame.error.data),
      )

      if (mismatch === undefined) {
        return yield* Effect.fail(
          new PeerRejected({
            message: frame.error.message,
            code: frame.error.code,
            method: binding.method,
          }),
        )
      }

      return yield* Effect.fail(
        new PeerRejected({
          message: frame.error.message,
          code: frame.error.code,
          method: binding.method,
          protocolMismatch: mismatch.protocolVersionMismatch.localFactoryProtocolVersion,
        }),
      )
    }

    if (frame.result === undefined) {
      return yield* Effect.fail(
        new BadReply({
          message: "reply carries neither result nor error",
          method: binding.method,
        }),
      )
    }

    return yield* Option.match(binding.decodeResult(frame.result), {
      onNone: () =>
        Effect.fail(
          new BadReply({
            message: "reply does not match the reviewed result schema",
            method: binding.method,
          }),
        ),
      onSome: (decoded) => Effect.succeed(decoded),
    })
  })

/**
 * A revocable, single-use reply endpoint. The `reply` effect wins at most one
 * race; every later reply and every reply after `revoke` fails with
 * `PeerRejected` code -32000 without touching the peer.
 */
export const createChallengeEndpoint = (
  kind: ChallengeKind,
  send: (payload: Schema.Json) => Effect.Effect<void, PeerRejected>,
): ChallengeEndpoint => {
  let settled = false

  const claim = (): boolean => {
    if (settled) return false

    settled = true

    return true
  }

  return {
    kind,
    reply: (payload) =>
      Effect.suspend(() =>
        claim()
          ? send(payload)
          : Effect.fail(
              new PeerRejected({
                message: "challenge already resolved or revoked",
                code: -32000,
              }),
            ),
      ),
    revoke: () => Effect.sync(() => claim()),
  }
}

const NotificationFrameSchema = Schema.Struct({
  type: Schema.Literal("notification"),
  method: Schema.String,
  params: Schema.optional(Schema.Json),
})

const ServerRequestFrameSchema = Schema.Struct({
  type: Schema.Literal("request"),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optional(Schema.Json),
})

const SessionNotificationParamsSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  notification: Schema.Json,
})

const PermissionParamsSchema = Schema.Struct({
  toolUses: Schema.optional(Schema.Json),
  options: Schema.optional(Schema.Json),
})

const QuestionParamsSchema = Schema.Struct({
  questions: Schema.optional(Schema.Json),
})

const OptionsParamsSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  rows: Schema.optional(Schema.Json),
  options: Schema.optional(Schema.Json),
  multi: Schema.optional(Schema.Boolean),
  multiSelect: Schema.optional(Schema.Boolean),
})

const kindOfServerMethod = (method: string): ChallengeKind | undefined => {
  if (method === EXEC_METHOD.requestPermission) return "permission"

  if (method === EXEC_METHOD.askUser) return "question"

  if (method === EXEC_METHOD.pickOptions) return "options"

  return undefined
}

const isRecordJson = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isStringJson = Schema.is(Schema.String)

const notificationRecord = (payload: Schema.Json): Record<string, Schema.Json> =>
  isRecordJson(payload) ? payload : {}

const stringField = (record: Record<string, Schema.Json>, key: string): string | undefined => {
  const value = record[key]

  return isStringJson(value) ? value : undefined
}

const sessionDeltaOf = (
  method: string,
  params: Schema.Json | undefined,
): PeerNotice | undefined => {
  if (method !== EXEC_METHOD.sessionNotification) return undefined

  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(SessionNotificationParamsSchema)(params),
  )

  if (decoded === undefined) {
    return PeerNotice.SessionDelta({
      sessionId: "",
      kind: "malformed",
      payload: params ?? null,
    })
  }

  const notification = decoded.notification
  const record = notificationRecord(notification)
  const kind = stringField(record, "type") ?? "unknown"
  const sessionId = decoded.sessionId ?? ""

  if (kind === "error") {
    return PeerNotice.TurnFailed({
      sessionId,
      code: stringField(record, "code") ?? "error",
      message: stringField(record, "message") ?? "session error",
    })
  }

  if (kind === "turn_interrupted") {
    return PeerNotice.TurnInterrupted({
      sessionId,
      reason: stringField(record, "reason") ?? "interrupted",
    })
  }

  if (kind === "agent_turn_completed") {
    const reason = stringField(record, "reason") ?? "completed"

    if (reason === "completed") {
      return PeerNotice.TurnCompleted({ sessionId, summary: notification })
    }

    if (
      reason === "cancelled" ||
      reason === "interrupted" ||
      reason === "permission_rejected" ||
      reason === "spec_handoff"
    ) {
      return PeerNotice.TurnInterrupted({ sessionId, reason })
    }

    return PeerNotice.TurnFailed({
      sessionId,
      code: reason,
      message: stringField(record, "message") ?? reason,
    })
  }

  if (kind === "droid_working_state_changed" && record["state"] === "idle") {
    return PeerNotice.TurnCompleted({ sessionId, summary: notification })
  }

  if (kind === "permission_resolved") {
    const toolUses = record["toolUseIds"]
    const singular = stringField(record, "toolUseId")

    const toolUseIds = Array.isArray(toolUses)
      ? toolUses.filter(isStringJson)
      : singular === undefined
        ? []
        : [singular]

    return PeerNotice.ChallengeResolved({
      peerRequestId: stringField(record, "requestId") ?? "",
      toolUseIds,
    })
  }

  if (kind === "settings_updated") {
    return PeerNotice.SettingsChanged({ settings: notification })
  }

  if (kind === "model_catalog") {
    return PeerNotice.ModelCatalog({ models: notification })
  }

  return PeerNotice.SessionDelta({ sessionId, kind, payload: notification })
}

const noticeImpl = (
  version: DialectVersion,
  bytes: Uint8Array,
  makeEndpoint?: (peerRequestId: string, kind: ChallengeKind) => ChallengeEndpoint,
): Effect.Effect<PeerNotice, BadReply | UnsupportedBinding> =>
  Effect.gen(function* () {
    void version

    const parsed = yield* Option.match(parseBytes(bytes), {
      onNone: () =>
        Effect.fail(
          new BadReply({
            message: "inbound frame is not valid JSON",
          }),
        ),
      onSome: (value) => Effect.succeed(value),
    })

    const serverRequest = Option.getOrUndefined(
      Schema.decodeUnknownOption(ServerRequestFrameSchema)(parsed),
    )

    if (serverRequest !== undefined) {
      const kind = kindOfServerMethod(serverRequest.method)

      if (kind === undefined) {
        return yield* Effect.fail(
          new UnsupportedBinding({
            message: "unreviewed server request method",
            method: serverRequest.method,
          }),
        )
      }

      const peerRequestId = String(serverRequest.id)

      const endpoint =
        makeEndpoint === undefined
          ? createChallengeEndpoint(kind, () => Effect.void)
          : makeEndpoint(peerRequestId, kind)

      if (kind === "permission") {
        const params = Option.getOrUndefined(
          Schema.decodeUnknownOption(PermissionParamsSchema)(serverRequest.params),
        )

        return PeerNotice.PermissionChallenge({
          peerRequestId,
          toolUses: params?.toolUses ?? [],
          options: params?.options ?? [],
          endpoint,
        })
      }

      if (kind === "question") {
        const params = Option.getOrUndefined(
          Schema.decodeUnknownOption(QuestionParamsSchema)(serverRequest.params),
        )

        return PeerNotice.QuestionChallenge({
          peerRequestId,
          questions: params?.questions ?? [],
          endpoint,
        })
      }

      const params = Option.getOrUndefined(
        Schema.decodeUnknownOption(OptionsParamsSchema)(serverRequest.params),
      )

      return PeerNotice.OptionsChallenge({
        peerRequestId,
        title: params?.title ?? "",
        options: params?.rows ?? params?.options ?? [],
        multiSelect: params?.multi === true || params?.multiSelect === true,
        endpoint,
      })
    }

    const notification = Option.getOrUndefined(
      Schema.decodeUnknownOption(NotificationFrameSchema)(parsed),
    )

    if (notification !== undefined) {
      const delta = sessionDeltaOf(notification.method, notification.params)

      if (delta !== undefined) return delta

      const codec = codecIndex.get(notification.method)

      if (codec === undefined || codec.direction !== "notification") {
        return PeerNotice.OtherNotice({
          method: notification.method,
          payload: notification.params ?? null,
        })
      }

      return PeerNotice.OtherNotice({
        method: notification.method,
        payload: notification.params ?? null,
      })
    }

    return yield* Effect.fail(
      new BadReply({
        message: "inbound frame is neither a notification nor a server request",
      }),
    )
  })

const jsonRpcRequestImpl = (
  id: string | number,
  binding: Binding<Schema.Json, Schema.Json>,
  params: Schema.Json,
  version: DialectVersion,
): Effect.Effect<Uint8Array, InvalidArguments> =>
  Option.match(binding.encodeParams(params), {
    onNone: () =>
      Effect.fail(
        new InvalidArguments({
          message: "arguments do not match the reviewed schema",
          method: binding.method,
        }),
      ),
    onSome: (encodedParams) =>
      Effect.succeed(
        bytesOf({
          jsonrpc: JSONRPC_VERSION,
          factoryApiVersion: version.legacyApiVersion,
          factoryProtocolVersion: version.protocolVersion,
          type: "request",
          id: String(id),
          method: binding.method,
          params: encodedParams,
        }),
      ),
  })

const jsonRpcResponseImpl = (id: string | number, result: Schema.Json): Uint8Array =>
  bytesOf({
    jsonrpc: JSONRPC_VERSION,
    factoryApiVersion: LEGACY_FACTORY_API_VERSION,
    type: "response",
    id: String(id),
    result,
  })

const jsonRpcErrorImpl = (id: string | number, code: number, message: string): Uint8Array =>
  bytesOf({
    jsonrpc: JSONRPC_VERSION,
    factoryApiVersion: LEGACY_FACTORY_API_VERSION,
    type: "response",
    id: String(id),
    error: { code, message },
  })

const reviewedBindingImpl = (
  method: string,
): Effect.Effect<Binding<Schema.Json, Schema.Json>, UnsupportedBinding> => {
  const binding = servedBindingOf(method)

  if (binding === undefined) {
    return Effect.fail(
      new UnsupportedBinding({
        message: "method has no served reviewed binding",
        method,
      }),
    )
  }

  return Effect.succeed(binding)
}

const dialectApi: DialectApi = {
  negotiate: negotiateImpl,
  encode: encodeImpl,
  reply: replyImpl,
  notice: noticeImpl,
  reviewedBinding: reviewedBindingImpl,
  reviewedMethods: () => GENERATED_CODECS.filter((codec) => codec.served).map((c) => c.method),
  jsonRpcRequest: jsonRpcRequestImpl,
  jsonRpcResponse: jsonRpcResponseImpl,
  jsonRpcError: jsonRpcErrorImpl,
}

export const dialectLayer: Layer.Layer<Dialect> = Layer.succeed(Dialect, dialectApi)
