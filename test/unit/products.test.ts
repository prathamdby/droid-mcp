import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual, promisify } from "node:util"

import { Effect, Option, Schema } from "effect"
import * as Predicate from "effect/Predicate"
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
import { startFakeContextApi } from "../support/fake-context-api.ts"
import { startFakeDaemon, startFakeTcpDaemon } from "../support/fake-daemon.ts"
import type {
  FakeDaemon,
  FakeTcpDaemon,
  ScriptedHandler,
  ScriptedReply,
} from "../support/fake-daemon.ts"

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
const records = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)))
const text = Schema.decodeUnknownSync(Schema.String)
const number = Schema.decodeUnknownSync(Schema.Number)

const toolNames = Schema.decodeUnknownSync(
  Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
)

const failureBody = Schema.decodeUnknownSync(
  Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    ref: Schema.optionalKey(Schema.String),
  }),
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

const toolEnvelope = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    isError: Schema.optionalKey(Schema.Boolean),
    structuredContent: Schema.optionalKey(Schema.Json),
  }),
)

type ToolEnvelope = ReturnType<typeof toolEnvelope>

const toolText = (envelope: ToolEnvelope): string => {
  if (envelope.content.length !== 1) {
    throw new Error("expected one tool content block: " + JSON.stringify(envelope))
  }

  const block = envelope.content[0]

  if (block === undefined || block.text.length === 0) {
    throw new Error("tool result carries no readable text: " + JSON.stringify(envelope))
  }

  return block.text
}

const toolPayload = (envelope: ToolEnvelope): Schema.Json => json(toolText(envelope))

/** Decodes a successful standard CallToolResult and proves its structured mirror. */
const toolValue = (reply: RpcReply): Schema.Json => {
  const envelope = toolEnvelope(result(reply))

  if (envelope.isError === true) throw new Error("expected a successful tool result")

  const value = toolPayload(envelope)
  const isObjectPayload = value !== null && !Array.isArray(value) && value instanceof Object

  if (isObjectPayload) {
    if (envelope.structuredContent === undefined) {
      throw new Error("object tool payload has no structuredContent")
    }

    expect(envelope.structuredContent).toEqual(value)
  } else if (envelope.structuredContent !== undefined) {
    throw new Error("scalar tool payload unexpectedly carries structuredContent")
  }

  return value
}

/** Decodes a tool execution failure inside a successful JSON-RPC reply. */
const toolFailure = (reply: RpcReply) => {
  const envelope = toolEnvelope(result(reply))

  if (envelope.isError !== true) {
    throw new Error("expected an isError tool result: " + JSON.stringify(reply))
  }

  if (envelope.structuredContent !== undefined) {
    throw new Error("tool failure unexpectedly carries structuredContent")
  }

  return failureBody(toolPayload(envelope))
}

