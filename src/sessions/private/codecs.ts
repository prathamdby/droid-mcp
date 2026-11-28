/**
 * Input decoders, JSON schemas and output encoders for the 13 bound session
 * operations. Absent optional fields are omitted from encoded JSON rather than
 * emitted as null.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { AutonomyLevel } from "../../authority/index.ts"
import { InvalidInput } from "../../capabilities/index.ts"
import type { JsonSchemaObject } from "../../capabilities/index.ts"
import { decisionRefLabel, PERMISSION_OUTCOMES } from "../../decisions/index.ts"
import type { DecisionView } from "../../decisions/index.ts"
import { releasedJson } from "../../disclosure/index.ts"
import type { Released } from "../../disclosure/index.ts"
import type {
  PlacementForkOutcome,
  PlacementModelInfo,
  PlacementSettingsPatch,
  PlacementSettingsView,
} from "../../placement/index.ts"
import type { TurnView } from "../../turns/index.ts"
import type {
  RunView,
  SessionInteractionMode,
  SessionReasoningEffort,
  SessionSettings,
  SessionSummary,
  SessionWorkspaceIntent,
  SessionWorktreeView,
} from "./types.ts"

// ---------------------------------------------------------------------------
// Constants & shared schemas
// ---------------------------------------------------------------------------

export const MAX_WAIT_MS = 300_000
export const DEFAULT_WAIT_MS = 20_000

const AUTONOMY_LITERALS = ["off", "low", "medium", "high"] as const

const REASONING_LITERALS = [
  "none",
  "dynamic",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

const INTERACTION_LITERALS = ["auto", "spec", "agi", "mission"] as const

const DELIVERY_LITERALS = ["detach", "block"] as const

const AutonomySchema = Schema.Literals(AUTONOMY_LITERALS)
const ReasoningSchema = Schema.Literals(REASONING_LITERALS)
const InteractionSchema = Schema.Literals(INTERACTION_LITERALS)
const DeliverySchema = Schema.Literals(DELIVERY_LITERALS)
const PermissionOutcomeSchema = Schema.Literals(PERMISSION_OUTCOMES)

const WaitMsSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_MS }))

const CursorSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))

const WorktreeLifecycleSchema = Schema.Literals(["ephemeral", "persistent"])
const WorktreeBranchModeSchema = Schema.Literals(["copy", "existing"])

// ---------------------------------------------------------------------------
// Permission outcome autonomy requirement
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Generic decoder helper
// ---------------------------------------------------------------------------

const decodeWith = <A>(
  operation: string,
  schema: Schema.Codec<A, Schema.Json>,
  input: Schema.Json,
): Effect.Effect<A, InvalidInput> => {
  const decoded = Schema.decodeUnknownOption(schema)(input)

  if (Option.isNone(decoded)) {
    return Effect.fail(
      new InvalidInput({
        message: operation + " received invalid input arguments",
      }),
    )
  }

  return Effect.succeed(decoded.value)
}

const requireNonBlank = (
  operation: string,
  field: string,
  value: string,
): Effect.Effect<string, InvalidInput> => {
  if (value.trim().length === 0) {
    return Effect.fail(
      new InvalidInput({
        message: operation + ": " + field + " must not be blank",
      }),
    )
  }

  return Effect.succeed(value)
}

// ---------------------------------------------------------------------------
// Input types & codecs
// ---------------------------------------------------------------------------

interface WorktreeInputFields {
  readonly worktree?: boolean | undefined
  readonly worktreeLifecycle?: "ephemeral" | "persistent" | undefined
  readonly worktreeBranchMode?: "copy" | "existing" | undefined
  readonly worktreeBaseBranch?: string | undefined
  readonly worktreeBaseBranchFromOrigin?: boolean | undefined
  readonly worktreeNewBranch?: string | undefined
  readonly worktreeDir?: string | undefined
}

const worktreeInputSchemaFields = {
  worktree: Schema.optionalKey(Schema.Boolean),
  worktreeLifecycle: Schema.optionalKey(WorktreeLifecycleSchema),
  worktreeBranchMode: Schema.optionalKey(WorktreeBranchModeSchema),
  worktreeBaseBranch: Schema.optionalKey(Schema.String),
  worktreeBaseBranchFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeNewBranch: Schema.optionalKey(Schema.String),
  worktreeDir: Schema.optionalKey(Schema.String),
}

export const buildWorkspaceIntent = (
  cwd: string,
  fields: WorktreeInputFields,
): SessionWorkspaceIntent => {
  if (fields.worktree !== true) {
    return { kind: "borrowed", path: cwd }
  }

  const kind: "ephemeral" | "persistent" =
    fields.worktreeLifecycle === "persistent" ? "persistent" : "ephemeral"

  return {
    kind,
    repoPath: cwd,
    worktreeDir: fields.worktreeDir,
    branchMode: fields.worktreeBranchMode,
    baseBranch: fields.worktreeBaseBranch,
    baseBranchFromOrigin: fields.worktreeBaseBranchFromOrigin,
    newBranch: fields.worktreeNewBranch,
  }
}

export const buildSessionSettings = (input: {
  readonly autonomyLevel: AutonomyLevel
  readonly modelId?: string | undefined
  readonly reasoningEffort?: SessionReasoningEffort | undefined
  readonly interactionMode?: SessionInteractionMode | undefined
  readonly specModeModelId?: string | undefined
  readonly specModeReasoningEffort?: SessionReasoningEffort | undefined
  readonly disabledToolIds?: ReadonlyArray<string> | undefined
}): SessionSettings => ({
  autonomyLevel: input.autonomyLevel,
  modelId: input.modelId,
  reasoningEffort: input.reasoningEffort,
  interactionMode: input.interactionMode,
  specModeModelId: input.specModeModelId,
  specModeReasoningEffort: input.specModeReasoningEffort,
  disabledToolIds: input.disabledToolIds,
})

// 1. session_create
const SessionCreateInputSchema = Schema.Struct({
  cwd: NonEmptyStringSchema,
  autonomyLevel: AutonomySchema,
  modelId: Schema.optionalKey(Schema.String),
  reasoningEffort: Schema.optionalKey(ReasoningSchema),
  interactionMode: Schema.optionalKey(InteractionSchema),
  specModeModelId: Schema.optionalKey(Schema.String),
  specModeReasoningEffort: Schema.optionalKey(ReasoningSchema),
  disabledToolIds: Schema.optionalKey(Schema.Array(Schema.String)),
  ...worktreeInputSchemaFields,
})

export type SessionCreateInput = Schema.Schema.Type<typeof SessionCreateInputSchema>

export const decodeSessionCreate = (
  input: Schema.Json,
): Effect.Effect<SessionCreateInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_create", SessionCreateInputSchema, input), (decoded) =>
    Effect.as(requireNonBlank("session_create", "cwd", decoded.cwd), decoded),
  )

// 2. session_stream
const SessionStreamInputSchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  waitMs: Schema.optionalKey(WaitMsSchema),
  delivery: Schema.optionalKey(DeliverySchema),
})

export type SessionStreamInput = Schema.Schema.Type<typeof SessionStreamInputSchema>

export const decodeSessionStream = (
  input: Schema.Json,
): Effect.Effect<SessionStreamInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_stream", SessionStreamInputSchema, input), (decoded) =>
    Effect.as(requireNonBlank("session_stream", "sessionId", decoded.sessionId), decoded),
  )

// 3. session_events
const SessionEventsInputSchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
  cursor: CursorSchema,
  waitMs: Schema.optionalKey(WaitMsSchema),
})

export type SessionEventsInput = Schema.Schema.Type<typeof SessionEventsInputSchema>

export const decodeSessionEvents = (
  input: Schema.Json,
): Effect.Effect<SessionEventsInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_events", SessionEventsInputSchema, input), (decoded) =>
    Effect.as(requireNonBlank("session_events", "sessionId", decoded.sessionId), decoded),
  )

// 4 & 5 & 12. sessionId-only inputs
const SessionIdOnlySchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
})

export type SessionIdOnlyInput = Schema.Schema.Type<typeof SessionIdOnlySchema>

export const decodeSessionIdOnly = (
  operation: string,
  input: Schema.Json,
): Effect.Effect<SessionIdOnlyInput, InvalidInput> =>
  Effect.flatMap(decodeWith(operation, SessionIdOnlySchema, input), (decoded) =>
    Effect.as(requireNonBlank(operation, "sessionId", decoded.sessionId), decoded),
  )

// 6. session_list
const EmptyObjectSchema = Schema.Struct({})

export type SessionListInput = Schema.Schema.Type<typeof EmptyObjectSchema>

export const decodeSessionList = (
  input: Schema.Json,
): Effect.Effect<SessionListInput, InvalidInput> =>
  decodeWith("session_list", EmptyObjectSchema, input)

// 7. session_run
const SessionRunInputSchema = Schema.Struct({
  cwd: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  autonomyLevel: AutonomySchema,
  modelId: Schema.optionalKey(Schema.String),
  reasoningEffort: Schema.optionalKey(ReasoningSchema),
  interactionMode: Schema.optionalKey(InteractionSchema),
  waitMs: Schema.optionalKey(WaitMsSchema),
  delivery: Schema.optionalKey(DeliverySchema),
  ...worktreeInputSchemaFields,
})

export type SessionRunInput = Schema.Schema.Type<typeof SessionRunInputSchema>

export const decodeSessionRun = (
  input: Schema.Json,
): Effect.Effect<SessionRunInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_run", SessionRunInputSchema, input), (decoded) =>
    Effect.as(requireNonBlank("session_run", "cwd", decoded.cwd), decoded),
  )

// 8. session_respond_permission
const RespondPermissionInputSchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  outcome: PermissionOutcomeSchema,
  comment: Schema.optionalKey(Schema.String),
  editedSpecContent: Schema.optionalKey(Schema.String),
})

export type RespondPermissionInput = Schema.Schema.Type<typeof RespondPermissionInputSchema>

export const decodeRespondPermission = (
  input: Schema.Json,
): Effect.Effect<RespondPermissionInput, InvalidInput> =>
  Effect.flatMap(
    decodeWith("session_respond_permission", RespondPermissionInputSchema, input),
    (d) =>
      Effect.flatMap(requireNonBlank("session_respond_permission", "sessionId", d.sessionId), () =>
        Effect.as(requireNonBlank("session_respond_permission", "requestId", d.requestId), d),
      ),
  )

// 9. session_answer_question
const AnswerQuestionInputSchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  answers: Schema.Array(
    Schema.Struct({
      index: CursorSchema,
      answer: Schema.String,
    }),
  ),
})

export type AnswerQuestionInput = Schema.Schema.Type<typeof AnswerQuestionInputSchema>

export const decodeAnswerQuestion = (
  input: Schema.Json,
): Effect.Effect<AnswerQuestionInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_answer_question", AnswerQuestionInputSchema, input), (d) =>
    Effect.flatMap(requireNonBlank("session_answer_question", "sessionId", d.sessionId), () =>
      Effect.as(requireNonBlank("session_answer_question", "requestId", d.requestId), d),
    ),
  )

// 10. session_pick_options
const PickOptionsInputSchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  selectedIds: Schema.Array(Schema.String),
  refresh: Schema.optionalKey(Schema.Boolean),
})

export type PickOptionsInput = Schema.Schema.Type<typeof PickOptionsInputSchema>

export const decodePickOptions = (
  input: Schema.Json,
): Effect.Effect<PickOptionsInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_pick_options", PickOptionsInputSchema, input), (d) =>
    Effect.flatMap(requireNonBlank("session_pick_options", "sessionId", d.sessionId), () =>
      Effect.as(requireNonBlank("session_pick_options", "requestId", d.requestId), d),
    ),
  )

// 11. session_update_settings
const UpdateSettingsInputSchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
  autonomyLevel: Schema.optionalKey(AutonomySchema),
  modelId: Schema.optionalKey(Schema.String),
  reasoningEffort: Schema.optionalKey(ReasoningSchema),
  interactionMode: Schema.optionalKey(InteractionSchema),
  specModeModelId: Schema.optionalKey(Schema.String),
  specModeReasoningEffort: Schema.optionalKey(ReasoningSchema),
  disabledToolIds: Schema.optionalKey(Schema.Array(Schema.String)),
})

export type UpdateSettingsInput = Schema.Schema.Type<typeof UpdateSettingsInputSchema>

export const decodeUpdateSettings = (
  input: Schema.Json,
): Effect.Effect<UpdateSettingsInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_update_settings", UpdateSettingsInputSchema, input), (d) =>
    Effect.as(requireNonBlank("session_update_settings", "sessionId", d.sessionId), d),
  )

export const buildSettingsPatch = (input: UpdateSettingsInput): PlacementSettingsPatch => ({
  autonomyLevel: input.autonomyLevel,
  modelId: input.modelId,
  reasoningEffort: input.reasoningEffort,
  interactionMode: input.interactionMode,
  specModeModelId: input.specModeModelId,
  specModeReasoningEffort: input.specModeReasoningEffort,
  disabledToolIds: input.disabledToolIds,
})

// 13. session_fork
const ForkInputSchema = Schema.Struct({
  sessionId: NonEmptyStringSchema,
  title: Schema.optionalKey(Schema.String),
})

export type ForkInput = Schema.Schema.Type<typeof ForkInputSchema>

export const decodeFork = (input: Schema.Json): Effect.Effect<ForkInput, InvalidInput> =>
  Effect.flatMap(decodeWith("session_fork", ForkInputSchema, input), (d) =>
    Effect.as(requireNonBlank("session_fork", "sessionId", d.sessionId), d),
  )

// ---------------------------------------------------------------------------
// JSON Schemas for discovery
// ---------------------------------------------------------------------------

const worktreeJsonSchemaProperties = {
  worktree: { type: "boolean" },
  worktreeLifecycle: { type: "string", enum: ["ephemeral", "persistent"] },
  worktreeBranchMode: { type: "string", enum: ["copy", "existing"] },
  worktreeBaseBranch: { type: "string" },
  worktreeBaseBranchFromOrigin: { type: "boolean" },
  worktreeNewBranch: { type: "string" },
  worktreeDir: { type: "string" },
} satisfies JsonSchemaObject

const SESSION_INPUT_SCHEMA_MAP = {
  session_create: {
    type: "object",
    additionalProperties: false,
    required: ["cwd", "autonomyLevel"],
    properties: {
      cwd: { type: "string", minLength: 1 },
      autonomyLevel: { type: "string", enum: [...AUTONOMY_LITERALS] },
      modelId: { type: "string" },
      reasoningEffort: { type: "string", enum: [...REASONING_LITERALS] },
      interactionMode: { type: "string", enum: [...INTERACTION_LITERALS] },
      specModeModelId: { type: "string" },
      specModeReasoningEffort: { type: "string", enum: [...REASONING_LITERALS] },
      disabledToolIds: { type: "array", items: { type: "string" } },
      ...worktreeJsonSchemaProperties,
    },
  },
  session_stream: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "prompt"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      prompt: { type: "string", minLength: 1 },
      waitMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS },
      delivery: { type: "string", enum: [...DELIVERY_LITERALS] },
    },
  },
  session_events: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "cursor"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      cursor: { type: "integer", minimum: 0 },
      waitMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS },
    },
  },
  session_interrupt: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
    },
  },
  session_close: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
    },
  },
  session_list: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  session_run: {
    type: "object",
    additionalProperties: false,
    required: ["cwd", "prompt", "autonomyLevel"],
    properties: {
      cwd: { type: "string", minLength: 1 },
      prompt: { type: "string", minLength: 1 },
      autonomyLevel: { type: "string", enum: [...AUTONOMY_LITERALS] },
      modelId: { type: "string" },
      reasoningEffort: { type: "string", enum: [...REASONING_LITERALS] },
      interactionMode: { type: "string", enum: [...INTERACTION_LITERALS] },
      waitMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS },
      delivery: { type: "string", enum: [...DELIVERY_LITERALS] },
      ...worktreeJsonSchemaProperties,
    },
  },
  session_respond_permission: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "requestId", "outcome"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      requestId: { type: "string", minLength: 1 },
      outcome: { type: "string", enum: [...PERMISSION_OUTCOMES] },
      comment: { type: "string" },
      editedSpecContent: { type: "string" },
    },
  },
  session_answer_question: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "requestId", "answers"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      requestId: { type: "string", minLength: 1 },
      answers: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "answer"],
          properties: {
            index: { type: "integer", minimum: 0 },
            answer: { type: "string" },
          },
        },
      },
    },
  },
  session_pick_options: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "requestId", "selectedIds"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      requestId: { type: "string", minLength: 1 },
      selectedIds: { type: "array", items: { type: "string" } },
      refresh: { type: "boolean" },
    },
  },
  session_update_settings: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      autonomyLevel: { type: "string", enum: [...AUTONOMY_LITERALS] },
      modelId: { type: "string" },
      reasoningEffort: { type: "string", enum: [...REASONING_LITERALS] },
      interactionMode: { type: "string", enum: [...INTERACTION_LITERALS] },
      specModeModelId: { type: "string" },
      specModeReasoningEffort: { type: "string", enum: [...REASONING_LITERALS] },
      disabledToolIds: { type: "array", items: { type: "string" } },
    },
  },
  session_models: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
    },
  },
  session_fork: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      title: { type: "string" },
    },
  },
} satisfies Record<string, JsonSchemaObject>

export type SessionOperationName = keyof typeof SESSION_INPUT_SCHEMA_MAP

export const sessionInputSchema = (id: SessionOperationName): JsonSchemaObject =>
  SESSION_INPUT_SCHEMA_MAP[id]

// ---------------------------------------------------------------------------
// Output JSON encoders (omit absent optional members)
// ---------------------------------------------------------------------------

type EncodedSettings = {
  autonomyLevel?: string
  interactionMode?: string
  modelId?: string
  reasoningEffort?: string
  specModeModelId?: string
  specModeReasoningEffort?: string
  disabledToolIds?: Array<string>
}

export const encodeSettings = (settings: PlacementSettingsView | undefined): EncodedSettings => {
  const out: EncodedSettings = {}

  if (settings === undefined) return out

  out.autonomyLevel = settings.autonomyLevel

  if (settings.interactionMode !== undefined) out.interactionMode = settings.interactionMode

  if (settings.modelId !== undefined) out.modelId = settings.modelId

  if (settings.reasoningEffort !== undefined) out.reasoningEffort = settings.reasoningEffort

  if (settings.specModeModelId !== undefined) out.specModeModelId = settings.specModeModelId

  if (settings.specModeReasoningEffort !== undefined) {
    out.specModeReasoningEffort = settings.specModeReasoningEffort
  }

  if (settings.disabledToolIds !== undefined) {
    out.disabledToolIds = [...settings.disabledToolIds]
  }

  return out
}

type EncodedWorktree = {
  path: string
  acquiredPath: string
  lifecycle: "ephemeral" | "persistent"
  branch?: string
}

export const encodeWorktree = (worktree: SessionWorktreeView): EncodedWorktree => {
  const out: EncodedWorktree = {
    path: worktree.path,
    acquiredPath: worktree.acquiredPath,
    lifecycle: worktree.lifecycle,
  }

  if (worktree.branch !== undefined) out.branch = worktree.branch

  return out
}

type EncodedSummary = {
  sessionId: string
  status: string
  cursor: number
  settings: EncodedSettings
  facets: Array<string>
  cwd?: string
  worktree?: EncodedWorktree
}

export const encodeSummary = (summary: SessionSummary): EncodedSummary => {
  const out: EncodedSummary = {
    sessionId: summary.sessionId,
    status: summary.status,
    cursor: summary.cursor,
    settings: encodeSettings(summary.settings),
    facets: [...summary.facets],
  }

  if (summary.cwd !== undefined) out.cwd = summary.cwd

  if (summary.worktree !== undefined) out.worktree = encodeWorktree(summary.worktree)

  return out
}

type EncodedPermissionDecision = {
  requestId: string
  kind: "permission"
  outcomes: Array<string>
  summary?: string
  details?: Schema.Json
}

type EncodedQuestionEntry = {
  index: number
  text: string
  multiSelect: boolean
  topic?: string
  options?: Array<Schema.Json>
}

type EncodedQuestionDecision = {
  requestId: string
  kind: "question"
  questions: Array<EncodedQuestionEntry>
}

type EncodedOptionRow = {
  id: string
  label?: string
  detail?: string
}

type EncodedOptionsDecision = {
  requestId: string
  kind: "options"
  rows: Array<EncodedOptionRow>
  multiSelect: boolean
  refreshable: boolean
  title?: string
  hint?: string
}

type EncodedDecision = EncodedPermissionDecision | EncodedQuestionDecision | EncodedOptionsDecision

export const encodeDecisionView = (view: DecisionView): EncodedDecision => {
  const data = view.data
  const requestId = decisionRefLabel(view.ref)

  if (data.kind === "permission") {
    const out: EncodedPermissionDecision = {
      requestId,
      kind: data.kind,
      outcomes: [...data.outcomes],
    }

    if (data.summary !== undefined) out.summary = data.summary

    if (data.details !== undefined) out.details = data.details

    return out
  }

  if (data.kind === "question") {
    const questions: Array<EncodedQuestionEntry> = []

    for (const q of data.questions) {
      const entry: EncodedQuestionEntry = {
        index: q.index,
        text: q.text,
        multiSelect: q.multiSelect,
      }

      if (q.topic !== undefined) entry.topic = q.topic

      if (q.options !== undefined) entry.options = [...q.options]

      questions.push(entry)
    }

    return {
      requestId,
      kind: data.kind,
      questions,
    }
  }

  const rows: Array<EncodedOptionRow> = []

  for (const row of data.rows) {
    const entry: EncodedOptionRow = { id: row.id }

    if (row.label !== undefined) entry.label = row.label

    if (row.detail !== undefined) entry.detail = row.detail

    rows.push(entry)
  }

  const out: EncodedOptionsDecision = {
    requestId,
    kind: data.kind,
    rows,
    multiSelect: data.multiSelect,
    refreshable: data.refreshable,
  }

  if (data.title !== undefined) out.title = data.title

  if (data.hint !== undefined) out.hint = data.hint

  return out
}

export const encodeReleasedEvents = (
  events: ReadonlyArray<Released<"event">>,
): Array<Schema.Json> => {
  const out: Array<Schema.Json> = []

  for (const item of events) {
    const payload = releasedJson(item)

    if (Option.isSome(payload)) out.push(payload.value)
  }

  return out
}

type EncodedTurnPayload = {
  sessionId: string
  status: string
  cursor: number
  events: Array<Schema.Json>
  truncated: boolean
  outstandingDecisions: Array<EncodedDecision>
  turnId?: string
  omittedCount?: number
  result?: Schema.Json
  lastText?: string
  failureReason?: string
}

export const encodeTurnPayload = (args: {
  readonly sessionId: string
  readonly turnId?: string | undefined
  readonly turn: TurnView | undefined
  readonly cursor: number
  readonly events: ReadonlyArray<Released<"event">>
  readonly truncated: boolean
  readonly omittedCount?: number | undefined
}): EncodedTurnPayload => {
  const out: EncodedTurnPayload = {
    sessionId: args.sessionId,
    status: args.turn === undefined ? "idle" : args.turn.status,
    cursor: args.cursor,
    events: encodeReleasedEvents(args.events),
    truncated: args.truncated,
    outstandingDecisions:
      args.turn === undefined ? [] : args.turn.outstandingDecisions.map(encodeDecisionView),
  }

  if (args.turnId !== undefined) out.turnId = args.turnId

  if (args.omittedCount !== undefined && args.omittedCount > 0) {
    out.omittedCount = args.omittedCount
  }

  if (args.turn !== undefined) {
    if (args.turn.summary !== undefined) {
      const summaryJson = releasedJson(args.turn.summary)

      if (Option.isSome(summaryJson)) out.result = summaryJson.value
    }

    if (args.turn.lastText !== undefined) out.lastText = args.turn.lastText

    if (args.turn.failureReason !== undefined) out.failureReason = args.turn.failureReason
  }

  return out
}

type EncodedRunView = {
  sessionId: string
  closed: boolean
  status: string
  cursor: number
  events: Array<Schema.Json>
  truncated: boolean
  outstandingDecisions: Array<EncodedDecision>
  result?: Schema.Json
  lastText?: string
  failureReason?: string
}

export const encodeRunView = (view: RunView): EncodedRunView => {
  const out: EncodedRunView = {
    sessionId: view.sessionId,
    closed: view.closed,
    status: view.status,
    cursor: view.cursor,
    events: encodeReleasedEvents(view.events),
    truncated: view.truncated,
    outstandingDecisions: view.outstandingDecisions.map(encodeDecisionView),
  }

  if (view.summary !== undefined) {
    const summaryJson = releasedJson(view.summary)

    if (Option.isSome(summaryJson)) out.result = summaryJson.value
  }

  if (view.lastText !== undefined) out.lastText = view.lastText

  if (view.failureReason !== undefined) out.failureReason = view.failureReason

  return out
}

type EncodedModelInfo = {
  id: string
  displayName?: string
  provider?: string
}

export const encodeModels = (
  models: ReadonlyArray<PlacementModelInfo>,
): Array<EncodedModelInfo> => {
  const out: Array<EncodedModelInfo> = []

  for (const model of models) {
    const entry: EncodedModelInfo = { id: model.id }

    if (model.displayName !== undefined) entry.displayName = model.displayName

    if (model.provider !== undefined) entry.provider = model.provider

    out.push(entry)
  }

  return out
}

type EncodedForkOutcome =
  | { readonly sessionId: string; readonly kind: "runnable"; readonly forkedSessionId: string }
  | { readonly sessionId: string; readonly kind: "external"; readonly externalSessionId: string }

export const encodeForkOutcome = (
  sessionId: string,
  outcome: PlacementForkOutcome,
): EncodedForkOutcome =>
  outcome.kind === "runnable"
    ? {
        sessionId,
        kind: "runnable",
        forkedSessionId: outcome.sessionId,
      }
    : {
        sessionId,
        kind: "external",
        externalSessionId: outcome.externalSessionId,
      }

type EncodedCreateResult = {
  sessionId: string
  cwd: string
  settings: EncodedSettings
  worktree?: EncodedWorktree
}

export const encodeCreateResult = (
  summary: SessionSummary,
  fallbackCwd: string,
): EncodedCreateResult => {
  const out: EncodedCreateResult = {
    sessionId: summary.sessionId,
    cwd: summary.cwd ?? fallbackCwd,
    settings: encodeSettings(summary.settings),
  }

  if (summary.worktree !== undefined) {
    out.worktree = encodeWorktree(summary.worktree)
  }

  return out
}
