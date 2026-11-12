import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { Config } from "../../src/config.ts"
import { SessionSettingsSchema, TurnStatusSchema } from "../../src/droid/turns.ts"
import { DIRECT_TOOLS } from "../../src/tools/compact.ts"
import { testConfig } from "../support/config.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply } from "../support/fake-daemon.ts"
import { initialize, readBody, startServer } from "../support/mcp-http.ts"
import type { Json, TestServer } from "../support/mcp-http.ts"

/**
 * The compact profile against the full one, over the real `/mcp` layer:
 * what a client pays to connect, whether every operation still behaves the
 * same through `tool_call`, and what bounded results and `batch` save.
 */

const KEY = "compact-key"
const OTHER_KEY = "compact-other-key"
const PROTOCOL = "2025-11-25"
const FILE_COUNT = 5_000

const Listed = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        inputSchema: Schema.Json,
        annotations: Schema.optional(
          Schema.Struct({
            readOnlyHint: Schema.optional(Schema.Boolean),
            destructiveHint: Schema.optional(Schema.Boolean),
            idempotentHint: Schema.optional(Schema.Boolean),
            openWorldHint: Schema.optional(Schema.Boolean),
          }),
        ),
      }),
    ),
  }),
})

const Called = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.optional(Schema.Json),
      content: Schema.optional(
        Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})

const Failure = Schema.Struct({ code: Schema.String, message: Schema.String })

interface Client {
  readonly list: () => Promise<{ readonly bytes: number; readonly body: typeof Listed.Type }>
  readonly call: (
    name: string,
    args: Json,
  ) => Promise<{ readonly bytes: number; readonly body: typeof Called.Type }>
}

const open = async (server: TestServer, key: string): Promise<Client> => {
  const authorization = "Bearer " + key
  const { sessionId } = await initialize(server, PROTOCOL, { authorization })

  const headers = {
    authorization,
    "mcp-session-id": sessionId ?? "",
    "mcp-protocol-version": PROTOCOL,
  }

  let id = 1

  const rpc = async (method: string, params: Json) => {
    id += 1

    const body = await readBody(await server.post({ jsonrpc: "2.0", id, method, params }, headers))

    return { bytes: Buffer.byteLength(JSON.stringify(body), "utf8"), body }
  }

  return {
    list: async () => {
      const { bytes, body } = await rpc("tools/list", {})

      return { bytes, body: Schema.decodeUnknownSync(Listed)(body) }
    },
    call: async (name, args) => {
      const { bytes, body } = await rpc("tools/call", { name, arguments: args })

      return { bytes, body: Schema.decodeUnknownSync(Called)(body) }
    },
  }
}

const structured = (body: typeof Called.Type): Json | undefined => {
  if (body.result?.isError === true || body.error !== undefined) {
    throw new Error("call failed: " + JSON.stringify(body))
  }

  return body.result?.structuredContent
}

const failureOf = (body: typeof Called.Type) =>
  Schema.decodeUnknownSync(Failure)(JSON.parse(body.result?.content?.[0]?.text ?? "{}"))

/** The plain-text failure the MCP layer returns when arguments fail a tool's schema. */
const isSchemaRejection = (body: typeof Called.Type): boolean =>
  (body.result?.content?.[0]?.text ?? "").startsWith("Invalid parameters for tool")

const AddressSchema = Schema.Struct({ port: Schema.Number })

const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()

    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      Option.match(Schema.decodeUnknownOption(AddressSchema)(probe.address()), {
        onNone: () => reject(new Error("no port")),
        onSome: ({ port }) => probe.close(() => resolve(port)),
      })
    })
  })

const files = Array.from(
  { length: FILE_COUNT },
  (_, index) => "src/module-" + String(index) + "/é中😀.ts",
)

let directory: string
let daemon: FakeDaemon

const servers: Array<TestServer> = []

