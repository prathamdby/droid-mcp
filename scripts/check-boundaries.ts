/**
 * Checks the module-boundary rules under `src/`.
 *
 * Every module lives in a directory directly under the root and may only import
 * the lower modules its position in the dependency graph allows. Cross-module
 * references must enter through the target module's `index.ts`; private files
 * and deep internals of other modules are off limits. Optional-provider edges
 * are type-only so a local-only assembly never loads provider code it does not
 * need. Transport, platform, and compiler packages are restricted to the outer
 * layers so the kernel stays free of them.
 *
 * Run with `pnpm check:boundaries`.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

interface ModuleSpec {
  readonly level: number
  readonly allows: ReadonlyArray<string>
  readonly typeOnly: ReadonlyArray<string>
  /**
   * The design decision the module hides — its Parnas secret. Every module
   * exists to hide exactly one volatile decision from all the others; this
   * field names it so the decomposition stays honest and reviewable.
   */
  readonly secret: string
}

const spec = (
  level: number,
  secret: string,
  allows: ReadonlyArray<string>,
  typeOnly: ReadonlyArray<string> = [],
): ModuleSpec => ({ level, secret, allows, typeOnly })

const MODULE_SPECS: ReadonlyArray<readonly [string, ModuleSpec]> = [
  [
    "caller",
    spec(
      0,
      "how principals are admitted, authenticated and bound to conversations and owned resources",
      [],
    ),
  ],
  [
    "disclosure",
    spec(
      0,
      "which payloads may leave the system and how protected values are scrubbed for each audience",
      [],
    ),
  ],
  [
    "custody",
    spec(
      0,
      "how resources are provisionally acquired, transferred across scopes and shut down within bounded time",
      [],
    ),
  ],
  [
    "factory-dialect",
    spec(
      0,
      "the exact wire versions, method strings, encodings and peer correlation formats of the Factory protocol",
      [],
    ),
  ],
  [
    "workspace",
    spec(
      1,
      "which filesystem roots are permitted and how checkouts are isolated, borrowed and cleaned up",
      ["caller", "custody"],
    ),
  ],
  [
    "authority",
    spec(
      1,
      "how required effects are compared, narrowed and granted per principal, target and evidence strength",
      ["caller"],
    ),
  ],
  [
    "guidance",
    spec(
      1,
      "the embedded operator guide content and the proof that its root instructions were delivered",
      ["caller"],
    ),
  ],
  [
    "observations",
    spec(1, "how observations are stored, retained, paged and woken up under backpressure", [
      "disclosure",
    ]),
  ],
  [
    "artifacts",
    spec(
      1,
      "how artifacts are selected, encoded, budgeted inline, retained and continued across pages",
      ["caller", "disclosure"],
    ),
  ],
  [
    "daemon-link",
    spec(
      1,
      "how the daemon connection is dialed, authenticated, negotiated, handed off, reconnected and replayed",
      ["factory-dialect", "custody", "disclosure"],
    ),
  ],
  [
    "capabilities",
    spec(
      2,
      "how operations are typed, bound, assembled and invoked — independent of any concrete operation list",
      ["caller", "authority", "guidance", "disclosure"],
    ),
  ],
  [
    "decisions",
    spec(
      2,
      "how outstanding offers are tracked, validated against the original choices and resolved with one-winner reply rights",
      ["authority", "disclosure"],
    ),
  ],
  [
    "local-exec",
    spec(
      2,
      "how the local executable is spawned, challenged, correlated and spoken to over its typed peer protocol",
      ["factory-dialect", "custody", "workspace", "authority", "disclosure"],
    ),
  ],
  [
    "daemon-operations",
    spec(
      3,
      "which operations the daemon serves, their replay restrictions and their enforceable settings",
      [
        "capabilities",
        "daemon-link",
        "factory-dialect",
        "authority",
        "caller",
        "disclosure",
        "guidance",
      ],
    ),
  ],
  [
    "hosted-factory",
    spec(
      3,
      "which hosted operations exist at the configured origin and how their REST shapes are bound",
      ["capabilities", "authority", "caller", "disclosure", "custody", "guidance"],
    ),
  ],
  [
    "prem-context",
    spec(
      3,
      "which Context operations exist at the configured origin and how spaces, documents and session records are bound",
      ["capabilities", "authority", "caller", "disclosure", "custody", "guidance"],
    ),
  ],
  [
    "placement",
    spec(
      4,
      "how a runnable provider is selected and a live lease is bound to caller, grant, workspace and credential",
      [
        "local-exec",
        "daemon-operations",
        "hosted-factory",
        "caller",
        "authority",
        "workspace",
        "custody",
      ],
      ["daemon-operations", "hosted-factory"],
    ),
  ],
  [
    "turns",
    spec(
      5,
      "how turn lifecycles race, reconcile completion, snapshot observations atomically and interrupt honestly",
      ["placement", "decisions", "observations", "authority", "disclosure", "custody"],
    ),
  ],
  [
    "sessions",
    spec(
      6,
      "how public session references are owned, filtered per caller, subscribed to and retained after completion",
      [
        "turns",
        "placement",
        "caller",
        "authority",
        "custody",
        "capabilities",
        "disclosure",
        "guidance",
        "observations",
        "decisions",
      ],
    ),
  ],
  [
    "presentation",
    spec(
      7,
      "how operations are ranked, aliased, composed into compact or full views and recovered in sequential batches",
      [
        "capabilities",
        "sessions",
        "artifacts",
        "guidance",
        "daemon-operations",
        "hosted-factory",
        "prem-context",
      ],
      ["daemon-operations", "hosted-factory", "prem-context"],
    ),
  ],
  [
    "mcp",
    spec(
      8,
      "the MCP negotiation, tool, resource, prompt and notification encodings exposed to clients",
      [
        "presentation",
        "sessions",
        "caller",
        "guidance",
        "artifacts",
        "observations",
        "decisions",
        "capabilities",
      ],
    ),
  ],
]

