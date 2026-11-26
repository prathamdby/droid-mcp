import { execFile } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Structural Proof 3: run `products/embedded` headless.
//
// In a fresh child Node process, register `node:module` `registerHooks`
// (`resolve` and `load`) BEFORE the very first import of
// `src/products/index.ts`. Admit a trusted local caller via `embedded()`,
// create a local session against `fake-droid-exec.mjs`, run a turn ("hello")
// to terminal `"completed"`, read its assistant text result and events, close
// the session and shut down the runtime.
//
// Assert that:
//   - the hook genuinely captured real module resolutions/loads (non-vacuous)
//   - neither `effect/ai/McpServer`, `effect/ai/*`, `effect/http*`, `node:http`,
//     `node:https`, `node:http2`, `node:_http_*`, `src/mcp/*`,
//     `src/products/private/http.ts`, nor `src/products/private/stdio.ts`
//     ever resolved or loaded, even transitively
//   - a positive-control child process using the same hook genuinely catches
//     `node:http` when imported.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "../..")
const PRODUCTS_INDEX_URL = pathToFileURL(join(REPO_ROOT, "src/products/index.ts")).href
const FAKE_EXEC = join(REPO_ROOT, "test/support/fake-droid-exec.mjs")

const execFileAsync = promisify(execFile)

// Shared forbidden-module classifier embedded verbatim into both the main
// child harness and the positive-control child harness so both use identical
// detection logic.
const HOOK_AND_CLASSIFIER_SOURCE = `import { registerHooks } from "node:module"

const resolved = []
const loadedUrls = []

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)

    resolved.push({
      specifier,
      url: result.url,
      parentURL: context.parentURL ?? null,
    })

    return result
  },
  load(url, context, nextLoad) {
    loadedUrls.push(url)

    return nextLoad(url, context)
  },
})

const FORBIDDEN_EXACT_SPECIFIERS = new Set([
  "node:http",
  "http",
  "node:https",
  "https",
  "node:http2",
  "http2",
  "effect/ai",
  "effect/ai/McpServer",
  "effect/http",
])

const classifyForbidden = (specifier, url) => {
  if (typeof specifier === "string") {
    if (FORBIDDEN_EXACT_SPECIFIERS.has(specifier)) return "specifier:" + specifier
    if (specifier.startsWith("node:_http_") || specifier.startsWith("_http_")) {
      return "specifier:" + specifier
    }
    if (specifier.startsWith("effect/ai/")) return "specifier:" + specifier
    if (specifier.startsWith("effect/http/") || specifier.startsWith("effect/unstable/http")) {
      return "specifier:" + specifier
    }
  }

  if (typeof url === "string") {
    if (
      url === "node:http" ||
      url === "node:https" ||
      url === "node:http2" ||
      url.startsWith("node:_http_")
    ) {
      return "url:" + url
    }
    if (url.includes("/src/mcp/")) return "url:src/mcp"
    if (url.endsWith("/src/products/private/http.ts")) return "url:products/private/http.ts"
    if (url.endsWith("/src/products/private/stdio.ts")) return "url:products/private/stdio.ts"
    if (/\\/effect\\/(?:dist\\/)?(?:unstable\\/)?ai(?:\\/|$)/.test(url)) return "url:effect/ai"
    if (url.includes("McpServer")) return "url:McpServer"
    if (
      /\\/effect\\/(?:dist\\/)?(?:unstable\\/)?http\\/(?:HttpServer|HttpRouter|HttpClient|HttpLayerRouter|HttpPlatform|HttpMiddleware|HttpIncomingMessage|HttpServerRequest|HttpServerResponse)/.test(
        url,
      )
    ) {
      return "url:effect/http"
    }
    if (/NodeHttp(?:Server|Client)/.test(url)) return "url:platform-node-http"
  }

  return null
}

const findForbiddenHits = () => {
  const hits = []

  for (const entry of resolved) {
    const reason = classifyForbidden(entry.specifier, entry.url)

    if (reason !== null) {
      hits.push({
        source: "resolve",
        specifier: entry.specifier,
        url: entry.url,
        parentURL: entry.parentURL,
        reason,
      })
    }
  }

  for (const url of loadedUrls) {
    const reason = classifyForbidden(null, url)

    if (reason !== null) {
      hits.push({
        source: "load",
        specifier: null,
        url,
        parentURL: null,
        reason,
      })
    }
  }

  return hits
}
`

