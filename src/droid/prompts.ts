import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { EXEC_METHOD } from "./exec-protocol.ts"
import type { JsonValue } from "./protocol.ts"

/**
 * The three prompts Droid raises mid-turn. Each one is a server-to-client
 * request; the hub parks it, publishes an event, and replies with whatever the
 * caller sends back. Validation lives here so a tool handler cannot send a
 * malformed answer to the CLI.
 */

/** Permission outcomes the CLI accepts (`PermissionSelectedOption`). */
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

export const PermissionOutcomeSchema = Schema.Literals(PERMISSION_OUTCOMES)

const ToolUseSchema = Schema.Struct({
  toolUse: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Json),
    }),
  ),
  confirmationType: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Json),
})

/**
 * The CLI sends option objects (`{ label, value }`); older builds and the SDK
 * types send bare outcome strings. Accept both so a real prompt never degrades
 * to an unanswerable generic event.
 */
const PermissionOptionSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    value: Schema.String,
    label: Schema.optional(Schema.String),
  }),
])

const PermissionParams = Schema.Struct({
  toolUses: Schema.optional(Schema.Array(ToolUseSchema)),
  options: Schema.optional(Schema.Array(PermissionOptionSchema)),
  associatedSessionIds: Schema.optional(Schema.Array(Schema.String)),
})

const QuestionSchema = Schema.Struct({
  index: Schema.Number,
  topic: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.optional(Schema.Array(Schema.Json)),
  multiSelect: Schema.optional(Schema.Boolean),
})

const AskUserParams = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  questions: Schema.Array(QuestionSchema),
})

const OptionRowSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
})

const PickOptionsParams = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
  emptyText: Schema.optional(Schema.String),
  rows: Schema.Array(OptionRowSchema),
  multi: Schema.optional(Schema.Boolean),
  preselectedIds: Schema.optional(Schema.Array(Schema.String)),
  initialSearch: Schema.optional(Schema.String),
})

export const PromptKindSchema = Schema.Literals(["permission", "question", "options"])

export type PromptKind = typeof PromptKindSchema.Type

export interface PermissionView {
  readonly kind: "permission"
  readonly toolUses: ReadonlyArray<typeof ToolUseSchema.Type>
  readonly options: ReadonlyArray<PermissionOutcome>
  readonly associatedSessionIds: ReadonlyArray<string>
}

export interface QuestionView {
  readonly kind: "question"
  readonly toolCallId?: string
  readonly questions: ReadonlyArray<typeof QuestionSchema.Type>
}

export interface OptionRow {
  readonly id: string
  readonly label?: string
  readonly detail?: string
}

export interface OptionsView {
  readonly kind: "options"
  readonly rows: ReadonlyArray<OptionRow>
  readonly multi: boolean
  readonly preselectedIds: ReadonlyArray<string>
}

export type PromptView = PermissionView | QuestionView | OptionsView

const decode = <A>(schema: Schema.Codec<A>, value: JsonValue | undefined): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(value)

export const kindOfMethod = (method: string): PromptKind | undefined => {
  if (method === EXEC_METHOD.requestPermission) return "permission"

  if (method === EXEC_METHOD.askUser) return "question"

  if (method === EXEC_METHOD.pickOptions) return "options"

  return undefined
}

/** Narrows the CLI's permission options to the values droid-mcp accepts. */
const knownOutcomes = (
  options: ReadonlyArray<Schema.Schema.Type<typeof PermissionOptionSchema>> | undefined,
): ReadonlyArray<PermissionOutcome> => {
  if (options === undefined || options.length === 0) return PERMISSION_OUTCOMES

  const values = options.map((option) => (Schema.is(Schema.String)(option) ? option : option.value))

  return PERMISSION_OUTCOMES.filter((outcome) => values.includes(outcome))
}

export const viewOf = (method: string, params: JsonValue | undefined): PromptView | undefined => {
  const kind = kindOfMethod(method)

  if (kind === "permission") {
    const decoded = decode(PermissionParams, params)

    if (Option.isNone(decoded)) return undefined

    return {
      kind: "permission",
      toolUses: decoded.value.toolUses ?? [],
      options: knownOutcomes(decoded.value.options),
      associatedSessionIds: decoded.value.associatedSessionIds ?? [],
    }
  }

  if (kind === "question") {
    const decoded = decode(AskUserParams, params)

    if (Option.isNone(decoded)) return undefined

    return {
      kind: "question",
      toolCallId: decoded.value.toolCallId,
      questions: decoded.value.questions,
    }
  }

  if (kind === "options") {
    const decoded = decode(PickOptionsParams, params)

    if (Option.isNone(decoded)) return undefined

    return {
      kind: "options",
      rows: decoded.value.rows,
      multi: decoded.value.multi === true,
      preselectedIds: decoded.value.preselectedIds ?? [],
    }
  }

  return undefined
}

export interface Prompt {
  readonly id: string
  readonly method: string
  readonly view?: PromptView
}

