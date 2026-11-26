/**
 * Level 8 `mcp` module: MCP negotiation, tools, resource URIs, prompts,
 * notifications, forms and compatibility encodings.
 *
 * Invariants:
 * - `bind` verifies the caller-conversation pairing before anything else:
 *   a mismatched caller fails `BindRefused`; an unsupported protocol
 *   revision fails `RevisionUnsupported`.
 * - `initialize` negotiates the revision honestly: the requested revision
 *   when supported, the default when omitted, a JSON-RPC error when the
 *   client insists on an unsupported one. Forms are never available on the
 *   sessionless revision `2026-07-28`, whatever the peer claims.
 * - Tool descriptors derive strictly from `presentation.advertise` — the
 *   module never invents tools — and every call routes through
 *   `presentation.call` / `presentation.batch` / `presentation.describe` /
 *   `presentation.continueResult`, so compact and full profiles share the
 *   one validation, authority and disclosure pipeline.
 * - Session resources and notifications resolve strictly through
 *   caller-scoped services: a foreign session id is indistinguishable from
 *   a missing one, and no notification ever crosses into another caller's
 *   stream.
 * - `resources.subscribe` is advertised only when the bound peer's
 *   transport can deliver subscription notifications, and a subscribe
 *   request on a transport that cannot is refused rather than accepted
 *   into silence.
 * - Guidance receipts mint only on successful delivery of the qualifying
 *   root document. Reference reads never acknowledge; a failed delivery
 *   never acknowledges.
 * - When forms are unavailable, an open decision is returned honestly in
 *   the pending payload — never silently dropped, never auto-answered.
 * - No request object reaches execution, no bearer parsing, no HTTP server
 *   and no unfiltered push channel exists here.
 */
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import type { Caller, Conversation } from "../caller/index.ts"
import { sameCaller } from "../caller/index.ts"
import { CURRENT_GUIDE_EDITION, Guidance } from "../guidance/index.ts"
import type { GuideText } from "../guidance/index.ts"
import { Presented, Presentation } from "../presentation/index.ts"
import type { BatchStepRequest, DiscoveryQuery, View } from "../presentation/index.ts"
import { Sessions } from "../sessions/index.ts"
import type { SessionChange, SessionSummary } from "../sessions/index.ts"
import {
  cursorOfPayload,
  elicitFor,
  formsAvailable,
  pendingDecisionsOf,
  sessionIdOfPayload,
  statusOfPayload,
} from "./private/forms.ts"
import { KNOWN_METHODS, recordOf, stringField } from "./private/frames.ts"
import {
  isJsonObject,
  readBatchArguments,
  readNamesList,
  readOptionalNumber,
  readOptionalString,
  readToolCallParams,
  readStreamDelivery,
} from "./private/payloads.ts"
import {
  parseCursor,
  parseResourceUri,
  SKILL_ROOT_URI,
  SKILL_URI_PREFIX,
} from "./private/resources.ts"
import {
  BindRefused,
  DEFAULT_PROTOCOL_REVISION,
  EndpointClosed,
  InvalidFrame,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  RevisionUnsupported,
  SESSIONLESS_PROTOCOL_REVISION,
  SUPPORTED_PROTOCOL_REVISIONS,
} from "./private/types.ts"
import type {
  FormAnswer,
  FormDeclined,
  FormRequest,
  FrameId,
  McpFrame,
  McpNotification,
  McpReply,
  PeerAbilities,
} from "./private/types.ts"
import {
  failureReply,
  finishSessionPayload,
  renderBatch,
  renderCallFailure,
  renderDiscovery,
  renderPresented,
  renderResultPage,
  renderToolFailure,
  renderToolsList,
  renderToolSuccess,
  SESSIONS_URI,
  sessionUriOf,
} from "./private/wire.ts"

export {
  BindRefused,
  DEFAULT_PROTOCOL_REVISION,
  EndpointClosed,
  InvalidFrame,
  RevisionUnsupported,
  SESSIONLESS_PROTOCOL_REVISION,
  SUPPORTED_PROTOCOL_REVISIONS,
}

export type {
  FormAnswer,
  FormDeclined,
  FormRequest,
  FrameId,
  McpFrame,
  McpNotification,
  McpReply,
  PeerAbilities,
}

// ---------------------------------------------------------------------------
// Service types
// ---------------------------------------------------------------------------

