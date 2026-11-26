/**
 * Wire encoding: translates presentation results, session observations,
 * discovery pages and failure codes into the exact JSON shapes MCP clients
 * already consume. This is the only place where legacy `{ code, message }`
 * vocabularies, continuation envelopes, `eventsOmitted` and numeric cursor
 * translation live.
 */
import * as Match from "effect/Match"
import type * as Schema from "effect/Schema"

import type {
  BatchReport,
  DiscoveryPage,
  Inventory,
  Presented,
  ResultPage,
} from "../../presentation/index.ts"
import { readSessionTurnPayload } from "./payloads.ts"
import { JSON_RPC_OPERATION_FAILED, type McpReply } from "./types.ts"
import type { FrameId } from "./types.ts"

// ---------------------------------------------------------------------------
// Failure data
// ---------------------------------------------------------------------------

type FailureDataWire = {
  code: string
  message: string
  ref?: string
}

/**
 * The legacy failure body carried in a JSON-RPC error's `data` field: the
 * exact `{ code, message, ref? }` shape clients already parse.
 */
export const failureData = (
  code: string,
  message: string,
  ref: string | undefined,
): Schema.Json => {
  const out: FailureDataWire = { code, message }

  if (ref !== undefined) out.ref = ref

  return out
}

/** A JSON-RPC error reply carrying the legacy failure body in `data`. */
export const failureReply = (
  id: FrameId,
  code: string,
  message: string,
  ref?: string,
): McpReply => ({
  kind: "error",
  id,
  code: JSON_RPC_OPERATION_FAILED,
  message,
  data: failureData(code, message, ref),
})

// ---------------------------------------------------------------------------
// Presented rendering
// ---------------------------------------------------------------------------

/** The inner envelope (without the reply wrapper) of a presented value. */
const presentedEnvelope = (presented: Presented): Schema.Json =>
  Match.value(presented).pipe(
    Match.when({ _tag: "Inline" }, (variant) => ({ result: variant.value })),
    Match.when({ _tag: "Continuation" }, (variant) => ({
      truncated: true,
      ref: variant.ref,
      totalBytes: variant.totalBytes,
      preview: variant.preview,
      hint: variant.hint,
    })),
    Match.when({ _tag: "CompletedUnpresentable" }, (variant) =>
      failureData(variant.code, variant.message, variant.ref),
    ),
    Match.exhaustive,
  )

/**
 * The successful envelope of one presented value. `Inline` becomes
 * `{ result }`; `Continuation` becomes the legacy truncated envelope;
 * `CompletedUnpresentable` — the operation already succeeded — renders its
 * recovery instructions as a failure body with the finished result's ref.
 */
