/**
 * The embedded product: a headless programmatic runtime. It composes the
 * caller-scoped capability pipeline and exposes direct typed invocation —
 * no MCP endpoint, no HTTP listener, no stdio framing, and no carrier
 * module of any kind is ever loaded through this file.
 *
 * Admission is explicit trusted admission only: the operator names the
 * local principal, and there is no anonymous fallback. Every invocation
 * passes through the same decode, guidance, delegation, authority and
 * release pipeline a server product uses, because the same bound catalog
 * dispatches it.
 */
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"

import { trustedEvidence } from "../../caller/index.ts"
import type { Invocation } from "../../capabilities/index.ts"
import { releasedJson } from "../../disclosure/index.ts"
import { CURRENT_GUIDE_EDITION } from "../../guidance/index.ts"
import { assemblePipeline } from "./assembly.ts"
import type { EmbeddedOptions, EmbeddedResult, EmbeddedRuntime } from "./types.ts"

/** Translates one invocation failure into its stable public code. */
const failureCode = (failure: { readonly _tag: string }): string =>
  Match.value(failure._tag).pipe(
    Match.when("InvalidInput", () => "invalid_arguments"),
    Match.when("OperationNotFound", () => "unknown_operation"),
    Match.when("GuidanceRequired", () => "guidance_required"),
    Match.when("Denied", () => "denied"),
    Match.when("authority_unverifiable", () => "authority_unverifiable"),
    Match.when("OperationUnverifiable", () => "authority_unverifiable"),
    Match.when("TargetUnavailable", () => "target_unavailable"),
    Match.when("PeerFailure", () => "peer_failure"),
    Match.when("MalformedPeerReply", () => "malformed_reply"),
    Match.when("DeliveryUncertain", () => "delivery_uncertain"),
    Match.when("OperationConflict", () => "conflict"),
    Match.when("OperationNotVisible", () => "not_visible"),
    Match.when("OperationDenied", () => "denied"),
    Match.when("DisclosureRefused", () => "disclosure_refused"),
    Match.when("ProtectedBytes", () => "protected_bytes"),
    Match.orElse(() => "internal_error"),
  )

/**
 * Builds the embedded runtime for one trusted local principal. The runtime
 * acknowledges the guidance root into the principal's conversation at
 * startup — the embedded host IS the trusted local operator, and the root
 * document is delivered with the runtime itself — so session operations are
 * not dead on arrival in a host that has no MCP surface through which a
 * client could ever read the guide.
 */
export const embedded = async (options: EmbeddedOptions): Promise<EmbeddedRuntime> => {
  const evidence = trustedEvidence(options.principal)

  if (Option.isNone(evidence)) {
    throw new Error("embedded requires a non-blank trusted principal name")
  }

  const assembly = await assemblePipeline(options)

  try {
    const who: Invocation = Effect.runSync(
      Effect.gen(function* () {
        const caller = yield* assembly.callers.admit(evidence.value)
        const conversation = yield* assembly.callers.conversation(caller)

        return { caller, conversation }
      }),
    )

    // Deliver the genuine root document into the conversation at startup:
    // an embedded host has no MCP resources for a client to read it through.
    Effect.runSync(
      Effect.gen(function* () {
        const doc = yield* assembly.guidance.document(CURRENT_GUIDE_EDITION, "SKILL.md")
        const delivered = yield* assembly.guidance.confirmRootDelivery(doc)

        yield* assembly.guidance.acknowledge(who.conversation, delivered)
      }),
    )

    let closing: Promise<void> | undefined

    const invoke = async (name: string, input: Schema.Json): Promise<EmbeddedResult> => {
      if (closing !== undefined) {
        return { ok: false, code: "closed", message: "the embedded runtime is closed" }
      }

      const outcome = await Effect.runPromise(
        Effect.result(assembly.capabilities.invoke(assembly.roster.catalog, who, name, input)),
      )

      if (Result.isFailure(outcome)) {
        return {
          ok: false,
          code: failureCode(outcome.failure),
          message: outcome.failure.message,
        }
      }

      const json = releasedJson(outcome.success)

      return { ok: true, value: Option.getOrElse(json, () => null) }
    }

    const operations = (): ReadonlyArray<string> =>
      assembly.roster.descriptions.map((description) => description.id)

    const close = (): Promise<void> => (closing ??= assembly.close())

    return { invoke, operations, close }
  } catch (failure) {
    await assembly.close().catch(() => undefined)

    throw failure
  }
}
