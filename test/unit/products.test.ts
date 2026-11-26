import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { promisify } from "node:util"

import { Effect, Option, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Callers, callersLayer, createBearerVerifier } from "../../src/caller/index.ts"
import {
  CliParseError,
  doctor,
  embedded,
  httpServer,
  parseCliArgs,
  stdioServer,
} from "../../src/products/index.ts"
import type { EmbeddedResult, HttpServerHandle } from "../../src/products/index.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"

const FAKE_EXEC = join(import.meta.dirname, "../support/fake-droid-exec.mjs")

// Synthetic keys deliberately share the first eight SHA-256 hex digits.
const ALICE = "fixture-2607"
const BOB = "fixture-70509"
const TOKENS = [ALICE, BOB]

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "products-test-")))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const localOptions = () => ({
  workspaceRoots: [sandbox],
  droidPath: process.execPath,
  droidArgs: [FAKE_EXEC],
})

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))
const text = Schema.decodeUnknownSync(Schema.String)

const toolNames = Schema.decodeUnknownSync(
  Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
)

const embeddedValue = (outcome: EmbeddedResult): Schema.Json => {
  if (!outcome.ok) throw new Error(outcome.code + ": " + outcome.message)

  return outcome.value
}

const rpcReply = Schema.decodeUnknownSync(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Number,
    result: Schema.optionalKey(Schema.Json),
    error: Schema.optionalKey(
      Schema.Struct({
        code: Schema.Number,
        message: Schema.String,
        data: Schema.optionalKey(Schema.Json),
      }),
    ),
  }),
)

type RpcReply = ReturnType<typeof rpcReply>

type RequestRpc = (method: string, params?: Schema.Json) => Promise<RpcReply>

const requestLine = (id: number, method: string, params: Schema.Json): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params })

const result = (reply: RpcReply): Schema.Json => {
  if (reply.result === undefined) throw new Error("expected RPC result: " + JSON.stringify(reply))

  return reply.result
}

const call = (request: RequestRpc, name: string, args: Schema.Json = {}): Promise<RpcReply> =>
  request("tools/call", { name, arguments: args })

const toolValue = (reply: RpcReply): Schema.Json => {
  const { result: value } = record(result(reply))

  if (value === undefined) throw new Error("expected tool result: " + JSON.stringify(reply))

  return value
}

const post = (
  listener: HttpServerHandle,
  body: string,
  token?: string,
  origin?: string,
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" })

  if (token !== undefined) headers.set("authorization", "Bearer " + token)

  if (origin !== undefined) headers.set("origin", origin)

  return fetch(listener.url + listener.path, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(4_000),
  })
}

const httpClient = (listener: HttpServerHandle, token: string): RequestRpc => {
  let id = 0

  return async (method, params = {}) => {
    const requestId = ++id
    const response = await post(listener, requestLine(requestId, method, params), token)

    expect(response.status).toBe(200)

    const reply = rpcReply(json(await response.text()))

    expect(reply.id).toBe(requestId)

    return reply
  }
}

describe("parseCliArgs", () => {
  it("defaults to compact stdio with both compatibility flags off", () => {
    expect(parseCliArgs([], {})).toMatchObject({
      command: "serve",
      transport: "stdio",
      profile: "compact",
      host: "127.0.0.1",
      port: 0,
      authTokens: [],
      sharedSessions: false,
      allowUnverifiedDaemonAuthority: false,
      includeDaemon: true,
      guidanceRequired: true,
      maxAutonomy: "medium",
    })
  })

  it("keeps the opt-ins independent of each other, transport, and profile", () => {
    const flags = ["--http", "--profile=full", "--no-daemon", "--no-guidance"]

    const env = {
      DROID_MCP_SHARED_SESSIONS: "true",
      DROID_MCP_ALLOW_UNVERIFIED_DAEMON_AUTHORITY: "true",
    }

    expect(parseCliArgs(flags, env)).toMatchObject({
      sharedSessions: false,
      allowUnverifiedDaemonAuthority: false,
    })
    expect(parseCliArgs([...flags, "--shared-sessions"], env)).toMatchObject({
      sharedSessions: true,
      allowUnverifiedDaemonAuthority: false,
    })
    expect(parseCliArgs([...flags, "--allow-unverified-daemon-authority"], env)).toMatchObject({
      sharedSessions: false,
      allowUnverifiedDaemonAuthority: true,
    })
  })

  it.each([
    "--profile=unknown",
    "--max-autonomy=unlimited",
    "--port=65536",
    "--port=-1",
    "--port=",
    "--port=1.5",
    "--shared-sessions=false",
    "--allow-unverified-daemon-authority=true",
    "--host",
    "--not-a-flag",
  ])("rejects invalid argument %s", (argument) => {
    expect(() => parseCliArgs([argument], {})).toThrow(CliParseError)
  })
})