const lowerModules = MODULE_SPECS.map(([name]) => name)

export const MODULES: ReadonlyMap<string, ModuleSpec> = new Map([
  ...MODULE_SPECS,
  [
    "products",
    spec(
      9,
      "operator configuration, ambient process state, transport carriers and product lifecycle wiring",
      lowerModules,
    ),
  ],
])

/** Compiler internals, module loaders and dynamic evaluation no module may touch. */
const UNIVERSAL_BANS: ReadonlyArray<string> = [
  "typescript",
  "node:module",
  "module",
  "node:vm",
  "vm",
]

/** Transport and platform packages anything below the product layer must never see. */
const TRANSPORT_BANS: ReadonlyArray<string> = [
  "effect/http",
  "node:http",
  "http",
  "node:https",
  "https",
  "node:http2",
  "http2",
  "@effect/platform-node",
]

/** Toolkit packages the kernel must never see. */
const TOOLKIT_BANS: ReadonlyArray<string> = ["effect/ai"]

const bannedSpecifier = (specifier: string, banned: string): boolean =>
  specifier === banned || specifier.startsWith(banned + "/") || specifier.startsWith(banned + "-")

/** Node's hidden HTTP builtins load the transport implementation directly. */
const isHiddenHttpBuiltin = (specifier: string): boolean => {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier

  return bare.startsWith("_http_")
}

export interface BoundaryViolation {
  readonly rule: string
  readonly file: string
  readonly line: number
  readonly detail: string
}

export interface BoundaryResult {
  readonly ok: boolean
  readonly checkedModules: number
  readonly checkedFiles: number
  readonly checkedImports: number
  readonly violations: ReadonlyArray<BoundaryViolation>
}

export interface CheckBoundariesOptions {
  readonly rootDir?: string | undefined
  readonly allowEmpty?: boolean | undefined
}

interface ModuleReference {
  readonly specifier: string
  readonly line: number
  readonly literal: boolean
  readonly requireCall: boolean
  readonly typeOnly: boolean
  readonly reExport: boolean
  readonly wildcardExport: boolean
}

interface ReferenceScan {
  readonly references: Array<ModuleReference>
  readonly importedNames: ReadonlyMap<string, string>
}

