/**
 * The 13 typed bound session operations, wired through `Capabilities.bind`.
 *
 * Every operation declares explicit structural `effect`, `replay`,
 * `annotations`, `prerequisite` (when guidance is required), `target` and
 * `demand`. Nothing derives policy from a description or name, and there is no
 * universal command backdoor.
 */
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import type * as Schema from "effect/Schema"

import type { Demand, EffectKind } from "../../authority/index.ts"
import type { AdmissionRefused, TargetRef } from "../../caller/index.ts"
import {
  DeliveryUncertain,
  InvalidInput,
  OperationConflict,
  OperationDenied,
  OperationNotVisible,
  OperationUnverifiable,
  PeerFailure,
  TargetUnavailable,
} from "../../capabilities/index.ts"
import type {
  BoundOperation,
  CapabilitiesApi,
  Definition,
  OperationAnnotations,
  OperationFailure,
  ReplayPolicy,
} from "../../capabilities/index.ts"
import { HumanChoice, outcomeRequirement } from "../../decisions/index.ts"
import { ReleasePayload } from "../../disclosure/index.ts"
import { CURRENT_GUIDE_EDITION } from "../../guidance/index.ts"
import type { Prerequisite } from "../../guidance/index.ts"
import { InvalidPosition, positionOffset } from "../../observations/index.ts"
import type { OpenFailed } from "../../placement/index.ts"
import { turnId } from "../../turns/index.ts"
import {
  buildSessionSettings,
  buildSettingsPatch,
  buildWorkspaceIntent,
  decodeAnswerQuestion,
  decodeFork,
  decodePickOptions,
  decodeRespondPermission,
  decodeSessionCreate,
  decodeSessionEvents,
  decodeSessionIdOnly,
  decodeSessionList,
  decodeSessionRun,
  decodeSessionStream,
  decodeUpdateSettings,
  encodeCreateResult,
  encodeForkOutcome,
  encodeModels,
  encodeRunView,
  encodeSettings,
  encodeSummary,
  encodeTurnPayload,
  MAX_WAIT_MS,
  sessionInputSchema,
} from "./codecs.ts"
import type { SessionOperationName } from "./codecs.ts"
import {
  CloseFailed,
  NotVisible,
  RunFailed,
  SessionIntent,
  SessionOperationFailed,
  SessionRefused,
} from "./types.ts"
import type { OneShotDelivery, SessionsApi } from "./types.ts"

// ---------------------------------------------------------------------------
// Error translation into Capabilities OperationFailure
// ---------------------------------------------------------------------------

const mapNotVisible = (failure: NotVisible): OperationFailure =>
  new OperationNotVisible({ message: failure.message })

const mapSessionRefused = (failure: SessionRefused): OperationFailure => {
  if (failure.reason === "authority_unverifiable") {
    return new OperationUnverifiable({ message: failure.message, reason: failure.reason })
  }

  if (failure.reason === "delegation_unavailable") {
    return new OperationNotVisible({ message: failure.message })
  }

  if (failure.reason === "no_eligible_provider") {
    return new TargetUnavailable({ message: failure.message, code: failure.reason })
  }

  return new OperationDenied({ message: failure.message, reason: failure.reason })
}

const mapOpenFailed = (failure: OpenFailed): OperationFailure =>
  new TargetUnavailable({ message: failure.message, code: failure.reason })

const mapAdmissionRefused = (failure: AdmissionRefused): OperationFailure =>
  new OperationDenied({ message: failure.message, reason: failure.reason })

const mapCloseFailed = (failure: CloseFailed): OperationFailure =>
  new PeerFailure({ code: failure.reason, message: failure.message })

const mapRunFailed = (failure: RunFailed): OperationFailure => {
  if (failure.uncertain === true) {
    return new DeliveryUncertain({ message: failure.message })
  }

  if (failure.code === "open_failed") {
    return new TargetUnavailable({ message: failure.message, code: failure.code })
  }

  return new PeerFailure({ code: failure.code, message: failure.message })
}

