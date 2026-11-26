/**
 * Shared filename classification helpers for the modularity plugin.
 *
 * The repository decomposes `src/` into modules at `src/<module>/`; each
 * module exposes exactly one public entry, `src/<module>/index.ts`, and keeps
 * everything else inside `src/<module>/private/`. The rules in this plugin
 * classify the linted file once from `context.filename` so they can decide
 * which specifier shapes are legal.
 */

/** Normalize every path separator to `/` so the checks hold on any platform. */
export function normalizeFilename(filename: string): string {
  return filename.replaceAll("\\", "/")
}

/** True when the linted file lives anywhere under the module root `src/`. */
export function isInsideSrc(filename: string): boolean {
  return /(?:^|\/)src\//.test(normalizeFilename(filename))
}

/** True when the linted file lives under the product composition root. */
export function isInsideProducts(filename: string): boolean {
  return /(?:^|\/)src\/products\//.test(normalizeFilename(filename))
}

/**
 * The module directory containing the linted file, e.g. `local-exec` for
 * `src/local-exec/private/process.ts`, or `null` outside `src/`.
 */
export function moduleNameOf(filename: string): string | null {
  const match = /(?:^|\/)src\/([^/]+)\//.exec(normalizeFilename(filename))
  return match?.[1] ?? null
}

/**
 * The path of the linted file relative to its module directory, e.g.
 * `private/process.ts` or `index.ts`, or `null` outside `src/`.
 */
export function pathWithinModule(filename: string): string | null {
  const match = /(?:^|\/)src\/[^/]+\/(.+)$/.exec(normalizeFilename(filename))
  return match?.[1] ?? null
}

/**
 * True when the linted file is a module's public entry `src/<module>/index.ts`.
 * Note this deliberately matches a directory exactly one level below `src/`:
 * `src/products/index.ts` qualifies, nested files never do.
 */
export function isModuleEntrypoint(filename: string): boolean {
  return /(?:^|\/)src\/[^/]+\/index\.ts$/.test(normalizeFilename(filename))
}

/**
 * Resolve a local specifier (starting with `./` or `../`) against the linted
 * file inside `src/` and decide whether it crosses into another module's
 * private interior or escapes the module root entirely.
 *
 * Returns `null` when the specifier is fine: same-module relative references
 * (including `./private/...` from a module's own `index.ts` and sibling
 * references between private files) and non-local package specifiers.
 */
export function classifyLocalSpecifier(
  filename: string,
  specifier: string,
): "cross_module_private" | "escapes_src" | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null

  const normalized = normalizeFilename(filename)
  const sourceMatch = /^(.*\/)?src\/([^/]+)\/(.+)$/.exec(normalized)
  if (sourceMatch === null) return null

  const sourceModule = sourceMatch[2]
  const sourceFileInModule = sourceMatch[3] ?? ""

  // The importing file's own directory, as segments relative to `src/<module>/`.
  const fileSegments = sourceFileInModule.split("/")
  const directorySegments = fileSegments.slice(0, -1)

  // Walk the specifier segment by segment. `depth` is the directory position
  // relative to the module root `src/<module>/`: positive inside the module,
  // zero at the module directory itself, negative above it. Once the path
  // climbs above the module root it has escaped the module; every following
  // segment is part of the target path outside the module, no matter how the
  // depth arithmetic works out.
  let depth = directorySegments.length
  let upCount = 0
  let escaped = false
  const targetSegments: Array<string> = []

  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue
    if (segment === "..") {
      depth -= 1
      if (depth < 0) {
        escaped = true
        upCount = Math.max(upCount, -depth)
      }
    } else {
      if (escaped) targetSegments.push(segment)
      depth += 1
    }
  }

  if (upCount === 0) return null // stays inside the importing module

  // Levels climbed above `src/<module>`:
  //   exactly 1 -> sibling module under src/ (or src itself)
  //   2 or more -> escapes the module root entirely
  if (upCount >= 2) return "escapes_src"

  const targetModule = targetSegments[0]

  if (targetModule === undefined) {
    // The specifier resolves into `src/` itself (no module directory).
    return "escapes_src"
  }

  if (targetModule === sourceModule) return null // a long way back into the same module

  if (targetSegments[1] === "private") return "cross_module_private"

  return null
}