const EMBEDDED_HARNESS =
  HOOK_AND_CLASSIFIER_SOURCE +
  `
const [productsIndexUrl, sandbox, fakeExec] = process.argv.slice(2)

const checks = []

const record = (name, pass, detail) => {
  checks.push({ name, pass, detail: detail ?? null })
}

const session = {
  createOk: false,
  streamOk: false,
  status: null,
  lastText: null,
  eventKinds: [],
  eventsReadOk: false,
  eventsReadCount: 0,
  closeOk: false,
  closed: null,
  postCloseCode: null,
}

let operations = []
let runtime = null

try {
  const productsModule = await import(productsIndexUrl)

  runtime = await productsModule.embedded({
    principal: "proof3-operator",
    workspaceRoots: [sandbox],
    droidPath: process.execPath,
    droidArgs: [fakeExec],
  })

  operations = [...runtime.operations()]

  record(
    "operations-include-session-lifecycle",
    operations.includes("session_create") &&
      operations.includes("session_stream") &&
      operations.includes("session_events") &&
      operations.includes("session_close"),
    JSON.stringify(operations.slice(0, 10)),
  )

  const created = await runtime.invoke("session_create", {
    cwd: sandbox,
    autonomyLevel: "low",
  })

  session.createOk = created.ok

  const sessionId =
    created.ok &&
    created.value !== null &&
    typeof created.value === "object" &&
    !Array.isArray(created.value) &&
    typeof created.value.sessionId === "string"
      ? created.value.sessionId
      : null

  record("session-created", created.ok && sessionId !== null, JSON.stringify(created))

  if (sessionId !== null) {
    const streamed = await runtime.invoke("session_stream", {
      sessionId,
      prompt: "hello",
      waitMs: 5_000,
    })

    session.streamOk = streamed.ok

    if (
      streamed.ok &&
      streamed.value !== null &&
      typeof streamed.value === "object" &&
      !Array.isArray(streamed.value)
    ) {
      session.status = typeof streamed.value.status === "string" ? streamed.value.status : null
      session.lastText =
        typeof streamed.value.lastText === "string" ? streamed.value.lastText : null
      session.eventKinds = Array.isArray(streamed.value.events)
        ? streamed.value.events
            .map((event) =>
              event !== null && typeof event === "object" && !Array.isArray(event)
                ? event.kind
                : null,
            )
            .filter((kind) => typeof kind === "string")
        : []
    }

    record(
      "turn-reached-terminal-completed",
      session.streamOk &&
        session.status === "completed" &&
        session.lastText === "hi" &&
        session.eventKinds.includes("turn_completed"),
      JSON.stringify({
        streamOk: session.streamOk,
        status: session.status,
        lastText: session.lastText,
        eventKinds: session.eventKinds,
      }),
    )

    const observed = await runtime.invoke("session_events", {
      sessionId,
      cursor: 0,
      waitMs: 0,
    })

    session.eventsReadOk = observed.ok

    if (
      observed.ok &&
      observed.value !== null &&
      typeof observed.value === "object" &&
      !Array.isArray(observed.value) &&
      Array.isArray(observed.value.events)
    ) {
      session.eventsReadCount = observed.value.events.length
    }

    record(
      "session-events-readable",
      session.eventsReadOk && session.eventsReadCount > 0,
      JSON.stringify({ ok: session.eventsReadOk, count: session.eventsReadCount }),
    )

    const closed = await runtime.invoke("session_close", { sessionId })

    session.closeOk = closed.ok
    session.closed =
      closed.ok &&
      closed.value !== null &&
      typeof closed.value === "object" &&
      !Array.isArray(closed.value) &&
      typeof closed.value.closed === "boolean"
        ? closed.value.closed
        : null

    record("session-closed", session.closeOk && session.closed === true, JSON.stringify(closed))
  }
} catch (error) {
  record("harness-error", false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  if (runtime !== null) {
    await runtime.close()
    await runtime.close()

    const afterClose = await runtime.invoke("session_list", {})

    session.postCloseCode = afterClose.ok ? null : afterClose.code

    record(
      "runtime-closed-and-rejects-further-calls",
      !afterClose.ok && afterClose.code === "closed",
      JSON.stringify(afterClose),
    )
  }
}

const uniqueResolvedUrls = [...new Set(resolved.map((entry) => entry.url))]
const uniqueLoadedUrls = [...new Set(loadedUrls)]
const forbiddenHits = findForbiddenHits()

record(
  "hook-captured-real-modules",
  uniqueLoadedUrls.length > 10 &&
    uniqueLoadedUrls.some((url) => url.endsWith("/src/products/index.ts")) &&
    uniqueLoadedUrls.some((url) => url.endsWith("/src/products/private/embedded.ts")) &&
    uniqueLoadedUrls.some((url) => url.endsWith("/src/sessions/index.ts")) &&
    uniqueLoadedUrls.some((url) => url.endsWith("/src/turns/index.ts")) &&
    uniqueLoadedUrls.some((url) => url.endsWith("/src/local-exec/index.ts")),
  JSON.stringify({
    loadedCount: uniqueLoadedUrls.length,
    resolvedCount: uniqueResolvedUrls.length,
  }),
)

record(
  "zero-forbidden-module-loads",
  forbiddenHits.length === 0,
  JSON.stringify(forbiddenHits.slice(0, 10)),
)

const report = {
  checks,
  operationsCount: operations.length,
  session,
  resolvedCount: uniqueResolvedUrls.length,
  loadedCount: uniqueLoadedUrls.length,
  uniqueLoadedUrls,
  forbiddenHits,
}

console.log("PROOF3_RESULT " + JSON.stringify(report))
`