export interface McpEndpoint {
  readonly receive: (frame: McpFrame) => Effect.Effect<McpReply, InvalidFrame | EndpointClosed>
  readonly notifications: () => Stream.Stream<McpNotification, EndpointClosed>
  readonly close: () => Effect.Effect<void>
}

export interface McpApi {
  readonly bind: (
    view: View,
    caller: Caller,
    scope: Conversation,
    peer: PeerAbilities,
  ) => Effect.Effect<McpEndpoint, RevisionUnsupported | BindRefused>
}

export class Mcp extends Context.Service<Mcp, McpApi>()("droid-mcp/mcp") {}

export interface McpOptions {
  readonly serverName?: string | undefined
  readonly serverVersion?: string | undefined
  readonly cacheHints?: boolean | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const supported = (revision: string): boolean =>
  // SAFETY: the readonly tuple widens to a plain readonly string array for
  // membership testing only; no element is read or written through it.
  (SUPPORTED_PROTOCOL_REVISIONS as ReadonlyArray<string>).includes(revision)

type EncodedSummaryWire = {
  readonly uri: string
  readonly sessionId: string
  readonly status: string
  readonly cursor: number
  cwd?: string
}

const encodeSummary = (summary: SessionSummary): EncodedSummaryWire => {
  const out: EncodedSummaryWire = {
    uri: sessionUriOf(summary.sessionId),
    sessionId: summary.sessionId,
    status: summary.status,
    cursor: summary.cursor,
  }

  if (summary.cwd !== undefined) out.cwd = summary.cwd

  return out
}

const textContent = (text: string, uri: string): Schema.Json => ({
  contents: [{ uri, mimeType: "text/markdown", text }],
})

const jsonContent = (value: Schema.Json, uri: string): Schema.Json => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
})

/** Named shapes for partially built request and wire payloads. */
type EventsBodyWire = {
  sessionId: string
  cursor: number
  events: ReadonlyArray<Schema.Json>
  truncated: boolean
  omittedCount?: number
  eventsOmitted?: boolean
}

type CallRequestWire = {
  name: string
  arguments: Schema.Json
  select?: string
  maxBytes?: number
}

type SearchQueryWire = {
  query?: string
  family?: DiscoveryQuery["family"]
  readOnly?: boolean
  limit?: number
  offset?: number
}

type BatchStepWireInput = {
  id?: string
  name: string
  arguments?: Schema.Json
  select?: string
}

type BatchRequestWire = {
  steps: ReadonlyArray<BatchStepRequest>
  stopOnError: boolean
  maxBytes?: number
}

type ResultRangeWire = {
  offset?: number
  length?: number
  select?: string
}