/** The event a caller sees; `deadline` is an absolute epoch millisecond. */
export interface PromptEvent {
  readonly kind: string
  readonly requestId: string
  readonly deadline: number
  readonly options?: ReadonlyArray<PermissionOutcome>
  readonly toolUses?: ReadonlyArray<typeof ToolUseSchema.Type>
  readonly questions?: ReadonlyArray<typeof QuestionSchema.Type>
  readonly rows?: ReadonlyArray<PickOptionRow>
  readonly multi?: boolean
}

export interface PickOptionRow {
  readonly id: string
  readonly label?: string
  readonly detail?: string
}

const permissionEvent = (prompt: Prompt, view: PermissionView, deadline: number): PromptEvent => ({
  kind: "pending_permission",
  requestId: prompt.id,
  deadline,
  options: view.options,
  toolUses: view.toolUses,
})

const questionEvent = (prompt: Prompt, view: QuestionView, deadline: number): PromptEvent => ({
  kind: "pending_question",
  requestId: prompt.id,
  deadline,
  questions: view.questions,
})

const optionsEvent = (prompt: Prompt, view: OptionsView, deadline: number): PromptEvent => ({
  kind: "pending_options",
  requestId: prompt.id,
  deadline,
  rows: view.rows.map((row) => ({ id: row.id, label: row.label, detail: row.detail })),
  multi: view.multi,
})

export const promptEvent = (prompt: Prompt, deadline: number): PromptEvent => {
  if (prompt.view?.kind === "permission") return permissionEvent(prompt, prompt.view, deadline)

  if (prompt.view?.kind === "question") return questionEvent(prompt, prompt.view, deadline)

  if (prompt.view?.kind === "options") return optionsEvent(prompt, prompt.view, deadline)

  return { kind: "prompt", requestId: prompt.id, deadline }
}

export class PromptProblem extends Schema.TaggedError<PromptProblem>()("PromptProblem", {
  code: Schema.String,
  message: Schema.String,
}) {}

const fail = (code: string, message: string): PromptProblem => new PromptProblem({ code, message })

export interface PermissionAnswer {
  readonly outcome: string
  readonly comment?: string
  readonly editedSpecContent?: string
}

export interface PermissionResult {
  selectedOption: string
  comment?: string
  editedSpecContent?: string
}

/** Builds the CLI result; `proceed_edit` only makes sense with the edited plan. */
export const permissionResult = (
  view: PermissionView,
  answer: PermissionAnswer,
): PermissionResult | PromptProblem => {
  const outcome = PERMISSION_OUTCOMES.find((candidate) => candidate === answer.outcome)

  if (outcome === undefined) {
    return fail("invalid_outcome", "unknown permission outcome: " + answer.outcome)
  }

  if (!view.options.includes(outcome)) {
    return fail(
      "invalid_outcome",
      "the prompt does not offer " + outcome + "; offered: " + view.options.join(", "),
    )
  }

  if (outcome === "proceed_edit" && (answer.editedSpecContent ?? "").length === 0) {
    return fail("edited_spec_required", "proceed_edit requires editedSpecContent")
  }

  const result: PermissionResult = { selectedOption: outcome }

  if (answer.comment !== undefined) result.comment = answer.comment

  if (answer.editedSpecContent !== undefined) result.editedSpecContent = answer.editedSpecContent

  return result
}

export interface AnswerInput {
  readonly index: number
  readonly answer: string
}

/** Fills each question's text from the request, which the caller only indexes. */
export const answersResult = (
  view: QuestionView,
  answers: ReadonlyArray<AnswerInput>,
):
  | {
      readonly cancelled: boolean
      readonly answers: ReadonlyArray<{ index: number; question: string; answer: string }>
    }
  | PromptProblem => {
  const filled: Array<{ index: number; question: string; answer: string }> = []

  for (const entry of answers) {
    const question = view.questions.find((candidate) => candidate.index === entry.index)

    if (question === undefined) {
      return fail(
        "invalid_question_index",
        "no question " + String(entry.index) + " in this prompt",
      )
    }

    filled.push({ index: entry.index, question: question.question, answer: entry.answer })
  }

  return { cancelled: false, answers: filled }
}

/** Rejects ids the prompt never offered, and honours single-select prompts. */
export const optionsResult = (
  view: OptionsView,
  selectedIds: ReadonlyArray<string>,
  refresh: boolean,
):
  | {
      readonly cancelled: boolean
      readonly selectedIds: ReadonlyArray<string>
      readonly refresh: boolean
    }
  | PromptProblem => {
  if (refresh) return { cancelled: false, selectedIds: [], refresh: true }

  if (!view.multi && selectedIds.length > 1) {
    return fail(
      "invalid_selection",
      "this prompt accepts one row; got " + String(selectedIds.length),
    )
  }

  for (const id of selectedIds) {
    if (!view.rows.some((row) => row.id === id)) {
      return fail("invalid_selection", "no row " + id + " in this prompt")
    }
  }

  return { cancelled: false, selectedIds: [...selectedIds], refresh: false }
}

export const isPromptProblem = (value: unknown): value is PromptProblem =>
  Schema.is(PromptProblem)(value)
