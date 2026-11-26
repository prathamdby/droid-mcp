/**
 * Permitted-root enforcement for `workspace`.
 *
 * Every admission decision is made on canonicalized paths: `realpath`
 * resolves symlinks, so a path inside an allowed root that links outside it
 * canonicalizes to a location outside the root and is denied. A root that
 * does not itself resolve is dropped at canonicalization time, so an
 * unusable configured root silently admits nothing rather than every path.
 */

import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"

import * as Option from "effect/Option"

/** Canonicalizes configured roots once at layer construction. */
export const canonicalizeRoots = (roots: ReadonlyArray<string>): ReadonlyArray<string> => {
  const canonical: Array<string> = []

  for (const root of roots) {
    try {
      canonical.push(realpathSync(resolve(root)))
    } catch {
      // An unresolvable configured root admits nothing; it is dropped here.
    }
  }

  return canonical
}

/** Canonicalizes a candidate path, or `Option.none()` when it does not resolve. */
export const canonicalizePath = (path: string): Option.Option<string> => {
  try {
    return Option.some(realpathSync(resolve(path)))
  } catch {
    return Option.none()
  }
}

/**
 * Canonicalizes the nearest existing ancestor of a path that need not exist
 * yet (a checkout parent about to be created). The canonical path of the
 * would-be location is the ancestor's canonical path plus the unresolved
 * suffix, so a symlinked ancestor still resolves truthfully. Returns
 * `Option.none()` when no ancestor exists.
 */
export const canonicalizeAncestor = (path: string): Option.Option<string> => {
  const absolute = resolve(path)
  let probe = absolute
  const suffix: Array<string> = []

  for (;;) {
    try {
      const canonical = realpathSync(probe)

      let joined = canonical

      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        joined = join(joined, suffix[index])
      }

      return Option.some(joined)
    } catch {
      const parent = dirname(probe)

      if (parent === probe) return Option.none()

      suffix.push(basename(probe))
      probe = parent
    }
  }
}

/**
 * True when `canonical` is inside one of the canonical roots. The separator
 * check refuses prefix collisions like `/srv/rootx` matching root `/srv/root`.
 */
export const insideRoots = (canonical: string, roots: ReadonlyArray<string>): boolean => {
  for (const root of roots) {
    if (canonical === root) return true

    if (canonical.startsWith(root + sep)) return true
  }

  return false
}
