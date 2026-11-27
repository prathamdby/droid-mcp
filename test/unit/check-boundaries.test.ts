import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { MODULES, checkBoundaries, parseArgs } from "../../scripts/check-boundaries.ts"
import type { BoundaryViolation } from "../../scripts/check-boundaries.ts"

interface TestRoot {
  readonly path: string
  readonly write: (moduleName: string, file: string, content: string) => void
  readonly writeRootFile: (file: string, content: string) => void
  readonly remove: () => void
}

const createRoot = (): TestRoot => {
  const path = mkdtempSync(join(tmpdir(), "boundaries-"))

  const place = (file: string, content: string): void => {
    const full = join(path, file)

    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  return {
    path,
    write: (moduleName, file, content) => place(join(moduleName, file), content),
    writeRootFile: (file, content) => place(file, content),
    remove: () => rmSync(path, { recursive: true, force: true }),
  }
}

const roots: Array<TestRoot> = []

const root = (): TestRoot => {
  const created = createRoot()

  roots.push(created)

  return created
}

afterEach(() => {
  while (roots.length > 0) {
    const entry = roots.pop()

    if (entry !== undefined) entry.remove()
  }
})

const EMPTY_MODULE = "export const marker = 1\n"

const validPair = (): TestRoot => {
  const base = root()

  base.write("caller", "index.ts", EMPTY_MODULE)
  base.write(
    "authority",
    "index.ts",
    'import { marker } from "../caller/index.ts"\n\nexport const upstream = marker\n',
  )

  return base
}

/** Asserts the full violation list exactly once, in order. */
const expectViolations = (
  actual: ReadonlyArray<BoundaryViolation>,
  expected: ReadonlyArray<BoundaryViolation>,
): void => {
  expect(actual).toEqual(expected)
}

const violation = (
  rule: string,
  file: string,
  line: number,
  detail: string,
): BoundaryViolation => ({
  rule,
  file,
  line,
  detail,
})

const singleViolation = (base: TestRoot): BoundaryViolation => {
  const result = checkBoundaries({ rootDir: base.path })

  expect(result.ok).toBe(false)
  expect(result.violations).toHaveLength(1)

  const only = result.violations[0]

  if (only === undefined) throw new Error("expected exactly one violation")

  return only
}

describe("valid module graphs", () => {
  it("passes a multi-level graph and reports exact counts", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("disclosure", "index.ts", EMPTY_MODULE)
    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write("factory-dialect", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'import { marker } from "../caller/index.ts"\n\nexport const upstream = marker\n',
    )
    base.write(
      "capabilities",
      "index.ts",
      'import { marker } from "../caller/index.ts"\n' +
        'import { upstream } from "../authority/index.ts"\n\n' +
        "export const combined = [marker, upstream]\n",
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.checkedModules).toBe(6)
    expect(result.checkedFiles).toBe(6)
    expect(result.checkedImports).toBe(3)
  })

  it("counts same-module relative imports without requiring graph edges", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      'import { helper } from "./helper.ts"\n\nexport const x = helper\n',
    )
    base.write("caller", "helper.ts", "export const helper = 1\n")

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(true)
    expect(result.checkedFiles).toBe(2)
    expect(result.checkedImports).toBe(1)
  })

  it("allows same-module imports into own private files", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      'import { secret } from "./private/secret.ts"\n\nexport const x = secret\n',
    )
    base.write("caller", "private/secret.ts", "export const secret = 1\n")

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it("allows a same-module type re-export from a private file", () => {
    const base = root()

    base.write("caller", "index.ts", 'export type { Mark } from "./private/model.ts"\n')
    base.write("caller", "private/model.ts", "export type Mark = number\n")

    expect(checkBoundaries({ rootDir: base.path }).violations).toEqual([])
  })

  it("allows bare external imports that are not banned", () => {
    const base = root()

    base.write("caller", "index.ts", 'import { Schema } from "effect"\n\nexport const x = Schema\n')

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(true)
  })
})

