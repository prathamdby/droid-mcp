import { statSync } from "node:fs"
import { isAbsolute } from "node:path"

import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

import type { AutonomyLevel } from "../config.ts"
import type { Logger } from "../log.ts"
import { ExecTimeout } from "./errors.ts"
import { start } from "./exec-client.ts"
import type { ExecClient, ExecRequest } from "./exec-client.ts"
import { EXEC_METHOD } from "./exec-protocol.ts"
import { capPermissionOptions, promptEvent, viewOf } from "./prompts.ts"
import type { Prompt, PromptView } from "./prompts.ts"
import type { JsonValue } from "./protocol.ts"
import { presentFields, toJsonValue } from "./protocol.ts"

/** Text in an event is capped so one long block cannot bloat every poll. */
export const EVENT_TEXT_LIMIT = 4 * 1024
export const RING_EVENT_LIMIT = 500
export const RING_BYTE_LIMIT = 256 * 1024
export const DEFAULT_WAIT_MS = 20_000
export const MAX_WAIT_MS = 300_000
export const IDLE_SESSION_MS = 30 * 60 * 1000
export const REAPER_INTERVAL_MS = 60_000
export const PROMPT_TIMEOUT_MS = 300_000

/** One permission field stays small enough that the event itself still fits the ring. */
export const FIELD_BYTE_LIMIT = 1024
const TRUNCATION_MARK = "…[truncated]"

/**
 * Live answered permissions that can still name a public id. Dropping the
 * oldest record does not make its keys fresh again.
 */
export const CORRELATION_LIMIT = 32

/**
 * CLI and tool ids already used by an answered, timed-out, or retired
 * permission in this turn. When the set is full, public-id inference stops
 * instead of treating an untracked id as new.
 */
export const SEEN_KEY_LIMIT = 96
const CHANGE_DIRECTORY = "droid.change_working_directory"

export const TurnStatusSchema = Schema.Literals(["running", "completed", "interrupted", "failed"])

export type TurnStatus = typeof TurnStatusSchema.Type

/** Sequence numbers and cursors; finite, so the advertised schema has no NaN/Infinity branch. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const TurnEventSchema = Schema.Struct({
  seq: Count,
  kind: Schema.String,
  text: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  toolUseId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Json),
  output: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  status: Schema.optional(TurnStatusSchema),
  reason: Schema.optional(Schema.String),
  promptType: Schema.optional(Schema.String),
  deadline: Schema.optional(Schema.Finite),
  options: Schema.optional(Schema.Array(Schema.String)),
  toolUses: Schema.optional(Schema.Array(Schema.Json)),
  questions: Schema.optional(Schema.Array(Schema.Json)),
  rows: Schema.optional(Schema.Array(Schema.Json)),
  multi: Schema.optional(Schema.Boolean),
})

export type TurnEvent = typeof TurnEventSchema.Type

export const TurnResultSchema = Schema.Struct({
  sessionId: Schema.String,
  status: TurnStatusSchema,
  cursor: Count,
  events: Schema.Array(TurnEventSchema),
  truncated: Schema.Boolean,
  result: Schema.optional(
    Schema.Struct({
      reason: Schema.String,
      turnId: Schema.optional(Schema.String),
      durationMs: Schema.optional(Schema.Finite),
      tokenUsage: Schema.optional(Schema.Json),
      structuredOutput: Schema.optional(Schema.Json),
    }),
  ),
})

export type TurnResult = typeof TurnResultSchema.Type

export const SessionSettingsSchema = Schema.Struct({
  autonomyLevel: Schema.optional(Schema.String),
  interactionMode: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
})

export type SessionSettings = typeof SessionSettingsSchema.Type

export class SessionProblem extends Schema.TaggedError<SessionProblem>()("SessionProblem", {
  code: Schema.String,
  message: Schema.String,
}) {}

interface UpdateSettingsParams {
  sessionId: string
  autonomyLevel: AutonomyLevel
  interactionMode: string
  modelId?: string
  reasoningEffort?: string
  restrictToolIds?: string[]
  disabledToolIds?: string[]
}

export interface CreateSessionOptions {
  readonly cwd: string
  readonly autonomyLevel: AutonomyLevel
  readonly modelId?: string
  readonly reasoningEffort?: string
  readonly restrictToolIds?: ReadonlyArray<string>
  readonly disabledToolIds?: ReadonlyArray<string>
  /** Server ceiling applied to permission prompts raised in this session. */
  readonly maxAutonomy?: AutonomyLevel
}

export interface CreateSessionResult {
  readonly sessionId: string
  readonly cwd: string
  readonly settings: SessionSettings
}

export interface StreamOptions {
  readonly sessionId: string
  readonly prompt: string
  readonly waitMs?: number
}

export interface EventsOptions {
  readonly sessionId: string
  readonly cursor: number
  readonly waitMs?: number
}

export interface AnswerOptions {
  readonly sessionId: string
  readonly requestId: string
  readonly result: JsonValue
}

export interface CommandOptions {
  readonly sessionId: string
  readonly method: string
  readonly params?: JsonValue
  readonly timeoutMs?: number
}

export interface SessionSummary {
  readonly sessionId: string
  readonly cwd: string
  readonly settings: SessionSettings
  readonly status: TurnStatus
  readonly cursor: number
}

export interface SessionHubApi {
  readonly create: (
    options: CreateSessionOptions,
  ) => Effect.Effect<CreateSessionResult, SessionProblem>
  readonly stream: (options: StreamOptions) => Effect.Effect<TurnResult, SessionProblem>
  readonly events: (options: EventsOptions) => Effect.Effect<TurnResult, SessionProblem>
  readonly interrupt: (
    sessionId: string,
  ) => Effect.Effect<{ readonly interrupted: boolean }, SessionProblem>
  readonly close: (sessionId: string) => Effect.Effect<{ readonly closed: boolean }, SessionProblem>
  readonly answer: (
    options: AnswerOptions,
  ) => Effect.Effect<{ readonly resolved: boolean }, SessionProblem>
  /** Sends an arbitrary `droid.*` request to a session's child process. */
  readonly command: (
    options: CommandOptions,
  ) => Effect.Effect<JsonValue | undefined, SessionProblem>
  /** Models the CLI reported at initialize time. */
  readonly models: (sessionId: string) => Effect.Effect<ReadonlyArray<JsonValue>, SessionProblem>
  /** The parsed prompt a caller must answer, or `undefined` when it is gone. */
  readonly pendingPrompt: (
    sessionId: string,
    requestId: string,
  ) => Effect.Effect<PromptView | undefined, SessionProblem>
  readonly sessions: Effect.Effect<ReadonlyArray<SessionSummary>>
}

/** A draft event; `seq` is assigned by the session's ring buffer. */
interface EventDraft {
  kind: string
  text?: string
  messageId?: string
  toolUseId?: string
  name?: string
  input?: JsonValue
  output?: string
  isError?: boolean
  code?: string
  message?: string
  requestId?: string
  status?: TurnStatus
  reason?: string
  promptType?: string
  deadline?: number
  options?: ReadonlyArray<string>
  toolUses?: ReadonlyArray<JsonValue>
  questions?: ReadonlyArray<JsonValue>
  rows?: ReadonlyArray<JsonValue>
  multi?: boolean
}