const post = (
  listener: Pick<HttpServerHandle, "url" | "path">,
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

const httpClient = (
  listener: Pick<HttpServerHandle, "url" | "path">,
  token: string,
): RequestRpc => {
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
    "--daemon-url=127.0.0.1:7338",
    "--daemon-url=unix:",
  ])("rejects invalid argument %s", (argument) => {
    expect(() => parseCliArgs([argument], {})).toThrow(CliParseError)
  })

  it("resolves the daemon defaults: runtime socket, owned spawn, no key", () => {
    expect(parseCliArgs([], { XDG_RUNTIME_DIR: "/run/user/1000" })).toMatchObject({
      daemonEndpoint: { socketPath: "/run/user/1000/droid-mcp/daemon.sock" },
      daemonAuth: undefined,
      daemonSpawn: { command: "droid" },
      workspaceRoots: undefined,
    })

    expect(parseCliArgs([], {}).daemonEndpoint).toEqual({
      socketPath: "/tmp/droid-mcp/daemon.sock",
    })

    const runtime = parseCliArgs([], {
      DROID_MCP_RUNTIME_DIR: "/run/custom",
      DROID_MCP_DROID_PATH: "/opt/droid/bin/droid",
    })

    expect(runtime.daemonEndpoint).toEqual({ socketPath: "/run/custom/daemon.sock" })
    expect(runtime.daemonSpawn).toMatchObject({ command: "/opt/droid/bin/droid" })
  })

  it("maps every accepted --daemon-url form and disables the owned spawn", () => {
    for (const [url, endpoint] of [
      ["unix:/tmp/daemon.sock", { socketPath: "/tmp/daemon.sock" }],
      ["http://127.0.0.1:7338", { host: "127.0.0.1", port: 7338 }],
      ["ws://localhost", { host: "localhost", port: 7338 }],
    ] as const) {
      expect(parseCliArgs(["--daemon-url", url], {})).toMatchObject({
        daemonEndpoint: endpoint,
        daemonSpawn: undefined,
      })
    }

    expect(
      parseCliArgs(["--daemon-url", "unix:/tmp/x.sock"], { XDG_RUNTIME_DIR: "/run" }),
    ).toMatchObject({ daemonEndpoint: { socketPath: "/tmp/x.sock" } })
  })

  it.each([
    {
      source: "flag",
      args: ["--daemon-url", "https://daemon.internal:8443"],
      env: {},
      scheme: "https:",
    },
    {
      source: "flag",
      args: ["--daemon-url", "wss://daemon.internal:8443"],
      env: {},
      scheme: "wss:",
    },
    {
      source: "environment",
      args: [],
      env: { DROID_MCP_DAEMON_URL: "https://daemon.internal:8443" },
      scheme: "https:",
    },
    {
      source: "environment",
      args: [],
      env: { DROID_MCP_DAEMON_URL: "WSS://DAEMON.INTERNAL:8443" },
      scheme: "wss:",
    },
  ])("rejects a secure daemon URL from the $source", ({ args, env, scheme }) => {
    const parse = () => parseCliArgs(args, env)

    const message =
      "--daemon-url scheme " +
      scheme +
      " is not supported; use unix:<path>, http://host:port, or ws://host:port"

    expect(parse).toThrow(CliParseError)
    expect(parse).toThrow(message)
  })

  it("derives the daemon credential from the Factory API key", () => {
    expect(parseCliArgs(["--factory-api-key", "key-1"], {}).daemonAuth).toMatchObject({
      apiKey: "key-1",
    })
    expect(parseCliArgs([], { FACTORY_API_KEY: "env-key" }).daemonAuth).toMatchObject({
      apiKey: "env-key",
    })
    expect(parseCliArgs([], {}).daemonAuth).toBeUndefined()
  })

  it("parses FACTORY_CONTEXT_HEADERS as a JSON object of string values", () => {
    expect(parseCliArgs([], {}).contextHeaders).toBeUndefined()
    expect(parseCliArgs([], { FACTORY_CONTEXT_HEADERS: "  " }).contextHeaders).toBeUndefined()
    expect(
      parseCliArgs([], {
        FACTORY_CONTEXT_HEADERS: '{"X-Factory-Org":" \\t tenant canary \\t","x-tenant":"t"}',
      }).contextHeaders,
    ).toEqual({
      "X-Factory-Org": "tenant canary",
      "x-tenant": "t",
    })
  })

  it("keeps empty Context header values empty after trimming", () => {
    expect(parseCliArgs([], { FACTORY_CONTEXT_HEADERS: '{"X-Org":""}' }).contextHeaders).toEqual({
      "X-Org": "",
    })
    expect(parseCliArgs([], { FACTORY_CONTEXT_HEADERS: '{"X-Org":"   "}' }).contextHeaders).toEqual(
      {
        "X-Org": "",
      },
    )
  })

  it.each(["not json", "[]", '["a"]', '"text"', "3", '{"X-Org":3}', '{"X-Org":null}'])(
    "rejects invalid FACTORY_CONTEXT_HEADERS input %s",
    (raw) => {
      expect(() => parseCliArgs([], { FACTORY_CONTEXT_HEADERS: raw })).toThrow(CliParseError)
      expect(() => parseCliArgs([], { FACTORY_CONTEXT_HEADERS: raw })).toThrow(
        "FACTORY_CONTEXT_HEADERS must be a JSON object of string values",
      )
    },
  )

  it.each([
    "accept",
    "Accept",
    "authorization",
    "Authorization",
    "COOKIE",
    "host",
    "proxy-authorization",
    "connection",
    "content-length",
    "content-type",
    "transfer-encoding",
    "te",
    "upgrade",
    "keep-alive",
    "expect",
    "trailer",
  ])("rejects the reserved Context header %s", (name) => {
    const raw = JSON.stringify({ [name]: "v" })

    expect(() => parseCliArgs([], { FACTORY_CONTEXT_HEADERS: raw })).toThrow(
      "FACTORY_CONTEXT_HEADERS may not set " + name.toLowerCase(),
    )
  })

  it("rejects invalid Context header names, values, and case-insensitive duplicates", () => {
    for (const raw of [
      '{"bad name":"v"}',
      '{"X-Org":"a\\r\\nX-Evil: 1"}',
      '{"X-Org":"a\\u0001b"}',
      '{"X-Org":"a\\u007fb"}',
      '{"X-Org":"secret-\\u0100"}',
      '{"X-Org":"a","x-org":"b"}',
    ]) {
      expect(() => parseCliArgs([], { FACTORY_CONTEXT_HEADERS: raw })).toThrow(CliParseError)
    }
  })

  it("rejects invalid Context headers without echoing their values", () => {
    const secret = "tenant-secret-canary"

    for (const raw of [
      JSON.stringify({ cookie: secret }),
      JSON.stringify({ "X-Org": secret + "\r\nX-Evil: 1" }),
    ]) {
      let message = ""

      try {
        parseCliArgs([], { FACTORY_CONTEXT_HEADERS: raw })
      } catch (failure) {
        message = failure instanceof Error ? failure.message : ""
      }

      expect(message).toContain("FACTORY_CONTEXT_HEADERS")
      expect(message).not.toContain(secret)
    }
  })

  it("passes workspace roots only when the operator names them", () => {
    expect(parseCliArgs([], {}).workspaceRoots).toBeUndefined()
    expect(
      parseCliArgs(["--workspace-root", "/a", "--workspace-root", "/b"], {}).workspaceRoots,
    ).toEqual(["/a", "/b"])
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

  it("prefers the configured Factory key over a conflicting droidEnv entry", async () => {
    const runtime = await embedded({
      ...localOptions(),
      principal: "operator",
      includeDaemon: false,
      factoryApiKey: "configured-key",
      droidEnv: { FACTORY_API_KEY: "override-loses" },
    })

    try {
      const created = await runtime.invoke("session_create", { cwd: sandbox, autonomyLevel: "low" })
      const sessionId = text(record(embeddedValue(created)).sessionId)

      const turn = await runtime.invoke("session_stream", {
        sessionId,
        prompt: "env-echo",
        waitMs: 5_000,
      })

      expect(embeddedValue(turn)).toMatchObject({
        status: "completed",
        result: { structuredOutput: { echo: "[REDACTED]" } },
      })
      expect(JSON.stringify(embeddedValue(turn))).not.toContain("override-loses")
      expect(JSON.stringify(embeddedValue(turn))).not.toContain("configured-key")
    } finally {
      await runtime.close()
    }

    const blank = await embedded({
      ...localOptions(),
      principal: "operator",
      includeDaemon: false,
      factoryApiKey: "   ",
      droidEnv: { FACTORY_API_KEY: "kept-key" },
    })

    try {
      const created = await blank.invoke("session_create", { cwd: sandbox, autonomyLevel: "low" })
      const sessionId = text(record(embeddedValue(created)).sessionId)

      const turn = await blank.invoke("session_stream", {
        sessionId,
        prompt: "env-echo",
        waitMs: 5_000,
      })

      expect(embeddedValue(turn)).toMatchObject({
        status: "completed",
        result: { structuredOutput: { echo: "[REDACTED]" } },
      })
      expect(JSON.stringify(embeddedValue(turn))).not.toContain("kept-key")
    } finally {
      await blank.close()
    }
  })

  it("admits the process working directory when no roots are configured", async () => {
    const runtime = await embedded({
      droidPath: process.execPath,
      droidArgs: [FAKE_EXEC],
      includeDaemon: false,
      principal: "operator",
    })

    try {
      const created = await runtime.invoke("session_create", {
        cwd: process.cwd(),
        autonomyLevel: "low",
      })

      const sessionId = text(record(embeddedValue(created)).sessionId)

      await expect(runtime.invoke("session_close", { sessionId })).resolves.toMatchObject({
        ok: true,
      })
    } finally {
      await runtime.close()
    }
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

  it("delivers daemon operations from the configured endpoint and credential", async () => {
    const socketPath = join(sandbox, "stdio-daemon.sock")

    const daemon = await startFakeDaemon(socketPath, {
      onRequest: () => ({ result: { sessions: [] } }),
    })

    const input = new PassThrough()
    const output = new PassThrough()
    const lines = createInterface({ input: output, terminal: false })
    const replies = lines[Symbol.asyncIterator]()

    const server = await stdioServer({
      input,
      output,
      daemonEndpoint: { socketPath },
      daemonAuth: { apiKey: "stdio-key" },
      daemonServedMethods: new Set(["daemon.list_opened_sessions"]),
    })

    let id = 0

    const nextReply = async (): Promise<RpcReply> => {
      const line = await replies.next()

      if (line.done) throw new Error("stdio ended before replying")

      return rpcReply(json(line.value))
    }

    const request: RequestRpc = (method, params = {}) => {
      const requestId = ++id

      input.write(requestLine(requestId, method, params) + "\n")

      return nextReply().then((reply) => {
        expect(reply.id).toBe(requestId)

        return reply
      })
    }

    try {
      result(await request("initialize"))
      toolValue(await call(request, "skill_read"))

      const listed = toolValue(await call(request, "daemon_list_opened_sessions", {}))

      expect(listed).toEqual({ sessions: [] })
      expect(daemon.requests.map(({ method }) => method)).toContain("daemon.list_opened_sessions")
    } finally {
      await server.close()
      lines.close()
      input.destroy()
      output.destroy()
      await daemon.close()
    }
  })

  it("forwards session change notifications as bare JSON-RPC frames", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines = createInterface({ input: output, terminal: false })
    const frames = lines[Symbol.asyncIterator]()

    const server = await stdioServer({
      ...localOptions(),
      input,
      output,
      includeDaemon: false,
    })

    let id = 0
    const notices: Array<Record<string, Schema.Json>> = []

    const next = async (): Promise<Schema.Json> => {
      const line = await frames.next()

      if (line.done) throw new Error("stdio ended before the next frame")

      return json(line.value)
    }

    const request: RequestRpc = async (method, params = {}) => {
      const requestId = ++id

      input.write(requestLine(requestId, method, params) + "\n")

      for (;;) {
        const value = await next()
        const frame = record(value)

        if (frame.id === requestId) {
          const reply = rpcReply(value)

          expect(reply.id).toBe(requestId)

          return reply
        }

        notices.push(frame)
      }
    }

    try {
      result(await request("initialize"))
      toolValue(await call(request, "skill_read"))

      const created = toolValue(
        await call(request, "session_create", { cwd: sandbox, autonomyLevel: "low" }),
      )

      const sessionId = text(record(created).sessionId)

      if (notices.length === 0) notices.push(record(await next()))

      const notice = notices[0]

      if (notice === undefined) throw new Error("no notification frame arrived")

      expect(String(notice.method)).toBe("notifications/resources/updated")
      expect(String(record(notice.params ?? {}).uri)).toContain(sessionId)
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
      expect(toolFailure(await call(bob, "session_close", { sessionId }))).toMatchObject({
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

  it("encodes direct, discovery, dispatch and batch results as visible MCP content", async () => {
    const server = await httpServer({ authTokens: [ALICE], includeDaemon: false, port: 0 })

    try {
      const request = httpClient(server, ALICE)

      expect(record(result(await request("initialize"))).content).toBeUndefined()
      expect(record(result(await request("tools/list"))).content).toBeUndefined()

      const directReply = await call(request, "server_info")
      const direct = record(toolValue(directReply))

      expect(direct).toMatchObject({
        serverName: "droid-mcp",
        profile: "compact",
        maxAutonomy: "medium",
      })
      expect(number(direct.operationCount)).toBeGreaterThan(0)

      const search = record(
        toolValue(await call(request, "tools_search", { query: "session events" })),
      )

      const entries = records(search.tools ?? [])
      const names = entries.map((entry) => text(entry.name))

      expect(number(search.total)).toBeGreaterThan(0)
      expect(names).toContain("session_events")

      const filtered = record(
        toolValue(
          await call(request, "tools_search", {
            family: "session",
            readOnly: true,
            limit: 2,
            offset: 0,
          }),
        ),
      )

      const filteredEntries = records(filtered.tools ?? [])
      const filteredNames = filteredEntries.map((entry) => text(entry.name))

      expect(number(filtered.total)).toBeGreaterThan(2)
      expect(filteredEntries).toHaveLength(2)
      expect(number(filtered.nextOffset)).toBe(2)

      for (const entry of filteredEntries) {
        expect(entry.family).toBe("session")
        expect(entry.readOnly).toBe(true)
      }

      const offsetPage = record(
        toolValue(
          await call(request, "tools_search", {
            family: "session",
            readOnly: true,
            limit: 2,
            offset: 2,
          }),
        ),
      )

      const offsetNames = records(offsetPage.tools ?? []).map((entry) => text(entry.name))
      const firstOffsetName = offsetNames[0]

      if (firstOffsetName === undefined) throw new Error("offset search page is empty")

      expect(filteredNames).not.toContain(firstOffsetName)

      expect(
        toolValue(await call(request, "tools_search", { query: "zzzz-no-such-operation-zzzz" })),
      ).toEqual({ total: 0, tools: [] })

      const invalidSearchArguments: ReadonlyArray<Schema.Json> = [
        { family: "bogus" },
        { readOnly: "yes" },
        { limit: 0 },
        { limit: 51 },
        { limit: 1.5 },
        { offset: -1 },
      ]

      for (const searchArguments of invalidSearchArguments) {
        expect(toolFailure(await call(request, "tools_search", searchArguments))).toMatchObject({
          code: "invalid_arguments",
        })
      }

      const dispatchReply = await call(request, "tool_call", {
        name: "server_info",
        arguments: {},
      })

      expect(result(dispatchReply)).toEqual(result(directReply))

      const scalarReply = await call(request, "tool_call", {
        name: "server_info",
        arguments: {},
        select: "/profile",
      })

      expect(toolValue(scalarReply)).toBe("compact")

      const arrayReply = await call(request, "tool_call", {
        name: "server_info",
        arguments: {},
        select: "/providerKinds",
      })

      expect(toolValue(arrayReply)).toEqual([])

      const batch = record(
        toolValue(
          await call(request, "batch", {
            steps: [
              { id: "first", name: "server_info" },
              { id: "second", name: "server_info", arguments: {} },
            ],
            stopOnError: false,
          }),
        ),
      )

      const steps = records(batch.steps ?? [])

      expect(batch.completed).toBe(2)
      expect(batch.failed).toBe(0)
      expect(steps).toHaveLength(2)

      for (const step of steps) {
        expect(step.status).toBe("ok")
        expect(record(step.result ?? {}).profile).toBe("compact")
      }

      const unbudgeted = record(
        toolValue(
          await call(request, "batch", {
            steps: [
              { id: "unbudgeted-first", name: "skill_read" },
              { id: "unbudgeted-second", name: "skill_read" },
            ],
          }),
        ),
      )

      for (const step of records(unbudgeted.steps ?? [])) {
        expect(step.status).toBe("ok")
        expect(step.truncated).toBeUndefined()
        expect(text(record(step.result ?? {}).markdown)).toContain("# Droid")
      }

      const budgeted = record(
        toolValue(
          await call(request, "batch", {
            steps: [
              { id: "budget-first", name: "skill_read" },
              { id: "budget-second", name: "skill_read" },
            ],
            maxBytes: 1,
          }),
        ),
      )

      const budgetedSteps = records(budgeted.steps ?? [])

      expect(budgeted.completed).toBe(2)
      expect(budgetedSteps).toHaveLength(2)

      for (const step of budgetedSteps) {
        expect(step.status).toBe("ok")
        expect(step.result).toBeUndefined()
        expect(step.truncated).toBe(true)

        const ref = text(step.ref)
        const page = record(toolValue(await call(request, "result_read", { ref, length: 128 })))

        expect(text(page.chunk)).toContain('"markdown"')
        expect(number(page.totalBytes)).toBeGreaterThan(1_024)
      }
    } finally {
      await server.close()
    }
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
          toolFailure(await call(bob, "session_stream", { sessionId, prompt: "hello" })),
        ).toMatchObject({
          code: "guidance_required",
        })

        const large = await call(alice, "tool_call", {
          name: "session_stream",
          arguments: { sessionId, prompt: "bulk:40", waitMs: 5_000 },
          maxBytes: 1_024,
        })

        const continuation = record(toolValue(large))
        const ref = text(continuation.ref)
        const totalBytes = number(continuation.totalBytes)
        const preview = text(continuation.preview)

        expect(continuation.truncated).toBe(true)
        expect(totalBytes).toBeGreaterThan(1_024)
        expect(preview.length).toBeGreaterThan(0)
        expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(1_024)
        expect(text(continuation.hint)).toContain("result_read")

        let offset = 0
        let assembled = ""
        let finished = false

        for (let round = 0; round < 100; round += 1) {
          const page = record(
            toolValue(await call(alice, "result_read", { ref, offset, length: 16_384 })),
          )

          expect(text(page.ref)).toBe(ref)
          expect(number(page.offset)).toBe(offset)

          assembled += text(page.chunk)

          if (page.done === true) {
            finished = true
            expect(page.nextOffset).toBeUndefined()
            break
          }

          const nextOffset = number(page.nextOffset)

          expect(nextOffset).toBeGreaterThan(offset)
          offset = nextOffset
        }

        expect(finished).toBe(true)
        expect(Buffer.byteLength(assembled, "utf8")).toBe(totalBytes)

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

        const absence = toolFailure(missing)

        expect(absence).toMatchObject({ code: "artifact_unavailable" })
        expect(toolFailure(foreign)).toEqual({ ...absence, ref })

        for (const request of [alice, bob]) {
          const load = await call(request, "tool_call", {
            name: "daemon_load_session",
            arguments: { sessionId, token: "fixture-daemon-token" },
          })

          expect(toolFailure(load)).toMatchObject({ code: "authority_unverifiable" })
        }

        expect(daemon.requests).toEqual([])
      } finally {
        await server.close()
      }
    } finally {
      await daemon.close()
    }
  })

  it("keeps execution failures visible and protocol errors on the error channel", async () => {
    const server = await httpServer({
      ...localOptions(),
      authTokens: [ALICE],
      includeDaemon: false,
      port: 0,
    })

    try {
      const request = httpClient(server, ALICE)

      toolValue(await call(request, "skill_read"))

      const invalid = await call(request, "session_events", {
        sessionId: "",
        cursor: -1,
        waitMs: 0,
      })

      expect(invalid.error).toBeUndefined()
      expect(toolFailure(invalid)).toMatchObject({ code: "invalid_arguments" })

      const innerUnknown = await call(request, "tool_call", {
        name: "no_such_operation",
        arguments: {},
      })

      expect(innerUnknown.error).toBeUndefined()
      expect(toolFailure(innerUnknown)).toMatchObject({ code: "unknown_operation" })

      const directUnknown = await call(request, "no_such_direct_tool")

      expect(directUnknown.error?.code).toBe(-32_000)
      expect(record(directUnknown.error?.data ?? {})).toMatchObject({
        code: "unknown_operation",
      })

      const invalidEnvelope = await request("tools/call", { arguments: {} })

      expect(invalidEnvelope.error?.code).toBe(-32_000)
      expect(record(invalidEnvelope.error?.data ?? {})).toMatchObject({
        code: "invalid_arguments",
      })

      const malformed = await post(server, "{", ALICE)

      expect(malformed.status).toBe(200)

      const malformedError = record(record(json(await malformed.text())).error ?? {})

      expect(malformedError.code).toBe(-32_700)

      const badFrame = await post(
        server,
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: "bad" }),
        ALICE,
      )

      expect(badFrame.status).toBe(200)

      const badFrameError = record(record(json(await badFrame.text())).error ?? {})

      expect(badFrameError.code).toBe(-32_600)

      const invalidSelect = await call(request, "tool_call", {
        name: "session_create",
        arguments: { cwd: sandbox, autonomyLevel: "low" },
        select: "/does/not/exist",
      })

      const failure = toolFailure(invalidSelect)

      expect(invalidSelect.error).toBeUndefined()
      expect(failure).toMatchObject({ code: "invalid_select" })

      const ref = text(failure.ref)
      const recovered = record(toolValue(await call(request, "result_read", { ref, length: 200 })))

      expect(text(recovered.ref)).toBe(ref)
      expect(text(recovered.chunk)).toContain("sess-")
    } finally {
      await server.close()
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

interface ConnectionCounter {
  readonly port: number
  readonly connections: () => number
  readonly close: () => Promise<void>
}

const startConnectionCounter = async (): Promise<ConnectionCounter> => {
  let connections = 0

  const server = createServer((socket) => {
    connections += 1
    socket.destroy()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const address = server.address()

  if (address === null || Predicate.isString(address)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error("connection counter did not bind")
  }

  return {
    port: address.port,
    connections: () => connections,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe("cli entry point", () => {
  const execFileAsync = promisify(execFile)
  const CLI_PATH = join(import.meta.dirname, "../../src/products/private/cli.ts")
  const CLI_ARGS = ["--experimental-strip-types", CLI_PATH]

  const cli = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
    execFileAsync(process.execPath, [...CLI_ARGS, ...args], { env, timeout: 4_000 })

  const cliVersion = async (): Promise<string> => (await cli(["--version"])).stdout.trim()

  const cliDaemonHandler = (apiKey: string, version: string): ScriptedHandler => {
    let authenticated = false

    return {
      onRequest: ({ method, params }): ScriptedReply => {
        if (method === "daemon.authenticate") {
          authenticated = isDeepStrictEqual(params, {
            apiKey,
            caller: "sdk",
            metadata: { sdk: { language: "typescript", version } },
          })

          return authenticated
            ? { result: { userId: "cli-user", orgId: "cli-org" } }
            : { error: { code: -32700, message: "Parse error" } }
        }

        if (authenticated && method === "daemon.list_opened_sessions") {
          return { result: { sessions: [] } }
        }

        return { error: { code: -32601, message: "Method not found" } }
      },
    }
  }

  const startCliDaemon = async (apiKey: string): Promise<FakeDaemon> => {
    const version = await cliVersion()

    return startFakeDaemon(join(sandbox, "cli-daemon.sock"), cliDaemonHandler(apiKey, version))
  }

  const startCliTcpDaemon = async (apiKey: string): Promise<FakeTcpDaemon> => {
    const version = await cliVersion()

    return startFakeTcpDaemon(cliDaemonHandler(apiKey, version))
  }

  const startCliHttp = async (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
    const child = spawn(
      process.execPath,
      [...CLI_ARGS, "serve", "--http", "--auth-token", ALICE, ...args],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 6_000,
        killSignal: "SIGKILL",
      },
    )

    const closed = once(child, "close")
    const lines = createInterface({ input: child.stdout, terminal: false })
    let stderr = ""

    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })

    const close = async (): Promise<void> => {
      lines.close()
      child.kill()
      await closed
    }

    const line = await lines[Symbol.asyncIterator]().next()
    const prefix = "listening on "

    if (line.done || !line.value.startsWith(prefix)) {
      await close()
      throw new Error("CLI did not announce its HTTP endpoint: " + stderr)
    }

    return { endpoint: new URL(line.value.slice(prefix.length)), close }
  }

  it("prints version and usage from the executable CLI entry point", async () => {
    await expect(cliVersion()).resolves.toBe("0.1.0")

    const help = await cli(["--help"])

    expect(help.stdout).toContain("droid-mcp serve [flags]")
    expect(help.stdout).toContain("droid-mcp doctor [flags]")
    expect(help.stdout).toContain("unix:<path>")
    expect(help.stdout).toContain("http://host:port")
    expect(help.stdout).toContain("ws://host:port")
    expect(help.stdout).not.toContain("http(s)")
    expect(help.stdout).not.toContain("ws(s)")
  })

  it.each([
    { source: "flag", args: ["--factory-api-key", "flag-key"], expectedKey: "flag-key" },
    { source: "environment", args: [], expectedKey: "env-key" },
  ])(
    "authenticates CLI doctor with the $source key and SDK identity",
    async ({ args, expectedKey }) => {
      const daemon = await startCliDaemon(expectedKey)

      try {
        const probe = cli(["doctor", "--daemon-url", "unix:" + daemon.socketPath, ...args], {
          FACTORY_API_KEY: "env-key",
        })

        await expect(probe).resolves.toMatchObject({
          stdout: '{"transport":"daemon","reachable":true}\n',
        })
        expect(daemon.requests.map(({ method }) => method)).toEqual(["daemon.authenticate"])
      } finally {
        await daemon.close()
      }
    },
  )

  it.each([
    ["serve", "https", "flag"],
    ["serve", "wss", "flag"],
    ["serve", "https", "environment"],
    ["serve", "wss", "environment"],
    ["doctor", "https", "flag"],
    ["doctor", "wss", "flag"],
    ["doctor", "https", "environment"],
    ["doctor", "wss", "environment"],
  ] as const)(
    "%s rejects a %s daemon URL from the %s before connecting",
    async (command, scheme, source) => {
      const counter = await startConnectionCounter()

      try {
        const secureUrl = scheme + "://127.0.0.1:" + String(counter.port)
        const args = source === "flag" ? [command, "--daemon-url", secureUrl] : [command]
        const env = source === "environment" ? { DROID_MCP_DAEMON_URL: secureUrl } : {}

        const message =
          "--daemon-url scheme " +
          scheme +
          ": is not supported; use unix:<path>, http://host:port, or ws://host:port"

        await expect(cli(args, env)).rejects.toMatchObject({
          code: 2,
          stderr: expect.stringContaining(message),
        })
        expect(counter.connections()).toBe(0)
      } finally {
        await counter.close()
      }
    },
  )

  it.each(["http", "ws"] as const)(
    "authenticates CLI doctor over plaintext %s daemon URLs",
    async (scheme) => {
      const daemon = await startCliTcpDaemon("env-key")

      try {
        const url = scheme + "://" + daemon.host + ":" + String(daemon.port)

        await expect(
          cli(["doctor", "--daemon-url", url], { FACTORY_API_KEY: "env-key" }),
        ).resolves.toMatchObject({
          stdout: '{"transport":"daemon","reachable":true}\n',
        })
        expect(daemon.requests.map(({ method }) => method)).toEqual(["daemon.authenticate"])
      } finally {
        await daemon.close()
      }
    },
  )

  it("does not start a daemon when CLI doctor probes an absent runtime socket", async () => {
    const executable = join(sandbox, "fake-droid")

    writeFileSync(executable, '#!/bin/sh\n: > "$0.launched"\n', { mode: 0o700 })

    await expect(
      cli(["doctor", "--droid-path", executable], {
        DROID_MCP_RUNTIME_DIR: sandbox,
        FACTORY_API_KEY: "env-key",
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '{"transport":"daemon","reachable":false}\n',
    })
    expect(existsSync(executable + ".launched")).toBe(false)
  })

  it.each([
    { endpoint: "Unix socket", startDaemon: startCliDaemon },
    { endpoint: "plaintext TCP", startDaemon: startCliTcpDaemon },
  ])(
    "authenticates CLI HTTP serve over a $endpoint endpoint before running a daemon-backed read",
    async ({ startDaemon }) => {
      const daemon = await startDaemon("env-key")

      const daemonUrl =
        "socketPath" in daemon
          ? "unix:" + daemon.socketPath
          : "http://" + daemon.host + ":" + String(daemon.port)

      const child = spawn(
        process.execPath,
        [...CLI_ARGS, "serve", "--http", "--auth-token", ALICE, "--daemon-url", daemonUrl],
        {
          env: { FACTORY_API_KEY: "env-key" },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 6_000,
          killSignal: "SIGKILL",
        },
      )

      const closed = once(child, "close")
      const lines = createInterface({ input: child.stdout, terminal: false })
      let stderr = ""

      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk
      })

      try {
        const line = await lines[Symbol.asyncIterator]().next()
        const prefix = "listening on "

        if (line.done || !line.value.startsWith(prefix)) {
          throw new Error("CLI did not announce its HTTP endpoint: " + stderr)
        }

        const endpoint = new URL(line.value.slice(prefix.length))
        const request = httpClient({ url: endpoint.origin, path: endpoint.pathname }, ALICE)

        toolValue(await call(request, "skill_read"))
        expect(
          toolValue(await call(request, "tool_call", { name: "daemon_list_opened_sessions" })),
        ).toEqual({ sessions: [] })
        expect(daemon.requests.map(({ method }) => method)).toEqual([
          "daemon.authenticate",
          "daemon.list_opened_sessions",
        ])
      } finally {
        lines.close()
        child.kill()
        await closed
        await daemon.close()
      }
    },
    8_000,
  )

  it("exits 2 on invalid FACTORY_CONTEXT_HEADERS without echoing its value", async () => {
    const secret = "cli-tenant-secret"

    interface CliFailure {
      readonly code?: number
      readonly stderr?: string
    }

    const failure = await cli([], {
      FACTORY_CONTEXT_HEADERS: JSON.stringify({ cookie: secret }),
    }).then(
      () => {
        throw new Error("CLI unexpectedly accepted invalid Context headers")
      },
      (error: CliFailure) => error,
    )

    expect(failure).toMatchObject({ code: 2 })
    expect(failure.stderr).toContain("FACTORY_CONTEXT_HEADERS")
    expect(failure.stderr).not.toContain(secret)
  })

  it("forwards CLI Context headers and bearer authentication through MCP", async () => {
    const api = await startFakeContextApi()
    const tenant = "toolCount"

    const server = await startCliHttp(["--no-daemon"], {
      FACTORY_API_KEY: "env-key",
      FACTORY_CONTEXT_BASE_URL: api.baseUrl,
      FACTORY_CONTEXT_HEADERS: JSON.stringify({ "X-Factory-Organization": tenant }),
    })

    try {
      const request = httpClient(
        { url: server.endpoint.origin, path: server.endpoint.pathname },
        ALICE,
      )

      expect(
        toolValue(await call(request, "tool_call", { name: "context_list_spaces", arguments: {} })),
      ).toEqual({ items: [] })
      expect(toolValue(await call(request, "server_info"))).toMatchObject({
        toolCount: expect.any(Number),
      })

      const recorded = api.requests.find(
        (recordedRequest) => recordedRequest.route === "GET /api/context/spaces",
      )

      expect(recorded?.headers.authorization).toBe("Bearer env-key")
      expect(recorded?.headers["x-factory-organization"]).toBe(tenant)
    } finally {
      await server.close()
      await api.close()
    }
  }, 8_000)

  it("passes the CLI Factory key to local sessions without widening the child environment", async () => {
    const expectedKey = "env-key"
    const daemon = await startCliDaemon(expectedKey)
    const keyedExecutable = join(sandbox, "keyed-droid.mjs")

    writeFileSync(
      keyedExecutable,
      [
        "#!" + process.execPath,
        "const expectedKey = " + JSON.stringify(expectedKey),
        "if (process.env.FACTORY_API_KEY !== expectedKey) {",
        '  console.error("the configured Factory API key did not reach the child")',
        "  process.exit(42)",
        "}",
        "if (",
        "  process.env.DROID_MCP_KEYS !== undefined ||",
        "  process.env.UNRELATED_SERVICE_SECRET !== undefined",
        ") {",
        '  console.error("the child environment was not restricted")',
        "  process.exit(43)",
        "}",
        "await import(" + JSON.stringify(pathToFileURL(FAKE_EXEC).href) + ")",
        "",
      ].join("\n"),
      { mode: 0o700 },
    )

    const child = spawn(
      process.execPath,
      [
        ...CLI_ARGS,
        "serve",
        "--http",
        "--daemon-url",
        "unix:" + daemon.socketPath,
        "--droid-path",
        keyedExecutable,
        "--workspace-root",
        sandbox,
      ],
      {
        env: {
          FACTORY_API_KEY: expectedKey,
          DROID_MCP_KEYS: ALICE,
          UNRELATED_SERVICE_SECRET: "unrelated-service-secret",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 6_000,
        killSignal: "SIGKILL",
      },
    )

    const closed = once(child, "close")
    const lines = createInterface({ input: child.stdout, terminal: false })
    let stderr = ""

    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })

    try {
      const line = await lines[Symbol.asyncIterator]().next()
      const prefix = "listening on "

      if (line.done || !line.value.startsWith(prefix)) {
        throw new Error("CLI did not announce its HTTP endpoint: " + stderr)
      }

      const endpoint = new URL(line.value.slice(prefix.length))
      const request = httpClient({ url: endpoint.origin, path: endpoint.pathname }, ALICE)

      toolValue(await call(request, "skill_read"))
      expect(
        toolValue(await call(request, "tool_call", { name: "daemon_list_opened_sessions" })),
      ).toEqual({ sessions: [] })
      expect(daemon.requests.map(({ method }) => method)).toEqual([
        "daemon.authenticate",
        "daemon.list_opened_sessions",
      ])

      const created = toolValue(
        await call(request, "session_create", { cwd: sandbox, autonomyLevel: "low" }),
      )

      const sessionId = text(record(created).sessionId)

      const turn = toolValue(
        await call(request, "session_stream", { sessionId, prompt: "env-echo", waitMs: 5_000 }),
      )

      expect(turn).toMatchObject({
        status: "completed",
        result: { structuredOutput: { echo: "[REDACTED]" } },
      })
      expect(JSON.stringify(turn)).not.toContain(expectedKey)

      const events = toolValue(
        await call(request, "session_events", { sessionId, cursor: 0, waitMs: 0 }),
      )

      expect(events).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: "turn_completed",
            summary: expect.objectContaining({
              structuredOutput: { echo: "[REDACTED]" },
            }),
          }),
        ]),
      })
      expect(JSON.stringify(events)).not.toContain(expectedKey)

      const streamed = toolValue(
        await call(request, "session_stream", { sessionId, prompt: "env-stream", waitMs: 5_000 }),
      )

      expect(streamed).toMatchObject({ status: "completed" })
      expect(JSON.stringify(streamed)).not.toContain(expectedKey)

      const streamEvents = toolValue(
        await call(request, "session_events", { sessionId, cursor: 0, waitMs: 0 }),
      )

      // The key arrives split across two deltas, so plain containment is
      // toothless: the security property is that reassembling every released
      // fragment in order never yields the key.
      const deltas = records(record(streamEvents).events)
        .filter((event) => event.kind === "delta")
        .map((event) => text(record(record(event).payload).textDelta))
        .join("")

      expect(deltas).not.toContain(expectedKey)
      expect(deltas).toContain("echo [REDACTED] done")
      expect(JSON.stringify(streamEvents)).not.toContain(expectedKey)

      const crashed = toolValue(
        await call(request, "session_stream", { sessionId, prompt: "env-crash", waitMs: 5_000 }),
      )

      expect(crashed).toMatchObject({
        status: "failed",
        failureReason: expect.stringContaining("[REDACTED]"),
      })
      expect(JSON.stringify(crashed)).not.toContain(expectedKey)

      const failureEvents = toolValue(
        await call(request, "session_events", { sessionId, cursor: 0, waitMs: 0 }),
      )

      expect(failureEvents).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: "turn_failed",
            message: expect.stringContaining("[REDACTED]"),
          }),
        ]),
      })
      expect(JSON.stringify(failureEvents)).not.toContain(expectedKey)
      expect(toolValue(await call(request, "session_close", { sessionId }))).toMatchObject({
        closed: true,
      })
    } finally {
      lines.close()
      child.kill()
      await closed
      await daemon.close()
    }
  }, 8_000)
})