describe("top-level layout", () => {
  it("rejects an unknown module directory with its exact detail", () => {
    const base = validPair()

    base.write("smuggled", "index.ts", EMPTY_MODULE)

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expectViolations(result.violations, [
      violation(
        "unknown_module",
        "smuggled",
        0,
        "directory is not one of the " + String(MODULES.size) + " known modules",
      ),
    ])
  })

  it("rejects a stray file directly under the root", () => {
    const base = validPair()

    base.writeRootFile("stray.ts", EMPTY_MODULE)

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "unknown_top_level_entry",
          "stray.ts",
          0,
          "stray file directly under the module root",
        ),
      ],
    )
  })
})

describe("dependency graph", () => {
  it("rejects a disallowed upward import from caller to authority", () => {
    const base = root()

    base.write("authority", "index.ts", EMPTY_MODULE)
    base.write(
      "caller",
      "index.ts",
      'import { marker } from "../authority/index.ts"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [violation("disallowed_dependency", "caller/index.ts", 1, "caller may not import authority")],
    )
  })

  it("rejects a disallowed same-level import from authority to custody", () => {
    const base = root()

    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'import { marker } from "../custody/index.ts"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })

  it("rejects a skipped-edge import from sessions to artifacts", () => {
    const base = root()

    base.write("artifacts", "index.ts", EMPTY_MODULE)
    base.write(
      "sessions",
      "index.ts",
      'import { marker } from "../artifacts/index.ts"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "sessions/index.ts",
          1,
          "sessions may not import artifacts",
        ),
      ],
    )
  })

  it("rejects imports through re-export statements", () => {
    const base = root()

    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write("authority", "index.ts", 'export { marker } from "../custody/index.ts"\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })

  it("rejects imports through import-type statements", () => {
    const base = root()

    base.write("custody", "index.ts", "export type Mark = number\n")
    base.write(
      "authority",
      "index.ts",
      'import type { Mark } from "../custody/index.ts"\nexport type Copy = Mark\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })

  it("allows direct dependencies listed in the updated graph", () => {
    const base = root()

    base.write("guidance", "index.ts", EMPTY_MODULE)
    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("authority", "index.ts", EMPTY_MODULE)
    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write("capabilities", "index.ts", EMPTY_MODULE)
    base.write("disclosure", "index.ts", EMPTY_MODULE)
    base.write(
      "prem-context",
      "index.ts",
      'import { marker as a } from "../authority/index.ts"\n' +
        'import { marker as g } from "../guidance/index.ts"\n\n' +
        "export const x = [a, g]\n",
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe("public entrypoint", () => {
  it("rejects a cross-module import into a private file along an allowed edge", () => {
    const base = root()

    base.write("caller", "private/secret.ts", "export const secret = 1\n")
    base.write(
      "authority",
      "index.ts",
      'import { secret } from "../caller/private/secret.ts"\nexport const x = secret\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "private_entrypoint",
          "authority/index.ts",
          1,
          '"../caller/private/secret.ts" must resolve to caller/index.ts',
        ),
      ],
    )
  })

  it("rejects a cross-module import into a deep non-index file along an allowed edge", () => {
    const base = root()

    base.write("caller", "helper.ts", "export const helper = 1\n")
    base.write(
      "authority",
      "index.ts",
      'import { helper } from "../caller/helper.ts"\nexport const x = helper\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "private_entrypoint",
          "authority/index.ts",
          1,
          '"../caller/helper.ts" must resolve to caller/index.ts',
        ),
      ],
    )
  })

  it("rejects extensionless cross-module imports", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'import { marker } from "../caller"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expect(only.rule).toBe("missing_extension")
    expect(only.file).toBe("authority/index.ts")
    expect(only.line).toBe(1)
    expect(only.detail).toBe('"../caller" must name a .ts file explicitly')
  })
})

describe("legacy isolation", () => {
  it("rejects an import that escapes the root into the legacy tree", () => {
    const parent = root()
    const legacyDir = join(parent.path, "legacy-src")
    const moduleRoot = join(parent.path, "src")

    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, "config.ts"), "export const x = 1\n")
    mkdirSync(moduleRoot, { recursive: true })
    mkdirSync(join(moduleRoot, "caller"), { recursive: true })
    writeFileSync(
      join(moduleRoot, "caller", "index.ts"),
      'import { x } from "../../legacy-src/config.ts"\nexport const y = x\n',
    )

    const result = checkBoundaries({ rootDir: moduleRoot })

    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)

    const only = result.violations[0]

    if (only === undefined) throw new Error("expected exactly one violation")

    expect(only.rule).toBe("legacy_escape")
    expect(only.file).toBe("caller/index.ts")
    expect(only.line).toBe(1)
    expect(only.detail).toBe('"../../legacy-src/config.ts" escapes the module root')
  })
})

describe("dynamic and commonjs imports", () => {
  it("rejects a disallowed literal dynamic import", () => {
    const base = root()

    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write("authority", "index.ts", 'export const load = () => import("../custody/index.ts")\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })

  it("rejects a non-literal dynamic import even in a valid module", () => {
    const base = root()

    base.write(
      "authority",
      "index.ts",
      "declare const target: string\n\nexport const load = () => import(target)\n",
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "non_literal_import",
          "authority/index.ts",
          3,
          "dynamic module reference must use a string literal",
        ),
      ],
    )
  })

  it("rejects require calls", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      'declare const require: (name: string) => number\n\nexport const x = require("effect")\n',
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.violations.every((entry) => entry.rule === "require_forbidden")).toBe(true)
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it("rejects createRequire calls", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      "declare function createRequire(url: string): (name: string) => number\n\n" +
        'export const x = createRequire("file:///x.ts")\n',
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.every((entry) => entry.rule === "require_forbidden")).toBe(true)
  })

  it("rejects destructured createRequire bindings", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      "declare const loader: { createRequire: (url: string) => number }\n\nexport const { createRequire } = loader\n",
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.every((entry) => entry.rule === "require_forbidden")).toBe(true)
  })

  it("rejects bracket-access createRequire", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      'declare const loader: Record<string, number>\n\nexport const x = loader["createRequire"]\n',
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.every((entry) => entry.rule === "require_forbidden")).toBe(true)
  })
})