const literalString = (expression: ts.Expression): string | undefined =>
  ts.isStringLiteral(expression) ? expression.text : undefined

const isRequireCallee = (expression: ts.Expression): boolean =>
  ts.isIdentifier(expression) && expression.text === "require"

const isCreateRequireCallee = (expression: ts.Expression): boolean => {
  if (ts.isIdentifier(expression)) return expression.text === "createRequire"

  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "createRequire"

  return (
    ts.isElementAccessExpression(expression) &&
    literalString(expression.argumentExpression) === "createRequire"
  )
}

const isGetBuiltinModuleCallee = (expression: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  expression.expression.text === "process" &&
  expression.name.text === "getBuiltinModule"

const isImportMetaUrl = (expression: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expression) &&
  ts.isMetaProperty(expression.expression) &&
  expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
  expression.name.text === "url"

const isDynamicCodeCallee = (expression: ts.Expression): boolean =>
  ts.isIdentifier(expression) && (expression.text === "eval" || expression.text === "Function")

/** A variable declaration initialized to a `require(...)` or `createRequire(...)` call. */
const variableDeclarationRequire = (node: ts.Node): ts.Node | undefined => {
  if (!ts.isVariableDeclaration(node)) return undefined

  const initializer = node.initializer

  if (initializer === undefined || !ts.isCallExpression(initializer)) return undefined

  if (isRequireCallee(initializer.expression) || isCreateRequireCallee(initializer.expression)) {
    return node
  }

  return undefined
}

/** Names a property, element or binding position that mentions `createRequire`. */
const mentionsCreateRequire = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "createRequire"

  if (ts.isElementAccessExpression(node)) {
    return literalString(node.argumentExpression) === "createRequire"
  }

  if (ts.isBindingElement(node)) {
    const propertyName = node.propertyName ?? node.name

    return ts.isIdentifier(propertyName) && propertyName.text === "createRequire"
  }

  return false
}