const POSITIVE_CONTROL_HARNESS =
  HOOK_AND_CLASSIFIER_SOURCE +
  `
await import("node:http")

const report = {
  resolvedHttp: resolved.some((entry) => entry.specifier === "node:http" || entry.url === "node:http"),
  loadedHttp: loadedUrls.includes("node:http"),
  forbiddenHits: findForbiddenHits(),
}

console.log("PROOF3_CONTROL " + JSON.stringify(report))
`

interface ProofCheck {
  readonly name: string
  readonly pass: boolean
  readonly detail: string | null
}

interface ForbiddenHit {
  readonly source: "resolve" | "load"
  readonly specifier: string | null
  readonly url: string
  readonly parentURL: string | null
  readonly reason: string
}

interface EmbeddedSessionReport {
  readonly createOk: boolean
  readonly streamOk: boolean
  readonly status: string | null
  readonly lastText: string | null
  readonly eventKinds: ReadonlyArray<string>
  readonly eventsReadOk: boolean
  readonly eventsReadCount: number
  readonly closeOk: boolean
  readonly closed: boolean | null
  readonly postCloseCode: string | null
}

interface Proof3Report {
  readonly checks: ReadonlyArray<ProofCheck>
  readonly operationsCount: number
  readonly session: EmbeddedSessionReport
  readonly resolvedCount: number
  readonly loadedCount: number
  readonly uniqueLoadedUrls: ReadonlyArray<string>
  readonly forbiddenHits: ReadonlyArray<ForbiddenHit>
}

interface ControlReport {
  readonly resolvedHttp: boolean
  readonly loadedHttp: boolean
  readonly forbiddenHits: ReadonlyArray<ForbiddenHit>
}