describe("embedded", () => {
  it("runs a local turn, reads events, omits the daemon and closes idempotently", async () => {
    const runtime = await embedded({
      ...localOptions(),
      principal: "operator",
      includeDaemon: false,
    })

    try {
      expect(runtime.operations()).toContain("session_create")
      expect(runtime.operations()).not.toContain("daemon_load_session")
      await expect(runtime.invoke("daemon_load_session", {})).resolves.toMatchObject({
        ok: false,
        code: "unknown_operation",
      })

      const created = await runtime.invoke("session_create", { cwd: sandbox, autonomyLevel: "low" })
      const sessionId = text(record(embeddedValue(created)).sessionId)

      const turn = await runtime.invoke("session_stream", {
        sessionId,
        prompt: "hello",
        waitMs: 5_000,
      })

      expect(embeddedValue(turn)).toMatchObject({ status: "completed", lastText: "hi" })

      const events = await runtime.invoke("session_events", { sessionId, cursor: 0, waitMs: 0 })

      expect(embeddedValue(events)).toMatchObject({
        events: expect.arrayContaining([expect.objectContaining({ kind: "turn_completed" })]),
      })

      await expect(
        runtime.invoke("session_events", { sessionId, after: 0, waitMs: 0 }),
      ).resolves.toMatchObject({ ok: false, code: "invalid_arguments" })

      await expect(runtime.invoke("session_close", { sessionId })).resolves.toEqual({
        ok: true,
        value: { sessionId, closed: true },
      })
    } finally {
      await Promise.all([runtime.close(), runtime.close()])
    }

    await expect(runtime.invoke("session_list", {})).resolves.toMatchObject({
      ok: false,
      code: "closed",
    })
  })

  it("installs both configured network providers without contacting either", async () => {
    const runtime = await embedded({
      principal: "operator",
      includeDaemon: false,
      factoryBaseUrl: "http://127.0.0.1:1",
      contextBaseUrl: "http://127.0.0.1:1",
    })

    try {
      const names = runtime.operations()

      expect(names.some((name) => name.startsWith("rest_"))).toBe(true)
      expect(names.some((name) => name.startsWith("context_"))).toBe(true)
      expect(names).not.toContain("daemon_load_session")
    } finally {
      await runtime.close()
    }
  })
})

describe("stdioServer", () => {
  it("negotiates and dispatches newline-delimited requests, then drains at EOF", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines = createInterface({ input: output, terminal: false })
    const replies = lines[Symbol.asyncIterator]()
    const server = await stdioServer({ input, output, includeDaemon: false })
    let id = 0

    const nextReply = async (expectedId: number): Promise<RpcReply> => {
      const line = await replies.next()

      if (line.done) throw new Error("stdio ended before replying")

      const reply = rpcReply(json(line.value))

      expect(reply.id).toBe(expectedId)

      return reply
    }

    const request: RequestRpc = (method, params = {}) => {
      const requestId = ++id

      input.write(requestLine(requestId, method, params) + "\n")

      return nextReply(requestId)
    }

    try {
      expect(result(await request("initialize"))).toMatchObject({
        serverInfo: { name: "droid-mcp" },
      })
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')

      const { tools } = toolNames(result(await request("tools/list")))

      expect(tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["server_info", "skill_read", "session_list", "tools_search"]),
      )
      expect(toolValue(await call(request, "server_info"))).toMatchObject({ profile: "compact" })
      expect(toolValue(await call(request, "skill_read"))).toMatchObject({
        uri: "skill://droid/SKILL.md",
        markdown: expect.stringContaining("# Droid"),
      })
      expect(toolValue(await call(request, "session_list"))).toEqual({ sessions: [] })

      input.end(
        requestLine(++id, "tools/call", {
          name: "tools_search",
          arguments: { query: "session_list" },
        }) + "\n",
      )
      expect(JSON.stringify(toolValue(await nextReply(id)))).toContain("session_list")
      await Promise.all([server.close(), server.close()])
      expect(input.listenerCount("data")).toBe(0)
    } finally {
      await server.close()
      lines.close()
      input.destroy()
      output.destroy()
    }
  })
})

