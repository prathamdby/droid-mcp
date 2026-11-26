/**
 * Public-adjacent types for the `mcp` module: protocol revisions, frame and
 * reply shapes, peer abilities and the endpoint-facing tagged errors. No
 * types imported from other `src/` modules appear here — boundary rules
 * forbid re-exporting them — so anything cross-module stays in `index.ts`.
 */
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** The protocol revisions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_REVISIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2026-07-28",
] as const

/**
 * The sessionless revision: no elicitation forms and no server-initiated
 * requests exist on it, so forms are never available there.
 */
export const SESSIONLESS_PROTOCOL_REVISION = "2026-07-28"

/** The revision chosen when a client omits its preference. */
export const DEFAULT_PROTOCOL_REVISION = "2025-11-25"

// ---------------------------------------------------------------------------
// Peer abilities
// ---------------------------------------------------------------------------

/** One open form request handed to a form-capable peer. */
export interface FormRequest {
  readonly kind: "permission" | "question" | "options"
  readonly summary: string
  readonly details: Schema.Json
}

/** The peer's answer to one form request. */
export type FormAnswer =
  | {
      readonly kind: "permission"
      readonly outcome: string
      readonly comment?: string | undefined
      readonly editedSpecContent?: string | undefined
    }
  | {
      readonly kind: "question"
      readonly answers: ReadonlyArray<{ readonly index: number; readonly answer: string }>
    }
  | {
      readonly kind: "options"
      readonly selectedIds: ReadonlyArray<string>
      readonly refresh?: boolean | undefined
    }

/** The peer declined or abandoned the form; the decision stays open. */
export interface FormDeclined {
  readonly reason: string
}

/**
 * The actual return channel of the peer this endpoint talks to. It never
 * encodes assumed server-initiated support: a client that cannot render
 * forms (`supportsForms: false` or no `elicit` callback) or one speaking the
 * sessionless revision simply has no form channel, and open decisions are
 * returned honestly for the caller to answer with the session tools.
 */
export interface PeerAbilities {
  readonly protocolRevision?: string | undefined
  readonly supportsForms: boolean
  readonly supportsSubscriptions?: boolean | undefined
  readonly elicit?: ((request: FormRequest) => Effect.Effect<FormAnswer, FormDeclined>) | undefined
}

// ---------------------------------------------------------------------------
// Frames and replies
// ---------------------------------------------------------------------------

/** JSON-RPC scalar identifier. */
export type FrameId = string | number

/**
 * A checked incoming frame. A request carries an `id` and expects a reply;
 * a notification carries none and is accepted silently.
 */
export type McpFrame =
  | {
      readonly kind: "request"
      readonly id: FrameId
      readonly method: string
      readonly params: Schema.Json
    }
  | {
      readonly kind: "notification"
      readonly method: string
      readonly params: Schema.Json
    }

/**
 * The outcome of one frame. Error replies encode the legacy failure
 * vocabulary as `data: { code, message, ref? }` so clients keep parsing
 * failure codes exactly as they did on the legacy server.
 */
export type McpReply =
  | { readonly kind: "result"; readonly id: FrameId; readonly result: Schema.Json }
  | {
      readonly kind: "error"
      readonly id: FrameId
      readonly code: number
      readonly message: string
      readonly data?: Schema.Json | undefined
    }
  | { readonly kind: "ack" }

/** One pushed resource-updated notice. */
export interface McpNotification {
  readonly method: "notifications/resources/updated"
  readonly params: { readonly uri: string }
}

// ---------------------------------------------------------------------------
// Endpoint errors
// ---------------------------------------------------------------------------

export class RevisionUnsupported extends Schema.TaggedError<RevisionUnsupported>()(
  "RevisionUnsupported",
  {
    message: Schema.String,
    revision: Schema.String,
    supported: Schema.Array(Schema.String),
  },
) {}

export class BindRefused extends Schema.TaggedError<BindRefused>()("BindRefused", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export class InvalidFrame extends Schema.TaggedError<InvalidFrame>()("InvalidFrame", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export class EndpointClosed extends Schema.TaggedError<EndpointClosed>()("EndpointClosed", {
  message: Schema.String,
}) {}

/** JSON-RPC error codes this module emits on the wire. */
export const JSON_RPC_PARSE_ERROR = -32_700
export const JSON_RPC_INVALID_REQUEST = -32_600
export const JSON_RPC_METHOD_NOT_FOUND = -32_601
export const JSON_RPC_INVALID_PARAMS = -32_602
export const JSON_RPC_INTERNAL_ERROR = -32_603

/**
 * The application error code carrying legacy `{ code, message }` failures:
 * the structured copy lives in `data`.
 */
export const JSON_RPC_OPERATION_FAILED = -32_000
