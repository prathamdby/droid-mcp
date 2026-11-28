import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import {
  BadReply,
  createChallengeEndpoint,
  DAEMON_METHOD,
  Dialect,
  type DialectApi,
  dialectLayer,
  EXEC_ARGS,
  EXEC_METHOD,
  IncompatibleVersion,
  InvalidArguments,
  JSONRPC_VERSION,
  LEGACY_FACTORY_API_VERSION,
  PeerNotice,
  PeerRejected,
  PERMISSION_OUTCOMES,
  SDK_PROTOCOL_VERSION,
  UnsupportedBinding,
} from "../../src/factory-dialect/index.ts"

const run = <A, E>(program: Effect.Effect<A, E, Dialect>): Exit.Exit<A, E> =>
  Effect.runSyncExit(Effect.provide(program, dialectLayer))

const withDialect = <A, E>(use: (api: DialectApi) => Effect.Effect<A, E>) =>
  Effect.flatMap(Dialect, use)

const expectSuccess = <A, E>(exit: Exit.Exit<A, E>): A => {
  expect(Exit.isSuccess(exit)).toBe(true)

  if (!Exit.isSuccess(exit)) throw new Error("expected success")

  return exit.value
}

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true)

  if (!Exit.isFailure(exit)) throw new Error("expected failure")

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isNone(error)) throw new Error("expected typed failure, got defect or interruption")

  return error.value
}

const encoder = new TextEncoder()

const bytes = (value: string): Uint8Array => encoder.encode(value)

const VERSION = {
  protocolVersion: SDK_PROTOCOL_VERSION,
  legacyApiVersion: LEGACY_FACTORY_API_VERSION,
}