describe("httpServer", () => {
  it("rejects invalid evidence and isolates callers whose bearer hashes share a prefix", async () => {
    const verifier = createBearerVerifier(TOKENS)

    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const callers = yield* Callers

        return yield* Effect.forEach(TOKENS, (token) =>
          callers.admit(Option.getOrThrow(verifier.verify("Bearer " + token))),
        )
      }).pipe(Effect.provide(callersLayer({}))),
    )

    const digests = TOKENS.map((token) => createHash("sha256").update(token).digest("hex"))

    expect(ids.map(({ id }) => id)).toEqual(digests)
    expect(new Set(digests).size).toBe(2)
    expect(new Set(digests.map((digest) => digest.slice(0, 8))).size).toBe(1)
    expect(digests.every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(true)

    const server = await httpServer({
      ...localOptions(),
      authTokens: TOKENS,
      includeDaemon: false,
      port: 0,
    })

    try {
      expect(server.host).toBe("127.0.0.1")
      expect(server.port).toBeGreaterThan(0)

      const initialize = requestLine(1, "initialize", {})

      for (const token of [undefined, "wrong-bearer"]) {
        const refused = await post(server, initialize, token)

        expect(refused.status).toBe(401)
        expect(refused.headers.get("www-authenticate")).toBe("Bearer")
      }

      const badOrigin = await post(server, initialize, ALICE, "http://example.invalid")

      expect(badOrigin.status).toBe(403)
      await badOrigin.body?.cancel()

      const alice = httpClient(server, ALICE)
      const bob = httpClient(server, BOB)

      expect(result(await alice("initialize"))).toMatchObject({ serverInfo: { name: "droid-mcp" } })
      expect(result(await bob("initialize"))).toMatchObject({ serverInfo: { name: "droid-mcp" } })
      toolValue(await call(alice, "skill_read"))
      toolValue(await call(bob, "skill_read"))

      const created = toolValue(
        await call(alice, "session_create", { cwd: sandbox, autonomyLevel: "low" }),
      )

      const sessionId = text(record(created).sessionId)

      expect(toolValue(await call(alice, "session_list"))).toMatchObject({
        sessions: [{ sessionId }],
      })
      expect(toolValue(await call(bob, "session_list"))).toEqual({ sessions: [] })
      expect((await call(bob, "session_close", { sessionId })).error?.data).toMatchObject({
        code: "not_visible",
      })

      for (const sensitive of [...TOKENS, ...digests]) {
        expect(JSON.stringify(created)).not.toContain(sensitive)
      }

      expect(toolValue(await call(alice, "session_close", { sessionId }))).toMatchObject({
        closed: true,
      })
    } finally {
      await Promise.all([server.close(), server.close()])
    }

    await expect(post(server, requestLine(1, "ping", {}), ALICE)).rejects.toThrow()
  })

  it("shares sessions only, not receipts, artifacts, or daemon authority", async () => {
    const socketPath = join(sandbox, "unused-daemon.sock")
    const daemon = await startFakeDaemon(socketPath, {})

    try {
      const server = await httpServer({
        ...localOptions(),
        authTokens: TOKENS,
        sharedSessions: true,
        daemonEndpoint: { socketPath },
        daemonServedMethods: new Set(["daemon.load_session"]),
      })

      try {
        const alice = httpClient(server, ALICE)
        const bob = httpClient(server, BOB)

        toolValue(await call(alice, "skill_read"))

        const created = toolValue(
          await call(alice, "session_create", { cwd: sandbox, autonomyLevel: "low" }),
        )

        const sessionId = text(record(created).sessionId)

        expect(
          (await call(bob, "session_stream", { sessionId, prompt: "hello" })).error?.data,
        ).toMatchObject({
          code: "guidance_required",
        })

        const large = await call(alice, "tool_call", {
          name: "session_stream",
          arguments: { sessionId, prompt: "bulk:40", waitMs: 5_000 },
          maxBytes: 1_024,
        })

        const continuation = record(result(large))
        const ref = text(continuation.ref)

        expect(continuation.truncated).toBe(true)
        expect(toolValue(await call(alice, "result_read", { ref, length: 100 }))).toHaveProperty(
          "chunk",
        )

        toolValue(await call(bob, "skill_read"))

        const sharedList = toolValue(await call(bob, "session_list"))

        const { sessions } = Schema.decodeUnknownSync(
          Schema.Struct({
            sessions: Schema.Array(
              Schema.Struct({ sessionId: Schema.String, cursor: Schema.Number }),
            ),
          }),
        )(sharedList)

        expect(sessions).toEqual([{ sessionId, cursor: expect.any(Number) }])

        const cursor = sessions[0]?.cursor

        if (cursor === undefined) throw new Error("shared session did not have a cursor")

        expect(
          toolValue(await call(bob, "session_events", { sessionId, cursor, waitMs: 0 })),
        ).toMatchObject({
          sessionId,
          status: "completed",
        })

        const foreign = await call(bob, "result_read", { ref, length: 100 })
        const missing = await call(bob, "result_read", { ref: "res_0000000000000000", length: 100 })

        const absence = record(missing.error?.data)

        expect(absence).toMatchObject({ code: "artifact_unavailable" })
        expect(foreign.error?.data).toEqual({ ...absence, ref })

        for (const request of [alice, bob]) {
          const load = await call(request, "tool_call", {
            name: "daemon_load_session",
            arguments: { sessionId, token: "fixture-daemon-token" },
          })

          expect(load.error?.data).toMatchObject({ code: "authority_unverifiable" })
        }

        expect(daemon.requests).toEqual([])
      } finally {
        await server.close()
      }
    } finally {
      await daemon.close()
    }
  })

  it.each(["compact", "full"] as const)("advertises only the %s profile", async (profile) => {
    const server = await httpServer({ authTokens: [ALICE], profile, includeDaemon: false })

    try {
      const request = httpClient(server, ALICE)
      const { tools } = toolNames(result(await request("tools/list")))
      const names = tools.map(({ name }) => name)

      expect(toolValue(await call(request, "server_info"))).toMatchObject({
        profile,
        toolCount: names.length,
      })
      expect(names).toContain("session_create")

      if (profile === "compact") {
        expect(names).toContain("tools_search")
        expect(names).not.toContain("session_run")
      } else {
        expect(names).not.toContain("tools_search")
        expect(names).toContain("session_run")
      }
    } finally {
      await server.close()
    }
  })
})