describe("kernel purity", () => {
  it.each([
    ["effect/ai/McpServer", "kernel_impurity", '"effect/ai/McpServer" is forbidden below level 8'],
    [
      "effect/http/HttpRouter",
      "kernel_impurity",
      '"effect/http/HttpRouter" is forbidden below level 9',
    ],
    [
      "effect/http-api/HttpApiClient",
      "kernel_impurity",
      '"effect/http-api/HttpApiClient" is forbidden below level 9',
    ],
    ["node:http", "kernel_impurity", '"node:http" is forbidden below level 9'],
    [
      "@effect/platform-node",
      "kernel_impurity",
      '"@effect/platform-node" is forbidden below level 9',
    ],
    ["typescript", "banned_external_import", '"typescript" is forbidden in every module'],
    [
      "typescript/lib/tsc",
      "banned_external_import",
      '"typescript/lib/tsc" is forbidden in every module',
    ],
    ["node:vm", "banned_external_import", '"node:vm" is forbidden in every module'],
    ["_http_server", "kernel_impurity", '"_http_server" is forbidden below level 9'],
    ["node:_http_client", "kernel_impurity", '"node:_http_client" is forbidden below level 9'],
  ])("rejects %s in a level-0 module for the expected reason", (specifier, rule, detail) => {
    const base = root()

    base.write("caller", "index.ts", 'import x from "' + specifier + '"\n\nexport const y = x\n')

    const only = singleViolation(base)

    expectViolations([only], [violation(rule, "caller/index.ts", 1, detail)])
  })

  it("rejects process.getBuiltinModule for a banned builtin", () => {
    const base = root()

    base.write("caller", "index.ts", 'export const http = process.getBuiltinModule("node:http")\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "kernel_impurity",
          "caller/index.ts",
          1,
          '"node:http" is forbidden below level 9',
        ),
      ],
    )
  })

  it("rejects process.getBuiltinModule with a non-literal argument", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      "declare const name: string\n\nexport const mod = process.getBuiltinModule(name)\n",
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "non_literal_import",
          "caller/index.ts",
          3,
          "dynamic module reference must use a string literal",
        ),
      ],
    )
  })

  it.each([["eval('1')"], ["new Function('return 1')()"], ["Function('return 1')()"]])(
    "rejects dynamic code through %s",
    (expression) => {
      const base = root()

      base.write("caller", "index.ts", "export const x = " + expression + "\n")

      const result = checkBoundaries({ rootDir: base.path })

      expect(result.ok).toBe(false)
      expect(result.violations.some((entry) => entry.rule === "dynamic_code_forbidden")).toBe(true)
    },
  )
})