const readJsonLine = <T>(stdout: string, prefix: string): T => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix))

  if (line === undefined) {
    throw new Error(`child process produced no ${prefix.trim()} line; stdout:\n${stdout}`)
  }

  // SAFETY: the child harness serializes this exact report shape on its single
  // marker line; a schema mismatch fails the assertions immediately below.
  return JSON.parse(line.slice(prefix.length)) as T
}

describe("structural proof 3: run products/embedded headless", () => {
  it("runs a local turn to terminal through embedded() without loading MCP or HTTP modules", async () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "droid-mcp-proof3-"))
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "droid-mcp-proof3-sandbox-")))

    try {
      const harnessPath = join(harnessDir, "embedded-harness.mjs")

      writeFileSync(harnessPath, EMBEDDED_HARNESS)

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", harnessPath, PRODUCTS_INDEX_URL, sandbox, FAKE_EXEC],
        {
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      )

      const report = readJsonLine<Proof3Report>(stdout, "PROOF3_RESULT ")

      const failed = report.checks.filter((check) => !check.pass)

      expect(failed.map((check) => `${check.name}: ${String(check.detail)}`)).toEqual([])

      expect(report.checks.map((check) => check.name).sort()).toEqual(
        [
          "hook-captured-real-modules",
          "operations-include-session-lifecycle",
          "runtime-closed-and-rejects-further-calls",
          "session-closed",
          "session-created",
          "session-events-readable",
          "turn-reached-terminal-completed",
          "zero-forbidden-module-loads",
        ].sort(),
      )

      expect(report.operationsCount).toBeGreaterThan(0)
      expect(report.session.createOk).toBe(true)
      expect(report.session.streamOk).toBe(true)
      expect(report.session.status).toBe("completed")
      expect(report.session.lastText).toBe("hi")
      expect(report.session.eventKinds).toContain("turn_completed")
      expect(report.session.eventsReadOk).toBe(true)
      expect(report.session.eventsReadCount).toBeGreaterThan(0)
      expect(report.session.closeOk).toBe(true)
      expect(report.session.closed).toBe(true)
      expect(report.session.postCloseCode).toBe("closed")

      // Non-vacuous module observation: the hook observed the real runtime graph.
      expect(report.loadedCount).toBeGreaterThan(10)
      expect(report.resolvedCount).toBeGreaterThan(10)
      expect(report.uniqueLoadedUrls.some((url) => url.endsWith("/src/products/index.ts"))).toBe(
        true,
      )
      expect(
        report.uniqueLoadedUrls.some((url) => url.endsWith("/src/products/private/embedded.ts")),
      ).toBe(true)
      expect(report.uniqueLoadedUrls.some((url) => url.endsWith("/src/sessions/index.ts"))).toBe(
        true,
      )
      expect(report.uniqueLoadedUrls.some((url) => url.endsWith("/src/turns/index.ts"))).toBe(true)
      expect(report.uniqueLoadedUrls.some((url) => url.endsWith("/src/local-exec/index.ts"))).toBe(
        true,
      )

      expect(report.forbiddenHits).toEqual([])
    } finally {
      rmSync(harnessDir, { recursive: true, force: true })
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it("positive control: the loader hook genuinely records and flags node:http when imported", async () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "droid-mcp-proof3-control-"))

    try {
      const controlPath = join(harnessDir, "control-harness.mjs")

      writeFileSync(controlPath, POSITIVE_CONTROL_HARNESS)

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", controlPath],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      )

      const report = readJsonLine<ControlReport>(stdout, "PROOF3_CONTROL ")

      expect(report.resolvedHttp).toBe(true)
      expect(report.loadedHttp).toBe(true)
      expect(report.forbiddenHits.length).toBeGreaterThan(0)
      expect(report.forbiddenHits.some((hit) => hit.url === "node:http")).toBe(true)
    } finally {
      rmSync(harnessDir, { recursive: true, force: true })
    }
  })
})
