import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit, Layer, Option, Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Caller } from "../../src/caller/index.ts"
import { Custody, custodyLayer } from "../../src/custody/index.ts"
import {
  CheckoutFailed,
  InvalidLocation,
  RootDenied,
  WorkspaceClosed,
  Workspaces,
  workspacesLayer,
} from "../../src/workspace/index.ts"

let sandbox: string
let workspaces: Workspaces["Service"]
let custodyApi: Custody["Service"]
let caller: Caller

/** Builds the workspace+custody pair over the given permitted roots. */
const provision = (roots: ReadonlyArray<string>) => {
  const workspacesLive = Layer.provideMerge(workspacesLayer({ allowedRoots: roots }), custodyLayer)
  const merged = Layer.merge(workspacesLive, custodyLayer)

  const services = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const ws = yield* Workspaces
        const custody = yield* Custody

        return { ws, custody }
      }),
      merged,
    ),
  )

  workspaces = services.ws
  custodyApi = services.custody
}

const gitIn = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()

/** Creates a real git repository with one commit on branch `main`. */
const makeRepo = (name: string): string => {
  const path = join(sandbox, name)

  mkdirSync(path, { recursive: true })
  gitIn(path, ["init", "-b", "main"])
  gitIn(path, ["config", "user.email", "test@example.com"])
  gitIn(path, ["config", "user.name", "test"])
  writeFileSync(join(path, "file.txt"), "content")
  gitIn(path, ["add", "."])
  gitIn(path, ["commit", "-m", "initial"])

  return realpathSync(path)
}

/**
 * Captures the typed failure of an effect. `Effect.flip` cannot serve here
 * because it re-fails `undefined` for effects that legitimately succeed
 * with no value.
 */
const captureFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)

    if (Exit.isFailure(exit)) {
      const found = Cause.findErrorOption(exit.cause)

      if (Option.isSome(found)) return found.value
    }

    return yield* Effect.die(null)
  })

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect))

/**
 * Runs an effect inside a fresh scope the test keeps open, so the case can
 * close it (or not) at the exact moment it requires. The body argument is
 * unused — the scope identity is supplied implicitly — but the signature
 * keeps the call sites uniform.
 */