const scanReferences = (source: ts.SourceFile): ReferenceScan => {
  const references: Array<ModuleReference> = []
  const importedNames = new Map<string, string>()

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const push = (
    specifier: string,
    node: ts.Node,
    requireCall: boolean,
    typeOnly: boolean,
    reExport: boolean,
    wildcardExport: boolean = false,
  ): void => {
    references.push({
      specifier,
      line: lineOf(node),
      literal: true,
      requireCall,
      typeOnly,
      reExport,
      wildcardExport,
    })
  }

  const pushModule = (specifier: string, node: ts.Node, typeOnly: boolean): void => {
    push(specifier, node, false, typeOnly, false)
  }

  const pushNonLiteral = (node: ts.Node): void => {
    references.push({
      specifier: "",
      line: lineOf(node),
      literal: false,
      requireCall: false,
      typeOnly: false,
      reExport: false,
      wildcardExport: false,
    })
  }

  const pushRequire = (node: ts.Node): void => {
    references.push({
      specifier: "",
      line: lineOf(node),
      literal: true,
      requireCall: true,
      typeOnly: false,
      reExport: false,
      wildcardExport: false,
    })
  }

  const rememberImportNames = (specifier: string, clause: ts.ImportClause | undefined): void => {
    if (clause === undefined) return

    if (clause.name !== undefined) importedNames.set(clause.name.text, specifier)

    const bindings = clause.namedBindings

    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        importedNames.set(element.name.text, specifier)
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text

        pushModule(specifier, node.moduleSpecifier, node.importClause?.isTypeOnly === true)
        rememberImportNames(specifier, node.importClause)
      }
    } else if (ts.isExportDeclaration(node)) {
      const target = node.moduleSpecifier

      if (target !== undefined && ts.isStringLiteral(target)) {
        // `export *` (no export clause) and `export * as ns` forward every
        // present and future name of the target, so the module no longer
        // controls its own interface — flag them independently of where they
        // point. Selective `export { x }` clauses are checked elsewhere.
        const isWildcard =
          node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)

        push(target.text, target, false, node.isTypeOnly, true, isWildcard)
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        pushRequire(node)
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument

      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        pushModule(argument.literal.text, argument.literal, true)
      } else {
        pushNonLiteral(node)
      }
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      pushModule(node.name.text, node.name, false)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments

        if (argument !== undefined && ts.isStringLiteral(argument)) {
          pushModule(argument.text, argument, false)
        } else {
          pushNonLiteral(node)
        }
      } else if (isRequireCallee(node.expression) || isCreateRequireCallee(node.expression)) {
        pushRequire(node)
      } else if (isGetBuiltinModuleCallee(node.expression)) {
        const [argument] = node.arguments
        const text = argument === undefined ? undefined : literalString(argument)

        if (text === undefined || argument === undefined) {
          pushNonLiteral(node)
        } else {
          pushModule(text, argument, false)
        }
      } else if (isDynamicCodeCallee(node.expression)) {
        push("__dynamic_code__", node, false, false, false)
      }
    } else if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "Function") {
        push("__dynamic_code__", node, false, false, false)
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "URL") {
        const args = node.arguments ?? []

        if (args.length === 2) {
          const base = args[1]

          if (base !== undefined && isImportMetaUrl(base)) {
            const first = args[0]

            if (first !== undefined && ts.isStringLiteral(first)) {
              pushModule(first.text, first, false)
            } else {
              pushNonLiteral(node)
            }
          }
        }
      }
    } else {
      if (variableDeclarationRequire(node) !== undefined || mentionsCreateRequire(node)) {
        pushRequire(node)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return { references, importedNames }
}

interface FileEntry {
  readonly absolutePath: string
  readonly moduleName: string
}

interface FileProblem {
  readonly rule: string
  readonly file: string
  readonly detail: string
}

interface FileScan {
  readonly files: Array<FileEntry>
  readonly problems: Array<FileProblem>
}

const scanModuleFiles = (rootDir: string, moduleName: string): FileScan => {
  const files: Array<FileEntry> = []
  const problems: Array<FileProblem> = []
  const moduleRoot = join(rootDir, moduleName)

  const walk = (directory: string, segments: ReadonlyArray<string>): void => {
    let entries

    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      problems.push({
        rule: "unreadable_file",
        file: [moduleName, ...segments].join("/") + "/",
        detail: "directory could not be read",
      })

      return
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      const relative = [moduleName, ...segments, entry.name].join("/")

      if (entry.isSymbolicLink()) {
        problems.push({
          rule: "symlink_forbidden",
          file: relative,
          detail: "symlinks are forbidden inside the module root",
        })

        continue
      }

      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          problems.push({
            rule: "nested_node_modules",
            file: relative + "/",
            detail: "nested node_modules directories are forbidden inside a module",
          })

          continue
        }

        walk(path, [...segments, entry.name])

        continue
      }

      if (!entry.isFile()) continue

      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push({ absolutePath: path, moduleName })
      } else {
        problems.push({
          rule: "unsupported_file",
          file: relative,
          detail: "only plain .ts source files are allowed inside a module",
        })
      }
    }
  }

  walk(moduleRoot, [])

  return { files, problems }
}

const decodeSpecifier = (specifier: string): string | undefined => {
  if (!specifier.includes("%")) return specifier

  try {
    return decodeURIComponent(specifier)
  } catch {
    return undefined
  }
}

interface LocalResolution {
  readonly path: string | undefined
  readonly error: string | undefined
}

/** Resolves a local specifier (relative, absolute or file: URL) to a filesystem path. */
const resolveLocal = (specifier: string, fromFile: string): LocalResolution => {
  if (specifier.startsWith("file:")) {
    try {
      return { path: normalize(fileURLToPath(specifier)), error: undefined }
    } catch {
      return { path: undefined, error: '"' + specifier + '" is not a valid file: URL' }
    }
  }

  const decoded = decodeSpecifier(specifier)

  if (decoded === undefined) {
    return { path: undefined, error: '"' + specifier + '" has malformed percent escapes' }
  }

  if (specifier.startsWith("/")) {
    return { path: normalize(decoded), error: undefined }
  }

  const base = resolve(dirname(fromFile), decoded)

  if (/\.(ts|mts|js|mjs|json)$/.test(decoded)) return { path: normalize(base), error: undefined }

  for (const candidate of [base + ".ts", join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return { path: normalize(candidate), error: undefined }
    } catch {
      // fall through: unresolved paths are still checked as literal paths
    }
  }

  return { path: normalize(base), error: undefined }
}