const mapOperationFailed = (failure: SessionOperationFailed): OperationFailure =>
  Match.value(failure.code).pipe(
    Match.when("submission_uncertain", () => new DeliveryUncertain({ message: failure.message })),
    Match.when("interrupt_uncertain", () => new DeliveryUncertain({ message: failure.message })),
    Match.when("reply_uncertain", () =>
      failure.uncertain === true
        ? new DeliveryUncertain({ message: failure.message })
        : new PeerFailure({ code: "not_delivered", message: failure.message }),
    ),
    Match.when("invalid_choice", () => new InvalidInput({ message: failure.message })),
    Match.when("invalid_cursor", () => new InvalidInput({ message: failure.message })),
    Match.when(
      "denied",
      () => new OperationDenied({ message: failure.message, reason: failure.reason ?? "denied" }),
    ),
    Match.when(
      "facet_unsupported",
      () => new TargetUnavailable({ message: failure.message, code: failure.code }),
    ),
    Match.when(
      "turn_unavailable",
      () => new TargetUnavailable({ message: failure.message, code: failure.code }),
    ),
    Match.when("busy", () => new OperationConflict({ message: failure.message })),
    Match.when(
      "stale_decision",
      () => new PeerFailure({ code: failure.code, message: failure.message }),
    ),
    Match.when(
      "submit_rejected",
      () => new PeerFailure({ code: failure.code, message: failure.message }),
    ),
    Match.when("rejected", () => new PeerFailure({ code: failure.code, message: failure.message })),
    Match.exhaustive,
  )

const mapInvalidPosition = (failure: InvalidPosition): OperationFailure =>
  new InvalidInput({ message: failure.message })

const mapSessionErrors = <A>(
  effect: Effect.Effect<
    A,
    | NotVisible
    | SessionRefused
    | OpenFailed
    | AdmissionRefused
    | CloseFailed
    | RunFailed
    | SessionOperationFailed
    | InvalidPosition
  >,
): Effect.Effect<A, OperationFailure> =>
  Effect.mapError(effect, (failure) =>
    Match.value(failure).pipe(
      Match.when({ _tag: "NotVisible" }, mapNotVisible),
      Match.when({ _tag: "SessionRefused" }, mapSessionRefused),
      Match.when({ _tag: "OpenFailed" }, mapOpenFailed),
      Match.when({ _tag: "AdmissionRefused" }, mapAdmissionRefused),
      Match.when({ _tag: "CloseFailed" }, mapCloseFailed),
      Match.when({ _tag: "RunFailed" }, mapRunFailed),
      Match.when({ _tag: "SessionOperationFailed" }, mapOperationFailed),
      Match.when({ _tag: "InvalidPosition" }, mapInvalidPosition),
      Match.exhaustive,
    ),
  )

// ---------------------------------------------------------------------------
// Fact helpers
// ---------------------------------------------------------------------------

const READ_ANNOTATIONS: OperationAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const WRITE_ANNOTATIONS: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

const WRITE_IDEMPOTENT_ANNOTATIONS: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const EXECUTE_ANNOTATIONS: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}

const DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS: OperationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
}

const sessionTarget = (id: string): TargetRef => ({ kind: "session", id })

const localTarget = (cwd: string): TargetRef => ({ kind: "local", id: cwd })

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BindSessionOperationsOptions {
  readonly capabilities: CapabilitiesApi
  readonly sessions: SessionsApi
  readonly guidanceRequired: boolean
  readonly defaultWaitMs: number
}