interface Completion {
  reason: string
  durationMs: number
  turnId?: string
  tokenUsage?: JsonValue
  structuredOutput?: JsonValue
}

interface TurnOutcome {
  reason: string
  durationMs?: number
  turnId?: string
  tokenUsage?: JsonValue
  structuredOutput?: JsonValue
}

interface TurnResultDraft {
  sessionId: string
  status: TurnStatus
  cursor: number
  events: TurnEvent[]
  truncated: boolean
  result?: TurnOutcome
}

interface ActiveTurn {
  readonly epoch: number
  readonly startedAt: number
  readonly firstSeq: number
  readonly completion: Deferred.Deferred<Completion>
  structuredOutput: JsonValue | undefined
}

type PromptOwner = "none" | "answer" | "timeout" | "drop"

interface PendingPrompt {
  readonly publicId: string
  readonly cliId: string
  readonly method: string
  readonly epoch: number
  readonly deferred: Deferred.Deferred<JsonValue>
  readonly event: TurnEvent | undefined
  view: PromptView | undefined
  cancelled: boolean
  owner: PromptOwner
}

/** One answered permission. `keys` are its CLI request id and tool-use ids. */
interface PermissionCorrelation {
  readonly publicId: string
  readonly keys: Array<string>
}

/** Permission answers are the only ones `permission_resolved` can name. */
const correlationKeys = (pending: PendingPrompt): Array<string> => {
  const view = pending.view

  if (view === undefined || view.kind !== "permission") return []

  const keys: Array<string> = [pending.cliId]

  for (const item of view.toolUses) {
    const id = item.toolUse?.id

    if (id !== undefined && !keys.includes(id)) keys.push(id)
  }

  return keys
}

interface RingItem {
  readonly event: TurnEvent
  readonly bytes: number
}

/**
 * A child acquired from `start`. It stays in `owned` until `exec.close` settles,
 * whether or not it was registered on a session.
 */
interface OwnedExec {
  readonly exec: ExecClient
  released: boolean
  /**
   * Claimed synchronously by the first shutdown. Completed only after `exec.close`
   * settles and this record has been dropped from `owned`.
   */
  shutdown?: Deferred.Deferred<void>
}

interface SessionState {
  readonly id: string
  readonly exec: ExecClient
  readonly owned: OwnedExec
  readonly scope: Scope.Closeable
  readonly mutex: Semaphore.Semaphore
  readonly promptMutex: Semaphore.Semaphore
  readonly prompts: Map<string, PendingPrompt>
  readonly byCli: Map<string, string>
  /** Answered permissions whose keys can still name one public id. */
  readonly correlations: Array<PermissionCorrelation>
  /** Ids that must not be treated as fresh after a collision, consume, or eviction. */
  readonly seenKeys: Set<string>
  /** False once `seenKeys` is full. Lookups then refuse every public id. */
  inferPublicIds: boolean
  readonly deltas: Map<string, string>
  readonly truncatedDeltas: Set<string>
  readonly buffer: Array<RingItem>
  cwd: string
  settings: SessionSettings
  models: ReadonlyArray<JsonValue>
  lastStatus: TurnStatus
  nextSeq: number
  bytes: number
  active: ActiveTurn | undefined
  lastCompletion: Completion | undefined
  signal: Deferred.Deferred<void>
  lastUsed: number
  phase: "open" | "closing" | "closed"
  alive: boolean
  turnEpoch: number
  promptSeq: number
  readonly cap: AutonomyLevel | undefined
}

const InitializeResult = Schema.Struct({
  sessionId: Schema.String,
  availableModels: Schema.optional(Schema.Array(Schema.Json)),
})

const NotificationEnvelopeSchema = Schema.Struct({
  notification: Schema.Json,
})

const TextDelta = Schema.Struct({
  type: Schema.Literal("assistant_text_delta"),
  messageId: Schema.String,
  blockIndex: Schema.Number,
  textDelta: Schema.String,
})

const TextComplete = Schema.Struct({
  type: Schema.Literal("assistant_text_complete"),
  messageId: Schema.String,
  blockIndex: Schema.Number,
})

const ThinkingComplete = Schema.Struct({
  type: Schema.Literal("thinking_text_complete"),
  text: Schema.String,
})

const ToolCall = Schema.Struct({
  type: Schema.Literal("tool_call"),
  toolUseId: Schema.String,
  name: Schema.String,
  input: Schema.optional(Schema.Json),
})

const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolUseId: Schema.String,
  isError: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.Json),
})

const ErrorNote = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
  errorType: Schema.optional(Schema.String),
})

const PermissionResolved = Schema.Struct({
  type: Schema.Literal("permission_resolved"),
  toolUseId: Schema.optional(Schema.String),
  /** Real CLI notifications send every tool use; the singular field is older. */
  toolUseIds: Schema.optional(Schema.Array(Schema.String)),
  requestId: Schema.optional(Schema.String),
})

const TurnCompleted = Schema.Struct({
  type: Schema.Literal("agent_turn_completed"),
  reason: Schema.String,
  turnId: Schema.optional(Schema.String),
  tokenUsage: Schema.optional(Schema.Json),
  structuredOutput: Schema.optional(Schema.Json),
})

const StructuredOutput = Schema.Struct({
  type: Schema.Literal("structured_output"),
  data: Schema.optional(Schema.Json),
})

const AssistantMessage = Schema.Struct({
  type: Schema.Literal("create_message"),
  message: Schema.Struct({
    id: Schema.optional(Schema.String),
    role: Schema.String,
    content: Schema.optional(Schema.Array(Schema.Json)),
  }),
})

const TextBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
})

const SettingsUpdated = Schema.Struct({
  type: Schema.Literal("settings_updated"),
  settings: Schema.optional(Schema.Json),
})

const SettingsFields = Schema.Struct({
  autonomyLevel: Schema.optional(Schema.String),
  interactionMode: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(Schema.String),
})

/** Cuts on a UTF-8 boundary and keeps the truncation mark inside `limit`. */
const truncateUtf8 = (text: string, limit: number = EVENT_TEXT_LIMIT): string => {
  if (Buffer.byteLength(text, "utf8") <= limit) return text

  const markBytes = Buffer.byteLength(TRUNCATION_MARK, "utf8")
  let budget = limit - markBytes

  if (budget < 0) budget = 0

  const bytes = Buffer.from(text, "utf8")
  let end = budget

  if (end > bytes.length) end = bytes.length

  if (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  }

  return bytes.subarray(0, end).toString("utf8") + TRUNCATION_MARK
}

const boundJson = (value: JsonValue, limit: number = FIELD_BYTE_LIMIT): JsonValue => {
  const encoded = JSON.stringify(value)

  if (Buffer.byteLength(encoded, "utf8") <= limit) return value

  return truncateUtf8(encoded, limit)
}

const ToolUseBody = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Json),
  thoughtSignature: Schema.optional(Schema.String),
})

const ToolUseEnvelope = Schema.Struct({
  toolUse: Schema.optional(ToolUseBody),
  confirmationType: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Json),
})

