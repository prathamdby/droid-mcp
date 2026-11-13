import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { errorCode } from "../../src/droid/errors.ts"
import { SKILL_FILES } from "../../src/generated/skill.ts"
import { SURFACE } from "../../src/generated/surface.ts"
import { MAX_BATCH_STEPS, META_TOOLS } from "../../src/tools/compact.ts"
import { DAEMON_UNSERVED_METHODS, SESSION_OWNED_METHODS } from "../../src/tools/generated.ts"
import { toolsFor } from "../../src/tools/index.ts"
import {
  DEFAULT_RESULT_BYTES,
  MAX_RESULT_BYTES,
  MIN_RESULT_BYTES,
} from "../../src/tools/results.ts"
import { testConfig } from "../support/config.ts"

/** The numbers the README and the skill state must be the ones the server exposes. */

const README = readFileSync("README.md", "utf8")
const TOOL_FAMILIES = readFileSync("src/skill/droid/references/tool-families.md", "utf8")
const SKILL = readFileSync("src/skill/droid/SKILL.md", "utf8")
const COMPACT = readFileSync("src/tools/compact.ts", "utf8")

const FAMILY_ROW = /^\| `([a-z]+)_` +\| (\d+) +\|/gm

const names = Object.keys(toolsFor(testConfig()).toolkit.tools)
const skillText = Object.values(SKILL_FILES).join("\n")
const exposedNames = new Set([...names, ...META_TOOLS.map((tool) => tool.name)])

// Wire methods, event types, and permission outcomes are not tool names or failure codes.
const nonCodeIdentifiers = new Set([
  ...SESSION_OWNED_METHODS.map((method) => method.slice("droid.".length)),
  ...[...DAEMON_UNSERVED_METHODS.keys()].map((method) => method.replaceAll(".", "_")),
  "assistant_text",
  "pending_options",
  "pending_permission",
  "pending_question",
  "prompt_resolved",
  "tool_result",
  "turn_completed",
  "proceed_once",
  "proceed_always",
  "proceed_always_file",
  "proceed_always_tools",
  "proceed_always_server",
  "proceed_report_false_positive",
  "proceed_auto_run_low",
  "proceed_auto_run_medium",
  "proceed_auto_run_high",
  "proceed_new_session_low",
  "proceed_new_session_medium",
  "proceed_new_session_high",
  "proceed_auto_run",
  "proceed_new_session",
  "proceed_edit",
])

const failureSources = [
  "src/tools/skill.ts",
  "src/tools/compact.ts",
  "src/tools/generated.ts",
  "src/tools/results.ts",
  "src/tools/guards.ts",
  "src/tools/session-prompts.ts",
  "src/tools/session-mcp.ts",
  "src/tools/rest-kit.ts",
  "src/droid/turns.ts",
  "src/droid/prompts.ts",
  "src/droid/errors.ts",
]