const isLocalSpecifier = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../") ||
  specifier.startsWith("/") ||
  specifier.startsWith("file:")

const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Containment check that follows symlinks when the target exists. */
const escapesRoot = (path: string, rootDir: string): boolean => {
  let realRoot = rootDir

  try {
    realRoot = realpathSync(rootDir)
  } catch {
    // the root itself is already validated; fall back to the lexical form
  }

  const candidates: Array<string> = [path]

  try {
    candidates.push(realpathSync(path))
  } catch {
    // the target does not exist; lexical containment is all that can be checked
  }

  for (const candidate of candidates) {
    if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) return true
  }

  return false
}

export interface CliParse {
  readonly rootDir: string | undefined
  readonly allowEmpty: boolean
  readonly errors: ReadonlyArray<string>
}

export const parseArgs = (argv: ReadonlyArray<string>): CliParse => {
  let rootDir: string | undefined
  let allowEmpty = false
  const errors: Array<string> = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === "--allow-empty") {
      allowEmpty = true
    } else if (argument === "--root") {
      const value = argv[index + 1]

      if (value === undefined || value.startsWith("--")) {
        errors.push("--root requires a directory")
      } else {
        rootDir = value
        index += 1
      }
    } else if (argument !== undefined && argument.startsWith("--root=")) {
      const value = argument.slice("--root=".length)

      if (value.length === 0) {
        errors.push("--root requires a directory")
      } else {
        rootDir = value
      }
    } else {
      errors.push("unknown argument: " + String(argument))
    }
  }

  return { rootDir, allowEmpty, errors }
}

type RecordViolation = (rule: string, file: string, line: number, detail: string) => void

const checkExternalSpecifier = (
  record: RecordViolation,
  specifier: string,
  level: number,
  relative: string,
  line: number,
): void => {
  const universal = UNIVERSAL_BANS.find((banned) => bannedSpecifier(specifier, banned))

  if (universal !== undefined) {
    record(
      "banned_external_import",
      relative,
      line,
      '"' + specifier + '" is forbidden in every module',
    )

    return
  }

  if (level <= 8) {
    if (isHiddenHttpBuiltin(specifier)) {
      record("kernel_impurity", relative, line, '"' + specifier + '" is forbidden below level 9')

      return
    }

    const transport = TRANSPORT_BANS.find((candidate) => bannedSpecifier(specifier, candidate))

    if (transport !== undefined) {
      record("kernel_impurity", relative, line, '"' + specifier + '" is forbidden below level 9')

      return
    }
  }

  if (level <= 7) {
    const toolkit = TOOLKIT_BANS.find((candidate) => bannedSpecifier(specifier, candidate))

    if (toolkit !== undefined) {
      record("kernel_impurity", relative, line, '"' + specifier + '" is forbidden below level 8')
    }
  }
}