export const renderPresented = (id: FrameId, presented: Presented): McpReply =>
  Match.value(presented).pipe(
    Match.when({ _tag: "Inline" }, (variant) => ({
      kind: "result" as const,
      id,
      result: { result: variant.value },
    })),
    Match.when({ _tag: "Continuation" }, (variant) => ({
      kind: "result" as const,
      id,
      result: {
        truncated: true,
        ref: variant.ref,
        totalBytes: variant.totalBytes,
        preview: variant.preview,
        hint: variant.hint,
      },
    })),
    Match.when({ _tag: "CompletedUnpresentable" }, (variant) =>
      failureReply(id, variant.code, variant.message, variant.ref),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Inventory (tools/list)
// ---------------------------------------------------------------------------

type ToolDescriptor = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Schema.Json
  annotations?: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
}

/** The MCP `tools` array: descriptors derived strictly from advertisement. */
export const renderToolsList = (inventory: Inventory): Schema.Json => {
  const tools: Array<ToolDescriptor> = []

  for (const entry of inventory.tools) {
    const descriptor: ToolDescriptor = {
      name: entry.name,
      description: entry.description,
      inputSchema: { type: "object", ...entry.inputSchema },
    }

    if (entry.annotations !== undefined) {
      descriptor.annotations = {
        readOnlyHint: entry.annotations.readOnlyHint,
        destructiveHint: entry.annotations.destructiveHint,
        idempotentHint: entry.annotations.idempotentHint,
        openWorldHint: entry.annotations.openWorldHint,
      }
    }

    tools.push(descriptor)
  }

  return { tools }
}

// ---------------------------------------------------------------------------
// Discovery (tools_search / tools_describe)
// ---------------------------------------------------------------------------

export const renderDiscovery = (page: DiscoveryPage): Schema.Json =>
  Match.value(page).pipe(
    Match.when({ _tag: "Search" }, (variant) => {
      const entries: Array<Schema.Json> = []

      for (const entry of variant.entries) {
        entries.push({
          name: entry.name,
          summary: entry.summary,
          readOnly: entry.readOnly,
          destructive: entry.destructive,
          family: entry.family,
          requiresGuidance: entry.requiresGuidance,
        })
      }

      type SearchWire = {
        total: number
        tools: ReadonlyArray<Schema.Json>
        nextOffset?: number
      }

      const out: SearchWire = {
        total: variant.total,
        tools: entries,
      }

      if (variant.nextOffset !== null) out.nextOffset = variant.nextOffset

      return out
    }),
    Match.when({ _tag: "Describe" }, (variant) => {
      const entries: Array<Schema.Json> = []

      for (const entry of variant.entries) {
        entries.push({
          name: entry.name,
          description: entry.description,
          inputSchema: entry.inputSchema,
          annotations: {
            readOnlyHint: entry.annotations.readOnlyHint,
            destructiveHint: entry.annotations.destructiveHint,
            idempotentHint: entry.annotations.idempotentHint,
            openWorldHint: entry.annotations.openWorldHint,
          },
          effect: entry.effect,
          replay: entry.replay,
          family: entry.family,
          requiresGuidance: entry.requiresGuidance,
        })
      }

      return { tools: entries, unknown: [...variant.unknown] }
    }),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

type BatchStepWire = {
  readonly id: string
  readonly name: string
  readonly status: string
  result?: Schema.Json
  truncated?: boolean
  ref?: string
  totalBytes?: number
  preview?: string
  hint?: string
  error?: Schema.Json
}

/** The legacy batch report shape: `{ completed, failed, skipped, steps }`. */
export const renderBatch = (report: BatchReport): Schema.Json => {
  const steps: Array<BatchStepWire> = []

  for (const step of report.steps) {
    const entry: BatchStepWire = { id: step.id, name: step.name, status: step.status }

    if (step.presented !== undefined) {
      Match.value(step.presented).pipe(
        Match.when({ _tag: "Inline" }, (variant) => {
          entry.result = variant.value
        }),
        Match.when({ _tag: "Continuation" }, (variant) => {
          entry.truncated = true
          entry.ref = variant.ref
          entry.totalBytes = variant.totalBytes
          entry.preview = variant.preview
          entry.hint = variant.hint
        }),
        Match.when({ _tag: "CompletedUnpresentable" }, (variant) => {
          entry.error = failureData(variant.code, variant.message, variant.ref)
        }),
        Match.exhaustive,
      )
    }

    if (step.failure !== undefined) {
      entry.error = failureData(step.failure.code, step.failure.message, step.failure.ref)
    }

    steps.push(entry)
  }

  return {
    completed: report.completed,
    failed: report.failed,
    skipped: report.skipped,
    steps,
  }
}

// ---------------------------------------------------------------------------
// Continuation pages (result_read)
// ---------------------------------------------------------------------------

type ResultPageWire = {
  readonly ref: string
  readonly totalBytes: number
  readonly chunk: string
  readonly offset: number
  readonly done: boolean
  nextOffset?: number
  selected?: Schema.Json
}

/**
 * The legacy `result_read` success shape. `chunk` and offsets describe the
 * byte page; `selected` carries the re-bounded selection envelope when a
 * select pointer was applied.
 */
export const renderResultPage = (page: ResultPage): Schema.Json => {
  const out: ResultPageWire = {
    ref: page.ref,
    totalBytes: page.totalBytes,
    chunk: page.chunk,
    offset: page.offset,
    done: page.done,
  }

  if (page.nextOffset !== null) out.nextOffset = page.nextOffset

  if (page.selected !== undefined) out.selected = presentedEnvelope(page.selected)

  return out
}

// ---------------------------------------------------------------------------
// Tool-call failure rendering
// ---------------------------------------------------------------------------

/**
 * Renders a presentation `CallFailure` as the exact legacy failure body:
 * `{ code, message, ref? }` in the error's `data` field.
 */
export const renderCallFailure = (
  id: FrameId,
  failure: { readonly code: string; readonly message: string; readonly ref?: string | undefined },
): McpReply => failureReply(id, failure.code, failure.message, failure.ref)

// ---------------------------------------------------------------------------
// Session payloads
// ---------------------------------------------------------------------------

/**
 * Adds the honest `eventsOmitted` marker and the session resource URI to an
 * encoded session payload. Eviction is reported, never silently replayed;
 * deliveries carry the URI the legacy server attached.
 */
type SessionAdditionsWire = {
  eventsOmitted?: boolean
  uri?: string
}

export const finishSessionPayload = (payload: Schema.Json): Schema.Json => {
  const turn = readSessionTurnPayload(payload)

  if (turn === undefined) return payload

  if (!isPayloadRecord(payload)) return payload

  const eviction = turn.truncated && turn.omittedCount !== undefined && turn.omittedCount > 0

  const additions: SessionAdditionsWire = {}

  if (eviction) additions.eventsOmitted = true

  if (turn.sessionId !== undefined) additions.uri = sessionUriOf(turn.sessionId)

  if (additions.eventsOmitted === undefined && additions.uri === undefined) return payload

  return { ...payload, ...additions }
}

const isPayloadRecord = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  value !== null && !Array.isArray(value) && value instanceof Object

export const SESSIONS_URI = "droid://sessions"

export const sessionUriOf = (sessionId: string): string => "droid://sessions/" + sessionId

export const eventsUriOf = (sessionId: string, cursor: number): string =>
  sessionUriOf(sessionId) + "/events/" + String(cursor)
