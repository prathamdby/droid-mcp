/**
 * Helpers for extracting assistant text deltas and constructing safe JSON
 * observation event payloads. Module-internal to `turns`.
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { DecisionViewData } from "../../decisions/index.ts"

const AssistantDeltaSchema = Schema.Struct({
  textDelta: Schema.String,
})

const TextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

const CreateMessageSchema = Schema.Struct({
  message: Schema.Struct({
    role: Schema.optional(Schema.String),
    content: Schema.optional(Schema.Array(Schema.Json)),
  }),
})

/**
 * Extracts newly emitted assistant text from a session delta, when present.
 */
export const extractDeltaText = (kind: string, payload: Schema.Json): string | undefined => {
  if (kind === "assistant_text_delta") {
    const decoded = Schema.decodeUnknownOption(AssistantDeltaSchema)(payload)

    if (Option.isSome(decoded) && decoded.value.textDelta.length > 0) {
      return decoded.value.textDelta
    }

    return undefined
  }

  if (kind === "create_message") {
    const decoded = Schema.decodeUnknownOption(CreateMessageSchema)(payload)

    if (Option.isNone(decoded)) return undefined

    if (decoded.value.message.role !== "assistant") return undefined

    const content = decoded.value.message.content

    if (content === undefined || content.length === 0) return undefined

    const parts: Array<string> = []

    for (const block of content) {
      const textBlock = Schema.decodeUnknownOption(TextBlockSchema)(block)

      if (Option.isSome(textBlock) && textBlock.value.text.length > 0) {
        parts.push(textBlock.value.text)
      }
    }

    return parts.length > 0 ? parts.join("") : undefined
  }

  return undefined
}

type PermissionEventData = {
  kind: "permission"
  outcomes: Array<string>
  summary?: string
  details?: Schema.Json
}

type QuestionEventEntry = {
  index: number
  text: string
  multiSelect: boolean
  topic?: string
  options?: Array<Schema.Json>
}

type OptionEventRow = {
  id: string
  label?: string
  detail?: string
}

type OptionsEventData = {
  kind: "options"
  rows: Array<OptionEventRow>
  multiSelect: boolean
  refreshable: boolean
  title?: string
  hint?: string
}

/**
 * Converts scrubbed `DecisionViewData` into a plain JSON value for inclusion
 * in an observation event. All free text has already crossed `disclosure`.
 */
export const serializeDecisionViewData = (data: DecisionViewData): Schema.Json => {
  if (data.kind === "permission") {
    const record: PermissionEventData = {
      kind: data.kind,
      outcomes: [...data.outcomes],
    }

    if (data.summary !== undefined) record.summary = data.summary

    if (data.details !== undefined) record.details = data.details

    return record
  }

  if (data.kind === "question") {
    const questions: Array<QuestionEventEntry> = []

    for (const question of data.questions) {
      const entry: QuestionEventEntry = {
        index: question.index,
        text: question.text,
        multiSelect: question.multiSelect,
      }

      if (question.topic !== undefined) entry.topic = question.topic

      if (question.options !== undefined) entry.options = [...question.options]

      questions.push(entry)
    }

    return {
      kind: data.kind,
      questions,
    }
  }

  const rows: Array<OptionEventRow> = []

  for (const row of data.rows) {
    const entry: OptionEventRow = { id: row.id }

    if (row.label !== undefined) entry.label = row.label

    if (row.detail !== undefined) entry.detail = row.detail

    rows.push(entry)
  }

  const record: OptionsEventData = {
    kind: data.kind,
    rows,
    multiSelect: data.multiSelect,
    refreshable: data.refreshable,
  }

  if (data.title !== undefined) record.title = data.title

  if (data.hint !== undefined) record.hint = data.hint

  return record
}
