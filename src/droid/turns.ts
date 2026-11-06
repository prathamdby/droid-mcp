import { statSync } from "node:fs"
import { isAbsolute } from "node:path"

import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

import type { AutonomyLevel } from "../config.ts"
import type { Logger } from "../log.ts"
import { ExecTimeout } from "./errors.ts"
import { start } from "./exec-client.ts"
import type { ExecClient, ExecRequest } from "./exec-client.ts"
import { EXEC_METHOD } from "./exec-protocol.ts"
import { promptEvent, viewOf } from "./prompts.ts"
import type { Prompt } from "./prompts.ts"
import type { PromptView } from "./prompts.ts"
import type { JsonValue } from "./protocol.ts"
import { toJsonValue } from "./protocol.ts"

/** Text in an event is capped so one long block cannot bloat every poll. */
export const EVENT_TEXT_LIMIT = 4 * 1024
export const RING_EVENT_LIMIT = 500
export const RING_BYTE_LIMIT = 256 * 1024
export const DEFAULT_WAIT_MS = 20_000
export const IDLE_SESSION_MS = 30 * 60 * 1000
export const REAPER_INTERVAL_MS = 60_000
export const PROMPT_TIMEOUT_MS = 300_000

export const TurnStatusSchema = Schema.Literals(["running", "completed", "interrupted", "failed"])

export type TurnStatus = typeof TurnStatusSchema.Type