/** Keeps names and ids; a huge tool input becomes a short string instead of evicting the event. */
const boundToolUse = (value: JsonValue): JsonValue => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= FIELD_BYTE_LIMIT) return value

  const decoded = Schema.decodeUnknownOption(ToolUseEnvelope)(value)

  if (Option.isNone(decoded) || decoded.value.toolUse === undefined) return boundJson(value)

  const toolUse = decoded.value.toolUse
  const input = toolUse.input === undefined ? undefined : boundJson(toolUse.input)
  const details = decoded.value.details === undefined ? undefined : boundJson(decoded.value.details)

  return presentFields({
    toolUse: presentFields({
      type: toolUse.type,
      id: toolUse.id,
      name: toolUse.name,
      input,
      thoughtSignature: toolUse.thoughtSignature,
    }),
    confirmationType: decoded.value.confirmationType,
    details,
  })
}

const jsonItems = (value: JsonValue): Array<JsonValue> | undefined => {
  if (!Array.isArray(value)) return undefined

  const items: Array<JsonValue> = []

  for (const item of value) items.push(item)

  return items
}

const QuestionFields = Schema.Struct({
  index: Schema.optional(Schema.Number),
  topic: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.Json)),
  multiSelect: Schema.optional(Schema.Boolean),
})

const RowFields = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
})

const boundQuestions = (value: JsonValue): Array<JsonValue> | undefined => {
  const items = jsonItems(value)

  if (items === undefined) return undefined

  if (Buffer.byteLength(JSON.stringify(items), "utf8") <= FIELD_BYTE_LIMIT) return items

  const bounded: Array<JsonValue> = []

  for (const item of items) {
    const decoded = Schema.decodeUnknownOption(QuestionFields)(item)

    if (Option.isNone(decoded)) {
      bounded.push(boundJson(item))

      continue
    }

    const question = decoded.value.question

    bounded.push(
      presentFields({
        index: decoded.value.index,
        topic: decoded.value.topic,
        question: question === undefined ? undefined : truncateUtf8(question, FIELD_BYTE_LIMIT),
        options: decoded.value.options,
        multiSelect: decoded.value.multiSelect,
      }),
    )
  }

  return bounded
}

const boundRows = (value: JsonValue): Array<JsonValue> | undefined => {
  const items = jsonItems(value)

  if (items === undefined) return undefined

  if (Buffer.byteLength(JSON.stringify(items), "utf8") <= FIELD_BYTE_LIMIT) return items

  const bounded: Array<JsonValue> = []

  for (const item of items) {
    const decoded = Schema.decodeUnknownOption(RowFields)(item)

    if (Option.isNone(decoded)) {
      bounded.push(boundJson(item))

      continue
    }

    const label = decoded.value.label
    const detail = decoded.value.detail

    bounded.push(
      presentFields({
        id: decoded.value.id,
        label: label === undefined ? undefined : truncateUtf8(label, FIELD_BYTE_LIMIT),
        detail: detail === undefined ? undefined : truncateUtf8(detail, FIELD_BYTE_LIMIT),
      }),
    )
  }

  return bounded
}

const stringify = (value: JsonValue | undefined): string => {
  if (value === undefined) return ""

  return Schema.is(Schema.String)(value) ? value : JSON.stringify(value)
}

/** Text blocks of an assistant message, ignoring tool and thinking blocks. */
const textOfMessage = (content: ReadonlyArray<JsonValue> | undefined): string => {
  if (content === undefined) return ""

  const parts: Array<string> = []

  for (const block of content) {
    const decoded = Schema.decodeUnknownOption(TextBlock)(block)

    if (Option.isSome(decoded) && decoded.value.type === "text" && decoded.value.text) {
      parts.push(decoded.value.text)
    }
  }

  return parts.join("")
}

const statusOf = (reason: string): TurnStatus => {
  if (reason === "completed") return "completed"

  if (reason === "cancelled" || reason === "permission_rejected" || reason === "spec_handoff") {
    return "interrupted"
  }

  return "failed"
}

/** The reply the hub sends when nobody answers a prompt before its deadline. */
const promptCancelResult = (method: string): JsonValue => {
  if (method === EXEC_METHOD.askUser) return { cancelled: true, answers: [] }

  if (method === EXEC_METHOD.pickOptions) return { cancelled: true, selectedIds: [] }

  return { selectedOption: "cancel" }
}

interface SettingsDraft {
  autonomyLevel?: string
  interactionMode?: string
  modelId?: string
  reasoningEffort?: string
}

const settingsDraft = (settings: SessionSettings): SettingsDraft => {
  const draft: SettingsDraft = {}

  if (settings.autonomyLevel !== undefined) draft.autonomyLevel = settings.autonomyLevel

  if (settings.interactionMode !== undefined) draft.interactionMode = settings.interactionMode

  if (settings.modelId !== undefined) draft.modelId = settings.modelId

  if (settings.reasoningEffort !== undefined) draft.reasoningEffort = settings.reasoningEffort

  return draft
}

const applySettings = (session: SessionState, value: JsonValue | undefined): void => {
  const decoded = Schema.decodeUnknownOption(SettingsFields)(value)

  if (Option.isNone(decoded)) return

  const patch = decoded.value
  const next = settingsDraft(session.settings)

  if (patch.autonomyLevel !== undefined) next.autonomyLevel = patch.autonomyLevel

  if (patch.interactionMode !== undefined) next.interactionMode = patch.interactionMode

  if (patch.modelId !== undefined) next.modelId = patch.modelId

  if (patch.reasoningEffort !== undefined) next.reasoningEffort = patch.reasoningEffort

  session.settings = next
}

const applyCwd = (session: SessionState, value: JsonValue | undefined): void => {
  const decoded = Schema.decodeUnknownOption(SettingsFields)(value)

  if (Option.isNone(decoded) || decoded.value.workingDirectory === undefined) return

  session.cwd = decoded.value.workingDirectory
}

export interface SessionHubOptions {
  readonly droidPath: string
  readonly version: string
  readonly logger?: Logger
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly waitMs?: number
  readonly idleMs?: number
  readonly reaperIntervalMs?: number
  readonly promptTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /** Overrides the CLI arguments; tests point this at a script instead of `droid`. */
  readonly args?: ReadonlyArray<string>
}

export interface SessionHub {
  readonly api: SessionHubApi
  readonly closeAll: Effect.Effect<void>
}

/** The hub as a service, so tools and tests both receive it from context. */
export class SessionHubService extends Context.Service<SessionHubService, SessionHubApi>()(
  "droid-mcp/SessionHub",
) {}

export const sessionHubLayer = (options: SessionHubOptions): Layer.Layer<SessionHubService> =>
  Layer.effect(
    SessionHubService,
    Effect.gen(function* () {
      const hub = yield* Effect.acquireRelease(sessionHub(options), (value) => value.closeAll)

      return hub.api
    }),
  )

const problem = (code: string, message: string): SessionProblem =>
  new SessionProblem({ code, message })

const notFound = (sessionId: string): SessionProblem =>
  problem("session_not_found", "no session " + sessionId + "; call session_create first")

