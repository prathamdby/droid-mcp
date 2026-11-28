/**
 * Translates placement challenge notices into `decisions` challenge inputs and
 * encodes normalized `ChallengeReply` answers back into the wire JSON the
 * placement reply endpoint expects.
 *
 * All functions here are module-internal to `turns`. No raw peer request id
 * ever crosses into display data or observation events.
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { PERMISSION_OUTCOMES } from "../../decisions/index.ts"
import type {
  ChallengeInput,
  ChallengeOptionRow,
  ChallengeQuestion,
  ChallengeReply,
  PermissionOutcome,
  ReplyDeliveryFailure,
  ReplyEndpoint,
} from "../../decisions/index.ts"
import type { PlacementRejected } from "../../placement/index.ts"

const DeliveryFailure = Data.taggedEnum<ReplyDeliveryFailure>()

// ---------------------------------------------------------------------------
// Decoders for inbound challenge payloads
// ---------------------------------------------------------------------------

const ToolUseEntrySchema = Schema.Struct({
  toolUse: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  ),
  confirmationType: Schema.optional(Schema.String),
})

const PermissionOptionItemSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    value: Schema.String,
    label: Schema.optional(Schema.String),
  }),
])

const QuestionItemSchema = Schema.Struct({
  index: Schema.Number,
  topic: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.Json)),
  multiSelect: Schema.optional(Schema.Boolean),
})

const OptionRowItemSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    id: Schema.String,
    label: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  }),
])

const isString = Schema.is(Schema.String)

const knownOutcomeOf = (value: string): PermissionOutcome | undefined => {
  for (const candidate of PERMISSION_OUTCOMES) {
    if (candidate === value) return candidate
  }

  return undefined
}

const parsePermissionOutcomes = (
  raw: Schema.Json | undefined,
): ReadonlyArray<PermissionOutcome> => {
  if (raw === undefined) return PERMISSION_OUTCOMES

  const decoded = Schema.decodeUnknownOption(Schema.Array(PermissionOptionItemSchema))(raw)

  if (Option.isNone(decoded)) return []

  const parsed: Array<PermissionOutcome> = []

  for (const item of decoded.value) {
    const value = isString(item) ? item : item.value
    const outcome = knownOutcomeOf(value)

    if (outcome === undefined) return []

    if (!parsed.includes(outcome)) parsed.push(outcome)
  }

  return parsed
}

const summarizeToolUses = (raw: Schema.Json): string => {
  const decoded = Schema.decodeUnknownOption(Schema.Array(ToolUseEntrySchema))(raw)

  if (Option.isNone(decoded) || decoded.value.length === 0) {
    return "Permission requested"
  }

  const names: Array<string> = []

  for (const entry of decoded.value) {
    const name = entry.toolUse?.name

    if (name !== undefined && name.length > 0 && !names.includes(name)) {
      names.push(name)
    }
  }

  if (names.length === 0) return "Permission requested"

  return "Permission requested for " + names.join(", ")
}

const parseQuestions = (raw: Schema.Json): ReadonlyArray<ChallengeQuestion> => {
  const decoded = Schema.decodeUnknownOption(Schema.Array(QuestionItemSchema))(raw)

  if (Option.isNone(decoded)) return []

  const questions: Array<ChallengeQuestion> = []

  for (const item of decoded.value) {
    const text = item.question ?? ""
    const multiSelect = item.multiSelect === true

    const base = {
      index: item.index,
      text,
      multiSelect,
    }

    if (item.topic !== undefined && item.options !== undefined) {
      questions.push({ ...base, topic: item.topic, options: item.options })
    } else if (item.topic !== undefined) {
      questions.push({ ...base, topic: item.topic })
    } else if (item.options !== undefined) {
      questions.push({ ...base, options: item.options })
    } else {
      questions.push(base)
    }
  }

  return questions
}

const parseOptionRows = (raw: Schema.Json): ReadonlyArray<ChallengeOptionRow> => {
  const decoded = Schema.decodeUnknownOption(Schema.Array(OptionRowItemSchema))(raw)

  if (Option.isNone(decoded)) return []

  const rows: Array<ChallengeOptionRow> = []

  for (const item of decoded.value) {
    if (isString(item)) {
      rows.push({ id: item, label: item })
      continue
    }

    const base = { id: item.id }

    if (item.label !== undefined && item.detail !== undefined) {
      rows.push({ ...base, label: item.label, detail: item.detail })
    } else if (item.label !== undefined) {
      rows.push({ ...base, label: item.label })
    } else if (item.detail !== undefined) {
      rows.push({ ...base, detail: item.detail })
    } else {
      rows.push(base)
    }
  }

  return rows
}

// ---------------------------------------------------------------------------
// Wire reply encoding & endpoint bridging
// ---------------------------------------------------------------------------

type PermissionReplyWire = {
  selectedOption: string
  comment?: string
  editedSpecContent?: string
}

type OptionsReplyWire = {
  selectedIds: Array<string>
  refresh?: boolean
}

const encodeChallengeReply = (answer: ChallengeReply): Schema.Json => {
  if (answer.kind === "permission") {
    const wire: PermissionReplyWire = {
      selectedOption: answer.reply.outcome,
    }

    if (answer.reply.comment !== undefined) {
      wire.comment = answer.reply.comment
    }

    if (answer.reply.editedSpecContent !== undefined) {
      wire.editedSpecContent = answer.reply.editedSpecContent
    }

    return wire
  }

  if (answer.kind === "question") {
    const answers: Array<Schema.Json> = []

    for (const entry of answer.reply.answers) {
      answers.push({
        index: entry.index,
        answer: entry.answer,
      })
    }

    return { answers }
  }

  const wire: OptionsReplyWire = {
    selectedIds: [...answer.reply.selectedIds],
  }

  if (answer.reply.refresh) {
    wire.refresh = true
  }

  return wire
}

const classifyReplyFailure = (failure: PlacementRejected): ReplyDeliveryFailure => {
  const lower = failure.message.toLowerCase()

  if (lower.includes("uncertain") || lower.includes("timeout") || lower.includes("lost")) {
    return DeliveryFailure.Uncertain({ message: failure.message })
  }

  return DeliveryFailure.NotDelivered({ message: failure.message })
}

const bridgeReplyEndpoint = (
  reply: (payload: Schema.Json) => Effect.Effect<void, PlacementRejected>,
): ReplyEndpoint => {
  return (answer) => reply(encodeChallengeReply(answer)).pipe(Effect.mapError(classifyReplyFailure))
}

// ---------------------------------------------------------------------------
// Challenge input builders
// ---------------------------------------------------------------------------

export const buildPermissionChallenge = (
  toolUses: Schema.Json,
  options: Schema.Json | undefined,
  reply: (payload: Schema.Json) => Effect.Effect<void, PlacementRejected>,
  timeoutMs: number | undefined,
): ChallengeInput => {
  const base = {
    kind: "permission" as const,
    outcomes: parsePermissionOutcomes(options),
    display: {
      summary: summarizeToolUses(toolUses),
      details: toolUses,
    },
    reply: bridgeReplyEndpoint(reply),
  }

  if (timeoutMs !== undefined) {
    return { ...base, timeoutMs }
  }

  return base
}

export const buildQuestionChallenge = (
  questions: Schema.Json,
  reply: (payload: Schema.Json) => Effect.Effect<void, PlacementRejected>,
  timeoutMs: number | undefined,
): ChallengeInput => {
  const base = {
    kind: "question" as const,
    display: {
      questions: parseQuestions(questions),
    },
    reply: bridgeReplyEndpoint(reply),
  }

  if (timeoutMs !== undefined) {
    return { ...base, timeoutMs }
  }

  return base
}

export const buildOptionsChallenge = (
  title: string,
  options: Schema.Json,
  multiSelect: boolean,
  reply: (payload: Schema.Json) => Effect.Effect<void, PlacementRejected>,
  timeoutMs: number | undefined,
): ChallengeInput => {
  const rows = parseOptionRows(options)

  const display =
    title.length > 0
      ? { title, rows, multiSelect, refreshable: true }
      : { rows, multiSelect, refreshable: true }

  const base = {
    kind: "options" as const,
    display,
    reply: bridgeReplyEndpoint(reply),
  }

  if (timeoutMs !== undefined) {
    return { ...base, timeoutMs }
  }

  return base
}