describe("level 8 module", () => {
  it("allows the toolkit import in mcp", () => {
    const base = root()

    base.write("mcp", "index.ts", 'import x from "effect/ai/McpServer"\n\nexport const y = x\n')

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(true)
  })

  it.each([
    ["node:http", '"node:http" is forbidden below level 9'],
    ["effect/http/HttpRouter", '"effect/http/HttpRouter" is forbidden below level 9'],
    ["@effect/platform-node", '"@effect/platform-node" is forbidden below level 9'],
  ])("rejects %s in mcp", (specifier, detail) => {
    const base = root()

    base.write("mcp", "index.ts", 'import x from "' + specifier + '"\n\nexport const y = x\n')

    const only = singleViolation(base)

    expectViolations([only], [violation("kernel_impurity", "mcp/index.ts", 1, detail)])
  })
})

describe("level 9 module", () => {
  it.each([["node:http"], ["effect/ai/McpServer"], ["@effect/platform-node"]])(
    "allows %s in products",
    (specifier) => {
      const base = root()

      base.write(
        "products",
        "index.ts",
        'import x from "' + specifier + '"\n\nexport const y = x\n',
      )

      const result = checkBoundaries({ rootDir: base.path })

      expect(result.ok).toBe(true)
    },
  )

  it("rejects typescript in products", () => {
    const base = root()

    base.write("products", "index.ts", 'import ts from "typescript"\n\nexport const y = ts\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "banned_external_import",
          "products/index.ts",
          1,
          '"typescript" is forbidden in every module',
        ),
      ],
    )
  })
})

describe("root existence guard", () => {
  it("fails on an empty directory with empty_root", () => {
    const base = root()

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.checkedFiles).toBe(0)
    expectViolations(result.violations, [
      violation(
        "empty_root",
        basenameOf(base.path) + "/",
        0,
        "no source files found under the module root",
      ),
    ])
  })

  it("fails on a missing directory with missing_root even when allowEmpty is set", () => {
    const base = root()
    const missing = join(base.path, "does-not-exist")

    for (const allowEmpty of [undefined, true]) {
      const result = checkBoundaries({ rootDir: missing, allowEmpty })

      expect(result.ok).toBe(false)
      expectViolations(result.violations, [
        violation("missing_root", "does-not-exist/", 0, "the module root does not exist"),
      ])
    }
  })

  it("passes an existing empty directory when allowEmpty is set", () => {
    const base = root()

    const result = checkBoundaries({ rootDir: base.path, allowEmpty: true })

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })
})

const basenameOf = (path: string): string => {
  const parts = path.split("/")

  return parts[parts.length - 1] ?? path
}

describe("type-only import positions", () => {
  it("rejects a disallowed import type position reference", () => {
    const base = root()

    base.write("custody", "index.ts", "export type Mark = number\n")
    base.write("authority", "index.ts", 'export type Copy = import("../custody/index.ts").Mark\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })

  it("rejects typeof import references to private files", () => {
    const base = root()

    base.write("caller", "private/secret.ts", "export const secret = 1\n")
    base.write(
      "authority",
      "index.ts",
      'export type Probe = typeof import("../caller/private/secret.ts")\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "private_entrypoint",
          "authority/index.ts",
          1,
          '"../caller/private/secret.ts" must resolve to caller/index.ts',
        ),
      ],
    )
  })
})

describe("reference directives and module augmentation", () => {
  it("rejects triple-slash path references", () => {
    const base = root()

    base.write("caller", "index.ts", '/// <reference path="./helper.ts" />\n\nexport const x = 1\n')
    base.write("caller", "helper.ts", "export const helper = 1\n")

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "reference_directive_forbidden",
          "caller/index.ts",
          1,
          '/// <reference path="./helper.ts" /> is forbidden inside the module root',
        ),
      ],
    )
  })

  it("rejects triple-slash types references", () => {
    const base = root()

    base.write("caller", "index.ts", '/// <reference types="node" />\n\nexport const x = 1\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "reference_directive_forbidden",
          "caller/index.ts",
          1,
          '/// <reference types="node" /> is forbidden inside the module root',
        ),
      ],
    )
  })

  it("treats declare module of another module as a reference", () => {
    const base = root()

    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'declare module "../custody/index.ts" {\n  export const extra: number\n}\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })
})