const withOpenScope = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const scope = await Effect.runPromise(Scope.make())

  const result = await Effect.runPromise(effect.pipe(Scope.provide(scope)))

  return { result, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "workspace-test-")))
  provision([sandbox])

  // SAFETY: test callers only need a stable identity for the callerId
  // recorded on workspace views; admission semantics are covered by the
  // caller module's own tests.
  caller = {
    id: "trusted:workspace-test" as Caller["id"],
    kind: "trusted",
    displayLabel: "workspace-test",
  } as Caller
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe("permitted roots", () => {
  it("an empty root list denies every acquisition", async () => {
    await provision([])
    mkdirSync(join(sandbox, "present"))

    const failure = await runScoped(
      captureFailure(workspaces.acquire(caller, { kind: "borrowed", path: sandbox })),
    )

    expect(failure).toBeInstanceOf(RootDenied)
  })

  it("a path outside every root is denied before any checkout is created", async () => {
    const repo = makeRepo("repo-outside")
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workspace-outside-")))

    try {
      await provision([outside])

      const failure = await runScoped(
        captureFailure(workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo })),
      )

      expect(failure).toBeInstanceOf(RootDenied)

      // No checkout was created anywhere.
      expect(existsSync(join(repo, ".workspace-checkouts"))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("a symlink inside a root pointing outside is denied on acquisition", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workspace-escape-")))

    try {
      const link = join(sandbox, "escape-link")

      symlinkSync(outside, link)

      const failure = await runScoped(
        captureFailure(workspaces.acquire(caller, { kind: "borrowed", path: link })),
      )

      expect(failure).toBeInstanceOf(RootDenied)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("a symlinked worktreeDir resolving outside the roots creates no checkout", async () => {
    const repo = makeRepo("repo-symlink-dir")
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workspace-escape-dir-")))

    try {
      const link = join(sandbox, "escape-dir-link")

      symlinkSync(outside, link)

      const failure = await runScoped(
        captureFailure(
          workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo, worktreeDir: link }),
        ),
      )

      expect(failure).toBeInstanceOf(RootDenied)
      expect(existsSync(join(outside, "anything"))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("changeLocation denies a symlink inside the root pointing outside", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workspace-escape-move-")))

    try {
      mkdirSync(join(sandbox, "start"))
      const link = join(sandbox, "move-escape-link")

      symlinkSync(outside, link)

      const { result: lease } = await withOpenScope(
        workspaces.acquire(caller, { kind: "borrowed", path: join(sandbox, "start") }),
      )

      const failure = await Effect.runPromise(
        captureFailure(workspaces.changeLocation(lease, link)),
      )

      expect(failure).toBeInstanceOf(RootDenied)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("changeLocation to a path outside the roots fails with RootDenied", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workspace-move-outside-")))

    try {
      mkdirSync(join(sandbox, "start2"))

      const { result: lease } = await withOpenScope(
        workspaces.acquire(caller, { kind: "borrowed", path: join(sandbox, "start2") }),
      )

      const failure = await Effect.runPromise(
        captureFailure(workspaces.changeLocation(lease, outside)),
      )

      expect(failure).toBeInstanceOf(RootDenied)

      // The location did not move.
      const view = await Effect.runPromise(workspaces.describe(lease))

      expect(view.location).toBe(realpathSync(join(sandbox, "start2")))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("borrowed checkout", () => {
  it("scope close never deletes or mutates the borrowed directory", async () => {
    const dir = join(sandbox, "borrowed")

    mkdirSync(dir)
    writeFileSync(join(dir, "keep.txt"), "borrowed")

    const { close } = await withOpenScope(
      workspaces.acquire(caller, { kind: "borrowed", path: dir }),
    )

    await close()

    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, "keep.txt"))).toBe(true)
  })

  it("release never deletes the borrowed directory", async () => {
    const dir = join(sandbox, "borrowed-release")

    mkdirSync(dir)

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "borrowed", path: dir }),
    )

    await Effect.runPromise(workspaces.release(lease))

    expect(existsSync(dir)).toBe(true)
  })

  it("drain of an adopted lifetime never deletes the borrowed directory", async () => {
    const dir = join(sandbox, "borrowed-drain")

    mkdirSync(dir)

    const { result: lease, close } = await withOpenScope(
      workspaces.acquire(caller, { kind: "borrowed", path: dir }),
    )

    const lifetime = await Effect.runPromise(custodyApi.createLifetime("session"))

    await Effect.runPromise(workspaces.adopt(lease, lifetime))
    await close()

    expect(existsSync(dir)).toBe(true)

    await Effect.runPromise(custodyApi.drain(lifetime))

    expect(existsSync(dir)).toBe(true)
  })

  it("borrowed views report non-isolated ownership without a branch", async () => {
    const dir = join(sandbox, "borrowed-view")

    mkdirSync(dir)

    const view = await runScoped(
      Effect.gen(function* () {
        const lease = yield* workspaces.acquire(caller, { kind: "borrowed", path: dir })

        return yield* workspaces.describe(lease)
      }),
    )

    expect(view.ownership).toBe("borrowed")
    expect(view.isolated).toBe(false)
    expect(view.branch).toBeUndefined()
    expect(view.acquiredPath).toBe(realpathSync(dir))
    expect(view.location).toBe(realpathSync(dir))
  })
})

describe("ephemeral isolated checkout", () => {
  it("creates a real checkout inside the roots and removes it on scope close", async () => {
    const repo = makeRepo("repo-ephemeral")

    let acquiredPath = ""

    await runScoped(
      Effect.gen(function* () {
        const lease = yield* workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo })
        const view = yield* workspaces.describe(lease)

        acquiredPath = view.acquiredPath

        expect(view.isolated).toBe(true)
        expect(view.ownership).toBe("ephemeral")
        expect(view.branch).toBeDefined()
        expect(existsSync(acquiredPath)).toBe(true)

        // The checkout is a real working copy of the repository.
        expect(existsSync(join(acquiredPath, "file.txt"))).toBe(true)
      }),
    )

    expect(existsSync(acquiredPath)).toBe(false)
    // The source repository is never removed.
    expect(existsSync(repo)).toBe(true)
  })

  it("release removes exactly the created ephemeral checkout", async () => {
    const repo = makeRepo("repo-eph-release")

    const { result: lease, close } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    const view = await Effect.runPromise(workspaces.describe(lease))

    expect(existsSync(view.acquiredPath)).toBe(true)

    await Effect.runPromise(workspaces.release(lease))

    expect(existsSync(view.acquiredPath)).toBe(false)
    expect(existsSync(repo)).toBe(true)

    // Scope close afterwards is a no-op for the same cleanup execution.
    await close()

    expect(existsSync(view.acquiredPath)).toBe(false)
  })

  it("adoption keeps the checkout alive past scope close; drain removes it", async () => {
    const repo = makeRepo("repo-eph-adopt")

    const { result: lease, close } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    const view = await Effect.runPromise(workspaces.describe(lease))
    const lifetime = await Effect.runPromise(custodyApi.createLifetime("session"))

    await Effect.runPromise(workspaces.adopt(lease, lifetime))
    await close()

    // Alive past the acquiring scope.
    expect(existsSync(view.acquiredPath)).toBe(true)

    await Effect.runPromise(custodyApi.drain(lifetime))

    expect(existsSync(view.acquiredPath)).toBe(false)
    expect(existsSync(repo)).toBe(true)
  })

  it("a failing checkout creation reports CheckoutFailed and leaves nothing behind", async () => {
    const repo = makeRepo("repo-existing-mode")

    const failure = await runScoped(
      captureFailure(
        workspaces.acquire(caller, {
          kind: "ephemeral",
          repoPath: repo,
          branchMode: "existing",
        }),
      ),
    )

    // existing branch mode without a newBranch cannot name the branch.
    expect(failure).toBeInstanceOf(CheckoutFailed)
    expect(existsSync(join(repo, ".workspace-checkouts"))).toBe(false)
  })

  it("a non-git repository fails acquisition with CheckoutFailed", async () => {
    const dir = join(sandbox, "not-a-repo")

    mkdirSync(dir)

    const failure = await runScoped(
      captureFailure(workspaces.acquire(caller, { kind: "ephemeral", repoPath: dir })),
    )

    expect(failure).toBeInstanceOf(CheckoutFailed)
  })
})

describe("persistent isolated checkout", () => {
  it("creates a real checkout and leaves it in place on scope close", async () => {
    const repo = makeRepo("repo-persistent")

    let acquiredPath = ""

    await runScoped(
      Effect.gen(function* () {
        const lease = yield* workspaces.acquire(caller, {
          kind: "persistent",
          repoPath: repo,
        })

        const view = yield* workspaces.describe(lease)

        acquiredPath = view.acquiredPath

        expect(view.ownership).toBe("persistent")
        expect(view.isolated).toBe(true)
        expect(existsSync(acquiredPath)).toBe(true)
      }),
    )

    expect(existsSync(acquiredPath)).toBe(true)
  })

  it("release does not delete the persistent checkout", async () => {
    const repo = makeRepo("repo-persist-release")

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "persistent", repoPath: repo }),
    )

    const view = await Effect.runPromise(workspaces.describe(lease))

    await Effect.runPromise(workspaces.release(lease))

    expect(existsSync(view.acquiredPath)).toBe(true)
  })

  it("drain does not delete the persistent checkout", async () => {
    const repo = makeRepo("repo-persist-drain")

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "persistent", repoPath: repo }),
    )

    const view = await Effect.runPromise(workspaces.describe(lease))
    const lifetime = await Effect.runPromise(custodyApi.createLifetime("session"))

    await Effect.runPromise(workspaces.adopt(lease, lifetime))
    await Effect.runPromise(custodyApi.drain(lifetime))

    expect(existsSync(view.acquiredPath)).toBe(true)
  })
})

