/**
 * Runs the vendored anti-slop plugin's rule tests.
 *
 * The tests use oxlint's `RuleTester` harness rather than Vitest, so they run
 * as plain scripts under `node --experimental-strip-types`, the same way
 * upstream runs them with `tsx`. Run with `pnpm test:lint-rules`.
 */
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = "tools/oxlint/anti-slop"

const walk = (directory: string): Array<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) return walk(path)

    return entry.name.endsWith(".test.ts") ? [path] : []
  })

const tests = walk(ROOT).sort()

if (tests.length === 0) {
  process.stderr.write("lint-rules: no test files found under " + ROOT + "\n")
  process.exit(1)
}

let failures = 0

for (const test of tests) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", test], {
    stdio: "inherit",
  })

  if (result.status !== 0) {
    failures += 1
    process.stderr.write("lint-rules: FAIL " + test + "\n")
  }
}

if (failures > 0) {
  process.stderr.write(
    "lint-rules: " + String(failures) + " of " + String(tests.length) + " test files failed\n",
  )
  process.exit(1)
}

process.stdout.write("lint-rules: " + String(tests.length) + " test files passed\n")