const failureCodes = new Set([
  errorCode(undefined),
  ...failureSources.flatMap((path) =>
    Array.from(
      readFileSync(path, "utf8").matchAll(
        path === "src/droid/errors.ts"
          ? /^\s+[A-Z]\w+: "([a-z_]+)"/gm
          : /(?:code:\s*|problem\(\s*|fail\(\s*)"([a-z_]+)"/g,
      ),
      (match) => match[1] ?? "",
    ),
  ),
])

const backtickedIdentifiers = (text: string): Array<string> =>
  Array.from(text.matchAll(/`([a-z]+(?:_[a-z]+)+|batch)`/g), (match) => match[1] ?? "")

const unknownOperations = (text: string): Array<string> => {
  const mentioned = [
    ...backtickedIdentifiers(text),
    ...(text.match(/\b(?:server|session|daemon|droid|rest|context)_[a-z]+(?:_[a-z]+)*\b/g) ?? []),
  ]

  return [...new Set(mentioned)].filter(
    (name) => !failureCodes.has(name) && !nonCodeIdentifiers.has(name) && !exposedNames.has(name),
  )
}

const unknownFailureCodes = (text: string): Array<string> =>
  [...new Set(backtickedIdentifiers(text))].filter(
    (code) => !exposedNames.has(code) && !nonCodeIdentifiers.has(code) && !failureCodes.has(code),
  )

const numbersIn = (text: string, pattern: RegExp): Array<number> => {
  const match = text.match(pattern)

  expect(match, pattern.source).not.toBeNull()

  return (match?.slice(1) ?? []).map(Number)
}

const computedFamilies = () => {
  const counts = new Map<string, number>()

  for (const name of names) {
    const family = name.slice(0, name.indexOf("_"))

    counts.set(family, (counts.get(family) ?? 0) + 1)
  }

  return Object.fromEntries(counts)
}

/** The `| \`prefix_\` | count |` rows of a markdown family table. */
const documentedFamilies = (markdown: string): Record<string, number> =>
  Object.fromEntries(
    Array.from(markdown.matchAll(FAMILY_ROW), (match) => [match[1] ?? "", Number(match[2])]),
  )

const generated = SURFACE.filter(
  (entry) =>
    !SESSION_OWNED_METHODS.includes(entry.method) && !DAEMON_UNSERVED_METHODS.has(entry.method),
).length

describe("documented tool counts", () => {
  it("match the families the server exposes in README.md", () => {
    expect(documentedFamilies(README)).toEqual(computedFamilies())
    expect(README).toContain("provides " + String(names.length) + " tools in seven families")
    expect(README).toContain(
      String(generated) +
        " are generated from the Factory Droid SDK, one per wire method, and " +
        String(names.length - generated) +
        " are hand-written",
    )
  })

  it("match the families the server exposes in tool-families.md", () => {
    expect(documentedFamilies(TOOL_FAMILIES)).toEqual(computedFamilies())
    expect(TOOL_FAMILIES).toContain(
      "publishes " +
        String(names.length) +
        " tools: " +
        String(generated) +
        " generated from the SDK's method surface and\n" +
        String(names.length - generated) +
        " hand-written",
    )
  })

  it("name the total in SKILL.md", () => {
    expect(SKILL).toContain("what the " + String(names.length) + " tool names mean")
  })

  it("state how many droid.* methods the session tools suppress", () => {
    const droidMethods = SURFACE.filter((entry) => entry.method.startsWith("droid.")).length
    const suppressed = SURFACE.filter((entry) => SESSION_OWNED_METHODS.includes(entry.method))

    expect(TOOL_FAMILIES).toContain("The SDK has " + String(droidMethods) + " `droid.*` methods.")
    expect(suppressed).toHaveLength(7)
    expect(TOOL_FAMILIES).toContain("Seven of them belong to the session loop")

    for (const entry of suppressed) {
      expect(TOOL_FAMILIES).toContain("`" + entry.method.slice("droid.".length) + "`")
    }

    expect(DAEMON_UNSERVED_METHODS.size).toBe(4)

    for (const [method, replacements] of DAEMON_UNSERVED_METHODS) {
      expect(TOOL_FAMILIES).toContain("`" + method.replaceAll(".", "_") + "`")

      for (const name of replacements) expect(TOOL_FAMILIES).toContain("`" + name + "`")
    }

    expect(names).toContain("droid_update_session_settings")
  })

  it("names only operations that the server exposes", () => {
    expect(unknownOperations(skillText)).toEqual([])

    for (const tool of META_TOOLS) {
      expect(backtickedIdentifiers(skillText)).toContain(tool.name)
    }
  })

  it.each(["tools_seach", "tools_describ", "tool_cal", "result_reed"])(
    "rejects the misspelled dispatch name %s",
    (name) => {
      expect(unknownOperations(skillText + "\n`" + name + "`")).toEqual([name])
    },
  )

  it("documents the server-defined failure codes", () => {
    for (const code of failureCodes) {
      expect(skillText, code).toContain("`" + code + "`")
    }
  })

  it("documents no invented failure codes", () => {
    expect(unknownFailureCodes(skillText)).toEqual([])
    expect(unknownFailureCodes(skillText + "\n`invented_failure_code`")).toEqual([
      "invented_failure_code",
    ])
  })

  it("pins documented dispatch bounds to the implementation", () => {
    expect(numbersIn(TOOL_FAMILIES, /Range: (\d+)\.\.(\d+) bytes; default: (\d+)/)).toEqual([
      MIN_RESULT_BYTES,
      MAX_RESULT_BYTES,
      DEFAULT_RESULT_BYTES,
    ])
    expect(numbersIn(TOOL_FAMILIES, /Start at `maxBytes: (\d+)`/)).toEqual([MIN_RESULT_BYTES])
    expect(numbersIn(TOOL_FAMILIES, /`batch` runs (\d+)\.\.(\d+) steps/)).toEqual([
      1,
      MAX_BATCH_STEPS,
    ])
    expect(numbersIn(TOOL_FAMILIES, /Batch defaults to (\d+) bytes/)).toEqual([
      (numbersIn(COMPACT, /const DEFAULT_BATCH_BYTES = (\d+) \* DEFAULT_RESULT_BYTES/)[0] ?? 0) *
        DEFAULT_RESULT_BYTES,
    ])
    expect(numbersIn(TOOL_FAMILIES, /step to (\d+)\.\.(\d+)/)).toEqual([
      MIN_RESULT_BYTES,
      MAX_RESULT_BYTES,
    ])
    expect(numbersIn(TOOL_FAMILIES, /`limit` \(default (\d+), maximum (\d+)\)/)).toEqual([
      ...numbersIn(COMPACT, /const DEFAULT_SEARCH_LIMIT = (\d+)/),
      ...numbersIn(COMPACT, /const SEARCH_LIMIT = (\d+)/),
    ])
    expect(numbersIn(TOOL_FAMILIES, /`tools_describe \{ names \}` accepts (\d+)\.\.(\d+)/)).toEqual(
      [1, ...numbersIn(COMPACT, /const DESCRIBE_LIMIT = (\d+)/)],
    )
  })
})