describe("changeLocation", () => {
  it("updates location while preserving acquiredPath and ownership", async () => {
    const repo = makeRepo("repo-move")
    const other = join(sandbox, "other-location")

    mkdirSync(other)

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    const before = await Effect.runPromise(workspaces.describe(lease))
    const moved = await Effect.runPromise(workspaces.changeLocation(lease, other))

    expect(moved.location).toBe(realpathSync(other))
    expect(moved.acquiredPath).toBe(before.acquiredPath)
    expect(moved.ownership).toBe("ephemeral")

    const after = await Effect.runPromise(workspaces.describe(lease))

    expect(after.location).toBe(realpathSync(other))
    expect(after.acquiredPath).toBe(before.acquiredPath)
  })

  it("does not transfer cleanup rights: closing removes only the original checkout", async () => {
    const repo = makeRepo("repo-move-cleanup")
    const other = join(sandbox, "moved-target")

    mkdirSync(other)
    writeFileSync(join(other, "precious.txt"), "keep")

    const { result: lease, close } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    const before = await Effect.runPromise(workspaces.describe(lease))

    await Effect.runPromise(workspaces.changeLocation(lease, other))
    await close()

    // The acquired ephemeral checkout is gone; the moved location is untouched.
    expect(existsSync(before.acquiredPath)).toBe(false)
    expect(existsSync(join(other, "precious.txt"))).toBe(true)
  })

  it("fails with InvalidLocation when the target does not exist", async () => {
    const dir = join(sandbox, "start-missing")

    mkdirSync(dir)

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "borrowed", path: dir }),
    )

    const failure = await Effect.runPromise(
      captureFailure(workspaces.changeLocation(lease, join(sandbox, "missing-entirely"))),
    )

    expect(failure).toBeInstanceOf(InvalidLocation)
  })

  it("fails with InvalidLocation when the target is a file", async () => {
    const dir = join(sandbox, "start-file")

    mkdirSync(dir)
    const file = join(sandbox, "a-file.txt")

    writeFileSync(file, "not a directory")

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "borrowed", path: dir }),
    )

    const failure = await Effect.runPromise(captureFailure(workspaces.changeLocation(lease, file)))

    expect(failure).toBeInstanceOf(InvalidLocation)
  })
})