describe("specifier classification", () => {
  it("rejects absolute-path imports that escape the root", () => {
    const base = root()
    const outside = join(tmpdir(), "boundary-absolute-outside.ts")

    writeFileSync(outside, "export const x = 1\n")

    try {
      base.write("caller", "index.ts", 'import { x } from "' + outside + '"\nexport const y = x\n')

      const only = singleViolation(base)

      expect(only.rule).toBe("legacy_escape")
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it("rejects file: URL imports that escape the root", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      'import { x } from "file:///etc/passwd.ts"\nexport const y = x\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "legacy_escape",
          "caller/index.ts",
          1,
          '"file:///etc/passwd.ts" escapes the module root',
        ),
      ],
    )
  })

  it("rejects subpath import aliases", () => {
    const base = root()

    base.write("caller", "index.ts", 'import { x } from "#internal/helper"\nexport const y = x\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "subpath_import_forbidden",
          "caller/index.ts",
          1,
          '"#internal/helper" is a package alias',
        ),
      ],
    )
  })

  it("treats the exact dot specifier as local", () => {
    const base = root()

    base.write("caller", "index.ts", 'import { x } from "."\nexport const y = x\n')
    base.write("caller", "helper.ts", "export const helper = 1\n")

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.violations.some((entry) => entry.rule === "banned_external_import")).toBe(false)
  })
})

describe("unsupported files and nested packages", () => {
  it.each([
    ["a.mjs", "unsupported_file"],
    ["b.js", "unsupported_file"],
    ["c.cjs", "unsupported_file"],
    ["d.cts", "unsupported_file"],
    ["e.mts", "unsupported_file"],
    ["f.tsx", "unsupported_file"],
    ["g.d.ts", "unsupported_file"],
    ["h.json", "unsupported_file"],
    ["private/notes.txt", "unsupported_file"],
    ["README", "unsupported_file"],
  ])("rejects %s inside a module", (file, rule) => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("caller", file, "export const x = 1\n")

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(
      result.violations.some((entry) => entry.rule === rule && entry.file === "caller/" + file),
    ).toBe(true)
  })

  it("rejects a nested node_modules directory", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("caller", "node_modules/evil/index.ts", EMPTY_MODULE)

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.violations.some((entry) => entry.rule === "nested_node_modules")).toBe(true)
  })
})

describe("symlinks", () => {
  it("rejects a symlink at a known module path without scanning its target", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    symlinkSync(join(base.path, "caller"), join(base.path, "custody"), "dir")

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([
      violation("symlink_forbidden", "custody", 0, "symlinks are forbidden inside the module root"),
    ])
    expect(result.checkedModules).toBe(1)
    expect(result.checkedFiles).toBe(1)
  })

  it("rejects symlinked files inside a module", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("caller", "real.ts", "export const x = 1\n")
    symlinkSync(join(base.path, "caller", "real.ts"), join(base.path, "caller", "link.ts"))

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expectViolations(result.violations, [
      violation(
        "symlink_forbidden",
        "caller/link.ts",
        0,
        "symlinks are forbidden inside the module root",
      ),
    ])
  })

  it("rejects symlinked directories inside a module", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("custody", "index.ts", EMPTY_MODULE)
    symlinkSync(join(base.path, "custody"), join(base.path, "caller", "link"), "dir")

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.ok).toBe(false)
    expect(result.violations.some((entry) => entry.rule === "symlink_forbidden")).toBe(true)
  })
})

describe("unknown targets and decoding", () => {
  it("rejects percent-encoded escapes into other modules", () => {
    const base = root()

    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'import { marker } from "../%63ustody/index.ts"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })

  it("rejects imports that target unknown directories inside the root", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'import { x } from "../phantom/index.ts"\nexport const y = x\n',
    )

    const only = singleViolation(base)

    expect(only.rule).toBe("unknown_target")
    expect(only.file).toBe("authority/index.ts")
    expect(only.line).toBe(1)
    expect(only.detail).toContain('"../phantom/index.ts"')
    expect(only.detail).toContain(String(MODULES.size))
  })

  it("rejects case-mismatched module targets", () => {
    const base = root()

    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'import { x } from "../Custody/index.ts"\nexport const y = x\n',
    )

    const only = singleViolation(base)

    expect(only.rule).toBe("unknown_target")
  })
})