describe("doctor", () => {
  it("reports a running HTTP listener's status and becomes unreachable after shutdown", async () => {
    const server = await httpServer({ authTokens: [ALICE], includeDaemon: false })

    const options = {
      transport: "http",
      url: server.url + server.path,
      bearerToken: ALICE,
    } as const

    try {
      await expect(doctor(options)).resolves.toEqual({
        transport: "http",
        reachable: true,
        status: 200,
      })
      await expect(doctor({ transport: "http", url: options.url })).resolves.toEqual({
        transport: "http",
        reachable: true,
        status: 401,
      })
    } finally {
      await server.close()
    }

    await expect(doctor(options)).resolves.toEqual({ transport: "http", reachable: false })
  })

  it("authenticates to an existing daemon but does not create one at an absent socket", async () => {
    const socketPath = join(sandbox, "daemon.sock")

    const daemon = await startFakeDaemon(socketPath, {
      onRequest: () => ({ result: { userId: "fixture-user", orgId: "fixture-org" } }),
    })

    const options = {
      transport: "daemon",
      endpoint: { socketPath },
      auth: { apiKey: "fixture-key" },
    } as const

    try {
      await expect(doctor(options)).resolves.toEqual({ transport: "daemon", reachable: true })
      expect(daemon.requests.map(({ method }) => method)).toEqual(["daemon.authenticate"])
      await expect.poll(daemon.openSockets).toBe(0)
    } finally {
      await daemon.close()
    }

    await expect(doctor(options)).resolves.toEqual({ transport: "daemon", reachable: false })
  })
})

describe("cli entry point", () => {
  const execFileAsync = promisify(execFile)
  const CLI_PATH = join(import.meta.dirname, "../../src/products/private/cli.ts")

  it("prints version and usage from the executable CLI entry point", async () => {
    const version = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      CLI_PATH,
      "--version",
    ])

    expect(version.stdout.trim()).toBe("0.1.0")

    const help = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      CLI_PATH,
      "--help",
    ])

    expect(help.stdout).toContain("droid-mcp serve [flags]")
    expect(help.stdout).toContain("droid-mcp doctor [flags]")
  })

  it("runs doctor subcommand against a live daemon socket", async () => {
    const socketPath = join(sandbox, "cli-doctor.sock")

    const daemon = await startFakeDaemon(socketPath, {
      onRequest: () => ({ result: { userId: "cli-user", orgId: "cli-org" } }),
    })

    try {
      const result = await execFileAsync(process.execPath, [
        "--experimental-strip-types",
        CLI_PATH,
        "doctor",
        "--daemon-url",
        "unix:" + socketPath,
        "--factory-api-key",
        "cli-key",
      ])

      expect(json(result.stdout.trim())).toEqual({ transport: "daemon", reachable: true })
    } finally {
      await daemon.close()
    }
  })
})
