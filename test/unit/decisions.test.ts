import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"

import { Authority, authorityLayer, Denied, Evidence } from "../../src/authority/index.ts"
import type { Grant } from "../../src/authority/index.ts"
import { Callers, callersLayer, trustedEvidence } from "../../src/caller/index.ts"
import type { Caller, TargetRef } from "../../src/caller/index.ts"
import {
  type ChallengeInput,
  type ChallengeReply,
  Decisions,
  decisionsLayer,
  type DecisionScope,
  HumanChoice,
  InvalidChoice,
  ReplyUncertain,
  ScopeRetired,
  StaleDecision,
} from "../../src/decisions/index.ts"
import type { PermissionChallenge } from "../../src/decisions/index.ts"
import {
  Disclosure,
  disclosureLayer,
  DisclosureRefused,
  REDACTED,
} from "../../src/disclosure/index.ts"
import type { DisclosureApi } from "../../src/disclosure/index.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeServices = (options?: {
  readonly maxAutonomy?: "off" | "low" | "medium" | "high"
  readonly protectedValues?: ReadonlyArray<string>
  readonly disclosure?: DisclosureApi
}) => {
  const disclosureLive =
    options?.disclosure === undefined
      ? disclosureLayer({ protectedValues: options?.protectedValues })
      : Layer.succeed(Disclosure, options.disclosure)

  const callersLive = callersLayer()

  const authorityLive = authorityLayer({
    maxAutonomy: options?.maxAutonomy ?? "high",
  })

  const decisionsLive = Layer.provideMerge(
    decisionsLayer,
    Layer.merge(authorityLive, disclosureLive),
  )

  const merged = Layer.mergeAll(decisionsLive, callersLive, authorityLive, disclosureLive)

  return Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const decisions = yield* Decisions
        const callers = yield* Callers
        const authority = yield* Authority
        const disclosure = yield* Disclosure

        return { decisions, callers, authority, disclosure }
      }),
      merged,
    ),
  )
}

type Services = ReturnType<typeof makeServices>

const target: TargetRef = { kind: "local", id: "local-1" }

const admit = (services: Services, principal: string): Caller =>
  Effect.runSync(services.callers.admit(Option.getOrThrow(trustedEvidence(principal))))

const grantAt = (
  services: Services,
  caller: Caller,
  ceiling: "off" | "low" | "medium" | "high",
): Grant =>
  Effect.runSync(
    services.authority.decide(
      caller,
      target,
      { effect: "execute" },
      Evidence.Explicit({ ceiling }),
    ),
  )

const openScope = (services: Services): DecisionScope =>
  Effect.runSync(services.decisions.openScope())

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

// ---------------------------------------------------------------------------
// Endpoint spies
// ---------------------------------------------------------------------------

type FailureMode = "none" | "not-delivered" | "uncertain"

interface FailureControl {
  current: FailureMode
}

interface FailureCount {
  count: number
}

interface EndpointSpy {
  readonly invocations: Array<ChallengeReply>
  readonly failWith: FailureControl
  readonly failures: FailureCount
}

interface EndpointFixture {
  readonly endpoint: ChallengeInput["reply"]
  readonly spy: EndpointSpy
}

/**
 * Counts every invocation of the endpoint effect. Because a reply endpoint is
 * a cold effect factory, an invocation only happens when the effect is
 * actually run; the spy records the reply payload on success, or increments
 * `failures` when the endpoint reports a delivery failure.
 */
const makeEndpoint = (): EndpointFixture => {
  const invocations: Array<ChallengeReply> = []
  const failWith: FailureControl = { current: "none" }
  const failures: FailureCount = { count: 0 }

  const endpoint: ChallengeInput["reply"] = (reply) =>
    Effect.gen(function* () {
      if (failWith.current === "not-delivered") {
        failures.count += 1

        return yield* Effect.fail({
          _tag: "NotDelivered" as const,
          message: "peer gone before handoff",
        })
      }

      if (failWith.current === "uncertain") {
        failures.count += 1

        return yield* Effect.fail({
          _tag: "Uncertain" as const,
          message: "transport lost after handoff",
        })
      }

      invocations.push(reply)
    })

  const spy: EndpointSpy = { invocations, failWith, failures }

  return { endpoint, spy }
}

// ---------------------------------------------------------------------------
// Challenge fixtures
// ---------------------------------------------------------------------------

type PermissionExtra = Partial<Omit<PermissionChallenge, "kind" | "reply">> & {
  readonly timeoutMs?: number
}

