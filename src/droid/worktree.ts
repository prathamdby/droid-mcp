import { execFile } from "node:child_process"
import { mkdirSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const execFileAsync = promisify(execFile)

export class WorktreeProblem extends Schema.TaggedError<WorktreeProblem>()("WorktreeProblem", {
  code: Schema.String,
  message: Schema.String,
}) {}

export const WORKTREE_LIFECYCLES = ["ephemeral", "persistent"] as const
export const WORKTREE_BRANCH_MODES = ["copy", "existing"] as const

export type WorktreeLifecycle = (typeof WORKTREE_LIFECYCLES)[number]

export type WorktreeBranchMode = (typeof WORKTREE_BRANCH_MODES)[number]

export interface WorktreeFields {
  readonly worktree?: boolean
  readonly worktreeLifecycle?: WorktreeLifecycle
  readonly worktreeBranchMode?: WorktreeBranchMode
  readonly worktreeBaseBranch?: string
  readonly worktreeBaseBranchFromOrigin?: boolean
  readonly worktreeNewBranch?: string
  readonly worktreeDir?: string
}

export interface Worktree {
  readonly path: string
  readonly branch: string
  readonly lifecycle: WorktreeLifecycle
  readonly repo: string
}

const problem = (code: string, message: string): WorktreeProblem =>
  new WorktreeProblem({ code, message })

const stderrOf = (cause: Error): string => {
  if (!("stderr" in cause)) return ""

  const stderr = cause.stderr

  return Schema.is(Schema.String)(stderr) ? stderr.trim() : ""
}

const gitFailure = (cause: unknown): WorktreeProblem => {
  if (!(cause instanceof Error)) return problem("worktree_failed", "git failed")

  const stderr = stderrOf(cause)

  return problem("worktree_failed", stderr.length > 0 ? stderr : cause.message)
}

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<{ readonly stdout: string }, WorktreeProblem> =>
  Effect.tryPromise({
    try: () =>
      execFileAsync("git", [...args], {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }),
    catch: gitFailure,
  })

const refName = (value: string): string | undefined => {
  if (value.length === 0 || value.length > 128) return undefined

  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return undefined

  if (value.includes("..") || value.includes("//") || value.endsWith(".lock")) return undefined

  if (/[\s~^:?*[\\]/.test(value)) return undefined

  return value
}

const requireRef = (label: string, value: string): Effect.Effect<string, WorktreeProblem> => {
  const name = refName(value)

  return name === undefined
    ? Effect.fail(problem("invalid_worktree", label + " is not a safe git ref: " + value))
    : Effect.succeed(name)
}

const repoRoot = (cwd: string): Effect.Effect<string, WorktreeProblem> =>
  git(cwd, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.mapError(() =>
      problem("invalid_worktree", "cwd is not inside a git repository: " + cwd),
    ),
  )

const commonDir = (repo: string): Effect.Effect<string, WorktreeProblem> =>
  git(repo, ["rev-parse", "--git-common-dir"]).pipe(
    Effect.map((result) => {
      const raw = result.stdout.trim()

      return isAbsolute(raw) ? raw : resolve(repo, raw)
    }),
  )

const verifyRef = (repo: string, ref: string): Effect.Effect<void, WorktreeProblem> =>
  git(repo, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]).pipe(
    Effect.asVoid,
    Effect.mapError(() => problem("invalid_worktree", "git ref does not exist: " + ref)),
  )

const randomId = (): string => Math.random().toString(16).slice(2, 10)

export const removeWorktree = (tree: Worktree): Effect.Effect<void> =>
  git(tree.repo, ["worktree", "remove", "--force", tree.path]).pipe(Effect.ignore, Effect.asVoid)

/**
 * Creates a git worktree when `fields.worktree` is true. Other worktree fields
 * without that flag are a mistake, not a silent no-op.
 */
export const createWorktree = (
  cwd: string,
  fields: WorktreeFields,
): Effect.Effect<Worktree | undefined, WorktreeProblem> =>
  Effect.gen(function* () {
    const extras =
      fields.worktreeLifecycle !== undefined ||
      fields.worktreeBranchMode !== undefined ||
      fields.worktreeBaseBranch !== undefined ||
      fields.worktreeBaseBranchFromOrigin !== undefined ||
      fields.worktreeNewBranch !== undefined ||
      fields.worktreeDir !== undefined

    if (fields.worktree !== true) {
      if (extras) {
        return yield* Effect.fail(
          problem("invalid_worktree", "set worktree: true to use the other worktree fields"),
        )
      }

      return undefined
    }

    const repo = yield* repoRoot(cwd)
    const lifecycle = fields.worktreeLifecycle ?? "ephemeral"
    const mode = fields.worktreeBranchMode ?? "copy"

    const parent =
      fields.worktreeDir !== undefined
        ? fields.worktreeDir
        : join(yield* commonDir(repo), "droid-mcp-worktrees")

    if (!isAbsolute(parent)) {
      return yield* Effect.fail(problem("invalid_worktree", "worktreeDir must be an absolute path"))
    }

    const id = randomId()

    const branch =
      fields.worktreeNewBranch !== undefined
        ? yield* requireRef("worktreeNewBranch", fields.worktreeNewBranch)
        : mode === "existing"
          ? yield* Effect.fail(
              problem("invalid_worktree", "existing branch mode needs worktreeNewBranch"),
            )
          : "droid-mcp/" + id

    const start =
      fields.worktreeBaseBranch === undefined
        ? "HEAD"
        : fields.worktreeBaseBranchFromOrigin === true
          ? "origin/" + (yield* requireRef("worktreeBaseBranch", fields.worktreeBaseBranch))
          : yield* requireRef("worktreeBaseBranch", fields.worktreeBaseBranch)

    if (mode === "copy") yield* verifyRef(repo, start)

    if (mode === "existing") yield* verifyRef(repo, branch)

    yield* Effect.try({
      try: () => {
        mkdirSync(parent, { recursive: true })
      },
      catch: (cause) =>
        problem(
          "invalid_worktree",
          cause instanceof Error ? cause.message : "cannot create the worktree directory",
        ),
    })

    const path = join(parent, id)

    const args =
      mode === "existing"
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, start]

    yield* git(repo, args)

    return { path, branch, lifecycle, repo }
  })