const checkReference = (
  record: RecordViolation,
  reference: ModuleReference,
  moduleName: string,
  spec: ModuleSpec,
  rootDir: string,
  fromFile: string,
  relative: string,
): void => {
  if (!reference.literal) {
    record(
      "non_literal_import",
      relative,
      reference.line,
      "dynamic module reference must use a string literal",
    )

    return
  }

  if (reference.requireCall) {
    record(
      "require_forbidden",
      relative,
      reference.line,
      "require and createRequire are forbidden inside the module root",
    )

    return
  }

  const specifier = reference.specifier

  if (reference.wildcardExport) {
    record(
      "wildcard_export",
      relative,
      reference.line,
      "export * forwards every present and future name of the target; name each exported symbol explicitly",
    )

    return
  }

  if (specifier === "__dynamic_code__") {
    record(
      "dynamic_code_forbidden",
      relative,
      reference.line,
      "eval, Function and new Function are forbidden inside the module root",
    )

    return
  }

  if (specifier.startsWith("#")) {
    record(
      "subpath_import_forbidden",
      relative,
      reference.line,
      '"' + specifier + '" is a package alias',
    )

    return
  }

  if (!isLocalSpecifier(specifier)) {
    checkExternalSpecifier(record, specifier, spec.level, relative, reference.line)

    return
  }

  const resolution = resolveLocal(specifier, fromFile)

  if (resolution.path === undefined) {
    record("legacy_escape", relative, reference.line, resolution.error ?? "unresolvable specifier")

    return
  }

  const resolved = resolution.path

  if (escapesRoot(resolved, rootDir)) {
    record("legacy_escape", relative, reference.line, '"' + specifier + '" escapes the module root')

    return
  }

  const inner = resolved.slice(rootDir.length + 1)
  const targetModule = inner.split(sep)[0]

  if (targetModule === undefined || !MODULES.has(targetModule)) {
    record(
      "unknown_target",
      relative,
      reference.line,
      '"' +
        specifier +
        '" targets a directory that is not one of the ' +
        String(MODULES.size) +
        " known modules",
    )

    return
  }

  if (targetModule === moduleName) return

  if (!spec.allows.includes(targetModule)) {
    record(
      "disallowed_dependency",
      relative,
      reference.line,
      moduleName + " may not import " + targetModule,
    )

    return
  }

  if (!specifier.endsWith(".ts")) {
    record(
      "missing_extension",
      relative,
      reference.line,
      '"' + specifier + '" must name a .ts file explicitly',
    )

    return
  }

  if (inner !== join(targetModule, "index.ts")) {
    record(
      "private_entrypoint",
      relative,
      reference.line,
      '"' + specifier + '" must resolve to ' + targetModule + "/index.ts",
    )

    return
  }

  if (spec.typeOnly.includes(targetModule) && !reference.typeOnly) {
    record(
      "type_only_dependency",
      relative,
      reference.line,
      moduleName + " may import " + targetModule + " only through import type",
    )

    return
  }

  if (!fileExists(resolved)) {
    record(
      "missing_target_file",
      relative,
      reference.line,
      '"' + specifier + '" resolves to a file that does not exist',
    )

    return
  }

  if (reference.reExport) {
    record(
      "reexport_forbidden",
      relative,
      reference.line,
      "re-exporting another module launders its transitive dependencies",
    )
  }
}

/** A local `export { X }` or `export default X` of a cross-module import launders the edge. */
const checkLocalReExportLaundering = (
  record: RecordViolation,
  source: ts.SourceFile,
  importedNames: ReadonlyMap<string, string>,
  rootDir: string,
  fromFile: string,
  relative: string,
): void => {
  if (importedNames.size === 0) return

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const isCrossModule = (specifier: string): boolean => {
    if (!isLocalSpecifier(specifier)) return false

    const resolution = resolveLocal(specifier, fromFile)

    if (resolution.path === undefined) return false

    if (escapesRoot(resolution.path, rootDir)) return false

    const inner = resolution.path.slice(rootDir.length + 1)
    const targetModule = inner.split(sep)[0]

    return targetModule !== undefined && targetModule !== relative.split("/")[0]
  }

  const report = (node: ts.Node, name: string): void => {
    record(
      "reexport_forbidden",
      relative,
      lineOf(node),
      're-exporting "' + name + '" launders a cross-module dependency',
    )
  }

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier !== undefined) continue

      const clause = statement.exportClause

      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const local = element.propertyName?.text ?? element.name.text
          const origin = importedNames.get(local)

          if (origin !== undefined && isCrossModule(origin)) report(element, local)
        }
      }

      continue
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression

      if (ts.isIdentifier(expression)) {
        const origin = importedNames.get(expression.text)

        if (origin !== undefined && isCrossModule(origin)) report(statement, expression.text)
      }
    }
  }
}