const operationFamilyOf = (value: Schema.Json): DiscoveryQuery["family"] | undefined => {
  switch (value) {
    case "server":
    case "skill":
    case "session":
    case "rest":
    case "context":
    case "daemon":
    case "droid":
      return value
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const mcpLayer = (
  options?: McpOptions,
): Layer.Layer<Mcp, never, Presentation | Sessions | Guidance> =>
  Layer.effect(
    Mcp,
    Effect.gen(function* () {
      const presentation = yield* Presentation
      const sessions = yield* Sessions
      const guidance = yield* Guidance

      const serverName = options?.serverName ?? "droid-mcp"
      const serverVersion = options?.serverVersion ?? "0.1.0"

      const bind: McpApi["bind"] = (view, caller, scope, peer) =>
        Effect.gen(function* () {
          if (!sameCaller(caller, scope.caller)) {
            return yield* Effect.fail(
              new BindRefused({
                message: "caller does not own the conversation scope",
                reason: "caller_mismatch",
              }),
            )
          }

          if (peer.protocolRevision !== undefined && !supported(peer.protocolRevision)) {
            return yield* Effect.fail(
              new RevisionUnsupported({
                message: "protocol revision " + peer.protocolRevision + " is not supported",
                revision: peer.protocolRevision,
                supported: [...SUPPORTED_PROTOCOL_REVISIONS],
              }),
            )
          }

          // The invocation evidence handed to presentation. `Invocation` is
          // a plain data interface owned by `capabilities`; this module has
          // no capabilities edge, so the shape is restated structurally and
          // presentation accepts it by structural typing.
          const who = { caller, conversation: scope }

          let closed = false
          let revision = peer.protocolRevision ?? DEFAULT_PROTOCOL_REVISION

          /**
           * Whether this peer's transport can actually deliver resource
           * subscription notifications. Advertising `resources.subscribe`
           * without a carrier that forwards the notification stream would
           * promise updates that never arrive.
           */
          const subscriptionsSupported = peer.supportsSubscriptions ?? false

          const closeSignal = yield* Deferred.make<void>()

          /**
           * Guidance acknowledgment after successful root delivery only.
           * Minting the proof requires the unaltered root document;
           * `acknowledge` records the receipt in this exact conversation.
           */
          const acknowledgeRoot = (doc: GuideText): Effect.Effect<void> =>
            Effect.gen(function* () {
              const proof = yield* Effect.result(guidance.confirmRootDelivery(doc))

              if (Result.isFailure(proof)) return

              yield* Effect.result(guidance.acknowledge(scope, proof.success))
            })

          /** Fetches the root document and acknowledges it once delivered. */
          const deliverRootDocument = (): Effect.Effect<GuideText | undefined> =>
            Effect.gen(function* () {
              const doc = yield* Effect.result(guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md"))

              if (Result.isFailure(doc)) return undefined

              yield* acknowledgeRoot(doc.success)

              return doc.success
            })

          // -----------------------------------------------------------------
          // Resource content resolvers
          // -----------------------------------------------------------------

          const readGuideResource = (
            id: FrameId,
            uri: string,
            part: string,
            isRootPart: boolean,
          ): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const doc = yield* Effect.result(guidance.document(CURRENT_GUIDE_EDITION, part))

              if (Result.isFailure(doc)) {
                return failureReply(id, "resource_not_found", "no resource at " + uri)
              }

              // Acknowledge ONLY with the content in hand and ONLY for the
              // qualifying root part; reference parts never open the gate.
              if (isRootPart && doc.success.isRoot) {
                yield* acknowledgeRoot(doc.success)
              }

              return {
                kind: "result" as const,
                id,
                result: textContent(doc.success.content, uri),
              }
            })

          const sessionNotFound = (id: FrameId, uri: string, sessionId: string): McpReply => ({
            kind: "result",
            id,
            result: jsonContent({ uri, error: "session_not_found", sessionId }, uri),
          })

          const readSessionsList = (id: FrameId): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const visible = yield* Effect.result(sessions.listVisible(caller))

              const listing: Array<EncodedSummaryWire> = []

              if (Result.isSuccess(visible)) {
                for (const summary of visible.success) {
                  listing.push(encodeSummary(summary))
                }
              }

              return {
                kind: "result" as const,
                id,
                result: jsonContent({ sessions: listing }, SESSIONS_URI),
              }
            })

          const readSessionDetail = (id: FrameId, sessionId: string): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const uri = sessionUriOf(sessionId)
              const resolved = yield* Effect.result(sessions.resolveId(caller, sessionId, "read"))

              if (Result.isFailure(resolved)) {
                // Foreign and missing sessions are deliberately identical.
                return sessionNotFound(id, uri, sessionId)
              }

              const summary = yield* Effect.result(resolved.success.summary())

              if (Result.isFailure(summary)) {
                return sessionNotFound(id, uri, sessionId)
              }

              return {
                kind: "result" as const,
                id,
                result: jsonContent(encodeSummary(summary.success), uri),
              }
            })

          const readSessionEvents = (
            id: FrameId,
            sessionId: string,
            cursorText: string,
          ): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const uri = sessionUriOf(sessionId) + "/events/" + cursorText
              const cursor = parseCursor(cursorText)

              if (cursor === undefined) {
                return {
                  kind: "result" as const,
                  id,
                  result: jsonContent({ error: "invalid_cursor" }, uri),
                }
              }

              const resolved = yield* Effect.result(sessions.resolveId(caller, sessionId, "read"))

              if (Result.isFailure(resolved)) {
                return {
                  kind: "result" as const,
                  id,
                  result: jsonContent({ error: "session_not_found", sessionId }, uri),
                }
              }

              const page = yield* Effect.result(resolved.success.observeAtOffset(cursor, 0))

              if (Result.isFailure(page)) {
                return {
                  kind: "result" as const,
                  id,
                  result: jsonContent(
                    { error: "invalid_cursor", message: page.failure.message },
                    uri,
                  ),
                }
              }

              const events: Array<Schema.Json> = []

              for (const item of page.success.items) {
                const json = Match.value(item.payload).pipe(
                  Match.when({ _tag: "JsonValue" }, (variant) => variant.value),
                  Match.orElse(() => null),
                )

                events.push(json)
              }

              const body: EventsBodyWire = {
                sessionId,
                cursor: page.success.cursor,
                events,
                truncated: page.success.gap,
              }

              if (page.success.gap && page.success.omittedCount > 0) {
                body.omittedCount = page.success.omittedCount
                body.eventsOmitted = true
              }

              return { kind: "result" as const, id, result: jsonContent(body, uri) }
            })

          const readResource = (id: FrameId, uri: string): Effect.Effect<McpReply> => {
            const parsed = parseResourceUri(uri)

            return Match.value(parsed).pipe(
              Match.when({ kind: "skill-root" }, () =>
                readGuideResource(id, uri, "SKILL.md", true),
              ),
              Match.when({ kind: "skill-reference" }, (variant) =>
                readGuideResource(id, uri, variant.part, false),
              ),
              Match.when({ kind: "sessions-list" }, () => readSessionsList(id)),
              Match.when({ kind: "session" }, (variant) =>
                readSessionDetail(id, variant.sessionId),
              ),
              Match.when({ kind: "session-events" }, (variant) =>
                readSessionEvents(id, variant.sessionId, variant.cursorText),
              ),
              Match.orElse(() =>
                Effect.succeed(failureReply(id, "resource_not_found", "no resource at " + uri)),
              ),
            )
          }

          const listResources = (id: FrameId): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const parts = yield* Effect.result(guidance.listParts(CURRENT_GUIDE_EDITION))

              const resources: Array<Schema.Json> = []

              if (Result.isSuccess(parts)) {
                for (const part of parts.success) {
                  resources.push({
                    uri: SKILL_URI_PREFIX + part,
                    name: part,
                    mimeType: "text/markdown",
                  })
                }
              }

              resources.push({
                uri: SESSIONS_URI,
                name: "sessions",
                description: "Live local Droid sessions. Read one session URI for its status.",
                mimeType: "application/json",
              })

              return { kind: "result" as const, id, result: { resources } }
            })

          const listResourceTemplates = (id: FrameId): McpReply => ({
            kind: "result",
            id,
            result: {
              resourceTemplates: [
                {
                  uriTemplate: "droid://sessions/{sessionId}",
                  name: "session",
                  description: "One live local session: status, cursor, cwd, and worktree.",
                  mimeType: "application/json",
                },
                {
                  uriTemplate: "droid://sessions/{sessionId}/events/{cursor}",
                  name: "session-events",
                  description: "Events since a cursor. The cursor is the next sequence number.",
                  mimeType: "application/json",
                },
              ],
            },
          })

          // -----------------------------------------------------------------
          // tools/call dispatch
          // -----------------------------------------------------------------

          /** Renders a presented inline value with session payload finishing. */
          const renderInline = (
            id: FrameId,
            presented: Presented,
            sessionPayload: boolean,
          ): McpReply => {
            if (sessionPayload && Presented.$is("Inline")(presented)) {
              return renderToolSuccess(id, finishSessionPayload(presented.value))
            }

            return renderPresented(id, presented)
          }

          /** Runs `presentation.call` and renders the outcome. */
          const runCall = (
            id: FrameId,
            name: string,
            args: Schema.Json,
            select: string | undefined,
            maxBytes: number | undefined,
            sessionPayload: boolean,
            unknownOperationChannel: "protocol" | "tool",
          ): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const request: CallRequestWire = { name, arguments: args }

              if (select !== undefined) request.select = select

              if (maxBytes !== undefined) request.maxBytes = maxBytes

              const outcome = yield* Effect.result(presentation.call(view, who, request))

              if (Result.isFailure(outcome)) {
                if (
                  unknownOperationChannel === "protocol" &&
                  outcome.failure.code === "unknown_operation"
                ) {
                  return failureReply(id, outcome.failure.code, outcome.failure.message)
                }

                return renderCallFailure(id, outcome.failure)
              }

              return renderInline(id, outcome.success, sessionPayload)
            })

          /**
           * Form-eliciting blocking delivery. After `presentation.call`
           * returns the blocking payload, a pending decision may be answered
           * through the peer's form channel — when the revision allows forms
           * and the peer implements one. A declined form, a mismatched
           * answer or a sessionless revision leaves the decision honestly
           * open in the returned payload.
           */
          const streamWithForms = (id: FrameId, args: Schema.Json): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const first = yield* Effect.result(
                presentation.call(view, who, { name: "session_stream", arguments: args }),
              )

              if (Result.isFailure(first)) {
                return renderCallFailure(id, first.failure)
              }

              const presented = first.success

              if (!Presented.$is("Inline")(presented) || !isJsonObject(presented.value)) {
                return renderPresented(id, presented)
              }

              if (readStreamDelivery(args) !== "block" || !formsAvailable(peer, revision)) {
                return renderToolSuccess(id, finishSessionPayload(presented.value))
              }

              // Form-eligible path: answer at most one pending decision per
              // round, re-observing through session_events afterwards.
              let payload: Schema.Json = presented.value

              for (let round = 0; round < 8; round += 1) {
                if (statusOfPayload(payload) !== "running") break

                const pending = pendingDecisionsOf(payload)
                const decision = pending[0]

                if (decision === undefined) break

                const sessionId = sessionIdOfPayload(payload)

                if (sessionId === undefined) break

                const answerPayload = yield* elicitFor(peer, sessionId, decision)

                if (answerPayload === undefined) {
                  // Honestly open: the peer cannot or will not answer through
                  // a form, so the caller answers with the session tools.
                  break
                }

                const answered = yield* Effect.result(
                  presentation.call(view, who, {
                    name: answerPayload.operation,
                    arguments: answerPayload.wireArguments,
                  }),
                )

                if (Result.isFailure(answered)) break

                // Wait for the turn to settle after the answer: `session_events`
                // returns on any new event (including the decision-resolved
                // event), so keep advancing the cursor until the turn finishes,
                // surfaces another decision, or stops making progress.
                for (let poll = 0; poll < 32; poll += 1) {
                  const cursor: number = cursorOfPayload(payload) ?? 0

                  const observed = yield* Effect.result(
                    presentation.call(view, who, {
                      name: "session_events",
                      arguments: { sessionId, cursor, waitMs: 5_000 },
                    }),
                  )

                  if (Result.isFailure(observed)) break

                  if (!Presented.$is("Inline")(observed.success)) break

                  const nextPayload: Schema.Json = observed.success.value
                  const nextCursor: number = cursorOfPayload(nextPayload) ?? cursor

                  payload = nextPayload

                  if (
                    statusOfPayload(payload) !== "running" ||
                    pendingDecisionsOf(payload).length > 0 ||
                    nextCursor === cursor
                  ) {
                    break
                  }
                }
              }

              return renderToolSuccess(id, finishSessionPayload(payload))
            })

          const dispatchMetaTool = (
            id: FrameId,
            name: string,
            args: Schema.Json,
          ): Effect.Effect<McpReply> => {
            if (name === "tools_search") {
              return Effect.gen(function* () {
                const searchText = stringField(args, "query")
                const record = recordOf(args)
                const query: SearchQueryWire = {}

                if (searchText !== undefined) query.query = searchText

                if (record !== undefined) {
                  const family = operationFamilyOf(record.family)
                  const readOnly = record.readOnly
                  const limit = readOptionalNumber(record, "limit")
                  const offset = readOptionalNumber(record, "offset")

                  if (family !== undefined) query.family = family

                  if (Predicate.isBoolean(readOnly)) query.readOnly = readOnly

                  if (limit !== undefined) query.limit = limit

                  if (offset !== undefined) query.offset = offset
                }

                const page = yield* Effect.result(presentation.describe(view, who, query))

                if (Result.isFailure(page)) {
                  return renderToolFailure(id, "internal_error", "discovery failed")
                }

                return renderToolSuccess(id, renderDiscovery(page.success))
              })
            }

            if (name === "tools_describe") {
              return Effect.gen(function* () {
                const page = yield* Effect.result(
                  presentation.describe(view, who, { names: readNamesList(args) }),
                )

                if (Result.isFailure(page)) {
                  return renderToolFailure(id, "invalid_arguments", "describe needs 1 to 20 names")
                }

                return renderToolSuccess(id, renderDiscovery(page.success))
              })
            }

            if (name === "tool_call") {
              const innerName = stringField(args, "name")

              if (innerName === undefined) {
                return Effect.succeed(
                  renderToolFailure(id, "invalid_arguments", "tool_call needs a name"),
                )
              }

              const inner = recordOf(args)

              return runCall(
                id,
                innerName,
                inner === undefined ? {} : (inner.arguments ?? {}),
                stringField(args, "select"),
                inner === undefined ? undefined : readOptionalNumber(inner, "maxBytes"),
                innerName.startsWith("session_"),
                "tool",
              )
            }

            if (name === "batch") {
              return Effect.gen(function* () {
                const decoded = readBatchArguments(args)

                if (decoded === undefined) {
                  return renderToolFailure(
                    id,
                    "invalid_arguments",
                    "batch needs an array of valid steps",
                  )
                }

                const steps: Array<BatchStepRequest> = []

                for (const step of decoded.steps) {
                  const wire: BatchStepWireInput = { name: step.name }

                  if (step.id !== undefined) wire.id = step.id

                  if (step.stepArguments !== undefined) wire.arguments = step.stepArguments

                  if (step.select !== undefined) wire.select = step.select

                  steps.push(wire)
                }

                const batchRequest: BatchRequestWire = {
                  steps,
                  stopOnError: decoded.stopOnError,
                }

                if (decoded.maxBytes !== undefined) batchRequest.maxBytes = decoded.maxBytes

                const report = yield* Effect.result(presentation.batch(view, who, batchRequest))

                if (Result.isFailure(report)) {
                  return renderToolFailure(id, report.failure.code, report.failure.message)
                }

                return renderToolSuccess(id, renderBatch(report.success))
              })
            }

            // result_read
            return Effect.gen(function* () {
              const ref = stringField(args, "ref")

              if (ref === undefined) {
                return renderToolFailure(id, "invalid_arguments", "result_read needs a ref")
              }

              const record = recordOf(args)

              const range: ResultRangeWire = {}

              if (record !== undefined) {
                const offsetValue = readOptionalNumber(record, "offset")
                const lengthValue = readOptionalNumber(record, "length")
                const selectValue = readOptionalString(record, "select")

                if (offsetValue !== undefined) range.offset = offsetValue

                if (lengthValue !== undefined) range.length = lengthValue

                if (selectValue !== undefined) range.select = selectValue
              }

              const page = yield* Effect.result(presentation.continueResult(who, ref, range))

              if (Result.isFailure(page)) {
                return Match.value(page.failure).pipe(
                  Match.when({ _tag: "ArtifactUnavailable" }, (variant) =>
                    renderToolFailure(id, "artifact_unavailable", variant.message, ref),
                  ),
                  Match.when({ _tag: "InvalidRange" }, (variant) =>
                    renderToolFailure(id, "invalid_offset", variant.message),
                  ),
                  Match.exhaustive,
                )
              }

              return renderToolSuccess(id, renderResultPage(page.success))
            })
          }

          const dispatchToolCall = (
            id: FrameId,
            name: string,
            args: Schema.Json,
          ): Effect.Effect<McpReply> => {
            const isMeta =
              name === "tools_search" ||
              name === "tools_describe" ||
              name === "tool_call" ||
              name === "batch" ||
              name === "result_read"

            if (isMeta) {
              // Meta-tools are reachable only when the view advertises them
              // (compact profile); a full view never lists them.
              if (!view.advertisedNames.includes(name)) {
                return Effect.succeed(
                  failureReply(id, "unknown_tool", "no operation named " + name),
                )
              }

              return dispatchMetaTool(id, name, args)
            }

            if (name === "skill_read") {
              return Effect.gen(function* () {
                const doc = yield* deliverRootDocument()

                if (doc === undefined) {
                  return renderToolFailure(
                    id,
                    "internal_error",
                    "the guide document is unavailable",
                  )
                }

                return renderToolSuccess(id, { uri: SKILL_ROOT_URI, markdown: doc.content })
              })
            }

            if (name === "session_stream") {
              return streamWithForms(id, args)
            }

            return runCall(
              id,
              name,
              args,
              undefined,
              undefined,
              name.startsWith("session_"),
              "protocol",
            )
          }

          // -----------------------------------------------------------------
          // Frame handling
          // -----------------------------------------------------------------

          const handleInitialize = (id: FrameId, params: Schema.Json): McpReply => {
            const requested = stringField(params, "protocolVersion")

            if (requested !== undefined && !supported(requested)) {
              return {
                kind: "error",
                id,
                code: JSON_RPC_INVALID_PARAMS,
                message: "unsupported protocol version " + requested,
                data: { supported: [...SUPPORTED_PROTOCOL_REVISIONS], requested },
              }
            }

            revision = requested ?? revision

            type CapabilitiesWire = {
              readonly tools: { readonly listChanged: boolean }
              readonly resources: { readonly subscribe: boolean; readonly listChanged: boolean }
              readonly prompts: { readonly listChanged: boolean }
              elicitation?: Record<string, never>
            }

            const capabilities: CapabilitiesWire = {
              tools: { listChanged: false },
              resources: { subscribe: subscriptionsSupported, listChanged: false },
              prompts: { listChanged: false },
            }

            if (formsAvailable(peer, revision)) {
              capabilities.elicitation = {}
            }

            return {
              kind: "result",
              id,
              result: {
                protocolVersion: revision,
                serverInfo: { name: serverName, version: serverVersion },
                capabilities,
                instructions: presentation.instructions(view),
              },
            }
          }

          const handlePromptsGet = (id: FrameId, params: Schema.Json): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const name = stringField(params, "name")

              if (name !== "droid") {
                return failureReply(id, "prompt_not_found", "no prompt named " + String(name))
              }

              const doc = yield* deliverRootDocument()

              if (doc === undefined) {
                return failureReply(id, "internal_error", "the guide document is unavailable")
              }

              return {
                kind: "result" as const,
                id,
                result: {
                  messages: [{ role: "user", content: { type: "text", text: doc.content } }],
                },
              }
            })

          const handleSkillsGet = (id: FrameId, params: Schema.Json): Effect.Effect<McpReply> =>
            Effect.gen(function* () {
              const uri = stringField(params, "uri") ?? stringField(params, "name")

              if (uri !== SKILL_ROOT_URI) {
                return failureReply(id, "skill_not_found", "no skill at " + String(uri))
              }

              const doc = yield* deliverRootDocument()

              if (doc === undefined) {
                return failureReply(id, "internal_error", "the guide document is unavailable")
              }

              const parts = yield* Effect.result(guidance.listParts(CURRENT_GUIDE_EDITION))

              const files: Array<Schema.Json> = []

              if (Result.isSuccess(parts)) {
                for (const part of parts.success) {
                  if (part === "SKILL.md") continue

                  const reference = yield* Effect.result(
                    guidance.document(CURRENT_GUIDE_EDITION, part),
                  )

                  if (Result.isSuccess(reference)) {
                    files.push({
                      uri: SKILL_URI_PREFIX + part,
                      name: part,
                      content: reference.success.content,
                    })
                  }
                }
              }

              return {
                kind: "result" as const,
                id,
                result: { uri: SKILL_ROOT_URI, content: doc.content, files },
              }
            })

          const dispatch = (
            id: FrameId,
            method: string,
            params: Schema.Json,
          ): Effect.Effect<McpReply> => {
            if (method === "initialize") return Effect.succeed(handleInitialize(id, params))

            if (method === "ping") {
              return Effect.succeed({ kind: "result" as const, id, result: {} })
            }

            if (method === "tools/list") {
              return Effect.gen(function* () {
                const inventory = yield* Effect.result(presentation.advertise(view, who))

                if (Result.isFailure(inventory)) {
                  return failureReply(id, "internal_error", "the inventory is unavailable")
                }

                return {
                  kind: "result" as const,
                  id,
                  result: renderToolsList(inventory.success),
                }
              })
            }

            if (method === "tools/call") {
              const parsed = readToolCallParams(params)

              if (parsed === undefined) {
                return Effect.succeed(
                  failureReply(id, "invalid_arguments", "tools/call needs a non-empty name"),
                )
              }

              return dispatchToolCall(id, parsed.name, parsed.callArguments)
            }

            if (method === "resources/list") return listResources(id)

            if (method === "resources/templates/list") {
              return Effect.succeed(listResourceTemplates(id))
            }

            if (method === "resources/read") {
              const uri = stringField(params, "uri")

              if (uri === undefined) {
                return Effect.succeed(
                  failureReply(id, "invalid_arguments", "resources/read needs a uri"),
                )
              }

              return readResource(id, uri)
            }

            if (method === "resources/subscribe" || method === "resources/unsubscribe") {
              if (method === "resources/subscribe" && !subscriptionsSupported) {
                return Effect.succeed({
                  kind: "error" as const,
                  id,
                  code: JSON_RPC_METHOD_NOT_FOUND,
                  message: "resource subscriptions are not available on this transport",
                })
              }

              const uri = stringField(params, "uri")

              if (uri === undefined || parseResourceUri(uri).kind === "unknown") {
                return Effect.succeed(
                  failureReply(id, "invalid_arguments", method + " needs a known resource uri"),
                )
              }

              return Effect.succeed({ kind: "result" as const, id, result: {} })
            }

            if (method === "prompts/list") {
              return Effect.succeed({
                kind: "result" as const,
                id,
                result: {
                  prompts: [
                    {
                      name: "droid",
                      description:
                        "Read the droid skill: token-efficient turns, dispatch, and all capability families.",
                    },
                  ],
                },
              })
            }

            if (method === "prompts/get") return handlePromptsGet(id, params)

            if (method === "skills/list") {
              return Effect.gen(function* () {
                const parts = yield* Effect.result(guidance.listParts(CURRENT_GUIDE_EDITION))

                const files: Array<Schema.Json> = []

                if (Result.isSuccess(parts)) {
                  for (const part of parts.success) {
                    files.push({ uri: SKILL_URI_PREFIX + part, name: part })
                  }
                }

                return {
                  kind: "result" as const,
                  id,
                  result: { skills: [{ uri: SKILL_ROOT_URI, name: "droid", files }] },
                }
              })
            }

            if (method === "skills/get") return handleSkillsGet(id, params)

            return Effect.succeed({
              kind: "error",
              id,
              code: JSON_RPC_METHOD_NOT_FOUND,
              message: "method not found: " + method,
            })
          }

          const receive = (
            frame: McpFrame,
          ): Effect.Effect<McpReply, InvalidFrame | EndpointClosed> =>
            Effect.suspend((): Effect.Effect<McpReply, InvalidFrame | EndpointClosed> => {
              if (closed) {
                return Effect.fail(new EndpointClosed({ message: "endpoint is closed" }))
              }

              if (frame.kind === "notification") {
                // Notifications never produce a reply; unknown ones are
                // tolerated because peers routinely send lifecycle notices.
                return Effect.succeed({ kind: "ack" })
              }

              if (!KNOWN_METHODS.includes(frame.method)) {
                return Effect.succeed({
                  kind: "error",
                  id: frame.id,
                  code: JSON_RPC_METHOD_NOT_FOUND,
                  message: "method not found: " + frame.method,
                })
              }

              return dispatch(frame.id, frame.method, frame.params)
            })

          const notifications = (): Stream.Stream<McpNotification, EndpointClosed> => {
            const uriOfChange = (change: SessionChange): string | undefined =>
              Match.value(change).pipe(
                Match.when({ _tag: "Created" }, (variant) => variant.summary.sessionId),
                Match.when({ _tag: "Updated" }, (variant) => variant.summary.sessionId),
                Match.when({ _tag: "Closed" }, (variant) => variant.sessionId),
                Match.exhaustive,
              )

            return sessions.watchVisible(caller).pipe(
              Stream.catch(() => Stream.empty),
              Stream.filterMap(
                Filter.fromPredicateOption(
                  (change: SessionChange): Option.Option<McpNotification> =>
                    Option.some({
                      method: "notifications/resources/updated",
                      params: { uri: sessionUriOf(uriOfChange(change) ?? "") },
                    }),
                ),
              ),
              Stream.interruptWhen(Effect.asVoid(Deferred.await(closeSignal))),
              Stream.mapError(() => new EndpointClosed({ message: "endpoint is closed" })),
            )
          }

          const close = (): Effect.Effect<void> =>
            Effect.suspend(() => {
              if (closed) return Effect.void

              closed = true

              return Effect.asVoid(Deferred.complete(closeSignal, Effect.void))
            })

          return { receive, notifications, close } satisfies McpEndpoint
        })

      return { bind }
    }),
  )