export const buildSessionOperations = (
  options: BindSessionOperationsOptions,
): ReadonlyArray<BoundOperation> => {
  const { capabilities, sessions, guidanceRequired, defaultWaitMs } = options

  const prerequisite: Prerequisite | undefined = guidanceRequired
    ? { edition: CURRENT_GUIDE_EDITION }
    : undefined

  const bindOp = <I>(args: {
    readonly id: SessionOperationName
    readonly description: string
    readonly effect: EffectKind
    readonly replay: ReplayPolicy
    readonly annotations: OperationAnnotations
    readonly decode: Definition<I, Schema.Json>["decode"]
    readonly target: Definition<I, Schema.Json>["target"]
    readonly demand: Definition<I, Schema.Json>["demand"]
    readonly perform: Definition<I, Schema.Json>["perform"]
  }): BoundOperation => {
    const baseFacts = {
      id: args.id,
      family: "session" as const,
      description: args.description,
      inputSchema: sessionInputSchema(args.id),
      effect: args.effect,
      replay: args.replay,
      annotations: args.annotations,
    }

    const facts = prerequisite !== undefined ? { ...baseFacts, prerequisite } : baseFacts

    const classify = (_input: I, output: Schema.Json) => ({
      payload: ReleasePayload.JsonValue({ value: output }),
    })

    return capabilities.bind({
      facts,
      decode: args.decode,
      target: args.target,
      demand: args.demand,
      perform: args.perform,
      classify,
    })
  }

  const sessionCreate = bindOp({
    id: "session_create",
    description:
      "Start a Droid session in a permitted workspace. Set worktree for an isolated checkout. Autonomy must not exceed the server ceiling.",
    effect: "execute",
    replay: "no_retry",
    annotations: EXECUTE_ANNOTATIONS,
    decode: decodeSessionCreate,
    target: (input) => localTarget(input.cwd),
    demand: (input): Demand => ({
      effect: "execute",
      requestedLevel: input.autonomyLevel,
      operation: "session_create",
    }),
    perform: (_grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const intent = SessionIntent.Local({
            workspace: buildWorkspaceIntent(input.cwd, input),
            settings: buildSessionSettings(input),
          })

          const ref = yield* sessions.create(who, intent)
          const reader = yield* sessions.resolve(who.caller, ref, "read")
          const summary = yield* reader.summary()

          return encodeCreateResult(summary, input.cwd)
        }),
      ),
  })

  const sessionStream = bindOp({
    id: "session_stream",
    description:
      "Submit a prompt to a live session. Omit delivery to wait up to waitMs and return events. detach returns immediately without an event dump; block waits until terminal or pending decision.",
    effect: "execute",
    replay: "no_retry",
    annotations: EXECUTE_ANNOTATIONS,
    decode: decodeSessionStream,
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "execute",
      operation: "session_stream",
    }),
    perform: (grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const submitter = yield* sessions.resolveId(who.caller, input.sessionId, "submit")
          const beforePage = yield* submitter.observe(null, 0)
          const ref = yield* submitter.submit({ text: input.prompt }, grant)

          if (input.delivery === "detach") {
            const turn = yield* submitter.inspect()

            return encodeTurnPayload({
              sessionId: submitter.sessionId,
              turnId: turnId(ref),
              turn,
              cursor: positionOffset(beforePage.resume),
              events: [],
              truncated: false,
            })
          }

          const waitMs = input.waitMs ?? (input.delivery === "block" ? MAX_WAIT_MS : defaultWaitMs)
          const turn = yield* submitter.wait("decision_or_terminal", waitMs)
          const page = yield* submitter.observe(beforePage.resume, 0)

          return encodeTurnPayload({
            sessionId: submitter.sessionId,
            turnId: turnId(ref),
            turn,
            cursor: positionOffset(page.resume),
            events: page.items,
            truncated: page.gap,
            omittedCount: page.omittedCount,
          })
        }),
      ),
  })

  const sessionEvents = bindOp({
    id: "session_events",
    description:
      "Observe session events since a numeric cursor. Pass the returned cursor back unchanged to avoid duplicates; truncated reports evicted history.",
    effect: "read",
    replay: "safe_read",
    annotations: READ_ANNOTATIONS,
    decode: decodeSessionEvents,
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "read",
      operation: "session_events",
    }),
    perform: (_grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const reader = yield* sessions.resolveId(who.caller, input.sessionId, "read")
          const page = yield* reader.observeAtOffset(input.cursor, input.waitMs ?? defaultWaitMs)
          const turn = yield* reader.inspect()

          return encodeTurnPayload({
            sessionId: reader.sessionId,
            turn,
            cursor: page.cursor,
            events: page.items,
            truncated: page.gap,
            omittedCount: page.omittedCount,
          })
        }),
      ),
  })

  const sessionInterrupt = bindOp({
    id: "session_interrupt",
    description: "Request interruption of the active turn in a live session.",
    effect: "write",
    replay: "no_retry",
    annotations: WRITE_IDEMPOTENT_ANNOTATIONS,
    decode: (input) => decodeSessionIdOnly("session_interrupt", input),
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "write",
      operation: "session_interrupt",
    }),
    perform: (grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const submitter = yield* sessions.resolveId(who.caller, input.sessionId, "submit")

          yield* submitter.interrupt(grant)

          return {
            sessionId: submitter.sessionId,
            interrupted: true,
          }
        }),
      ),
  })

  const sessionClose = bindOp({
    id: "session_close",
    description:
      "Revoke lookup, retire turns and pending decisions, and drain resources for a live session.",
    effect: "write",
    replay: "no_retry",
    annotations: DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS,
    decode: (input) => decodeSessionIdOnly("session_close", input),
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "write",
      operation: "session_close",
    }),
    perform: (_grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const admin = yield* sessions.resolveId(who.caller, input.sessionId, "admin")

          yield* admin.close()

          return {
            sessionId: admin.sessionId,
            closed: true,
          }
        }),
      ),
  })

  const sessionList = bindOp({
    id: "session_list",
    description: "List live sessions visible to the admitted caller.",
    effect: "read",
    replay: "safe_read",
    annotations: READ_ANNOTATIONS,
    decode: decodeSessionList,
    target: () => sessionTarget("*"),
    demand: (): Demand => ({
      effect: "read",
      operation: "session_list",
    }),
    perform: (_grant, _input, who) =>
      mapSessionErrors(
        Effect.map(sessions.listVisible(who.caller), (list) => ({
          sessions: list.map(encodeSummary),
        })),
      ),
  })

  const sessionRun = bindOp({
    id: "session_run",
    description:
      "Create a session and execute one turn. Automatically closes on terminal return or interruption; remains live and addressable if still running.",
    effect: "execute",
    replay: "no_retry",
    annotations: EXECUTE_ANNOTATIONS,
    decode: decodeSessionRun,
    target: (input) => localTarget(input.cwd),
    demand: (input): Demand => ({
      effect: "execute",
      requestedLevel: input.autonomyLevel,
      operation: "session_run",
    }),
    perform: (_grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const delivery: OneShotDelivery = input.delivery ?? "wait"

          const view = yield* sessions.runOnce(who, {
            session: SessionIntent.Local({
              workspace: buildWorkspaceIntent(input.cwd, input),
              settings: buildSessionSettings(input),
            }),
            prompt: { text: input.prompt },
            waitMs: input.waitMs,
            delivery,
          })

          return encodeRunView(view)
        }),
      ),
  })

  const sessionRespondPermission = bindOp({
    id: "session_respond_permission",
    description:
      "Answer an outstanding permission decision on a live session. Outcomes exceeding the server autonomy ceiling are refused.",
    effect: "write",
    replay: "no_retry",
    annotations: WRITE_ANNOTATIONS,
    decode: decodeRespondPermission,
    target: (input) => sessionTarget(input.sessionId),
    demand: (input): Demand => ({
      effect: "write",
      requestedLevel: outcomeRequirement(input.outcome),
      operation: "session_respond_permission",
    }),
    perform: (grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const answerer = yield* sessions.resolveId(who.caller, input.sessionId, "answer")

          const choice = HumanChoice.Permission({
            outcome: input.outcome,
            comment: input.comment,
            editedSpecContent: input.editedSpecContent,
          })

          yield* answerer.decideByLabel(input.requestId, choice, grant)

          return {
            sessionId: answerer.sessionId,
            requestId: input.requestId,
            resolved: true,
          }
        }),
      ),
  })

  const sessionAnswerQuestion = bindOp({
    id: "session_answer_question",
    description: "Answer an outstanding question decision on a live session.",
    effect: "write",
    replay: "no_retry",
    annotations: WRITE_ANNOTATIONS,
    decode: decodeAnswerQuestion,
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "write",
      operation: "session_answer_question",
    }),
    perform: (grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const answerer = yield* sessions.resolveId(who.caller, input.sessionId, "answer")

          const choice = HumanChoice.Question({
            answers: input.answers,
          })

          yield* answerer.decideByLabel(input.requestId, choice, grant)

          return {
            sessionId: answerer.sessionId,
            requestId: input.requestId,
            resolved: true,
          }
        }),
      ),
  })

  const sessionPickOptions = bindOp({
    id: "session_pick_options",
    description: "Answer an outstanding option-picker decision on a live session.",
    effect: "write",
    replay: "no_retry",
    annotations: WRITE_ANNOTATIONS,
    decode: decodePickOptions,
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "write",
      operation: "session_pick_options",
    }),
    perform: (grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const answerer = yield* sessions.resolveId(who.caller, input.sessionId, "answer")
          const refresh = input.refresh === true

          const choice = HumanChoice.Options({
            selectedIds: input.selectedIds,
            refresh,
          })

          yield* answerer.decideByLabel(input.requestId, choice, grant)

          return {
            sessionId: answerer.sessionId,
            requestId: input.requestId,
            resolved: true,
            refresh,
          }
        }),
      ),
  })

  const sessionUpdateSettings = bindOp({
    id: "session_update_settings",
    description:
      "Update live session settings such as autonomy level, model, reasoning effort or interaction mode within the grant ceiling.",
    effect: "configure",
    replay: "no_retry",
    annotations: WRITE_IDEMPOTENT_ANNOTATIONS,
    decode: decodeUpdateSettings,
    target: (input) => sessionTarget(input.sessionId),
    demand: (input): Demand =>
      input.autonomyLevel !== undefined
        ? {
            effect: "configure",
            requestedLevel: input.autonomyLevel,
            operation: "session_update_settings",
          }
        : {
            effect: "configure",
            operation: "session_update_settings",
          },
    perform: (grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const admin = yield* sessions.resolveId(who.caller, input.sessionId, "admin")
          const updated = yield* admin.updateSettings(buildSettingsPatch(input), grant)

          return {
            sessionId: admin.sessionId,
            settings: encodeSettings(updated),
          }
        }),
      ),
  })

  const sessionModels = bindOp({
    id: "session_models",
    description: "List the models reported by a live session.",
    effect: "read",
    replay: "safe_read",
    annotations: READ_ANNOTATIONS,
    decode: (input) => decodeSessionIdOnly("session_models", input),
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "read",
      operation: "session_models",
    }),
    perform: (_grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const reader = yield* sessions.resolveId(who.caller, input.sessionId, "read")
          const models = yield* reader.listModels()

          return {
            sessionId: reader.sessionId,
            models: encodeModels(models),
          }
        }),
      ),
  })

  const sessionFork = bindOp({
    id: "session_fork",
    description:
      "Fork a live session, returning honestly whether the fork is runnable here or an external reference.",
    effect: "write",
    replay: "no_retry",
    annotations: EXECUTE_ANNOTATIONS,
    decode: decodeFork,
    target: (input) => sessionTarget(input.sessionId),
    demand: (): Demand => ({
      effect: "write",
      operation: "session_fork",
    }),
    perform: (grant, input, who) =>
      mapSessionErrors(
        Effect.gen(function* () {
          const admin = yield* sessions.resolveId(who.caller, input.sessionId, "admin")

          const request = input.title !== undefined ? { title: input.title } : {}
          const outcome = yield* admin.fork(request, grant)

          return encodeForkOutcome(admin.sessionId, outcome)
        }),
      ),
  })

  return [
    sessionCreate,
    sessionStream,
    sessionEvents,
    sessionInterrupt,
    sessionClose,
    sessionList,
    sessionRun,
    sessionRespondPermission,
    sessionAnswerQuestion,
    sessionPickOptions,
    sessionUpdateSettings,
    sessionModels,
    sessionFork,
  ]
}
