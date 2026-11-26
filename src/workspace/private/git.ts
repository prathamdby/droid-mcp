/**
 * Isolated-checkout execution for `workspace`.
 *
 * Every command runs through `execFile` with a fixed argument vector — never
 * a shell — inside the already-canonicalized repository directory. Ref names
 * are validated against the same rules as a strict reference parser before
 * they reach the command line, and every ref is verified to resolve before
 * it is used. Removal is confined to the exact checkout path this module
 * created; the source repository directory is never an argument to removal.
 */

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const execFileAsync = promisify(execFile)

export class GitError extends Error {
  readonly _tag = "GitError"
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.reason = reason
    this.name = "GitError"
  }
}

export type BranchMode = "copy" | "existing"

export interface IsolatedSpec {
  /** Canonicalized repository directory. */
  readonly repoPath: string
  /** Canonicalized parent directory the checkout is created inside. */
  readonly worktreeParent: string
  readonly branchMode: BranchMode
  readonly baseBranch?: string | undefined
  readonly baseBranchFromOrigin?: boolean | undefined
  readonly newBranch?: string | undefined
}

export interface IsolatedResult {
  /** Canonicalized absolute path of the created checkout directory. */
  readonly path: string
  readonly branch: string
}

const stderrOf = (cause: Error): string => {
  if (!("stderr" in cause)) return ""

  const stderr: unknown = cause.stderr

  return Schema.is(Schema.String)(stderr) ? stderr.trim() : ""
}

const gitFailure = (cause: unknown): GitError => {
  if (!(cause instanceof Error)) return new GitError("git command failed")

  const stderr = stderrOf(cause)

  return new GitError(stderr.length > 0 ? stderr : cause.message)
}

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<{ readonly stdout: string }, GitError> =>
  Effect.tryPromise({
    try: () =>
      execFileAsync("git", [...args], {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }),
    catch: gitFailure,
  })

/**
 * Strict ref-name validation: rejects anything a reference parser would
 * treat as an option, a path escape or a malformed ref before it reaches a
 * command line.
 */
const refName = (value: string): string | undefined => {
  if (value.length === 0 || value.length > 128) return undefined

  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return undefined

  if (value.includes("..") || value.includes("//") || value.endsWith(".lock")) return undefined

  if (/[\s~^:?*[\\]/.test(value)) return undefined

  return value
}

const requireRef = (label: string, value: string): Effect.Effect<string, GitError> => {
  const name = refName(value)

  return name === undefined
    ? Effect.fail(new GitError(label + " is not a safe ref name: " + value))
    : Effect.succeed(name)
}

const verifyRef = (repo: string, ref: string): Effect.Effect<void, GitError> =>
  git(repo, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]).pipe(
    Effect.asVoid,
    Effect.mapError(() => new GitError("ref does not resolve: " + ref)),
  )

const newToken = (): string => randomBytes(5).toString("hex")

/**
 * Creates one isolated checkout. The caller has already canonicalized and
 * admitted every input path; this module never decides admission itself.
 */
export const createIsolatedCheckout = (
  spec: IsolatedSpec,
): Effect.Effect<IsolatedResult, GitError> =>
  Effect.gen(function* () {
    if (!isAbsolute(spec.repoPath)) {
      return yield* Effect.fail(new GitError("repoPath must be an absolute path"))
    }

    if (!isAbsolute(spec.worktreeParent)) {
      return yield* Effect.fail(new GitError("worktreeDir must be an absolute path"))
    }

    yield* git(spec.repoPath, ["rev-parse", "--git-dir"]).pipe(
      Effect.mapError(() => new GitError("not a git repository: " + spec.repoPath)),
    )

    const token = newToken()

    const branch =
      spec.newBranch !== undefined
        ? yield* requireRef("newBranch", spec.newBranch)
        : spec.branchMode === "existing"
          ? yield* Effect.fail(new GitError("existing branch mode requires newBranch"))
          : "ws/" + token

    const start =
      spec.baseBranch === undefined
        ? "HEAD"
        : spec.baseBranchFromOrigin === true
          ? "origin/" + (yield* requireRef("baseBranch", spec.baseBranch))
          : yield* requireRef("baseBranch", spec.baseBranch)

    if (spec.branchMode === "copy") yield* verifyRef(spec.repoPath, start)

    if (spec.branchMode === "existing") yield* verifyRef(spec.repoPath, branch)

    yield* Effect.try({
      try: () => {
        mkdirSync(spec.worktreeParent, { recursive: true })
      },
      catch: (cause) =>
        new GitError(cause instanceof Error ? cause.message : "cannot create checkout parent"),
    })

    const path = join(spec.worktreeParent, token)

    const args =
      spec.branchMode === "existing"
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, start]

    yield* git(spec.repoPath, args)

    return { path, branch }
  })

/**
 * Removes exactly the checkout directory created by `createIsolatedCheckout`.
 * The effect never fails: checkout removal is a best-effort final step, and
 * a directory that is already gone is indistinguishable from a success.
 */
export const removeIsolatedCheckout = (spec: {
  readonly repoPath: string
  readonly path: string
}): Effect.Effect<void> =>
  git(spec.repoPath, ["worktree", "remove", "--force", spec.path]).pipe(
    Effect.ignore,
    Effect.asVoid,
  )
