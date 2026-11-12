import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { SKILL_FILES } from "../../src/generated/skill.ts"
import { SURFACE } from "../../src/generated/surface.ts"
import { SESSION_OWNED_METHODS } from "../../src/tools/generated.ts"
import { toolsFor } from "../../src/tools/index.ts"
import { testConfig } from "../support/config.ts"

/** The numbers the README and the skill state must be the ones the server exposes. */

const README = readFileSync("README.md", "utf8")
const TOOL_FAMILIES = readFileSync("src/skill/droid/references/tool-families.md", "utf8")
const SKILL = readFileSync("src/skill/droid/SKILL.md", "utf8")

const FAMILY_ROW = /^\| `([a-z]+)_` +\| (\d+) +\|/gm

const names = Object.keys(toolsFor(testConfig()).toolkit.tools)
const skillText = Object.values(SKILL_FILES).join("\n")

const failureSources = [
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

const failureCodes = new Set(
  failureSources.flatMap((path) =>
    Array.from(
      readFileSync(path, "utf8").matchAll(
        path === "src/droid/errors.ts"
          ? /^\s+[A-Z]\w+: "([a-z_]+)"/gm
          : /(?:code:\s*|problem\(\s*|fail\(\s*)"([a-z_]+)"/g,
      ),
      (match) => match[1] ?? "",
    ),
  ),
)

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

const generated = SURFACE.filter((entry) => !SESSION_OWNED_METHODS.includes(entry.method)).length

describe("documented tool counts", () => {
  it("match the families the server exposes in README.md", () => {
    expect(documentedFamilies(README)).toEqual(computedFamilies())
    expect(README).toContain("provides " + String(names.length) + " tools in six families")
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

    expect(names).toContain("droid_update_session_settings")
  })

  it("names only operations that the server exposes", () => {
    const mentioned = skillText.match(
      /\b(?:server|session|daemon|droid|rest|context)_[a-z]+(?:_[a-z]+)*\b/g,
    )

    expect(mentioned).not.toBeNull()

    for (const name of new Set(mentioned)) {
      if (failureCodes.has(name)) continue

      expect(names, name).toContain(name)
    }
  })

  it("documents the server-defined failure codes", () => {
    for (const code of failureCodes) {
      expect(skillText, code).toContain("`" + code + "`")
    }
  })
})