export const TurnEventSchema = Schema.Struct({
  seq: Schema.Number,
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
  deadline: Schema.optional(Schema.Number),
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
  cursor: Schema.Number,
  events: Schema.Array(TurnEventSchema),
  truncated: Schema.Boolean,
  result: Schema.optional(
    Schema.Struct({
      reason: Schema.String,
      turnId: Schema.optional(Schema.String),
      durationMs: Schema.optional(Schema.Number),
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
  readonly startedAt: number
  readonly firstSeq: number
  readonly completion: Deferred.Deferred<Completion>
}

interface PendingPrompt {
  readonly id: string
  readonly method: string
  readonly view: PromptView | undefined
  readonly deferred: Deferred.Deferred<JsonValue>
}

interface SessionState {
  readonly id: string
  readonly cwd: string
  readonly exec: ExecClient
  readonly mutex: Semaphore.Semaphore
  readonly promptMutex: Semaphore.Semaphore
  readonly prompts: Map<string, PendingPrompt>
  readonly deltas: Map<string, string>
  readonly buffer: Array<TurnEvent>
  settings: SessionSettings
  models: ReadonlyArray<JsonValue>
  lastStatus: TurnStatus
  nextSeq: number
  bytes: number
  active: ActiveTurn | undefined
  /** The last turn's outcome, so a poll after completion still reports it. */
  lastCompletion: Completion | undefined
  structuredOutput: JsonValue | undefined
  signal: Deferred.Deferred<void>
  lastUsed: number
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

const cap = (text: string, limit: number = EVENT_TEXT_LIMIT): string =>
  text.length <= limit ? text : text.slice(0, limit) + "…[truncated]"

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

const notFound = (sessionId: string): SessionProblem =>
  new SessionProblem({
    code: "session_not_found",
    message: "no session " + sessionId + "; call session_create first",
  })

export const checkCwd = (cwd: string): Effect.Effect<string, SessionProblem> => {
  if (!isAbsolute(cwd)) {
    return Effect.fail(
      new SessionProblem({ code: "invalid_cwd", message: "cwd must be an absolute path" }),
    )
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
        : Effect.fail(
            new SessionProblem({
              code: "invalid_cwd",
              message: "cwd does not exist or is not a directory: " + cwd,
            }),
          ),
    ),
  )
}

export const sessionHub = (options: SessionHubOptions): Effect.Effect<SessionHub> =>
  Effect.gen(function* () {
    const sessions = new Map<string, SessionState>()
    const logger = options.logger
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
    const idleMs = options.idleMs ?? IDLE_SESSION_MS
    const reaperIntervalMs = options.reaperIntervalMs ?? REAPER_INTERVAL_MS
    const promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS
    const fibers: Array<Fiber.Fiber<unknown>> = []

    const publish = (session: SessionState, draft: EventDraft): void => {
      const full: TurnEvent = { ...draft, seq: session.nextSeq }
      session.nextSeq += 1
      session.buffer.push(full)
      session.bytes += JSON.stringify(full).length

      while (session.buffer.length > RING_EVENT_LIMIT || session.bytes > RING_BYTE_LIMIT) {
        const removed = session.buffer.shift()

        if (removed === undefined) break

        session.bytes -= JSON.stringify(removed).length
      }

      const waiting = session.signal
      session.signal = Deferred.makeUnsafe<void>()
      Deferred.doneUnsafe(waiting, Effect.void)
    }

    const snapshot = (session: SessionState, cursor: number) => {
      const oldest = session.buffer[0]?.seq ?? session.nextSeq

      return {
        events: session.buffer.filter((event) => event.seq >= cursor),
        truncated: cursor < oldest,
        next: session.nextSeq,
      }
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

      if (session.structuredOutput !== undefined) {
        completion.structuredOutput = session.structuredOutput
      }

      session.active = undefined
      session.lastCompletion = completion
      session.structuredOutput = undefined
      session.lastStatus = statusOf(completion.reason)
      publish(session, {
        kind: "turn_completed",
        status: session.lastStatus,
        reason: completion.reason,
      })
      Deferred.doneUnsafe(active.completion, Effect.succeed(completion))
    }

    const onNotification = (session: SessionState, params: JsonValue | undefined): void => {
      if (params === undefined) return

      const envelope = Schema.decodeUnknownOption(NotificationEnvelopeSchema)(params)

      if (Option.isNone(envelope)) return

      const value = envelope.value.notification
      const delta = Schema.decodeUnknownOption(TextDelta)(value)

      if (Option.isSome(delta)) {
        const key = delta.value.messageId + ":" + String(delta.value.blockIndex)
        session.deltas.set(key, (session.deltas.get(key) ?? "") + delta.value.textDelta)

        return
      }

      const complete = Schema.decodeUnknownOption(TextComplete)(value)

      if (Option.isSome(complete)) {
        const key = complete.value.messageId + ":" + String(complete.value.blockIndex)
        const text = session.deltas.get(key) ?? ""
        session.deltas.delete(key)
        publish(session, {
          kind: "assistant_text",
          text: cap(text),
          messageId: complete.value.messageId,
        })

        return
      }

      const thinking = Schema.decodeUnknownOption(ThinkingComplete)(value)

      if (Option.isSome(thinking)) {
        publish(session, { kind: "thinking", text: cap(thinking.value.text) })

        return
      }

      const call = Schema.decodeUnknownOption(ToolCall)(value)

      if (Option.isSome(call)) {
        const draft: EventDraft = {
          kind: "tool_call",
          toolUseId: call.value.toolUseId,
          name: call.value.name,
        }

        if (call.value.input !== undefined) draft.input = call.value.input
        publish(session, draft)

        return
      }

      const toolResult = Schema.decodeUnknownOption(ToolResult)(value)

      if (Option.isSome(toolResult)) {
        const draft: EventDraft = {
          kind: "tool_result",
          toolUseId: toolResult.value.toolUseId,
          output: cap(stringify(toolResult.value.result)),
        }

        if (toolResult.value.isError !== undefined) draft.isError = toolResult.value.isError
        publish(session, draft)

        return
      }

      const failure = Schema.decodeUnknownOption(ErrorNote)(value)

      if (Option.isSome(failure)) {
        const draft: EventDraft = { kind: "error", message: cap(failure.value.message) }

        if (failure.value.errorType !== undefined) draft.code = failure.value.errorType
        publish(session, draft)

        return
      }

      const resolved = Schema.decodeUnknownOption(PermissionResolved)(value)

      if (Option.isSome(resolved)) {
        const draft: EventDraft = { kind: "prompt_resolved" }

        if (resolved.value.toolUseId !== undefined) draft.toolUseId = resolved.value.toolUseId

        if (resolved.value.requestId !== undefined) draft.requestId = resolved.value.requestId
        publish(session, draft)

        return
      }

      const assistant = Schema.decodeUnknownOption(AssistantMessage)(value)

      if (Option.isSome(assistant) && assistant.value.message.role === "assistant") {
        const text = textOfMessage(assistant.value.message.content)

        if (text.length > 0) {
          const draft: EventDraft = { kind: "assistant_text", text: cap(text) }

          if (assistant.value.message.id !== undefined) {
            draft.messageId = assistant.value.message.id
          }

          publish(session, draft)
        }

        return
      }

      const structured = Schema.decodeUnknownOption(StructuredOutput)(value)

      if (Option.isSome(structured)) {
        session.structuredOutput = structured.value.data

        return
      }

      const completed = Schema.decodeUnknownOption(TurnCompleted)(value)

      if (Option.isSome(completed)) completeTurn(session, completed.value)
    }

    const answerPrompt = (session: SessionState, requestId: string, result: JsonValue): boolean => {
      const pending = session.prompts.get(requestId)

      if (pending === undefined) return false

      session.prompts.delete(requestId)
      Deferred.doneUnsafe(pending.deferred, Effect.succeed(result))

      return true
    }

    const onPrompt = (session: SessionState, request: ExecRequest): Effect.Effect<void> =>
      Effect.gen(function* () {
        const prompt: Prompt = { id: request.id, method: request.method }
        const view = viewOf(request.method, request.params)
        const deadline = Date.now() + promptTimeoutMs

        const event = promptEvent(
          view === undefined ? prompt : { id: request.id, method: request.method, view },
          deadline,
        )

        const draft: EventDraft = {
          kind: event.kind,
          requestId: event.requestId,
          deadline: event.deadline,
          promptType: request.method,
        }

        if (event.options !== undefined) draft.options = event.options

        if (event.toolUses !== undefined) draft.toolUses = event.toolUses

        if (event.questions !== undefined) draft.questions = event.questions

        if (event.rows !== undefined) draft.rows = event.rows.map((row) => ({ ...row }))

        if (event.multi !== undefined) draft.multi = event.multi
        publish(session, draft)

        const deferred = Deferred.makeUnsafe<JsonValue>()
        session.prompts.set(request.id, { id: request.id, method: request.method, view, deferred })

        const waiter = Effect.gen(function* () {
          const answered = yield* Deferred.await(deferred).pipe(
            Effect.timeoutOption(Duration.millis(promptTimeoutMs)),
          )

          if (Option.isSome(answered)) {
            yield* session.exec.respond(request.id, answered.value).pipe(Effect.ignore)

            return
          }

          session.prompts.delete(request.id)
          yield* session.exec
            .respond(request.id, promptCancelResult(request.method))
            .pipe(Effect.ignore)
          publish(session, {
            kind: "prompt_resolved",
            requestId: request.id,
            reason: "timeout",
            message: "no answer within " + String(promptTimeoutMs) + " ms",
          })
        })

        fibers.push(yield* Effect.forkDetach(waiter))
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
              const active = session.active

              if (active === undefined) return

              const completion: Completion = {
                reason: "process_exit",
                durationMs: Date.now() - active.startedAt,
              }

              session.active = undefined
              session.lastCompletion = completion
              session.lastStatus = "failed"
              publish(session, {
                kind: "error",
                code: "process_exit",
                message: "droid exec exited with code " + String(info.code),
              })
              publish(session, {
                kind: "turn_completed",
                status: "failed",
                reason: "process_exit",
              })
              Deferred.doneUnsafe(active.completion, Effect.succeed(completion))
            }),
          ),
        )

        fibers.push(yield* Effect.forkDetach(notifications))
        fibers.push(yield* Effect.forkDetach(requests))
        fibers.push(yield* Effect.forkDetach(exitWatcher))
      })

    const create = (
      createOptions: CreateSessionOptions,
    ): Effect.Effect<CreateSessionResult, SessionProblem> =>
      Effect.gen(function* () {
        const cwd = yield* checkCwd(createOptions.cwd)

        const exec = yield* start({
          droidPath: options.droidPath,
          cwd,
          version: options.version,
          env: options.env,
          args: options.args,
          requestTimeoutMs: options.requestTimeoutMs,
          logger,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SessionProblem({
                code: "exec_failed",
                message: cause.message + (cause.detail === undefined ? "" : ": " + cause.detail),
              }),
          ),
        )

        const initialized = yield* exec
          .request({
            method: EXEC_METHOD.initialize,
            params: { machineId: "local", cwd },
            timeoutMs: options.requestTimeoutMs ?? 60_000,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionProblem({
                  code: Schema.is(ExecTimeout)(cause) ? "exec_timeout" : "exec_failed",
                  message: cause.message,
                }),
            ),
          )

        const decoded = Option.getOrUndefined(
          Schema.decodeUnknownOption(InitializeResult)(initialized),
        )

        if (decoded === undefined) {
          yield* exec.close

          return yield* Effect.fail(
            new SessionProblem({
              code: "exec_failed",
              message: "droid exec did not return a session id",
            }),
          )
        }

        const settings: SessionSettings = {
          autonomyLevel: createOptions.autonomyLevel,
          interactionMode: "auto",
          modelId: createOptions.modelId,
          reasoningEffort: createOptions.reasoningEffort,
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
          .pipe(
            Effect.mapError(
              (cause) => new SessionProblem({ code: "exec_failed", message: cause.message }),
            ),
          )

        const session: SessionState = {
          id: decoded.sessionId,
          cwd,
          exec,
          mutex: yield* Semaphore.make(1),
          promptMutex: yield* Semaphore.make(1),
          prompts: new Map(),
          deltas: new Map(),
          buffer: [],
          settings,
          models: decoded.availableModels ?? [],
          lastStatus: "completed",
          nextSeq: 1,
          bytes: 0,
          active: undefined,
          lastCompletion: undefined,
          structuredOutput: undefined,
          signal: Deferred.makeUnsafe<void>(),
          lastUsed: Date.now(),
        }

        sessions.set(session.id, session)
        yield* attach(session)

        return { sessionId: session.id, cwd, settings }
      })

    const stream = (streamOptions: StreamOptions): Effect.Effect<TurnResult, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(streamOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(streamOptions.sessionId))

        if (streamOptions.prompt.trim().length === 0) {
          return yield* Effect.fail(
            new SessionProblem({
              code: "invalid_prompt",
              message: "prompt must contain at least one non-whitespace character",
            }),
          )
        }

        if (session.active !== undefined) {
          return yield* Effect.fail(
            new SessionProblem({
              code: "session_busy",
              message: "session " + session.id + " already has a running turn",
            }),
          )
        }

        const acquired = yield* Semaphore.takeIfAvailable(session.mutex, 1)

        if (!acquired) {
          return yield* Effect.fail(
            new SessionProblem({
              code: "session_busy",
              message: "session " + session.id + " already has a running turn",
            }),
          )
        }

        const active: ActiveTurn = {
          startedAt: Date.now(),
          firstSeq: session.nextSeq,
          completion: Deferred.makeUnsafe<Completion>(),
        }

        return yield* Effect.ensuring(
          Effect.gen(function* () {
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
              // The child may have exited while the message was in flight; the
              // exit watcher owns the turn and has published the reason.
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

              session.active = undefined
              session.lastStatus = "failed"
              publish(session, { kind: "error", code: "exec_failed", message: sent.message })
              publish(session, {
                kind: "turn_completed",
                status: "failed",
                reason: "process_exit",
              })

              return resultOf(session, "failed", active.firstSeq, {
                reason: "process_exit",
                durationMs: Date.now() - active.startedAt,
              })
            }

            const waited = yield* Deferred.await(active.completion).pipe(
              Effect.timeoutOption(Duration.millis(streamOptions.waitMs ?? waitMs)),
            )

            return Option.match(waited, {
              onNone: () => resultOf(session, "running", active.firstSeq, undefined),
              onSome: (completion) =>
                resultOf(session, statusOf(completion.reason), active.firstSeq, completion),
            })
          }),
          Semaphore.release(session.mutex, 1),
        )
      })

    const events = (eventsOptions: EventsOptions): Effect.Effect<TurnResult, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(eventsOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(eventsOptions.sessionId))

        session.lastUsed = Date.now()
        const current = snapshot(session, eventsOptions.cursor)

        if (session.active === undefined || current.events.length > 0) {
          return resultOf(
            session,
            session.active === undefined ? session.lastStatus : "running",
            eventsOptions.cursor,
            session.active === undefined ? session.lastCompletion : undefined,
          )
        }

        const signal = session.signal
        yield* Effect.raceFirst(
          Deferred.await(signal),
          Effect.sleep(Duration.millis(eventsOptions.waitMs ?? waitMs)),
        )

        return resultOf(
          session,
          session.active === undefined ? session.lastStatus : "running",
          eventsOptions.cursor,
          session.active === undefined ? session.lastCompletion : undefined,
        )
      })

    const interrupt = (
      sessionId: string,
    ): Effect.Effect<{ readonly interrupted: boolean }, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(sessionId))

        // The CLI accepts an interrupt at any time; the boolean reports whether
        // there was a turn for it to stop.
        const interrupted = session.active !== undefined

        yield* session.exec
          .request({ method: EXEC_METHOD.interrupt, params: { sessionId } })
          .pipe(Effect.ignore)

        return { interrupted }
      })

    const close = (
      sessionId: string,
    ): Effect.Effect<{ readonly closed: boolean }, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(sessionId))

        sessions.delete(sessionId)

        for (const pending of session.prompts.values()) {
          Deferred.doneUnsafe(pending.deferred, Effect.succeed(promptCancelResult(pending.method)))
        }

        session.prompts.clear()
        yield* session.exec
          .request({ method: EXEC_METHOD.close, params: { sessionId } })
          .pipe(Effect.ignore)
        yield* session.exec.close

        return { closed: true }
      })

    const command = (
      commandOptions: CommandOptions,
    ): Effect.Effect<JsonValue | undefined, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(commandOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(commandOptions.sessionId))

        session.lastUsed = Date.now()

        return yield* session.exec
          .request({
            method: commandOptions.method,
            params: commandOptions.params,
            timeoutMs: commandOptions.timeoutMs ?? options.requestTimeoutMs ?? 30_000,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionProblem({
                  code: Schema.is(ExecTimeout)(cause) ? "exec_timeout" : "exec_failed",
                  message: cause.message,
                }),
            ),
          )
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

        return session.prompts.get(requestId)?.view
      })

    const answer = (
      answerOptions: AnswerOptions,
    ): Effect.Effect<{ readonly resolved: boolean }, SessionProblem> =>
      Effect.gen(function* () {
        const session = sessions.get(answerOptions.sessionId)

        if (session === undefined) return yield* Effect.fail(notFound(answerOptions.sessionId))

        const resolved = yield* Semaphore.withPermit(
          session.promptMutex,
          Effect.sync(() => answerPrompt(session, answerOptions.requestId, answerOptions.result)),
        )

        if (!resolved) {
          return yield* Effect.fail(
            new SessionProblem({
              code: "prompt_not_found",
              message: "no pending prompt " + answerOptions.requestId,
            }),
          )
        }

        return { resolved }
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
      sessions: Effect.sync(() =>
        Array.from(sessions.values()).map((session) => ({
          sessionId: session.id,
          cwd: session.cwd,
          status: session.active === undefined ? session.lastStatus : "running",
          cursor: session.nextSeq,
        })),
      ),
    }

    return {
      api,
      closeAll: Effect.gen(function* () {
        yield* Fiber.interrupt(reaper)

        for (const session of Array.from(sessions.values())) {
          yield* close(session.id).pipe(Effect.ignore)
        }

        for (const fiber of fibers) {
          yield* Fiber.interrupt(fiber)
        }
      }),
    }
  })
