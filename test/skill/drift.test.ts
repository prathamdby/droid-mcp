import { execFile } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { SKILL_FILES, SKILL_MD } from "../../src/generated/skill.ts"

const run = promisify(execFile)
const ROOT = "src/skill/droid"

const walk = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    return entry.isDirectory() ? walk(path) : [path]
  })

describe("embedded skill", () => {
  it("matches the markdown in src/skill/droid", () => {
    const files = walk(ROOT).map((path) => relative(ROOT, path).split(sep).join("/"))

    expect(Object.keys(SKILL_FILES).sort()).toEqual(files.sort())

    const embedded = new Map(Object.entries(SKILL_FILES))

    for (const path of files) {
      expect(embedded.get(path)).toBe(readFileSync(join(ROOT, path), "utf8"))
    }
  })

  it("keeps SKILL.md as the skill's own entry", () => {
    expect(SKILL_MD).toBe(SKILL_FILES["SKILL.md"])
    expect(SKILL_MD.startsWith("---\n")).toBe(true)
    expect(SKILL_MD).toContain("\nname: droid\n")
    expect(SKILL_MD).toContain("\ndescription: ")
  })

  it("passes the drift check the release gate runs", async () => {
    const result = await run("node", [
      "--experimental-strip-types",
      "scripts/embed-skill.ts",
      "--check",
    ])

    expect(result.stdout).toContain("is current")
  })
})
