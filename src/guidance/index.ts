/**
 * Level 1 `guidance` module: guide content and receipt validity.
 *
 * This module owns the embedded operator guide and the proof that its root
 * document was successfully delivered into a conversation. Reading the root
 * document never acknowledges it: only `confirmRootDelivery` of the genuine
 * root text followed by an explicit `acknowledge` records a receipt. Receipts
 * are scoped strictly to `(caller.id, conversation.id, edition)` — sharing a
 * session namespace never shares receipts — and the receipt set is
 * LRU-bounded so an evicted conversation must deliver the root again.
 *
 * Nothing here names a wire URI, a header or an operation: the module deals
 * in documents, editions and receipts only.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { Conversation } from "../caller/index.ts"
import { GUIDE_DOCUMENTS, ROOT_PART } from "./private/content.ts"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The only guide edition this build serves. */
export type GuideEdition = "droid-v1"

/** The current guide edition, pinned to the embedded content. */
export const CURRENT_GUIDE_EDITION: GuideEdition = "droid-v1"

/**
 * The known document parts of the guide. `document` accepts any `string` so
 * that unknown parts surface as a typed `GuideMissing` rather than a cast.
 */
export type GuidePart =
  | "SKILL.md"
  | "references/session-loop.md"
  | "references/prompts.md"
  | "references/delegation.md"
  | "references/tool-families.md"

/** One delivered guide document. `isRoot` marks the qualifying root part. */
export interface GuideText {
  readonly edition: GuideEdition
  readonly part: string
  readonly content: string
  readonly isRoot: boolean
}

/** A gate demand: the named edition must have a receipt in scope. */
export interface Prerequisite {
  readonly edition: GuideEdition
}

/**
 * Brand key for the opaque `RootDelivery` proof. The symbol is
 * module-private, so outside code cannot construct or read the proof body.
 */
const rootDeliveryBrand: unique symbol = Symbol("droid-mcp-v2/guidance/RootDelivery")

/**
 * Proof that the qualifying root document was confirmed as delivered. Only
 * `confirmRootDelivery` mints it, and only for the genuine root text: a
 * reference document, an unknown part or altered content can never produce
 * one. A receipt is not consent for anything; it is evidence of delivery.
 */
export interface RootDelivery {
  readonly [rootDeliveryBrand]: "RootDelivery"
}

/** Hidden proof body carried behind the opaque public handle. */
interface RootDeliveryBody {
  readonly [rootDeliveryBrand]: "RootDelivery"
  readonly edition: GuideEdition
  readonly part: string
}