const closedProblem = (sessionId: string): SessionProblem =>
  problem("session_closed", "session " + sessionId + " is closed")

const shuttingDown = (): SessionProblem => problem("exec_failed", "session hub is shutting down")

export const checkCwd = (cwd: string): Effect.Effect<string, SessionProblem> => {
  if (!isAbsolute(cwd)) {
    return Effect.fail(problem("invalid_cwd", "cwd must be an absolute path"))
  }

  return Effect.sync(() => {
    try {
      return statSync(cwd).isDirectory()
    } catch {
      return false
    }
  }).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.succeed(cwd)
        : Effect.fail(problem("invalid_cwd", "cwd does not exist or is not a directory: " + cwd)),
    ),
  )
}

export const sessionHub = (options: SessionHubOptions): Effect.Effect<SessionHub> =>
  Effect.gen(function* () {
    const sessions = new Map<string, SessionState>()
    const owned: Array<OwnedExec> = []
    const logger = options.logger
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
    const idleMs = options.idleMs ?? IDLE_SESSION_MS
    const reaperIntervalMs = options.reaperIntervalMs ?? REAPER_INTERVAL_MS
    const promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS
    let closing = false

    const listedStatus = (session: SessionState): TurnStatus => {
      if (!session.alive) return "failed"

      if (session.active !== undefined) return "running"

      return session.lastStatus
    }

    const publish = (session: SessionState, draft: EventDraft): TurnEvent => {
      const event: TurnEvent = { ...draft, seq: session.nextSeq }
      session.nextSeq += 1
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8")
      session.buffer.push({ event, bytes })
      session.bytes += bytes

      while (session.buffer.length > RING_EVENT_LIMIT || session.bytes > RING_BYTE_LIMIT) {
        const removed = session.buffer.shift()

        if (removed === undefined) break

        session.bytes -= removed.bytes
      }

      const waiting = session.signal
      session.signal = Deferred.makeUnsafe<void>()
      Deferred.doneUnsafe(waiting, Effect.void)

      return event
    }

    const snapshot = (session: SessionState, cursor: number) => {
      const visible: Array<TurnEvent> = []

      for (const item of session.buffer) {
        if (item.event.seq >= cursor) visible.push(item.event)
      }

      // Re-attach a prompt the ring evicted. Skip one that was cancelled, or that
      // this cursor has already moved past, so an old poll cannot resurrect it.
      for (const pending of session.prompts.values()) {
        const event = pending.event

        if (event === undefined || pending.cancelled || event.seq < cursor) continue

        let present = false

        for (const existing of visible) {
          if (existing.seq === event.seq) present = true
        }

        if (!present) visible.push(event)
      }

      visible.sort((left, right) => left.seq - right.seq)
      const oldest = session.buffer[0]?.event.seq ?? session.nextSeq

      return { events: visible, truncated: cursor < oldest, next: session.nextSeq }
    }

    const resultOf = (
      session: SessionState,
      status: TurnStatus,
      from: number,
      completion: Completion | undefined,
    ): TurnResult => {
      const { events, truncated, next } = snapshot(session, from)

      const draft: TurnResultDraft = {
        sessionId: session.id,
        status,
        cursor: next,
        events: [...events],
        truncated,
      }

      if (completion !== undefined) {
        const outcome: TurnOutcome = {
          reason: completion.reason,
          durationMs: completion.durationMs,
        }

        if (completion.turnId !== undefined) outcome.turnId = completion.turnId

        if (completion.tokenUsage !== undefined) outcome.tokenUsage = completion.tokenUsage

        if (completion.structuredOutput !== undefined) {
          outcome.structuredOutput = completion.structuredOutput
        }

        draft.result = outcome
      }

      return draft
    }

    const dropPrompt = (session: SessionState, pending: PendingPrompt): void => {
      if (pending.owner !== "none") return

      pending.cancelled = true
      pending.owner = "drop"
      session.prompts.delete(pending.publicId)

      if (session.byCli.get(pending.cliId) === pending.publicId) {
        session.byCli.delete(pending.cliId)
      }

      Deferred.doneUnsafe(pending.deferred, Effect.succeed(promptCancelResult(pending.method)))
    }

    /** Drop a key from live records. Absence afterwards does not make it fresh. */
    const detachKey = (session: SessionState, key: string): void => {
      for (const existing of session.correlations) {
        const index = existing.keys.indexOf(key)

        if (index >= 0) existing.keys.splice(index, 1)
      }
    }

    const stopInferring = (session: SessionState): void => {
      session.inferPublicIds = false
      session.correlations.length = 0
    }

    /**
     * Record a key that later prompts must not claim. A full set stops
     * inference so an evicted id cannot be handed to a newer prompt.
     */
    const rememberSeen = (session: SessionState, key: string): boolean => {
      if (!session.inferPublicIds) return false

      if (session.seenKeys.has(key)) return true

      if (session.seenKeys.size >= SEEN_KEY_LIMIT) {
        stopInferring(session)

        return false
      }

      session.seenKeys.add(key)

      return true
    }

    const rememberCorrelation = (session: SessionState, pending: PendingPrompt): void => {
      if (!session.inferPublicIds) return

      const keys = correlationKeys(pending)

      if (keys.length === 0) return

      const fresh: Array<string> = []

      for (const key of keys) {
        const already = session.seenKeys.has(key)

        if (!rememberSeen(session, key)) return

        detachKey(session, key)

        if (!already) fresh.push(key)
      }

      if (!session.inferPublicIds || fresh.length === 0) return

      session.correlations.push({ publicId: pending.publicId, keys: fresh })

      while (session.correlations.length > CORRELATION_LIMIT) session.correlations.shift()
    }

    /** Keep the ids, but do not leave a live mapping a later resolution can steal. */
    const burnPromptKeys = (session: SessionState, pending: PendingPrompt): void => {
      for (const key of correlationKeys(pending)) {
        if (!rememberSeen(session, key)) return

        detachKey(session, key)
      }
    }

    const forgetCorrelation = (session: SessionState, publicId: string): void => {
      const index = session.correlations.findIndex((item) => item.publicId === publicId)

      if (index >= 0) session.correlations.splice(index, 1)
    }

    /**
     * Only a key still on one live record names a public id. A consumed,
     * collided, or evicted key stays in `seenKeys`, so a later prompt cannot
     * claim it. Shared ids that are still outstanding together are left
     * unnamed: the notifications are indistinguishable. A full `seenKeys`
     * stops inference for the rest of the turn. The next turn clears both.
     */
    const takeCorrelation = (session: SessionState, key: string): string | undefined => {
      if (!session.inferPublicIds) return undefined

      const index = session.correlations.findIndex((item) => item.keys.includes(key))

      if (index < 0) return undefined

      const found = session.correlations[index]
      session.correlations.splice(index, 1)

      return found?.publicId
    }

    const expirePrompts = (session: SessionState): void => {
      for (const pending of session.prompts.values()) dropPrompt(session, pending)

      session.prompts.clear()
      session.byCli.clear()
      session.correlations.length = 0
      session.seenKeys.clear()
      session.inferPublicIds = true
    }

    const settleActive = (
      session: SessionState,
      active: ActiveTurn,
      completion: Completion,
      error?: { readonly code: string; readonly message: string },
    ): boolean => {
      if (session.active !== active) return false

      session.active = undefined
      session.deltas.clear()
      session.truncatedDeltas.clear()
      expirePrompts(session)
      session.lastCompletion = completion
      session.lastStatus = statusOf(completion.reason)

      if (error !== undefined) {
        publish(session, { kind: "error", code: error.code, message: error.message })
      }

      publish(session, {
        kind: "turn_completed",
        status: session.lastStatus,
        reason: completion.reason,
      })
      Deferred.doneUnsafe(active.completion, Effect.succeed(completion))

      return true
    }

    const completeTurn = (session: SessionState, notification: typeof TurnCompleted.Type): void => {
      const active = session.active

      if (active === undefined) return

      const completion: Completion = {
        reason: notification.reason,
        durationMs: Date.now() - active.startedAt,
      }

      if (notification.turnId !== undefined) completion.turnId = notification.turnId

      if (notification.tokenUsage !== undefined) completion.tokenUsage = notification.tokenUsage

      if (notification.structuredOutput !== undefined) {
        completion.structuredOutput = notification.structuredOutput
      }

      if (active.structuredOutput !== undefined) {
        completion.structuredOutput = active.structuredOutput
      }

      settleActive(session, active, completion)
    }

    const markDead = (session: SessionState, message: string): void => {
      session.alive = false

      if (session.phase !== "open") return

      const active = session.active

      if (active !== undefined) {
        settleActive(
          session,
          active,
          { reason: "process_exit", durationMs: Date.now() - active.startedAt },
          { code: "process_exit", message },
        )

        return
      }

      expirePrompts(session)
      session.deltas.clear()
      session.truncatedDeltas.clear()
      session.lastStatus = "failed"
      session.lastCompletion = { reason: "process_exit", durationMs: 0 }
      publish(session, { kind: "error", code: "process_exit", message })
      publish(session, { kind: "turn_completed", status: "failed", reason: "process_exit" })
    }

    const appendDelta = (session: SessionState, key: string, chunk: string): void => {
      if (session.truncatedDeltas.has(key)) return

      const next = (session.deltas.get(key) ?? "") + chunk

      if (Buffer.byteLength(next, "utf8") <= EVENT_TEXT_LIMIT) {
        session.deltas.set(key, next)

        return
      }

      session.deltas.set(key, truncateUtf8(next))
      session.truncatedDeltas.add(key)
    }

    const onNotification = (session: SessionState, params: JsonValue | undefined): void => {
      if (params === undefined) return

      const envelope = Schema.decodeUnknownOption(NotificationEnvelopeSchema)(params)

      if (Option.isNone(envelope)) return

      const value = envelope.value.notification
      const settings = Schema.decodeUnknownOption(SettingsUpdated)(value)

      if (Option.isSome(settings)) {
        applySettings(session, settings.value.settings ?? {})

        return
      }

      const active = session.active

      if (active === undefined) return

      const delta = Schema.decodeUnknownOption(TextDelta)(value)

      if (Option.isSome(delta)) {
        const key = delta.value.messageId + ":" + String(delta.value.blockIndex)
        appendDelta(session, key, delta.value.textDelta)

        return
      }

      const complete = Schema.decodeUnknownOption(TextComplete)(value)

      if (Option.isSome(complete)) {
        const key = complete.value.messageId + ":" + String(complete.value.blockIndex)
        const text = session.deltas.get(key) ?? ""
        session.deltas.delete(key)
        session.truncatedDeltas.delete(key)
        publish(session, {
          kind: "assistant_text",
          text: truncateUtf8(text),
          messageId: complete.value.messageId,
        })

        return
      }

      const thinking = Schema.decodeUnknownOption(ThinkingComplete)(value)

      if (Option.isSome(thinking)) {
        publish(session, { kind: "thinking", text: truncateUtf8(thinking.value.text) })

        return
      }

      const call = Schema.decodeUnknownOption(ToolCall)(value)

      if (Option.isSome(call)) {
        const draft: EventDraft = {
          kind: "tool_call",
          toolUseId: call.value.toolUseId,
          name: call.value.name,
        }

        if (call.value.input !== undefined) draft.input = boundJson(call.value.input)

        publish(session, draft)

        return
      }

      const toolResult = Schema.decodeUnknownOption(ToolResult)(value)

      if (Option.isSome(toolResult)) {
        const draft: EventDraft = {
          kind: "tool_result",
          toolUseId: toolResult.value.toolUseId,
          output: truncateUtf8(stringify(toolResult.value.result)),
        }

        if (toolResult.value.isError !== undefined) draft.isError = toolResult.value.isError

        publish(session, draft)

        return
      }

      const failure = Schema.decodeUnknownOption(ErrorNote)(value)

      if (Option.isSome(failure)) {
        const draft: EventDraft = {
          kind: "error",
          message: truncateUtf8(failure.value.message),
        }

        if (failure.value.errorType !== undefined) draft.code = failure.value.errorType

        publish(session, draft)

        return
      }

      const resolved = Schema.decodeUnknownOption(PermissionResolved)(value)

      if (Option.isSome(resolved)) {
        const requestId = resolved.value.requestId
        const toolUseId = resolved.value.toolUseId
        const toolUseIds = resolved.value.toolUseIds ?? []

        const fromRequest =
          requestId === undefined ? undefined : takeCorrelation(session, requestId)

        let fromTool: string | undefined

        if (fromRequest === undefined && toolUseId !== undefined) {
          fromTool = takeCorrelation(session, toolUseId)
        }

        if (fromRequest === undefined && fromTool === undefined) {
          for (const id of toolUseIds) {
            fromTool = takeCorrelation(session, id)

            if (fromTool !== undefined) break
          }
        }

        const publicId = fromRequest ?? fromTool
        const draft: EventDraft = { kind: "prompt_resolved" }

        if (publicId !== undefined) draft.requestId = publicId

        const shownToolId = toolUseId ?? (toolUseIds.length === 1 ? toolUseIds[0] : undefined)

        if (shownToolId !== undefined) draft.toolUseId = shownToolId

        publish(session, draft)

        return
      }

      const assistant = Schema.decodeUnknownOption(AssistantMessage)(value)

      if (Option.isSome(assistant) && assistant.value.message.role === "assistant") {
        const text = textOfMessage(assistant.value.message.content)

        if (text.length > 0) {
          const draft: EventDraft = { kind: "assistant_text", text: truncateUtf8(text) }

          if (assistant.value.message.id !== undefined) {
            draft.messageId = assistant.value.message.id
          }

          publish(session, draft)
        }

        return
      }

      const structured = Schema.decodeUnknownOption(StructuredOutput)(value)

      if (Option.isSome(structured)) {
        active.structuredOutput = structured.value.data

        return
      }

      const completed = Schema.decodeUnknownOption(TurnCompleted)(value)

      if (Option.isSome(completed)) completeTurn(session, completed.value)
    }

    const promptDraft = (session: SessionState, prompt: Prompt, deadline: number): EventDraft => {
      const event = promptEvent(prompt, deadline)

      const draft: EventDraft = {
        kind: event.kind,
        requestId: event.requestId,
        deadline: event.deadline,
        promptType: prompt.method,
      }

      if (event.options !== undefined) draft.options = event.options

      if (event.multi !== undefined) draft.multi = event.multi

      if (event.toolUses !== undefined) {
        const parsed = toJsonValue(event.toolUses)
        const items = jsonItems(parsed)

        if (items !== undefined) {
          const bounded: Array<JsonValue> = []

          for (const item of items) bounded.push(boundToolUse(item))

          draft.toolUses = bounded
        }
      }

      if (event.questions !== undefined) {
        const questions = boundQuestions(toJsonValue(event.questions))

        if (questions !== undefined) draft.questions = questions
      }

      if (event.rows !== undefined) {
        const rows = boundRows(toJsonValue(event.rows))

        if (rows !== undefined) draft.rows = rows
      }

      return draft
    }

    const onPrompt = (session: SessionState, request: ExecRequest): Effect.Effect<void> =>
      Effect.gen(function* () {
        const registered = yield* Semaphore.withPermit(
          session.promptMutex,
          Effect.sync(() => {
            if (session.phase !== "open" || !session.alive || session.active === undefined) {
              return undefined
            }

            const previousId = session.byCli.get(request.id)

            if (previousId !== undefined) {
              const previous = session.prompts.get(previousId)

              if (previous !== undefined) dropPrompt(session, previous)
            }

            const view = viewOf(request.method, request.params)
            let stored = view

            if (stored?.kind === "permission" && session.cap !== undefined) {
              stored = {
                ...stored,
                options: capPermissionOptions(stored.options, session.cap),
              }
            }

            const publicId = "hub-" + String(session.promptSeq)
            session.promptSeq += 1
            const epoch = session.turnEpoch
            const deadline = Date.now() + promptTimeoutMs
            const prompt: Prompt = { id: publicId, method: request.method, view: stored }
            const event = publish(session, promptDraft(session, prompt, deadline))

            const pending: PendingPrompt = {
              publicId,
              cliId: request.id,
              method: request.method,
              epoch,
              deferred: Deferred.makeUnsafe<JsonValue>(),
              event,
              view: stored,
              cancelled: false,
              owner: "none",
            }

            session.byCli.set(request.id, publicId)
            session.prompts.set(publicId, pending)

            return pending
          }),
        )

        if (registered === undefined) {
          yield* session.exec
            .respond(request.id, promptCancelResult(request.method))
            .pipe(Effect.ignore)

          return
        }

        const pending = registered

        const waiter = Effect.gen(function* () {
          const answered = yield* Deferred.await(pending.deferred).pipe(
            Effect.timeoutOption(Duration.millis(promptTimeoutMs)),
          )

          if (pending.cancelled || pending.owner === "drop" || pending.owner === "answer") {
            return
          }

          if (Option.isSome(answered)) return

          const claimed = yield* Semaphore.withPermit(
            session.promptMutex,
            Effect.sync(() => {
              if (pending.cancelled || pending.owner !== "none") return false

              if (
                session.phase !== "open" ||
                !session.alive ||
                session.turnEpoch !== pending.epoch ||
                session.active === undefined ||
                session.byCli.get(pending.cliId) !== pending.publicId
              ) {
                dropPrompt(session, pending)

                return false
              }

              pending.owner = "timeout"
              pending.cancelled = true
              session.prompts.delete(pending.publicId)

              if (session.byCli.get(pending.cliId) === pending.publicId) {
                session.byCli.delete(pending.cliId)
              }

              return true
            }),
          )

          if (!claimed) return

          if (
            session.phase !== "open" ||
            !session.alive ||
            session.turnEpoch !== pending.epoch ||
            session.byCli.has(pending.cliId)
          ) {
            return
          }

          burnPromptKeys(session, pending)

          yield* session.exec
            .respond(pending.cliId, promptCancelResult(pending.method))
            .pipe(Effect.ignore)

          if (session.phase !== "open" || session.turnEpoch !== pending.epoch) return

          publish(session, {
            kind: "prompt_resolved",
            requestId: pending.publicId,
            reason: "timeout",
            message: "no answer within " + String(promptTimeoutMs) + " ms",
          })
        })

        yield* Effect.forkIn(waiter, session.scope)
      })

    // The first caller owns `exec.close`. Everyone else waits on the same deferred.
    // `released` and removal happen only after that close settles, so a concurrent
    // `closeAll` cannot observe a dropped record and skip a child that is still alive.
    const shutdownOwned = (record: OwnedExec): Effect.Effect<void> =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (record.shutdown !== undefined) return Deferred.await(record.shutdown)

          const gate = Deferred.makeUnsafe<void>()
          record.shutdown = gate

          return record.exec.close.pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                record.released = true
                const index = owned.indexOf(record)

                if (index >= 0) owned.splice(index, 1)

                Deferred.doneUnsafe(gate, Effect.void)
              }),
            ),
          )
        }),
      )

    // Bookkeeping is synchronous. The close RPC stays interruptible so cancellation does
    // not wait out its timeout; `ensuring` still tears the child down.
    const closeSession = (session: SessionState): Effect.Effect<{ readonly closed: boolean }> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          session.phase = "closing"
          session.alive = false
          sessions.delete(session.id)
          const active = session.active

          if (active !== undefined) {
            settleActive(session, active, {
              reason: "cancelled",
              durationMs: Date.now() - active.startedAt,
            })
          } else {
            expirePrompts(session)
            session.deltas.clear()
            session.truncatedDeltas.clear()
          }

          yield* Scope.close(session.scope, Exit.void).pipe(Effect.ignore)
          yield* restore(
            session.exec
              .request({ method: EXEC_METHOD.close, params: { sessionId: session.id } })
              .pipe(Effect.ignore),
          )
          session.phase = "closed"

          return { closed: true }
        }).pipe(Effect.ensuring(shutdownOwned(session.owned))),
      )

    const close = (
      sessionId: string,
    ): Effect.Effect<{ readonly closed: boolean }, SessionProblem> =>
      Effect.suspend(() => {
        const session = sessions.get(sessionId)

        if (session === undefined) return Effect.fail(notFound(sessionId))

        return closeSession(session)
      })

    const attach = (session: SessionState): Effect.Effect<void> =>
      Effect.gen(function* () {
        const notifications = session.exec.notifications.pipe(
          Stream.runForEach((notification) =>
            Effect.sync(() => {
              session.lastUsed = Date.now()
              onNotification(session, notification.params)
            }),
          ),
        )

        const requests = session.exec.requests.pipe(
          Stream.runForEach((request) =>
            onPrompt(session, request).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  session.lastUsed = Date.now()
                }),
              ),
            ),
          ),
        )

        const exitWatcher = session.exec.exited.pipe(
          Effect.flatMap((info) =>
            Effect.sync(() => {
              markDead(session, "droid exec exited with code " + String(info.code))
            }),
          ),
        )

        yield* Effect.forkIn(notifications, session.scope)
        yield* Effect.forkIn(requests, session.scope)
        yield* Effect.forkIn(exitWatcher, session.scope)
      })

    const create = (
      createOptions: CreateSessionOptions,
    ): Effect.Effect<CreateSessionResult, SessionProblem> =>
      Effect.gen(function* () {
        // Per run. The effect value is reusable, and these must not be shared across fibers.
        let registeredId: string | undefined
        let record: OwnedExec | undefined

        const work = Effect.gen(function* () {
          if (closing) return yield* Effect.fail(shuttingDown())

          const cwd = yield* checkCwd(createOptions.cwd)

          if (closing) return yield* Effect.fail(shuttingDown())

          const exec = yield* start({
            droidPath: options.droidPath,
            cwd,
            version: options.version,
            env: options.env,
            args: options.args,
            requestTimeoutMs: options.requestTimeoutMs,
            logger,
          }).pipe(
            Effect.mapError((cause) =>
              problem(
                "exec_failed",
                cause.message + (cause.detail === undefined ? "" : ": " + cause.detail),
              ),
            ),
          )

          record = { exec, released: false }
          owned.push(record)

          if (closing) return yield* Effect.fail(shuttingDown())

          const initialized = yield* exec
            .request({
              method: EXEC_METHOD.initialize,
              params: { machineId: "local", cwd },
              timeoutMs: options.requestTimeoutMs ?? 60_000,
            })
            .pipe(
              Effect.mapError((cause) =>
                problem(
                  Schema.is(ExecTimeout)(cause) ? "exec_timeout" : "exec_failed",
                  cause.message,
                ),
              ),
            )

          const decoded = Option.getOrUndefined(
            Schema.decodeUnknownOption(InitializeResult)(initialized),
          )

          if (decoded === undefined) {
            return yield* Effect.fail(
              problem("exec_failed", "droid exec did not return a session id"),
            )
          }

          if (closing) return yield* Effect.fail(shuttingDown())

          const settings: SettingsDraft = {
            autonomyLevel: createOptions.autonomyLevel,
            interactionMode: "auto",
          }

          if (createOptions.modelId !== undefined) settings.modelId = createOptions.modelId

          if (createOptions.reasoningEffort !== undefined) {
            settings.reasoningEffort = createOptions.reasoningEffort
          }

          const settingsParams: UpdateSettingsParams = {
            sessionId: decoded.sessionId,
            autonomyLevel: createOptions.autonomyLevel,
            interactionMode: "auto",
          }

          if (createOptions.modelId !== undefined) settingsParams.modelId = createOptions.modelId

          if (createOptions.reasoningEffort !== undefined) {
            settingsParams.reasoningEffort = createOptions.reasoningEffort
          }

          if (createOptions.restrictToolIds !== undefined) {
            settingsParams.restrictToolIds = [...createOptions.restrictToolIds]
          }

          if (createOptions.disabledToolIds !== undefined) {
            settingsParams.disabledToolIds = [...createOptions.disabledToolIds]
          }

          yield* exec
            .request({
              method: EXEC_METHOD.updateSettings,
              params: toJsonValue(settingsParams),
            })
            .pipe(Effect.mapError((cause) => problem("exec_failed", cause.message)))

          if (closing) return yield* Effect.fail(shuttingDown())

          const previous = sessions.get(decoded.sessionId)

          if (previous !== undefined) yield* close(previous.id).pipe(Effect.ignore)

          if (closing) return yield* Effect.fail(shuttingDown())

          const session: SessionState = {
            id: decoded.sessionId,
            cwd,
            exec,
            owned: record,
            scope: Scope.makeUnsafe(),
            mutex: yield* Semaphore.make(1),
            promptMutex: yield* Semaphore.make(1),
            prompts: new Map(),
            byCli: new Map(),
            correlations: [],
            seenKeys: new Set(),
            inferPublicIds: true,
            deltas: new Map(),
            truncatedDeltas: new Set(),
            buffer: [],
            settings,
            models: decoded.availableModels ?? [],
            lastStatus: "completed",
            nextSeq: 1,
            bytes: 0,
            active: undefined,
            lastCompletion: undefined,
            signal: Deferred.makeUnsafe<void>(),
            lastUsed: Date.now(),
            phase: "open",
            alive: true,
            turnEpoch: 0,
            promptSeq: 1,
            cap: createOptions.maxAutonomy,
          }

          if (closing) return yield* Effect.fail(shuttingDown())

          sessions.set(session.id, session)
          registeredId = session.id

          if (closing) return yield* Effect.fail(shuttingDown())

          yield* attach(session)

          if (closing) return yield* Effect.fail(shuttingDown())

          return { sessionId: session.id, cwd, settings }
        })

        return yield* Effect.onExit(work, (exit) => {
          if (Exit.isSuccess(exit)) return Effect.void

          if (registeredId !== undefined) return close(registeredId).pipe(Effect.ignore)

          if (record !== undefined) return shutdownOwned(record)

          return Effect.void
        })
      })

    const requireLive = (session: SessionState): SessionProblem | undefined => {
      if (session.phase !== "open") return notFound(session.id)

      if (!session.alive) return closedProblem(session.id)

      return undefined
    }

    const stream = (streamOptions: StreamOptions): Effect.Effect<TurnResult, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(streamOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(streamOptions.sessionId))

        const unavailable = requireLive(session)

        if (unavailable !== undefined) return yield* Effect.fail(unavailable)

        if (streamOptions.prompt.trim().length === 0) {
          return yield* Effect.fail(
            problem("invalid_prompt", "prompt must contain at least one non-whitespace character"),
          )
        }

        if (session.active !== undefined) {
          return yield* Effect.fail(
            problem("session_busy", "session " + session.id + " already has a running turn"),
          )
        }

        const acquired = yield* Semaphore.takeIfAvailable(session.mutex, 1)

        if (!acquired) {
          return yield* Effect.fail(
            problem("session_busy", "session " + session.id + " already has a running turn"),
          )
        }

        return yield* Effect.ensuring(
          Effect.gen(function* () {
            const blocked = requireLive(session)

            if (blocked !== undefined) return yield* Effect.fail(blocked)

            if (session.active !== undefined) {
              return yield* Effect.fail(
                problem("session_busy", "session " + session.id + " already has a running turn"),
              )
            }

            expirePrompts(session)
            session.turnEpoch += 1
            session.deltas.clear()
            session.truncatedDeltas.clear()
            session.lastCompletion = undefined

            const active: ActiveTurn = {
              epoch: session.turnEpoch,
              startedAt: Date.now(),
              firstSeq: session.nextSeq,
              completion: Deferred.makeUnsafe<Completion>(),
              structuredOutput: undefined,
            }

            session.active = active
            session.lastStatus = "running"
            session.lastUsed = Date.now()

            const sent = yield* Effect.match(
              session.exec.request({
                method: EXEC_METHOD.addUserMessage,
                params: { text: streamOptions.prompt },
                timeoutMs: options.requestTimeoutMs ?? 30_000,
              }),
              {
                onFailure: (cause) => cause,
                onSuccess: () => undefined,
              },
            )

            if (sent !== undefined) {
              const settled = yield* Deferred.await(active.completion).pipe(
                Effect.timeoutOption(Duration.millis(100)),
              )

              if (Option.isSome(settled)) {
                return resultOf(
                  session,
                  statusOf(settled.value.reason),
                  active.firstSeq,
                  settled.value,
                )
              }

              const completion: Completion = {
                reason: "exec_failed",
                durationMs: Date.now() - active.startedAt,
              }

              settleActive(session, active, completion, {
                code: "exec_failed",
                message: sent.message,
              })

              return resultOf(session, "failed", active.firstSeq, completion)
            }

            const waited = yield* Deferred.await(active.completion).pipe(
              Effect.timeoutOption(Duration.millis(streamOptions.waitMs ?? waitMs)),
            )

            if (Option.isNone(waited)) {
              return resultOf(session, "running", active.firstSeq, undefined)
            }

            return resultOf(session, statusOf(waited.value.reason), active.firstSeq, waited.value)
          }),
          Semaphore.release(session.mutex, 1),
        )
      })

    const events = (eventsOptions: EventsOptions): Effect.Effect<TurnResult, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(eventsOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(eventsOptions.sessionId))

        if (session.alive) session.lastUsed = Date.now()

        const current = snapshot(session, eventsOptions.cursor)

        const completion = () => (session.active === undefined ? session.lastCompletion : undefined)

        if (!session.alive || session.active === undefined || current.events.length > 0) {
          return resultOf(session, listedStatus(session), eventsOptions.cursor, completion())
        }

        const signal = session.signal
        yield* Effect.raceFirst(
          Deferred.await(signal),
          Effect.sleep(Duration.millis(eventsOptions.waitMs ?? waitMs)),
        )

        return resultOf(session, listedStatus(session), eventsOptions.cursor, completion())
      })

    const interrupt = (
      sessionId: string,
    ): Effect.Effect<{ readonly interrupted: boolean }, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(sessionId))

        const unavailable = requireLive(session)

        if (unavailable !== undefined) return yield* Effect.fail(unavailable)

        const interrupted = session.active !== undefined
        yield* session.exec
          .request({ method: EXEC_METHOD.interrupt, params: { sessionId } })
          .pipe(Effect.ignore)

        return { interrupted }
      })

    const command = (
      commandOptions: CommandOptions,
    ): Effect.Effect<JsonValue | undefined, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(commandOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(commandOptions.sessionId))

        const unavailable = requireLive(session)

        if (unavailable !== undefined) return yield* Effect.fail(unavailable)

        session.lastUsed = Date.now()

        const value = yield* session.exec
          .request({
            method: commandOptions.method,
            params: commandOptions.params,
            timeoutMs: commandOptions.timeoutMs ?? options.requestTimeoutMs ?? 30_000,
          })
          .pipe(
            Effect.mapError((cause) =>
              problem(
                Schema.is(ExecTimeout)(cause) ? "exec_timeout" : "exec_failed",
                cause.message,
              ),
            ),
          )

        if (commandOptions.method === EXEC_METHOD.updateSettings) {
          applySettings(session, commandOptions.params)
        }

        if (commandOptions.method === CHANGE_DIRECTORY) applyCwd(session, commandOptions.params)

        return value
      })

    const models = (sessionId: string): Effect.Effect<ReadonlyArray<JsonValue>, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(sessionId))

        return session.models
      })

    const pendingPrompt = (
      sessionId: string,
      requestId: string,
    ): Effect.Effect<PromptView | undefined, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(sessionId))

        const unavailable = requireLive(session)

        if (unavailable !== undefined) return yield* Effect.fail(unavailable)

        const pending = session.prompts.get(requestId)

        if (pending === undefined || pending.cancelled) return undefined

        if (session.turnEpoch !== pending.epoch || session.active === undefined) return undefined

        return pending.view
      })

    const answer = (
      answerOptions: AnswerOptions,
    ): Effect.Effect<{ readonly resolved: boolean }, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(answerOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(answerOptions.sessionId))

        const unavailable = requireLive(session)

        if (unavailable !== undefined) return yield* Effect.fail(unavailable)

        const claimed = yield* Semaphore.withPermit(
          session.promptMutex,
          Effect.sync(() => {
            const pending = session.prompts.get(answerOptions.requestId)

            if (pending === undefined || pending.cancelled || pending.owner !== "none") {
              return undefined
            }

            if (
              session.phase !== "open" ||
              !session.alive ||
              session.turnEpoch !== pending.epoch ||
              session.active === undefined ||
              session.byCli.get(pending.cliId) !== pending.publicId
            ) {
              return undefined
            }

            pending.owner = "answer"
            pending.cancelled = true
            session.prompts.delete(pending.publicId)

            if (session.byCli.get(pending.cliId) === pending.publicId) {
              session.byCli.delete(pending.cliId)
            }

            Deferred.doneUnsafe(pending.deferred, Effect.succeed(answerOptions.result))

            return pending
          }),
        )

        if (claimed === undefined) {
          return yield* Effect.fail(
            problem("prompt_not_found", "no pending prompt " + answerOptions.requestId),
          )
        }

        if (
          session.phase !== "open" ||
          !session.alive ||
          session.turnEpoch !== claimed.epoch ||
          session.byCli.has(claimed.cliId)
        ) {
          return yield* Effect.fail(
            problem("prompt_not_found", "no pending prompt " + answerOptions.requestId),
          )
        }

        rememberCorrelation(session, claimed)

        yield* session.exec.respond(claimed.cliId, answerOptions.result).pipe(
          Effect.mapError((cause) => {
            forgetCorrelation(session, claimed.publicId)

            return problem("exec_failed", cause.message)
          }),
        )

        return { resolved: true }
      })

    const reap = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = Date.now()

        for (const session of Array.from(sessions.values())) {
          if (session.active !== undefined) continue

          if (now - session.lastUsed < idleMs) continue

          logger?.info("session.reaped", { sessionId: session.id })
          yield* close(session.id).pipe(Effect.ignore)
        }
      })

    const reaper = yield* Effect.forkDetach(
      Effect.forever(
        Effect.sleep(Duration.millis(reaperIntervalMs)).pipe(Effect.flatMap(() => reap())),
      ),
    )

    const api: SessionHubApi = {
      create,
      stream,
      events,
      interrupt,
      close,
      answer,
      command,
      models,
      pendingPrompt,
      sessions: Effect.sync(() => {
        const listed: Array<SessionSummary> = []

        for (const session of sessions.values()) {
          listed.push({
            sessionId: session.id,
            cwd: session.cwd,
            settings: session.settings,
            status: listedStatus(session),
            cursor: session.nextSeq,
          })
        }

        return listed
      }),
    }

    return {
      api,
      closeAll: Effect.gen(function* () {
        closing = true
        yield* Fiber.interrupt(reaper)

        for (const session of Array.from(sessions.values())) {
          yield* close(session.id).pipe(Effect.ignore)
        }

        // `close` drops the public session before teardown. Children already closing,
        // and children not registered yet, are still in `owned` until `exec.close` settles.
        for (const record of Array.from(owned)) {
          yield* shutdownOwned(record)
        }
      }),
    }
  })