describe("factory-dialect", () => {
  describe("extract-dialect --check", () => {
    it("verifies pins, allowlist completeness and byte-exact freshness", () => {
      const output = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "scripts/extract-dialect.ts", "--check"],
        { cwd: join(import.meta.dirname, "../.."), encoding: "utf8" },
      )

      expect(output).toContain("pins verified")
      expect(output).toContain("is current")
    })
  })

  describe("protocol constants", () => {
    it("decodes a fork result only when it carries newSessionId", () => {
      const exit = run(
        withDialect((api) =>
          Effect.gen(function* () {
            const binding = yield* api.reviewedBinding("droid.fork_session")

            return {
              reviewed: Option.isSome(binding.decodeResult({ newSessionId: "forked-session" })),
              legacy: Option.isSome(binding.decodeResult({ sessionId: "forked-session" })),
            }
          }),
        ),
      )

      expect(expectSuccess(exit)).toEqual({ reviewed: true, legacy: false })
    })

    it("exposes the wire constants", () => {
      expect(JSONRPC_VERSION).toBe("2.0")
      expect(LEGACY_FACTORY_API_VERSION).toBe("1.0.0")
      expect(SDK_PROTOCOL_VERSION).toBe("1.269.0")
      expect(EXEC_ARGS).toEqual([
        "exec",
        "--input-format",
        "stream-jsonrpc",
        "--output-format",
        "stream-jsonrpc",
      ])
      expect(EXEC_METHOD.initialize).toBe("droid.initialize_session")
      expect(DAEMON_METHOD.authenticate).toBe("daemon.authenticate")
    })

    it("exposes all 16 permission outcomes", () => {
      expect(PERMISSION_OUTCOMES).toHaveLength(16)
      expect(PERMISSION_OUTCOMES).toContain("proceed_once")
      expect(PERMISSION_OUTCOMES).toContain("cancel")
      expect(PERMISSION_OUTCOMES).toContain("proceed_report_false_positive")
    })
  })

  describe("reviewedBinding", () => {
    it("fails with UnsupportedBinding for an unreviewed method", () => {
      const exit = run(withDialect((api) => api.reviewedBinding("daemon.invented_method")))

      const failure = expectFailure(exit)

      if (!(failure instanceof UnsupportedBinding)) {
        throw new Error("expected UnsupportedBinding")
      }

      expect(failure.method).toBe("daemon.invented_method")
    })

    it("fails with UnsupportedBinding for a reviewed-but-unserved method", () => {
      const exit = run(withDialect((api) => api.reviewedBinding("droid.list_skills")))

      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(UnsupportedBinding)
    })

    it("fails with UnsupportedBinding for droid.get_settings, which the SDK does not declare", () => {
      const exit = run(withDialect((api) => api.reviewedBinding("droid.get_settings")))

      expectFailure(exit)
    })

    it("succeeds for a served method", () => {
      const exit = run(withDialect((api) => api.reviewedBinding("daemon.list_opened_sessions")))

      const binding = expectSuccess(exit)

      expect(binding.method).toBe("daemon.list_opened_sessions")
      expect(binding.direction).toBe("request")
    })

    it("lists only served methods in reviewedMethods", () => {
      const exit = run(withDialect((api) => Effect.succeed(api.reviewedMethods())))
      const methods = expectSuccess(exit)

      expect(methods.length).toBeGreaterThan(150)
      expect(methods).not.toContain("droid.list_skills")
      expect(methods).not.toContain("droid.get_settings")
      expect(methods).toContain("daemon.authenticate")
      expect(methods).toContain("droid.initialize_session")
    })
  })

  describe("encode and reply", () => {
    const useKillBinding = <A, E>(
      use: (
        api: DialectApi,
        binding: import("../../src/factory-dialect/index.ts").Binding<Schema.Json, Schema.Json>,
      ) => Effect.Effect<A, E>,
    ) =>
      withDialect((api) =>
        Effect.flatMap(api.reviewedBinding("droid.kill_worker_session"), (binding) =>
          use(api, binding),
        ),
      )

    it("encodes valid params", () => {
      const exit = run(
        useKillBinding((api, binding) => api.encode(binding, { workerSessionId: "ws-1" })),
      )

      const encoded = expectSuccess(exit)

      // SAFETY: the encoded bytes were produced by the dialect from valid
      // params of a one-field schema, so parsing returns that object shape.
      const decoded = JSON.parse(new TextDecoder().decode(encoded)) as { workerSessionId: string }

      expect(decoded.workerSessionId).toBe("ws-1")
    })

    it("rejects invalid params with InvalidArguments", () => {
      const exit = run(useKillBinding((api, binding) => api.encode(binding, { wrong: true })))

      const failure = expectFailure(exit)

      if (!(failure instanceof InvalidArguments)) {
        throw new Error("expected InvalidArguments")
      }

      expect(failure.method).toBe("droid.kill_worker_session")
    })

    it("decodes a valid reply", () => {
      const exit = run(
        useKillBinding((api, binding) =>
          api.reply(binding, bytes(JSON.stringify({ type: "response", id: "1", result: {} }))),
        ),
      )

      expectSuccess(exit)
    })

    it("rejects a malformed reply with BadReply", () => {
      const exit = run(useKillBinding((api, binding) => api.reply(binding, bytes("not json{{{"))))

      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(BadReply)
    })

    it("rejects a reply whose result fails the schema with BadReply", () => {
      const exit = run(
        useKillBinding((api, binding) =>
          api.reply(
            binding,
            bytes(JSON.stringify({ type: "response", id: "1", result: "not-an-object" })),
          ),
        ),
      )

      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(BadReply)
    })

    it("translates a -32601 error into PeerRejected", () => {
      const exit = run(
        useKillBinding((api, binding) =>
          api.reply(
            binding,
            bytes(
              JSON.stringify({
                type: "response",
                id: "1",
                error: { code: -32601, message: "method not found" },
              }),
            ),
          ),
        ),
      )

      const failure = expectFailure(exit)

      if (!(failure instanceof PeerRejected)) {
        throw new Error("expected PeerRejected")
      }

      expect(failure.code).toBe(-32601)
    })

    it("translates a -32001 error into PeerRejected", () => {
      const exit = run(
        useKillBinding((api, binding) =>
          api.reply(
            binding,
            bytes(
              JSON.stringify({
                type: "response",
                id: "1",
                error: { code: -32001, message: "unauthorized" },
              }),
            ),
          ),
        ),
      )

      const failure = expectFailure(exit)

      if (!(failure instanceof PeerRejected)) {
        throw new Error("expected PeerRejected")
      }

      expect(failure.code).toBe(-32001)
    })

    it("captures the expected version from a protocolVersionMismatch", () => {
      const exit = run(
        useKillBinding((api, binding) =>
          api.reply(
            binding,
            bytes(
              JSON.stringify({
                type: "response",
                id: "1",
                error: {
                  code: -32601,
                  message: "version mismatch",
                  data: {
                    protocolVersionMismatch: {
                      localFactoryProtocolVersion: "1.300.0",
                      peerFactoryProtocolVersion: SDK_PROTOCOL_VERSION,
                    },
                  },
                },
              }),
            ),
          ),
        ),
      )

      const failure = expectFailure(exit)

      if (!(failure instanceof PeerRejected)) {
        throw new Error("expected PeerRejected")
      }

      expect(failure.protocolMismatch).toBe("1.300.0")
    })
  })

  describe("negotiate", () => {
    it("accepts a supported peer version", () => {
      const exit = run(
        withDialect((api) => api.negotiate({ protocolVersion: SDK_PROTOCOL_VERSION })),
      )

      const version = expectSuccess(exit)

      expect(version.protocolVersion).toBe(SDK_PROTOCOL_VERSION)
      expect(version.legacyApiVersion).toBe(LEGACY_FACTORY_API_VERSION)
    })

    it("adopts the peer's protocol version", () => {
      const exit = run(withDialect((api) => api.negotiate({ protocolVersion: "1.300.0" })))

      const version = expectSuccess(exit)

      expect(version.protocolVersion).toBe("1.300.0")
    })

    it("rejects a malformed version with IncompatibleVersion", () => {
      const exit = run(withDialect((api) => api.negotiate({ protocolVersion: "abc" })))

      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(IncompatibleVersion)
    })

    it("rejects an incompatible legacy api version", () => {
      const exit = run(
        withDialect((api) =>
          api.negotiate({ protocolVersion: SDK_PROTOCOL_VERSION, legacyApiVersion: "2.0.0" }),
        ),
      )

      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(IncompatibleVersion)
    })
  })

  describe("notice", () => {
    it("normalizes a session notification into SessionDelta", () => {
      const frame = JSON.stringify({
        type: "notification",
        method: "droid.session_notification",
        params: {
          sessionId: "s-1",
          notification: { type: "assistant_text_delta", text: "hi" },
        },
      })

      const exit = run(withDialect((api) => api.notice(VERSION, bytes(frame))))
      const notice = expectSuccess(exit)

      expect(notice._tag).toBe("SessionDelta")

      if (!PeerNotice.$is("SessionDelta")(notice)) {
        throw new Error("expected SessionDelta")
      }

      expect(notice.sessionId).toBe("s-1")
      expect(notice.kind).toBe("assistant_text_delta")
    })

    it("normalizes a session error notification into TurnFailed", () => {
      const frame = JSON.stringify({
        type: "notification",
        method: "droid.session_notification",
        params: {
          sessionId: "s-1",
          notification: { type: "error", code: "model_error", message: "boom" },
        },
      })

      const exit = run(withDialect((api) => api.notice(VERSION, bytes(frame))))
      const notice = expectSuccess(exit)

      expect(notice._tag).toBe("TurnFailed")

      if (!PeerNotice.$is("TurnFailed")(notice)) {
        throw new Error("expected TurnFailed")
      }

      expect(notice.code).toBe("model_error")
      expect(notice.message).toBe("boom")
    })

    it("keeps an incomplete permission_resolved notice as a session delta", () => {
      const incomplete = [
        { type: "permission_resolved", toolUseId: "tool-1", selectedOption: "proceed_once" },
        { type: "permission_resolved", requestId: "req-1", selectedOption: "proceed_once" },
        {
          type: "permission_resolved",
          requestId: "req-1",
          toolUseIds: ["tool-1", 2],
          selectedOption: "proceed_once",
        },
      ]

      for (const notification of incomplete) {
        const frame = JSON.stringify({
          type: "notification",
          method: "droid.session_notification",
          params: { sessionId: "s-1", notification },
        })

        const notice = expectSuccess(run(withDialect((api) => api.notice(VERSION, bytes(frame)))))

        expect(notice._tag).toBe("SessionDelta")
        expect(PeerNotice.$is("ChallengeResolved")(notice)).toBe(false)
      }
    })

    it("normalizes a reviewed permission_resolved notice into ChallengeResolved", () => {
      const frame = JSON.stringify({
        type: "notification",
        method: "droid.session_notification",
        params: {
          sessionId: "s-1",
          notification: {
            type: "permission_resolved",
            requestId: "req-1",
            toolUseIds: ["tool-1"],
            selectedOption: "proceed_once",
          },
        },
      })

      const notice = expectSuccess(run(withDialect((api) => api.notice(VERSION, bytes(frame)))))

      expect(notice._tag).toBe("ChallengeResolved")

      if (!PeerNotice.$is("ChallengeResolved")(notice)) {
        throw new Error("expected ChallengeResolved")
      }

      expect(notice.peerRequestId).toBe("req-1")
      expect(notice.toolUseIds).toEqual(["tool-1"])
    })

    it("normalizes a working-state idle notification into TurnCompleted", () => {
      const frame = JSON.stringify({
        type: "notification",
        method: "droid.session_notification",
        params: {
          sessionId: "s-1",
          notification: { type: "droid_working_state_changed", state: "idle" },
        },
      })

      const exit = run(withDialect((api) => api.notice(VERSION, bytes(frame))))
      const notice = expectSuccess(exit)

      expect(notice._tag).toBe("TurnCompleted")
    })

    it("normalizes a permission server request into PermissionChallenge", () => {
      const frame = JSON.stringify({
        type: "request",
        id: "req-1",
        method: "droid.request_permission",
        params: { toolUses: [{ toolUse: { id: "tu-1" } }], options: ["proceed_once", "cancel"] },
      })

      const exit = run(withDialect((api) => api.notice(VERSION, bytes(frame))))
      const notice = expectSuccess(exit)

      expect(notice._tag).toBe("PermissionChallenge")

      if (!PeerNotice.$is("PermissionChallenge")(notice)) {
        throw new Error("expected PermissionChallenge")
      }

      expect(notice.peerRequestId).toBe("req-1")
      expect(notice.endpoint.kind).toBe("permission")
    })

    it("normalizes a question server request into QuestionChallenge", () => {
      const frame = JSON.stringify({
        type: "request",
        id: "req-2",
        method: "droid.ask_user",
        params: { questions: [{ index: 0, question: "which?" }] },
      })

      const exit = run(withDialect((api) => api.notice(VERSION, bytes(frame))))
      const notice = expectSuccess(exit)

      expect(notice._tag).toBe("QuestionChallenge")
    })

    it("normalizes an options server request into OptionsChallenge", () => {
      const frame = JSON.stringify({
        type: "request",
        id: "req-3",
        method: "droid.pick_options",
        params: { title: "pick", rows: [{ id: "a" }], multi: true },
      })

      const exit = run(withDialect((api) => api.notice(VERSION, bytes(frame))))
      const notice = expectSuccess(exit)

      expect(notice._tag).toBe("OptionsChallenge")

      if (!PeerNotice.$is("OptionsChallenge")(notice)) {
        throw new Error("expected OptionsChallenge")
      }

      expect(notice.title).toBe("pick")
      expect(notice.multiSelect).toBe(true)
    })

    it("rejects malformed JSON with BadReply", () => {
      const exit = run(withDialect((api) => api.notice(VERSION, bytes("{{{{not json"))))

      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(BadReply)
    })

    it("rejects an unreviewed server request method with UnsupportedBinding", () => {
      const frame = JSON.stringify({
        type: "request",
        id: "req-9",
        method: "droid.invented_prompt",
        params: {},
      })

      const exit = run(withDialect((api) => api.notice(VERSION, bytes(frame))))
      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(UnsupportedBinding)
    })

    it("wires the caller-supplied endpoint factory into challenges", async () => {
      const sent: Array<{ readonly id: string; readonly payload: Schema.Json }> = []

      const frame = JSON.stringify({
        type: "request",
        id: "req-7",
        method: "droid.request_permission",
        params: { toolUses: [], options: [] },
      })

      const exit = run(
        withDialect((api) =>
          api.notice(VERSION, bytes(frame), (peerRequestId, kind) =>
            createChallengeEndpoint(kind, (payload) =>
              Effect.sync(() => {
                sent.push({ id: peerRequestId, payload })
              }),
            ),
          ),
        ),
      )

      const notice = expectSuccess(exit)

      if (!PeerNotice.$is("PermissionChallenge")(notice)) {
        throw new Error("expected PermissionChallenge")
      }

      await Effect.runPromise(notice.endpoint.reply({ outcome: "proceed_once" }))

      expect(sent).toHaveLength(1)
      expect(sent[0]?.id).toBe("req-7")
    })
  })

  describe("challenge endpoint", () => {
    it("lets a reply succeed exactly once", async () => {
      const sent: Array<Schema.Json> = []

      const endpoint = createChallengeEndpoint("permission", (payload) =>
        Effect.sync(() => {
          sent.push(payload)
        }),
      )

      await Effect.runPromise(endpoint.reply({ outcome: "proceed_once" }))

      const second = Effect.runPromiseExit(endpoint.reply({ outcome: "cancel" }))
      const exit = await second

      expect(Exit.isFailure(exit)).toBe(true)
      expect(sent).toHaveLength(1)
    })

    it("never replies after revoke", async () => {
      const sent: Array<Schema.Json> = []

      const endpoint = createChallengeEndpoint("question", (payload) =>
        Effect.sync(() => {
          sent.push(payload)
        }),
      )

      await Effect.runPromise(endpoint.revoke())

      const exit = await Effect.runPromiseExit(endpoint.reply({ answer: "x" }))

      expect(Exit.isFailure(exit)).toBe(true)

      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause)

        expect(Option.isSome(error)).toBe(true)

        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(PeerRejected)
        }
      }

      expect(sent).toHaveLength(0)
    })

    it("reply after revoke fails even when a reply already succeeded", async () => {
      const endpoint = createChallengeEndpoint("options", () => Effect.void)

      await Effect.runPromise(endpoint.reply({ picked: [] }))
      await Effect.runPromise(endpoint.revoke())

      const exit = await Effect.runPromiseExit(endpoint.reply({ picked: ["a"] }))

      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe("jsonRpc envelopes", () => {
    it("builds a request envelope with version fields", () => {
      const exit = run(
        withDialect((api) =>
          Effect.flatMap(api.reviewedBinding("droid.kill_worker_session"), (binding) =>
            api.jsonRpcRequest("id-1", binding, { workerSessionId: "ws-9" }, VERSION),
          ),
        ),
      )

      const encoded = expectSuccess(exit)

      // SAFETY: the dialect just encoded a JSON-RPC envelope; parsing its own
      // output returns the envelope object.
      const frame = JSON.parse(new TextDecoder().decode(encoded)) as Record<string, Schema.Json>

      expect(frame["jsonrpc"]).toBe("2.0")
      expect(frame["factoryApiVersion"]).toBe("1.0.0")
      expect(frame["factoryProtocolVersion"]).toBe(SDK_PROTOCOL_VERSION)
      expect(frame["method"]).toBe("droid.kill_worker_session")
      expect(frame["id"]).toBe("id-1")
    })

    it("rejects invalid params in a request envelope", () => {
      const exit = run(
        withDialect((api) =>
          Effect.flatMap(api.reviewedBinding("droid.kill_worker_session"), (binding) =>
            api.jsonRpcRequest("id-1", binding, { wrong: 1 }, VERSION),
          ),
        ),
      )

      const failure = expectFailure(exit)

      expect(failure).toBeInstanceOf(InvalidArguments)
    })

    it("builds response and error envelopes", () => {
      const exit = run(
        withDialect((api) =>
          Effect.succeed({
            response: api.jsonRpcResponse("id-2", { ok: true }),
            error: api.jsonRpcError("id-3", -32601, "missing"),
          }),
        ),
      )

      const { response, error } = expectSuccess(exit)

      // SAFETY: the dialect just encoded the response envelope; parsing its
      // own output returns the envelope object.
      const responseFrame = JSON.parse(new TextDecoder().decode(response)) as Record<
        string,
        Schema.Json
      >

      // SAFETY: same as above, for the error envelope.
      const errorFrame = JSON.parse(new TextDecoder().decode(error)) as Record<string, Schema.Json>

      expect(responseFrame["type"]).toBe("response")
      expect(responseFrame["id"]).toBe("id-2")
      expect(errorFrame["id"]).toBe("id-3")
    })
  })

  describe("module hygiene", () => {
    it("never imports typescript under src/factory-dialect", () => {
      const root = join(import.meta.dirname, "../../src/factory-dialect")
      const files: Array<string> = []

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)

          if (entry.isDirectory()) walk(full)
          else files.push(full)
        }
      }

      walk(root)

      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        const content = readFileSync(file, "utf8")

        expect(content).not.toMatch(/from "typescript"/)
        expect(content).not.toMatch(/require\("typescript"\)/)
        expect(content).not.toMatch(/src\/droid\//)
      }
    })

    it("generated codecs contain no unknown types", () => {
      const content = readFileSync(
        join(import.meta.dirname, "../../src/factory-dialect/private/generated-codecs.ts"),
        "utf8",
      )

      expect(content).not.toMatch(/: unknown\b/)
      expect(content).not.toMatch(/\bunknown\[\]/)
      expect(content).not.toMatch(/<unknown>/)
      expect(content).not.toMatch(/as unknown\b/)
    })
  })

  describe("PeerNotice tagged enum", () => {
    it("constructs variants through the tagged constructors", () => {
      const endpoint = createChallengeEndpoint("permission", () => Effect.void)

      const notice = PeerNotice.PermissionChallenge({
        peerRequestId: "req-1",
        toolUses: [],
        options: [],
        endpoint,
      })

      expect(notice._tag).toBe("PermissionChallenge")

      const resolved = PeerNotice.ChallengeResolved({ peerRequestId: "req-1", toolUseIds: ["t"] })

      expect(resolved._tag).toBe("ChallengeResolved")
    })
  })
})