describe("re-export laundering", () => {
  it.each(["{ marker }", "type { Mark }", "{ type Mark }"])(
    "rejects selective export %s across modules even along an allowed edge",
    (clause) => {
      const base = root()

      base.write("caller", "index.ts", EMPTY_MODULE + "export type Mark = number\n")
      base.write("authority", "index.ts", `export ${clause} from "../caller/index.ts"\n`)

      expect(singleViolation(base)).toMatchObject({
        rule: "reexport_forbidden",
        file: "authority/index.ts",
        line: 1,
      })
    },
  )

  it("rejects export-star across modules even along an allowed edge", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("authority", "index.ts", 'export * from "../caller/index.ts"\n')

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "wildcard_export",
          "authority/index.ts",
          1,
          "export * forwards every present and future name of the target; name each exported symbol explicitly",
        ),
      ],
    )
  })

  it("rejects same-module export-star into own private files with wildcard_export", () => {
    const base = root()

    base.write("caller", "index.ts", 'export * from "./private/helper.ts"\n')
    base.write("caller", "private/helper.ts", EMPTY_MODULE)

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "wildcard_export",
          "caller/index.ts",
          1,
          "export * forwards every present and future name of the target; name each exported symbol explicitly",
        ),
      ],
    )
  })

  it("rejects export-star-as-namespace re-exports with wildcard_export", () => {
    const base = root()

    base.write("caller", "index.ts", 'export * as ns from "./private/helper.ts"\n')
    base.write("caller", "private/helper.ts", EMPTY_MODULE)

    expect(singleViolation(base)).toMatchObject({
      rule: "wildcard_export",
      file: "caller/index.ts",
      line: 1,
    })
  })

  it("rejects local re-export of a binding imported from another module", () => {
    const base = root()

    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'import { marker } from "../caller/index.ts"\n\nexport { marker }\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "reexport_forbidden",
          "authority/index.ts",
          3,
          're-exporting "marker" launders a cross-module dependency',
        ),
      ],
    )
  })

  it("rejects default re-export of a cross-module import", () => {
    const base = root()

    base.write("caller", "index.ts", "export default 1\n")
    base.write(
      "authority",
      "index.ts",
      'import marker from "../caller/index.ts"\n\nexport default marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "reexport_forbidden",
          "authority/index.ts",
          3,
          're-exporting "marker" launders a cross-module dependency',
        ),
      ],
    )
  })
})

describe("type-only provider edges", () => {
  it("rejects value imports of daemon-operations from placement", () => {
    const base = root()

    base.write("daemon-operations", "index.ts", EMPTY_MODULE)
    base.write(
      "placement",
      "index.ts",
      'import { marker } from "../daemon-operations/index.ts"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "type_only_dependency",
          "placement/index.ts",
          1,
          "placement may import daemon-operations only through import type",
        ),
      ],
    )
  })

  it("allows type-only imports of daemon-operations from placement", () => {
    const base = root()

    base.write("daemon-operations", "index.ts", "export type Facts = number\n")
    base.write(
      "placement",
      "index.ts",
      'import type { Facts } from "../daemon-operations/index.ts"\nexport type Copy = Facts\n',
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("rejects value imports of prem-context from presentation", () => {
    const base = root()

    base.write("prem-context", "index.ts", EMPTY_MODULE)
    base.write(
      "presentation",
      "index.ts",
      'import { marker } from "../prem-context/index.ts"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "type_only_dependency",
          "presentation/index.ts",
          1,
          "presentation may import prem-context only through import type",
        ),
      ],
    )
  })

  it("allows value imports of capabilities from placement", () => {
    const base = root()

    base.write("capabilities", "index.ts", EMPTY_MODULE)
    base.write("caller", "index.ts", EMPTY_MODULE)
    base.write("authority", "index.ts", EMPTY_MODULE)
    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write("workspace", "index.ts", EMPTY_MODULE)
    base.write("factory-dialect", "index.ts", EMPTY_MODULE)
    base.write("disclosure", "index.ts", EMPTY_MODULE)
    base.write("guidance", "index.ts", EMPTY_MODULE)
    base.write("local-exec", "index.ts", EMPTY_MODULE)
    base.write(
      "placement",
      "index.ts",
      'import { marker } from "../local-exec/index.ts"\nexport const x = marker\n',
    )

    const result = checkBoundaries({ rootDir: base.path })

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe("missing target files", () => {
  it("rejects an import whose target file does not exist", () => {
    const base = root()

    base.write(
      "authority",
      "index.ts",
      'import { marker } from "../caller/index.ts"\nexport const x = marker\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "missing_target_file",
          "authority/index.ts",
          1,
          '"../caller/index.ts" resolves to a file that does not exist',
        ),
      ],
    )
  })
})

describe("worker-style url construction", () => {
  it("treats new URL with import.meta.url as a module reference", () => {
    const base = root()

    base.write("custody", "index.ts", EMPTY_MODULE)
    base.write(
      "authority",
      "index.ts",
      'export const url = new URL("../custody/index.ts", import.meta.url)\n',
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "disallowed_dependency",
          "authority/index.ts",
          1,
          "authority may not import custody",
        ),
      ],
    )
  })

  it("rejects non-literal new URL arguments", () => {
    const base = root()

    base.write(
      "caller",
      "index.ts",
      "declare const target: string\n\nexport const url = new URL(target, import.meta.url)\n",
    )

    const only = singleViolation(base)

    expectViolations(
      [only],
      [
        violation(
          "non_literal_import",
          "caller/index.ts",
          3,
          "dynamic module reference must use a string literal",
        ),
      ],
    )
  })
})