describe("closed leases", () => {
  it("describe fails with WorkspaceClosed after release", async () => {
    const repo = makeRepo("repo-closed-release")

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    await Effect.runPromise(workspaces.release(lease))

    const failure = await Effect.runPromise(captureFailure(workspaces.describe(lease)))

    expect(failure).toBeInstanceOf(WorkspaceClosed)
  })

  it("changeLocation fails with WorkspaceClosed after release", async () => {
    const repo = makeRepo("repo-closed-move")

    mkdirSync(join(sandbox, "post-close-target"))

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    await Effect.runPromise(workspaces.release(lease))

    const failure = await Effect.runPromise(
      captureFailure(workspaces.changeLocation(lease, join(sandbox, "post-close-target"))),
    )

    expect(failure).toBeInstanceOf(WorkspaceClosed)
  })

  it("describe and changeLocation fail with WorkspaceClosed after scope close", async () => {
    const repo = makeRepo("repo-closed-scope")

    const { result: lease, close } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    await close()

    const described = await Effect.runPromise(captureFailure(workspaces.describe(lease)))

    expect(described).toBeInstanceOf(WorkspaceClosed)

    const moved = await Effect.runPromise(captureFailure(workspaces.changeLocation(lease, sandbox)))

    expect(moved).toBeInstanceOf(WorkspaceClosed)
  })

  it("describe fails with WorkspaceClosed after adoption drain", async () => {
    const repo = makeRepo("repo-closed-drain")

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    const lifetime = await Effect.runPromise(custodyApi.createLifetime("session"))

    await Effect.runPromise(workspaces.adopt(lease, lifetime))

    // Still live before drain.
    const view = await Effect.runPromise(workspaces.describe(lease))

    expect(view.ownership).toBe("ephemeral")

    await Effect.runPromise(custodyApi.drain(lifetime))

    const failure = await Effect.runPromise(captureFailure(workspaces.describe(lease)))

    expect(failure).toBeInstanceOf(WorkspaceClosed)
  })

  it("adopt fails with WorkspaceClosed after release", async () => {
    const repo = makeRepo("repo-adopt-closed")

    const { result: lease } = await withOpenScope(
      workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo }),
    )

    await Effect.runPromise(workspaces.release(lease))

    const lifetime = await Effect.runPromise(custodyApi.createLifetime("session"))

    const failure = await Effect.runPromise(captureFailure(workspaces.adopt(lease, lifetime)))

    expect(failure).toBeInstanceOf(WorkspaceClosed)
  })
})

describe("acquisition identity", () => {
  it("the view carries the acquiring caller identity", async () => {
    const dir = join(sandbox, "identity-check")

    mkdirSync(dir)

    const view = await runScoped(
      Effect.gen(function* () {
        const lease = yield* workspaces.acquire(caller, { kind: "borrowed", path: dir })

        return yield* workspaces.describe(lease)
      }),
    )

    expect(view.callerId).toBe(String(caller.id))
  })

  it("isolated acquisition honors newBranch for the created checkout", async () => {
    const repo = makeRepo("repo-branch")

    const view = await runScoped(
      Effect.gen(function* () {
        const lease = yield* workspaces.acquire(caller, {
          kind: "persistent",
          repoPath: repo,
          newBranch: "feature/pinned",
        })

        return yield* workspaces.describe(lease)
      }),
    )

    expect(view.branch).toBe("feature/pinned")

    // The checkout is really on that branch.
    const branch = gitIn(view.acquiredPath, ["rev-parse", "--abbrev-ref", "HEAD"])

    expect(branch).toBe("feature/pinned")
  })

  it("two acquisitions never share a checkout path", async () => {
    const repo = makeRepo("repo-distinct")

    const views = await runScoped(
      Effect.gen(function* () {
        const first = yield* workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo })
        const second = yield* workspaces.acquire(caller, { kind: "ephemeral", repoPath: repo })

        return [yield* workspaces.describe(first), yield* workspaces.describe(second)] as const
      }),
    )

    expect(views[0].acquiredPath).not.toBe(views[1].acquiredPath)
    expect(views[0].branch).not.toBe(views[1].branch)
  })
})