/** Options for the guidance gate. */
export interface GuidanceOptions {
  /**
   * When `false`, `check` succeeds without any receipt. Defaults to `true`.
   */
  readonly required?: boolean
  /**
   * Maximum number of scoped receipts retained. The least recently checked
   * receipt is evicted past the cap. Defaults to 4096.
   */
  readonly maxReceipts?: number
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class GuideMissing extends Schema.TaggedError<GuideMissing>()("GuideMissing", {
  message: Schema.String,
  edition: Schema.String,
  part: Schema.String,
}) {}

export class ReceiptRejected extends Schema.TaggedError<ReceiptRejected>()("ReceiptRejected", {
  message: Schema.String,
  reason: Schema.String,
}) {}

export class GuidanceRequired extends Schema.TaggedError<GuidanceRequired>()("GuidanceRequired", {
  message: Schema.String,
  edition: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface GuidanceApi {
  /** Fetch one document part of an edition; unknown edition or part fails. */
  readonly document: (edition: GuideEdition, part: string) => Effect.Effect<GuideText, GuideMissing>
  /** List the known parts of an edition in stable order. */
  readonly listParts: (edition: GuideEdition) => Effect.Effect<ReadonlyArray<string>, GuideMissing>
  /**
   * Mint proof of root delivery. Fails with `ReceiptRejected` unless `doc`
   * is the unaltered root document of a known edition; nothing is recorded
   * here and no other document can produce a proof.
   */
  readonly confirmRootDelivery: (doc: GuideText) => Effect.Effect<RootDelivery, ReceiptRejected>
  /** Record the receipt for a delivered root in this exact conversation scope. */
  readonly acknowledge: (
    scope: Conversation,
    delivered: RootDelivery,
  ) => Effect.Effect<void, ReceiptRejected>
  /**
   * Satisfy the gate: succeeds only when this exact conversation scope holds
   * a receipt for the demanded edition, unless the gate is disabled.
   */
  readonly check: (
    scope: Conversation,
    prerequisite: Prerequisite,
  ) => Effect.Effect<void, GuidanceRequired>
  /** Whether this exact conversation scope currently holds a receipt. */
  readonly hasReceipt: (scope: Conversation, prerequisite: Prerequisite) => Effect.Effect<boolean>
}

export class Guidance extends Context.Service<Guidance, GuidanceApi>()("droid-mcp-v2/Guidance") {}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECEIPTS = 4096

const missing = (edition: string, part: string): GuideMissing =>
  new GuideMissing({
    message: "guide document is missing",
    edition,
    part,
  })

const documentByPart = new Map(GUIDE_DOCUMENTS.map((entry) => [entry.part, entry]))

const knownEdition = (edition: GuideEdition): boolean => edition === CURRENT_GUIDE_EDITION

/**
 * Receipt key scoped to the exact conversation of the exact caller for one
 * edition. Two conversations of one caller, or one binding shared across
 * callers, never collide.
 */
const receiptKey = (scope: Conversation, edition: string): string =>
  String(scope.caller.id) + " " + String(scope.id) + " " + edition

const readDelivery = (delivered: RootDelivery): RootDeliveryBody =>
  // SAFETY: the brand is module-private, so every `RootDelivery` in existence
  // was constructed by `confirmRootDelivery` below with exactly this body.
  delivered as RootDeliveryBody

/**
 * Builds the per-layer `Guidance` service. The receipt map is local to each
 * layer instance, so independent assemblies never share gate state.
 */
export const guidanceLayer = (options?: GuidanceOptions): Layer.Layer<Guidance> => {
  const required = options?.required ?? true
  const maxReceipts = Math.max(1, Math.floor(options?.maxReceipts ?? DEFAULT_MAX_RECEIPTS))

  return Layer.sync(Guidance, () => {
    /*
     * Insertion-ordered receipt keys. A hit re-inserts the key at the end,
     * so the first key is always the least recently confirmed or checked.
     */
    const receipts = new Map<string, true>()

    const remember = (key: string): void => {
      receipts.delete(key)
      receipts.set(key, true)

      while (receipts.size > maxReceipts) {
        const oldest = receipts.keys().next()

        if (oldest.done) break

        receipts.delete(oldest.value)
      }
    }

    const recall = (key: string): boolean => {
      if (!receipts.has(key)) return false

      receipts.delete(key)
      receipts.set(key, true)

      return true
    }

    const document: GuidanceApi["document"] = (edition, part) =>
      Effect.suspend(() => {
        if (!knownEdition(edition)) return Effect.fail(missing(edition, part))

        const entry = documentByPart.get(part)

        if (entry === undefined) return Effect.fail(missing(edition, part))

        return Effect.succeed({
          edition,
          part: entry.part,
          content: entry.content,
          isRoot: entry.isRoot,
        })
      })

    const listParts: GuidanceApi["listParts"] = (edition) =>
      Effect.suspend(() => {
        if (!knownEdition(edition)) return Effect.fail(missing(edition, ""))

        return Effect.succeed(GUIDE_DOCUMENTS.map((entry) => entry.part))
      })

    const confirmRootDelivery: GuidanceApi["confirmRootDelivery"] = (doc) =>
      Effect.suspend(() => {
        if (!knownEdition(doc.edition)) {
          return Effect.fail(
            new ReceiptRejected({
              message: "delivery proof refused",
              reason: "unknown-edition",
            }),
          )
        }

        const entry = documentByPart.get(doc.part)

        const genuine =
          doc.isRoot === true &&
          doc.part === ROOT_PART &&
          entry !== undefined &&
          entry.isRoot &&
          doc.content === entry.content

        if (!genuine) {
          return Effect.fail(
            new ReceiptRejected({
              message: "delivery proof refused",
              reason: "not-root-delivery",
            }),
          )
        }

        const body: RootDeliveryBody = {
          [rootDeliveryBrand]: "RootDelivery",
          edition: doc.edition,
          part: doc.part,
        }

        return Effect.succeed(body)
      })

    const acknowledge: GuidanceApi["acknowledge"] = (scope, delivered) =>
      Effect.sync(() => {
        const body = readDelivery(delivered)

        remember(receiptKey(scope, body.edition))
      })

    const check: GuidanceApi["check"] = (scope, prerequisite) =>
      Effect.suspend(() => {
        if (!required) return Effect.void

        if (recall(receiptKey(scope, prerequisite.edition))) return Effect.void

        return Effect.fail(
          new GuidanceRequired({
            message: "the guide root document has not been delivered in this conversation",
            edition: prerequisite.edition,
          }),
        )
      })

    const hasReceipt: GuidanceApi["hasReceipt"] = (scope, prerequisite) =>
      Effect.sync(() => recall(receiptKey(scope, prerequisite.edition)))

    return { document, listParts, confirmRootDelivery, acknowledge, check, hasReceipt }
  })
}