describe("parseArgs", () => {
  it("parses a root given as a separate argument", () => {
    expect(parseArgs(["--root", "src"])).toEqual({
      rootDir: "src",
      allowEmpty: false,
      errors: [],
    })
  })

  it("parses --root=value form", () => {
    expect(parseArgs(["--root=src"])).toEqual({
      rootDir: "src",
      allowEmpty: false,
      errors: [],
    })
  })

  it("collects every argument error", () => {
    expect(parseArgs(["--bogus", "--root"])).toEqual({
      rootDir: undefined,
      allowEmpty: false,
      errors: ["unknown argument: --bogus", "--root requires a directory"],
    })
  })

  it("rejects a flag swallowed as the root value", () => {
    expect(parseArgs(["--root", "--allow-empty"])).toEqual({
      rootDir: undefined,
      allowEmpty: true,
      errors: ["--root requires a directory"],
    })
  })
})

describe("module graph invariants", () => {
  it("declares exactly the 23-module architecture", () => {
    expect(MODULES.size).toBe(23)
  })

  it("documents a non-empty hidden design decision for every module", () => {
    for (const [name, moduleSpec] of MODULES) {
      expect(
        moduleSpec.secret.trim().length,
        name + " must declare a non-empty secret",
      ).toBeGreaterThan(0)
    }
  })

  it("documents a distinct secret for every module", () => {
    const secrets = [...MODULES.values()].map((moduleSpec) => moduleSpec.secret)

    expect(new Set(secrets).size).toBe(MODULES.size)
  })

  it("points every dependency at a module that exists in MODULES", () => {
    for (const [name, moduleSpec] of MODULES) {
      for (const dependency of moduleSpec.allows) {
        expect(MODULES.has(dependency), name + " depends on missing module " + dependency).toBe(
          true,
        )
      }

      for (const dependency of moduleSpec.typeOnly) {
        expect(MODULES.has(dependency), name + " type-only depends on missing " + dependency).toBe(
          true,
        )
      }
    }
  })

  it("points every edge at a strictly lower level, forming a DAG", () => {
    for (const [name, moduleSpec] of MODULES) {
      for (const dependency of moduleSpec.allows) {
        const target = MODULES.get(dependency)

        expect(target, dependency + " must exist").toBeDefined()

        if (target === undefined) continue

        expect(target.level, name + " -> " + dependency + " must point downward").toBeLessThan(
          moduleSpec.level,
        )
      }
    }
  })

  it("passes the real src/ directory with no violations", () => {
    const result = checkBoundaries({ rootDir: join(import.meta.dirname, "../../src") })

    expect(result).toMatchObject({ ok: true, checkedModules: 23, violations: [] })
  })
})