const permissionChallenge = (
  endpoint: ChallengeInput["reply"],
  extra?: PermissionExtra,
): ChallengeInput => ({
  kind: "permission",
  outcomes: ["proceed_once", "proceed_always", "proceed_auto_run_high", "proceed_edit", "cancel"],
  display: { summary: "run the test suite" },
  ...extra,
  reply: endpoint,
})

const questionChallenge = (
  endpoint: ChallengeInput["reply"],
  extra?: { readonly timeoutMs?: number },
): ChallengeInput => ({
  kind: "question",
  display: {
    questions: [
      { index: 0, text: "which environment?", multiSelect: false },
      { index: 1, text: "any notes?", multiSelect: false },
    ],
  },
  ...extra,
  reply: endpoint,
})

const optionsChallenge = (
  endpoint: ChallengeInput["reply"],
  extra?: { readonly timeoutMs?: number },
): ChallengeInput => ({
  kind: "options",
  display: {
    rows: [
      { id: "row-a", label: "first row" },
      { id: "row-b", label: "second row" },
    ],
    multiSelect: false,
    refreshable: true,
  },
  ...extra,
  reply: endpoint,
})

// ---------------------------------------------------------------------------
// offer, views and disclosure
// ---------------------------------------------------------------------------

describe("offer and views", () => {
  it("rejects foreign scope handles from another layer instance", () => {
    const first = makeServices()
    const second = makeServices()
    const foreignScope = openScope(first)
    const localScope = openScope(second)
    const { endpoint } = makeEndpoint()
    const challenge = permissionChallenge(endpoint)
    const view = Effect.runSync(second.decisions.offer(localScope, challenge))
    const foreignView = Effect.runSync(first.decisions.offer(foreignScope, challenge))
    const grant = grantAt(second, admit(second, "scope-owner"), "high")

    expect(
      expectFailure(Effect.runSyncExit(second.decisions.outstanding(foreignScope))),
    ).toBeInstanceOf(ScopeRetired)
    expect(
      expectFailure(Effect.runSyncExit(second.decisions.offer(foreignScope, challenge))),
    ).toBeInstanceOf(ScopeRetired)

    const foreignAnswer = Effect.runSyncExit(
      second.decisions.answer(
        localScope,
        foreignView.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(expectFailure(foreignAnswer)).toBeInstanceOf(StaleDecision)
    Effect.runSync(second.decisions.retire(foreignScope))
    expect(Effect.runSync(second.decisions.outstanding(localScope))).toEqual([view])
  })

  it("rejects an offer retired while its display is being released", async () => {
    const { disclosure } = makeServices()

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const releasing = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()

        const { decisions } = makeServices({
          disclosure: {
            ...disclosure,
            release: (input, to) =>
              Deferred.succeed(releasing, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(disclosure.release(input, to)),
              ),
          },
        })

        const scope = yield* decisions.openScope()
        const { endpoint } = makeEndpoint()
        const offer = yield* Effect.forkChild(decisions.offer(scope, permissionChallenge(endpoint)))

        yield* Deferred.await(releasing)
        yield* decisions.retire(scope)
        yield* Deferred.succeed(resume, undefined)

        return yield* Fiber.await(offer)
      }),
    )

    expect(expectFailure(exit)).toBeInstanceOf(ScopeRetired)
  })

  it("returns a decision view with scrubbed display data and an opaque ref", () => {
    const services = makeServices()
    const scope = openScope(services)
    const { endpoint } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    expect(view.data.kind).toBe("permission")

    if (view.data.kind === "permission") {
      expect(view.data.summary).toBe("run the test suite")
      expect(view.data.outcomes).toContain("proceed_once")
    }
  })

  it("lists outstanding offers and empties after an answer", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const before = Effect.runSync(services.decisions.outstanding(scope))

    expect(before).toHaveLength(1)

    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
    expect(spy.invocations[0]).toEqual({
      kind: "permission",
      reply: { outcome: "proceed_once", comment: undefined, editedSpecContent: undefined },
    })

    const after = Effect.runSync(services.decisions.outstanding(scope))

    expect(after).toHaveLength(0)
  })

  it("scrubs secrets in display data through disclosure", () => {
    const services = makeServices({ protectedValues: ["hunter2-secret"] })
    const scope = openScope(services)
    const { endpoint } = makeEndpoint()

    const view = Effect.runSync(
      services.decisions.offer(
        scope,
        permissionChallenge(endpoint, {
          display: { summary: "use token hunter2-secret here" },
        }),
      ),
    )

    if (view.data.kind === "permission") {
      expect(view.data.summary).toContain(REDACTED)
      expect(view.data.summary).not.toContain("hunter2-secret")
    } else {
      throw new Error("expected a permission view")
    }
  })

  it("propagates disclosure refusal out of offer and registers no offer", () => {
    const realDisclosure = Effect.runSync(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Disclosure
        }),
        disclosureLayer(),
      ),
    )

    const refusing: DisclosureApi = {
      ...realDisclosure,
      release: (_input, to) =>
        Effect.fail(
          new DisclosureRefused({
            message: "display payload refused by policy",
            sink: to.sink,
            reason: "test_refusal",
          }),
        ),
    }

    const services = makeServices({ disclosure: refusing })
    const scope = openScope(services)
    const { endpoint, spy } = makeEndpoint()

    const exit = Effect.runSyncExit(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(DisclosureRefused)

    const outstanding = Effect.runSync(services.decisions.outstanding(scope))

    expect(outstanding).toHaveLength(0)
    expect(spy.invocations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Validation before claiming
// ---------------------------------------------------------------------------

describe("validation before claiming", () => {
  it("rejects a kind-mismatched choice and leaves the offer answerable", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Question({ answers: [{ index: 0, answer: "prod" }] }),
        grant,
      ),
    )

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(InvalidChoice)

    if (failure instanceof InvalidChoice) {
      expect(failure.reason).toBe("kind_mismatch")
    }

    expect(spy.invocations).toHaveLength(0)

    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "cancel" }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
  })

  it("rejects an unoffered permission outcome", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(
      services.decisions.offer(
        scope,
        permissionChallenge(endpoint, { outcomes: ["proceed_once", "cancel"] }),
      ),
    )

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_always" }),
        grant,
      ),
    )

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(InvalidChoice)

    if (failure instanceof InvalidChoice) {
      expect(failure.reason).toBe("unoffered_outcome")
    }

    expect(spy.invocations).toHaveLength(0)

    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
  })

  it("rejects proceed_edit without editedSpecContent", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_edit" }),
        grant,
      ),
    )

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(InvalidChoice)

    if (failure instanceof InvalidChoice) {
      expect(failure.reason).toBe("edited_spec_required")
    }

    expect(spy.invocations).toHaveLength(0)

    // With the edited spec supplied the same answer succeeds.
    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_edit", editedSpecContent: "edited plan" }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
  })

  it("rejects an unknown question index", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, questionChallenge(endpoint)))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Question({ answers: [{ index: 7, answer: "nope" }] }),
        grant,
      ),
    )

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(InvalidChoice)

    if (failure instanceof InvalidChoice) {
      expect(failure.reason).toBe("unknown_question_index")
    }

    expect(spy.invocations).toHaveLength(0)

    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Question({ answers: [{ index: 0, answer: "prod" }] }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
  })

  it("rejects unknown option ids and multi-select violations on single-select prompts", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, optionsChallenge(endpoint)))

    const unknown = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Options({ selectedIds: ["row-missing"] }),
        grant,
      ),
    )

    const unknownFailure = expectFailure(unknown)

    expect(unknownFailure).toBeInstanceOf(InvalidChoice)

    if (unknownFailure instanceof InvalidChoice) {
      expect(unknownFailure.reason).toBe("unknown_option_id")
    }

    const multi = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Options({ selectedIds: ["row-a", "row-b"] }),
        grant,
      ),
    )

    const multiFailure = expectFailure(multi)

    expect(multiFailure).toBeInstanceOf(InvalidChoice)

    if (multiFailure instanceof InvalidChoice) {
      expect(multiFailure.reason).toBe("multi_select_violation")
    }

    expect(spy.invocations).toHaveLength(0)

    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Options({ selectedIds: ["row-a"] }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
    expect(spy.invocations[0]).toEqual({
      kind: "options",
      reply: { selectedIds: ["row-a"], refresh: false },
    })
  })

  it("accepts a refresh request on a refreshable prompt without row validation", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, optionsChallenge(endpoint)))

    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Options({ selectedIds: [], refresh: true }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
    expect(spy.invocations[0]).toEqual({
      kind: "options",
      reply: { selectedIds: [], refresh: true },
    })
  })

  it("denies a permission outcome whose autonomy requirement exceeds the grant", () => {
    const services = makeServices({ maxAutonomy: "low" })
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "low")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_auto_run_high" }),
        grant,
      ),
    )

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(Denied)
    expect(spy.invocations).toHaveLength(0)

    // Denial never consumed the offer: an authorized outcome still answers it.
    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)
  })

  it("denies an unlevelled persistent outcome below high even when leveled aliases would pass", () => {
    const services = makeServices({ maxAutonomy: "medium" })
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "medium")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(
      services.decisions.offer(
        scope,
        permissionChallenge(endpoint, { outcomes: ["proceed_auto_run", "cancel"] }),
      ),
    )

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_auto_run" }),
        grant,
      ),
    )

    expect(expectFailure(exit)).toBeInstanceOf(Denied)
    expect(spy.invocations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Single-winner contention
// ---------------------------------------------------------------------------

describe("single-winner contention", () => {
  it("concurrent answers: exactly one wins, the loser gets StaleDecision, the endpoint runs once", async () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const [firstExit, secondExit] = await Promise.all([
      Effect.runPromiseExit(
        services.decisions.answer(
          scope,
          view.ref,
          HumanChoice.Permission({ outcome: "proceed_once" }),
          grant,
        ),
      ),
      Effect.runPromiseExit(
        services.decisions.answer(
          scope,
          view.ref,
          HumanChoice.Permission({ outcome: "cancel" }),
          grant,
        ),
      ),
    ])

    const exits = [firstExit, secondExit]
    const successes = exits.filter(Exit.isSuccess)
    const failures = exits.filter(Exit.isFailure)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    const failure = expectFailure(failures[0])

    expect(failure).toBeInstanceOf(StaleDecision)
    expect(spy.invocations).toHaveLength(1)
  })

  it("answer after retire gets StaleDecision and the endpoint never runs", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    Effect.runSync(services.decisions.retire(scope))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(expectFailure(exit)).toBeInstanceOf(StaleDecision)
    expect(spy.invocations).toHaveLength(0)
  })

  it("answer racing retire contends atomically: exactly one wins", async () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const answerPromise = Effect.runPromiseExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    const retirePromise = Effect.runPromiseExit(services.decisions.retire(scope))

    const [answerExit] = await Promise.all([answerPromise, retirePromise])

    if (Exit.isSuccess(answerExit)) {
      // The answer won: the endpoint ran exactly once.
      expect(spy.invocations).toHaveLength(1)
    } else {
      // Retirement won: the answer is stale and the endpoint never ran.
      expect(expectFailure(answerExit)).toBeInstanceOf(StaleDecision)
      expect(spy.invocations).toHaveLength(0)
    }
  })

  it("timeout consumes the offer: it leaves outstanding and later answers are stale", async () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(
      services.decisions.offer(scope, permissionChallenge(endpoint, { timeoutMs: 25 })),
    )

    const before = Effect.runSync(services.decisions.outstanding(scope))

    expect(before).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 120))

    const after = Effect.runSync(services.decisions.outstanding(scope))

    expect(after).toHaveLength(0)

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(expectFailure(exit)).toBeInstanceOf(StaleDecision)
    expect(spy.invocations).toHaveLength(0)
  })

  it("an answer before the timeout wins and the timer never consumes twice", async () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(
      services.decisions.offer(scope, permissionChallenge(endpoint, { timeoutMs: 40 })),
    )

    Effect.runSync(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "cancel" }),
        grant,
      ),
    )

    expect(spy.invocations).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(spy.invocations).toHaveLength(1)
  })

  it("retire withdraws the timeout contender without consuming twice", async () => {
    const services = makeServices()
    const scope = openScope(services)
    const { endpoint, spy } = makeEndpoint()

    Effect.runSync(
      services.decisions.offer(scope, permissionChallenge(endpoint, { timeoutMs: 40 })),
    )

    Effect.runSync(services.decisions.retire(scope))

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(spy.invocations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Reused peer ids
// ---------------------------------------------------------------------------

describe("reused peer ids", () => {
  it("two offers get distinct refs and endpoints never cross-deliver", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")

    // Two sequential offers that a peer would correlate by the same reused
    // request id: this module never keys on that id, so both get fresh refs.
    const first = makeEndpoint()
    const second = makeEndpoint()

    const firstView = Effect.runSync(
      services.decisions.offer(scope, permissionChallenge(first.endpoint)),
    )

    const secondView = Effect.runSync(
      services.decisions.offer(scope, permissionChallenge(second.endpoint)),
    )

    expect(firstView.ref).not.toBe(secondView.ref)

    Effect.runSync(
      services.decisions.answer(
        scope,
        firstView.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(first.spy.invocations).toHaveLength(1)
    expect(second.spy.invocations).toHaveLength(0)

    // Answering the first ref again is stale and never touches the second offer.
    const replay = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        firstView.ref,
        HumanChoice.Permission({ outcome: "cancel" }),
        grant,
      ),
    )

    expect(expectFailure(replay)).toBeInstanceOf(StaleDecision)
    expect(second.spy.invocations).toHaveLength(0)

    // The second offer is still live and answerable through its own ref.
    Effect.runSync(
      services.decisions.answer(
        scope,
        secondView.ref,
        HumanChoice.Permission({ outcome: "cancel" }),
        grant,
      ),
    )

    expect(second.spy.invocations).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Delivery failures
// ---------------------------------------------------------------------------

describe("delivery failures", () => {
  it("an uncertain endpoint failure surfaces ReplyUncertain, consumes the offer, and never replays", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    spy.failWith.current = "uncertain"

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(ReplyUncertain)

    if (failure instanceof ReplyUncertain) {
      expect(failure.delivery).toBe("uncertain")
    }

    expect(spy.failures.count).toBe(1)

    const second = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(expectFailure(second)).toBeInstanceOf(StaleDecision)
    expect(spy.failures.count).toBe(1)
    expect(spy.invocations).toHaveLength(0)
  })

  it("a definite non-delivery surfaces a failure, consumes the offer, and never re-invokes", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    spy.failWith.current = "not-delivered"

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    const failure = expectFailure(exit)

    expect(failure).toBeInstanceOf(ReplyUncertain)

    if (failure instanceof ReplyUncertain) {
      expect(failure.delivery).toBe("not_delivered")
    }

    expect(spy.failures.count).toBe(1)

    const second = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(expectFailure(second)).toBeInstanceOf(StaleDecision)
    expect(spy.failures.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// retire
// ---------------------------------------------------------------------------

describe("retire", () => {
  it("retires the scope atomically: offer and outstanding fail with ScopeRetired, answer with StaleDecision", () => {
    const services = makeServices()
    const scope = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(scope, permissionChallenge(endpoint)))

    Effect.runSync(services.decisions.retire(scope))

    const offerExit = Effect.runSyncExit(
      services.decisions.offer(scope, permissionChallenge(endpoint)),
    )

    expect(expectFailure(offerExit)).toBeInstanceOf(ScopeRetired)

    const outstandingExit = Effect.runSyncExit(services.decisions.outstanding(scope))

    expect(expectFailure(outstandingExit)).toBeInstanceOf(ScopeRetired)

    const answerExit = Effect.runSyncExit(
      services.decisions.answer(
        scope,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(expectFailure(answerExit)).toBeInstanceOf(StaleDecision)
    expect(spy.invocations).toHaveLength(0)
  })

  it("retire withdraws outstanding offers without invoking their endpoints", () => {
    const services = makeServices()
    const scope = openScope(services)
    const first = makeEndpoint()
    const second = makeEndpoint()

    Effect.runSync(services.decisions.offer(scope, permissionChallenge(first.endpoint)))
    Effect.runSync(services.decisions.offer(scope, questionChallenge(second.endpoint)))

    const before = Effect.runSync(services.decisions.outstanding(scope))

    expect(before).toHaveLength(2)

    Effect.runSync(services.decisions.retire(scope))

    expect(first.spy.invocations).toHaveLength(0)
    expect(second.spy.invocations).toHaveLength(0)
  })

  it("retire is idempotent", () => {
    const services = makeServices()
    const scope = openScope(services)

    Effect.runSync(services.decisions.retire(scope))
    Effect.runSync(services.decisions.retire(scope))
  })
})

// ---------------------------------------------------------------------------
// Cross-scope isolation
// ---------------------------------------------------------------------------

describe("cross-scope isolation", () => {
  it("a ref from one scope is stale in another scope", () => {
    const services = makeServices()
    const first = openScope(services)
    const second = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const { endpoint, spy } = makeEndpoint()

    const view = Effect.runSync(services.decisions.offer(first, permissionChallenge(endpoint)))

    const exit = Effect.runSyncExit(
      services.decisions.answer(
        second,
        view.ref,
        HumanChoice.Permission({ outcome: "proceed_once" }),
        grant,
      ),
    )

    expect(expectFailure(exit)).toBeInstanceOf(StaleDecision)
    expect(spy.invocations).toHaveLength(0)
  })

  it("retiring one scope leaves another scope's offers answerable", () => {
    const services = makeServices()
    const first = openScope(services)
    const second = openScope(services)
    const caller = admit(services, "operator")
    const grant = grantAt(services, caller, "high")
    const other = makeEndpoint()

    const view = Effect.runSync(
      services.decisions.offer(second, permissionChallenge(other.endpoint)),
    )

    Effect.runSync(services.decisions.retire(first))

    Effect.runSync(
      services.decisions.answer(
        second,
        view.ref,
        HumanChoice.Permission({ outcome: "cancel" }),
        grant,
      ),
    )

    expect(other.spy.invocations).toHaveLength(1)
  })
})