const serve = async (overrides: Partial<Config>): Promise<TestServer> => {
  const server = await startServer({
    config: testConfig({
      socketPath: daemon.socketPath,
      runtimeDir: directory,
      factoryApiKey: "test-key",
      ...overrides,
    }),
    keys: [KEY, OTHER_KEY],
  })

  servers.push(server)

  return server
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "droid-mcp-compact-"))
  const fake = fileURLToPath(new URL("../support/fake-droid-exec.mjs", import.meta.url))
  writeFileSync(join(directory, "droid"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, {
    mode: 0o755,
  })
  daemon = await startFakeDaemon(join(directory, "daemon.sock"), {
    onRequest: (request): ScriptedReply => {
      if (request.method === "daemon.authenticate") {
        return { result: { userId: "user-1", orgId: "org-1" } }
      }

      if (request.method === "daemon.list_files") {
        return { result: { files, totalFiles: files.length, truncated: false } }
      }

      if (request.method === "daemon.list_models") {
        return { result: { models: [{ id: "gpt-6.1-sol" }, { id: "claude-opus-5-5" }] } }
      }

      return { result: { ok: true, echo: request.params ?? null } }
    },
  })
})

afterAll(async () => {
  for (const server of servers) await server.dispose()
  await daemon.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("compact profile", () => {
  it.each([
    ["droid_list_skills", "session_list_skills or daemon_list_skills"],
    ["droid_list_tools", "session_list_tools"],
    ["droid_list_mcp_tools", "session_list_mcp_tools or daemon_list_mcp_tools"],
    ["droid_list_mcp_registry", "daemon_list_mcp_registry"],
  ])(
    "does not advertise %s and names its replacements across dispatch tools",
    async (name, replacements) => {
      const compact = await open(await serve({ toolProfile: "compact" }), KEY)
      const before = daemon.requests.length

      const failure = {
        code: "unknown_tool",
        message: name + " is not served by the daemon; use " + replacements,
      }

      expect(
        structured((await compact.call("tools_search", { query: name, limit: 50 })).body),
      ).toEqual({ total: 0, tools: [] })
      expect(failureOf((await compact.call("tool_call", { name })).body)).toEqual(failure)
      expect(failureOf((await compact.call("tools_describe", { names: [name] })).body)).toEqual(
        failure,
      )
      expect(structured((await compact.call("batch", { steps: [{ name }] })).body)).toMatchObject({
        completed: 0,
        failed: 1,
        steps: [{ status: "failed", error: failure }],
      })
      expect(
        structured(
          (await compact.call("tools_describe", { names: replacements.split(" or ") })).body,
        ),
      ).toMatchObject({
        tools: replacements.split(" or ").map((replacement) => ({
          name: replacement,
          policy: { readOnly: true, destructive: false },
        })),
        unknown: [],
      })
      expect(daemon.requests).toHaveLength(before)
    },
  )

  it("advertises 15 tools at under a tenth of the full list's bytes", async () => {
    const compact = await (await open(await serve({ toolProfile: "compact" }), KEY)).list()
    const full = await (await open(await serve({ toolProfile: "full" }), KEY)).list()
    const names = compact.body.result.tools.map((tool) => tool.name)

    expect(names).toEqual([
      ...DIRECT_TOOLS,
      "tools_search",
      "tools_describe",
      "tool_call",
      "batch",
      "result_read",
    ])
    expect(full.body.result.tools).toHaveLength(284)
    expect(compact.bytes).toBeLessThan(24 * 1024)
    expect(compact.bytes).toBeLessThan(full.bytes / 10)

    console.info(
      "tools/list bytes: compact " + String(compact.bytes) + ", full " + String(full.bytes),
    )
  })

  it("annotates every tool, with reads read-only and finite numbers only", async () => {
    for (const profile of ["compact", "full"] as const) {
      const listed = await (await open(await serve({ toolProfile: profile }), KEY)).list()

      expect(JSON.stringify(listed.body)).not.toContain('"NaN"')

      for (const tool of listed.body.result.tools) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf("boolean")
        expect(tool.annotations?.destructiveHint, tool.name).toBeTypeOf("boolean")
      }
    }

    const full = await (await open(await serve({ toolProfile: "full" }), KEY)).list()
    const hints = new Map(full.body.result.tools.map((tool) => [tool.name, tool.annotations]))

    for (const name of [
      "daemon_list_models",
      "rest_list_computers",
      "session_events",
      "server_info",
    ]) {
      expect(hints.get(name), name).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    }

    for (const name of [
      "daemon_git_push",
      "rest_delete_computer",
      "daemon_execute_rewind",
      "daemon_apply_user_preferences",
      "session_close",
      "session_remove_mcp_server",
    ]) {
      expect(hints.get(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    }

    expect(hints.get("daemon_create_pr")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    })

    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    const direct = (await compact.list()).body.result.tools.find(
      (tool) => tool.name === "session_close",
    )

    expect(direct?.annotations?.destructiveHint).toBe(true)

    for (const name of [
      "session_close",
      "session_remove_mcp_server",
      "daemon_apply_user_preferences",
    ]) {
      expect(structured((await compact.call("tools_search", { query: name })).body)).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name, readOnly: false, destructive: true }),
        ]),
      })
      expect(
        structured((await compact.call("tools_describe", { names: [name] })).body),
      ).toMatchObject({
        tools: [{ name, policy: { readOnly: false, destructive: true } }],
      })
    }
  })

  it("finds every operation once through tools_search and describes it as the full profile lists it", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    const full = (await (await open(await serve({ toolProfile: "full" }), KEY)).list()).body.result
      .tools

    const names: Array<string> = []
    let offset: number | undefined = 0

    while (offset !== undefined) {
      const page = Schema.decodeUnknownSync(
        Schema.Struct({
          nextOffset: Schema.optional(Schema.Number),
          tools: Schema.Array(Schema.Struct({ name: Schema.String })),
        }),
      )(structured((await compact.call("tools_search", { limit: 50, offset })).body))

      names.push(...page.tools.map((tool) => tool.name))
      offset = page.nextOffset
    }

    expect(names).toEqual(full.map((tool) => tool.name))

    for (let start = 0; start < full.length; start += 20) {
      const chunk = full.slice(start, start + 20)

      const described = Schema.decodeUnknownSync(
        Schema.Struct({
          tools: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              description: Schema.String,
              inputSchema: Schema.Json,
            }),
          ),
        }),
      )(
        structured(
          (await compact.call("tools_describe", { names: chunk.map((tool) => tool.name) })).body,
        ),
      )

      expect(described.tools).toEqual(
        chunk.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      )
    }

    const hits = Schema.decodeUnknownSync(
      Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    )(structured((await compact.call("tools_search", { query: "git push" })).body))

    expect(hits.tools[0]?.name).toBe("daemon_git_push")
  })

  it("runs every operation through tool_call with the outcome its own tool has", async () => {
    const port = await closedPort()
    const offline = { daemonUrl: "http://127.0.0.1:" + String(port), factoryApiKey: undefined }
    const compact = await open(await serve({ toolProfile: "compact", ...offline }), KEY)
    const full = await open(await serve({ toolProfile: "full", ...offline }), KEY)
    const names = (await full.list()).body.result.tools.map((tool) => tool.name)
    const kinds = new Map<string, number>()

    const outcomeOf = (body: typeof Called.Type, dispatched: boolean) => {
      if (body.error !== undefined) return { kind: "invalid" }

      if (body.result?.isError === true) {
        if (isSchemaRejection(body)) return { kind: "invalid" }

        const failure = failureOf(body)

        if (dispatched && failure.code === "invalid_arguments") return { kind: "invalid" }

        return { kind: "failure", code: failure.code }
      }

      const value = body.result?.structuredContent

      const result = dispatched
        ? Schema.decodeUnknownSync(Schema.Struct({ result: Schema.optional(Schema.Json) }))(value)
            .result
        : value

      return { kind: "ok", result }
    }

    for (const name of names) {
      const direct = outcomeOf((await full.call(name, {})).body, false)

      const viaCall = outcomeOf(
        (await compact.call("tool_call", { name, arguments: {} })).body,
        true,
      )

      if (name === "server_info") {
        expect(viaCall).toMatchObject({ kind: "ok", result: { profile: "compact", toolCount: 15 } })
        expect(direct).toMatchObject({ kind: "ok", result: { profile: "full", toolCount: 284 } })
      } else {
        expect(viaCall, name).toEqual(direct)
      }

      kinds.set(direct.kind, (kinds.get(direct.kind) ?? 0) + 1)
    }

    expect(names).toHaveLength(284)
    console.info(
      "parity outcomes across 284 operations: " + JSON.stringify(Object.fromEntries(kinds)),
    )
  })

  it("rejects a misspelled operation argument under compact", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)
    const full = await open(await serve({ toolProfile: "full" }), KEY)

    const before = daemon.requests.filter(
      (request) => request.method === "daemon.list_files",
    ).length

    const args = { sessionIdX: "s-1" }

    const dispatched = await compact.call("tool_call", {
      name: "daemon_list_files",
      arguments: args,
    })

    const direct = await full.call("daemon_list_files", args)

    expect(failureOf(dispatched.body).code).toBe("invalid_params")
    expect(direct.body.result?.isError).toBe(true)
    expect(failureOf(dispatched.body)).toEqual(failureOf(direct.body))
    expect(
      daemon.requests.filter((request) => request.method === "daemon.list_files"),
    ).toHaveLength(before)

    // Full-profile operations ignore extra properties when required arguments are present.
    const valid = { sessionId: "s-1", sessionIdX: "ignored" }

    const viaCall = structured(
      (
        await compact.call("tool_call", {
          name: "daemon_list_files",
          arguments: valid,
          select: "/totalFiles",
        })
      ).body,
    )

    const own = Schema.decodeUnknownSync(Schema.Struct({ totalFiles: Schema.Number }))(
      structured((await full.call("daemon_list_files", valid)).body),
    )

    expect(viaCall).toEqual({ result: own.totalFiles })
    expect(daemon.requests.at(-1)?.params).toEqual({ sessionId: "s-1" })
  })

  it("retains a completed operation after an invalid select without repeating it", async () => {
    const server = await serve({ toolProfile: "compact", droidPath: join(directory, "droid") })
    const compact = await open(server, KEY)

    const invalid = await compact.call("tool_call", {
      name: "session_create",
      arguments: { cwd: directory, autonomyLevel: "low" },
      select: "/missing",
    })

    const failure = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.Literal("invalid_select"),
        message: Schema.String,
        ref: Schema.String,
      }),
    )(JSON.parse(invalid.body.result?.content?.[0]?.text ?? "{}"))

    expect(invalid.body.result?.isError).toBe(true)

    const restored = Schema.decodeUnknownSync(
      Schema.Struct({
        selected: Schema.Struct({
          result: Schema.Struct({ sessionId: Schema.String, cwd: Schema.String }),
        }),
      }),
    )(structured((await compact.call("result_read", { ref: failure.ref, select: "" })).body))

    expect(restored.selected.result.cwd).toBe(directory)
    expect(structured((await compact.call("session_list", {})).body)).toMatchObject({
      sessions: [{ sessionId: restored.selected.result.sessionId, cwd: directory }],
    })
    const other = await open(server, OTHER_KEY)
    expect(failureOf((await other.call("result_read", { ref: failure.ref })).body).code).toBe(
      "result_not_found",
    )
    expect(
      structured(
        (await compact.call("session_close", { sessionId: restored.selected.result.sessionId }))
          .body,
      ),
    ).toEqual({ closed: true })
    expect(structured((await compact.call("session_list", {})).body)).toEqual({ sessions: [] })
  })

  it("retains batch results after invalid selects with either stopOnError setting", async () => {
    const compact = await open(
      await serve({ toolProfile: "compact", droidPath: join(directory, "droid") }),
      KEY,
    )

    for (const stopOnError of [true, false]) {
      const batch = await compact.call("batch", {
        stopOnError,
        steps: [
          {
            id: "created",
            name: "session_create",
            arguments: { cwd: directory, autonomyLevel: "low" },
            select: "/missing",
          },
          {
            name: "session_close",
            arguments: { sessionId: { $from: "created", path: "/sessionId" } },
          },
        ],
      })

      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          completed: Schema.Number,
          failed: Schema.Number,
          skipped: Schema.Number,
          steps: Schema.Array(
            Schema.Struct({
              status: Schema.String,
              error: Schema.optional(Schema.Struct({ code: Schema.String, ref: Schema.String })),
            }),
          ),
        }),
      )(structured(batch.body))

      expect(result).toMatchObject({
        completed: stopOnError ? 0 : 1,
        failed: 1,
        skipped: stopOnError ? 1 : 0,
        steps: [
          { status: "failed", error: { code: "invalid_select" } },
          { status: stopOnError ? "skipped" : "ok" },
        ],
      })

      const ref = result.steps[0]?.error?.ref ?? ""

      const restored = Schema.decodeUnknownSync(
        Schema.Struct({
          selected: Schema.Struct({ result: Schema.Struct({ sessionId: Schema.String }) }),
        }),
      )(structured((await compact.call("result_read", { ref, select: "" })).body))

      if (stopOnError) {
        expect(
          structured(
            (await compact.call("session_close", { sessionId: restored.selected.result.sessionId }))
              .body,
          ),
        ).toEqual({ closed: true })
      }

      expect(structured((await compact.call("session_list", {})).body)).toEqual({ sessions: [] })
    }
  })

  it("bounds a large result and loses nothing of it", async () => {
    const full = await open(await serve({ toolProfile: "full" }), KEY)
    const compactServer = await serve({ toolProfile: "compact" })
    const compact = await open(compactServer, KEY)
    const args = { sessionId: "s-1" }

    const direct = await full.call("daemon_list_files", args)
    const bounded = await compact.call("tool_call", { name: "daemon_list_files", arguments: args })

    const selected = await compact.call("tool_call", {
      name: "daemon_list_files",
      arguments: args,
      select: "/totalFiles",
    })

    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({
        truncated: Schema.Literal(true),
        ref: Schema.String,
        totalBytes: Schema.Number,
        preview: Schema.String,
      }),
    )(structured(bounded.body))

    expect(structured(selected.body)).toEqual({ result: FILE_COUNT })
    expect(Buffer.byteLength(JSON.stringify(structured(bounded.body)))).toBeLessThanOrEqual(16_384)

    let text = ""
    let offset: number | undefined = 0
    let reads = 0

    while (offset !== undefined) {
      const page = Schema.decodeUnknownSync(
        Schema.Struct({ chunk: Schema.String, nextOffset: Schema.optional(Schema.Number) }),
      )(structured((await compact.call("result_read", { ref: envelope.ref, offset })).body))

      text += page.chunk
      offset = page.nextOffset
      reads += 1
    }

    expect(JSON.parse(text)).toEqual(structured(direct.body))
    expect(Buffer.byteLength(text)).toBe(envelope.totalBytes)

    const part = await compact.call("result_read", { ref: envelope.ref, select: "/files/4999" })

    expect(structured(part.body)).toMatchObject({ selected: { result: files[4999] } })

    const other = await open(compactServer, OTHER_KEY)
    const stolen = await other.call("result_read", { ref: envelope.ref })

    expect(failureOf(stolen.body).code).toBe("result_not_found")
    expect(bounded.bytes).toBeLessThan(direct.bytes / 10)

    console.info(
      "daemon_list_files response bytes: full " +
        String(direct.bytes) +
        ", tool_call " +
        String(bounded.bytes) +
        ", tool_call with select " +
        String(selected.bytes) +
        "; reassembled from " +
        String(reads) +
        " result_read pages",
    )
  })

  it("rejects byte offsets inside a character and pages from exact boundaries", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)
    const full = await open(await serve({ toolProfile: "full" }), KEY)
    const args = { sessionId: "s-1" }
    const text = JSON.stringify(structured((await full.call("daemon_list_files", args)).body))
    const bytes = Buffer.from(text)

    const envelope = Schema.decodeUnknownSync(Schema.Struct({ ref: Schema.String }))(
      structured(
        (await compact.call("tool_call", { name: "daemon_list_files", arguments: args })).body,
      ),
    )

    for (const character of ["é", "中", "😀"]) {
      const offset = bytes.indexOf(Buffer.from(character))
      expect(offset).toBeGreaterThan(0)

      for (let continuation = 1; continuation < Buffer.byteLength(character); continuation += 1) {
        const invalid = await compact.call("result_read", {
          ref: envelope.ref,
          offset: offset + continuation,
          length: 1024,
        })

        expect(failureOf(invalid.body).code).toBe("invalid_offset")
      }

      const page = Schema.decodeUnknownSync(
        Schema.Struct({ offset: Schema.Number, chunk: Schema.String, nextOffset: Schema.Number }),
      )(
        structured(
          (await compact.call("result_read", { ref: envelope.ref, offset, length: 1024 })).body,
        ),
      )

      expect(page.offset).toBe(offset)
      expect(page.chunk.startsWith(character)).toBe(true)
      expect(page.chunk).not.toContain("\ufffd")
      expect(page.offset + Buffer.byteLength(page.chunk)).toBe(page.nextOffset)
      expect(Buffer.from(page.chunk)).toEqual(bytes.subarray(offset, page.nextOffset))
      expect(Buffer.byteLength(page.chunk)).toBeLessThanOrEqual(1024)
    }

    expect(
      structured(
        (await compact.call("result_read", { ref: envelope.ref, offset: bytes.length })).body,
      ),
    ).toMatchObject({
      offset: bytes.length,
      chunk: "",
    })
    expect(
      structured(
        (await compact.call("result_read", { ref: envelope.ref, offset: bytes.length + 10 })).body,
      ),
    ).toMatchObject({
      offset: bytes.length + 10,
      chunk: "",
    })
  })

  it("chains dependent operations in one batch call", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)
    const full = await open(await serve({ toolProfile: "full" }), KEY)
    const before = daemon.requests.length

    let directBytes = 0

    for (const [name, args] of [
      ["daemon_list_models", {}],
      ["daemon_list_files", { sessionId: "s-1" }],
      ["daemon_search_files", { sessionId: "s-1", query: files[0] ?? "" }],
    ] as const) {
      directBytes += (await full.call(name, args)).bytes
    }

    const batch = await compact.call("batch", {
      steps: [
        { id: "models", name: "daemon_list_models", select: "/models/0/id" },
        {
          id: "files",
          name: "daemon_list_files",
          arguments: { sessionId: "s-1" },
          select: "/totalFiles",
        },
        {
          id: "search",
          name: "daemon_search_files",
          arguments: { sessionId: "s-1", query: { $from: "files", path: "/files/0" } },
        },
      ],
    })

    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        completed: Schema.Number,
        steps: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            status: Schema.String,
            result: Schema.optional(Schema.Json),
          }),
        ),
      }),
    )(structured(batch.body))

    expect(result.completed).toBe(3)
    expect(result.steps.map((step) => step.result)).toEqual([
      "gpt-6.1-sol",
      FILE_COUNT,
      { ok: true, echo: { sessionId: "s-1", query: files[0] } },
    ])

    const searched = daemon.requests
      .slice(before)
      .filter((request) => request.method === "daemon.search_files")

    expect(searched.at(-1)?.params).toEqual({ sessionId: "s-1", query: files[0] })
    expect(batch.bytes).toBeLessThan(directBytes / 10)

    console.info(
      "3 dependent operations: 3 calls and " +
        String(directBytes) +
        " bytes direct, 1 batch call and " +
        String(batch.bytes) +
        " bytes",
    )
  })

  it("stops a batch at the first failure and reports the rest as skipped", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    const batch = await compact.call("batch", {
      steps: [
        { name: "daemon_list_models" },
        {
          name: "daemon_update_session_settings",
          arguments: { sessionId: "s-1", autonomyLevel: "high" },
        },
        { name: "daemon_list_models" },
      ],
    })

    expect(structured(batch.body)).toMatchObject({
      completed: 1,
      failed: 1,
      skipped: 1,
      steps: [
        { id: "0", status: "ok" },
        { id: "1", status: "failed", error: { code: "autonomy_exceeds_cap" } },
        { id: "2", status: "skipped" },
      ],
    })
  })

  it("rejects unknown operations, bad references, and unknown arguments to its own tools", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    const unknown = await compact.call("tool_call", { name: "daemon_no_such_method" })

    expect(failureOf(unknown.body).code).toBe("unknown_tool")

    const reference = await compact.call("batch", {
      steps: [{ name: "daemon_list_files", arguments: { sessionId: { $from: "missing" } } }],
    })

    expect(structured(reference.body)).toMatchObject({
      steps: [{ status: "failed", error: { code: "invalid_reference" } }],
    })

    const typo = await compact.call("tool_call", { nme: "daemon_list_models" })

    expect(typo.body.result?.isError).toBe(true)
    expect(typo.body.result?.content?.[0]?.text).toContain(
      'Expected no excess property\n  at ["nme"]',
    )
  })

  it("rejects null for optional dispatch inputs", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    const calls = [
      ["tools_search", { readOnly: null }],
      ["tool_call", { name: "daemon_list_models", arguments: null }],
      ["tool_call", { name: "daemon_list_models", maxBytes: null }],
      ["batch", { steps: [{ name: "daemon_list_models", id: null }] }],
      ["batch", { steps: [{ name: "daemon_list_models" }], stopOnError: null }],
      ["result_read", { ref: "missing", select: null }],
    ] as const

    for (const [name, args] of calls) {
      const { body } = await compact.call(name, args)

      expect(body.result?.isError, name).toBe(true)
      expect(isSchemaRejection(body), name).toBe(true)
    }
  })

  it("continues past a failed step when stopOnError is false", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    const batch = await compact.call("batch", {
      stopOnError: false,
      steps: [
        { name: "daemon_list_models" },
        {
          name: "daemon_update_session_settings",
          arguments: { sessionId: "s-1", autonomyLevel: "high" },
        },
        { name: "daemon_list_models" },
      ],
    })

    expect(structured(batch.body)).toMatchObject({
      completed: 2,
      failed: 1,
      skipped: 0,
      steps: [
        { status: "ok" },
        { status: "failed", error: { code: "autonomy_exceeds_cap" } },
        { status: "ok", result: { models: [{ id: "gpt-6.1-sol" }, { id: "claude-opus-5-5" }] } },
      ],
    })
  })

  it("rejects references to failed steps while continuing the batch", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    const batch = await compact.call("batch", {
      stopOnError: false,
      steps: [
        {
          id: "failed",
          name: "daemon_update_session_settings",
          arguments: { sessionId: "s-1", autonomyLevel: "high" },
        },
        {
          name: "daemon_list_files",
          arguments: { sessionId: { $from: "failed", path: "/sessionId" } },
        },
        { name: "daemon_list_models" },
      ],
    })

    expect(structured(batch.body)).toMatchObject({
      completed: 1,
      failed: 2,
      skipped: 0,
      steps: [
        { status: "failed", error: { code: "autonomy_exceeds_cap" } },
        { status: "failed", error: { code: "invalid_reference" } },
        { status: "ok", result: { models: [{ id: "gpt-6.1-sol" }, { id: "claude-opus-5-5" }] } },
      ],
    })
  })

  it("lists a live session with its status, cursor, and settings", async () => {
    for (const toolProfile of ["compact", "full"] as const) {
      const client = await open(
        await serve({ toolProfile, droidPath: join(directory, "droid") }),
        KEY,
      )

      const created = Schema.decodeUnknownSync(
        Schema.Struct({
          sessionId: Schema.String,
          cwd: Schema.String,
          settings: SessionSettingsSchema,
        }),
      )(
        structured(
          (await client.call("session_create", { cwd: directory, autonomyLevel: "low" })).body,
        ),
      )

      const listed = Schema.decodeUnknownSync(
        Schema.Struct({
          sessions: Schema.Array(
            Schema.Struct({
              sessionId: Schema.String,
              cwd: Schema.String,
              status: TurnStatusSchema,
              cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
              settings: SessionSettingsSchema,
            }),
          ),
        }),
      )(structured((await client.call("session_list", {})).body))

      expect(listed.sessions).toHaveLength(1)
      expect(listed.sessions[0]).toMatchObject(created)
      expect(listed.sessions[0]?.settings).toMatchObject({ autonomyLevel: "low" })
      expect(
        structured((await client.call("session_close", { sessionId: created.sessionId })).body),
      ).toEqual({ closed: true })
      expect(structured((await client.call("session_list", {})).body)).toEqual({ sessions: [] })
    }
  })

  it("lists live local sessions", async () => {
    const compact = await open(await serve({ toolProfile: "compact" }), KEY)

    expect(structured((await compact.call("session_list", {})).body)).toEqual({ sessions: [] })
  })
})