export const checkBoundaries = (options: CheckBoundariesOptions): BoundaryResult => {
  const rootDir = resolve(options.rootDir ?? "src")
  const violations: Array<BoundaryViolation> = []

  const record: RecordViolation = (rule, file, line, detail) => {
    violations.push({ rule, file, line, detail })
  }

  if (!isDirectory(rootDir)) {
    record("missing_root", basename(rootDir) + "/", 0, "the module root does not exist")

    return { ok: false, checkedModules: 0, checkedFiles: 0, checkedImports: 0, violations }
  }

  let entries: Array<string>

  try {
    entries = readdirSync(rootDir).sort()
  } catch {
    entries = []
  }

  const moduleEntries: Array<string> = []

  for (const entry of entries) {
    let entryStat

    try {
      entryStat = lstatSync(join(rootDir, entry))
    } catch {
      record("unreadable_file", entry, 0, "entry could not be inspected")

      continue
    }

    if (entryStat.isSymbolicLink()) {
      record("symlink_forbidden", entry, 0, "symlinks are forbidden inside the module root")

      continue
    }

    if (!entryStat.isDirectory()) {
      record("unknown_top_level_entry", entry, 0, "stray file directly under the module root")

      continue
    }

    if (!MODULES.has(entry)) {
      record(
        "unknown_module",
        entry,
        0,
        "directory is not one of the " + String(MODULES.size) + " known modules",
      )

      continue
    }

    moduleEntries.push(entry)
  }

  const files: Array<FileEntry> = []

  for (const entry of moduleEntries) {
    const scan = scanModuleFiles(rootDir, entry)

    for (const problem of scan.problems) {
      record(problem.rule, problem.file, 0, problem.detail)
    }

    files.push(...scan.files)
  }

  let checkedImports = 0

  for (const file of files) {
    const offset = rootDir.length + 1
    const relative = file.absolutePath.slice(offset).split(sep).join("/")
    const moduleName = file.moduleName
    const moduleSpec = MODULES.get(moduleName)

    if (moduleSpec === undefined) continue

    let text = ""

    try {
      text = readFileSync(file.absolutePath, "utf8")
    } catch {
      record("unreadable_file", relative, 0, "file could not be read")

      continue
    }

    const source = ts.createSourceFile(file.absolutePath, text, ts.ScriptTarget.ESNext, true)

    const recordDirective = (directive: ts.FileReference, kind: string): void => {
      record(
        "reference_directive_forbidden",
        relative,
        source.getLineAndCharacterOfPosition(directive.pos).line + 1,
        "/// <reference " +
          kind +
          '="' +
          directive.fileName +
          '" /> is forbidden inside the module root',
      )
    }

    for (const directive of source.referencedFiles) {
      recordDirective(directive, "path")
    }

    for (const directive of source.typeReferenceDirectives) {
      recordDirective(directive, "types")
    }

    for (const directive of source.libReferenceDirectives) {
      recordDirective(directive, "lib")
    }

    const scan = scanReferences(source)

    for (const reference of scan.references) {
      checkedImports += 1
      checkReference(
        record,
        reference,
        moduleName,
        moduleSpec,
        rootDir,
        file.absolutePath,
        relative,
      )
    }

    checkLocalReExportLaundering(
      record,
      source,
      scan.importedNames,
      rootDir,
      file.absolutePath,
      relative,
    )
  }

  if (files.length === 0 && options.allowEmpty !== true && violations.length === 0) {
    record("empty_root", basename(rootDir) + "/", 0, "no source files found under the module root")
  }

  return {
    ok: violations.length === 0,
    checkedModules: moduleEntries.length,
    checkedFiles: files.length,
    checkedImports,
    violations,
  }
}

const isMain = (): boolean => {
  const argv = process.argv[1]

  if (argv === undefined) return false

  try {
    return realpathSync(resolve(argv)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const cli = parseArgs(process.argv.slice(2))

  if (cli.errors.length > 0) {
    for (const error of cli.errors) {
      process.stderr.write("check-boundaries: " + error + "\n")
    }

    process.exit(1)
  }

  const result = checkBoundaries({ rootDir: cli.rootDir, allowEmpty: cli.allowEmpty })

  process.stdout.write(
    JSON.stringify({
      checkedModules: result.checkedModules,
      checkedFiles: result.checkedFiles,
      checkedImports: result.checkedImports,
      violations: result.violations,
    }) + "\n",
  )

  process.exit(result.ok ? 0 : 1)
}
