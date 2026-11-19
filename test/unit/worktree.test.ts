import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import { afterEach, describe, expect, it } from "vitest"

import { SessionHubService, SessionProblem } from "../../src/droid/turns.ts"
import type { SessionHubApi, TurnResult } from "../../src/droid/turns.ts"
import { createWorktree, removeWorktree } from "../../src/droid/worktree.ts"
import { presentTurn } from "../../src/tools/session-delivery.ts"
import { blockUntilSettled } from "../../src/tools/session-elicit.ts"
import { sessionTools } from "../../src/tools/session.ts"
import { testConfig } from "../support/config.ts"
import { fakeHub } from "../support/hub.ts"

const repos: Array<string> = []

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "droid-mcp-worktree-"))
  repos.push(root)
  git(root, ["init", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "test"])
  writeFileSync(join(root, "README.md"), "hello\n")
  git(root, ["add", "README.md"])
  git(root, ["commit", "-m", "init"])

  return root
}

afterEach(() => {
  for (const root of repos.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("worktree spawn", () => {
  it("creates a copy worktree and removes an ephemeral one", async () => {
    const root = repo()
    const tree = await Effect.runPromise(createWorktree(root, { worktree: true }))

    expect(tree?.lifecycle).toBe("ephemeral")
    expect(tree?.branch.startsWith("droid-mcp/")).toBe(true)
    expect(tree?.path.includes("droid-mcp-worktrees")).toBe(true)
    expect(tree?.path).not.toBe(root)

    if (tree === undefined) throw new Error("missing worktree")

    git(tree.path, ["status", "--short"])
    await Effect.runPromise(removeWorktree(tree))
    expect(() => git(tree.path, ["status", "--short"])).toThrow()
  })

  it("rejects worktree fields without the flag", async () => {
    const root = repo()
    const result = await Effect.runPromiseExit(createWorktree(root, { worktreeNewBranch: "topic" }))

    expect(Exit.isFailure(result)).toBe(true)
  })

  it("rejects unsafe refs and a relative worktree directory", async () => {
    const root = repo()

    const cases = [
      { worktree: true as const, worktreeNewBranch: "../evil" },
      { worktree: true as const, worktreeNewBranch: "-bad" },
      { worktree: true as const, worktreeNewBranch: "a b" },
      { worktree: true as const, worktreeBaseBranch: "origin/../main" },
      { worktree: true as const, worktreeDir: "relative/dir" },
    ]

    for (const fields of cases) {
      const code = await Effect.runPromise(
        createWorktree(root, fields).pipe(
          Effect.match({
            onFailure: (error) => error.code,
            onSuccess: () => "ok",
          }),
        ),
      )

      expect(code).toBe("invalid_worktree")
    }
  })

  it("accepts a dotted branch name", async () => {
    const root = repo()

    const tree = await Effect.runPromise(
      createWorktree(root, { worktree: true, worktreeNewBranch: "droid-mcp/topic.1" }),
    )

    expect(tree?.branch).toBe("droid-mcp/topic.1")
  })

  it("checks out an existing branch and keeps a persistent worktree after close", async () => {
    const root = repo()

    git(root, ["branch", "topic"])

    const existing = await Effect.runPromise(
      createWorktree(root, {
        worktree: true,
        worktreeBranchMode: "existing",
        worktreeNewBranch: "topic",
        worktreeLifecycle: "persistent",
      }),
    )

    expect(existing?.branch).toBe("topic")
    expect(existing?.lifecycle).toBe("persistent")
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: existing?.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("topic")

    const persistent = await Effect.runPromise(
      createWorktree(root, { worktree: true, worktreeLifecycle: "persistent" }),
    )

    const ephemeral = await Effect.runPromise(createWorktree(root, { worktree: true }))

    if (persistent === undefined || ephemeral === undefined) throw new Error("missing worktree")

    const closeOne = async (tree: NonNullable<typeof persistent>) => {
      const hub = await Effect.runPromise(Effect.scoped(fakeHub()))

      const created = await Effect.runPromise(
        hub.api.create({ cwd: tree.path, autonomyLevel: "low", worktree: tree }),
      )

      await Effect.runPromise(hub.api.close(created.sessionId))
      await Effect.runPromise(hub.closeAll)
    }

    await closeOne(persistent)
    await closeOne(ephemeral)

    expect(existsSync(persistent.path)).toBe(true)
    git(persistent.path, ["status", "--short"])
    expect(existsSync(ephemeral.path)).toBe(false)
  })
})

const unused = () => Effect.die("unused")

const failingHub = (): SessionHubApi => ({
  create: () => Effect.fail(new SessionProblem({ code: "exec_failed", message: "nope" })),
  stream: unused,
  events: unused,
  interrupt: unused,
  close: unused,
  answer: unused,
  command: unused,
  models: unused,
  pendingPrompt: unused,
  sessions: Effect.succeed([]),
  changes: Stream.empty,
})

describe("failed session create", () => {
  it("removes an ephemeral worktree and keeps a persistent one", async () => {
    const root = repo()
    const tools = sessionTools(testConfig())

    const listed = () =>
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })

    const ephemeral = await Effect.runPromiseExit(
      tools.handlers
        .session_create({ cwd: root, autonomyLevel: "low", worktree: true })
        .pipe(Effect.provideService(SessionHubService, failingHub())),
    )

    const persistent = await Effect.runPromiseExit(
      tools.handlers
        .session_create({
          cwd: root,
          autonomyLevel: "low",
          worktree: true,
          worktreeLifecycle: "persistent",
        })
        .pipe(Effect.provideService(SessionHubService, failingHub())),
    )

    expect(Exit.isFailure(ephemeral)).toBe(true)
    expect(Exit.isFailure(persistent)).toBe(true)

    const list = listed()

    expect(list.match(/^worktree /gm)?.length).toBe(2)
    expect(list).toContain("droid-mcp-worktrees")
  })
})

describe("turn delivery", () => {
  it("keeps prompts and drops the event dump", () => {
    const result: TurnResult = {
      sessionId: "s1",
      status: "running",
      cursor: 3,
      truncated: false,
      events: [
        { seq: 1, kind: "assistant_text", text: "working" },
        { seq: 2, kind: "tool_call", name: "edit" },
        { seq: 3, kind: "pending_permission", requestId: "p1" },
      ],
    }

    expect(presentTurn(result)).toEqual({
      sessionId: "s1",
      status: "running",
      cursor: 3,
      truncated: false,
      events: [{ seq: 3, kind: "pending_permission", requestId: "p1" }],
      uri: "droid://sessions/s1",
      summary: "working",
      eventsOmitted: true,
    })
  })

  it("keeps a ring truncation flag when delivery also omits events", () => {
    const result: TurnResult = {
      sessionId: "s1",
      status: "running",
      cursor: 2,
      truncated: true,
      events: [
        { seq: 1, kind: "assistant_text", text: "done" },
        { seq: 2, kind: "pending_question", requestId: "q1" },
      ],
    }

    const presented = presentTurn(result)

    expect(presented.truncated).toBe(true)
    expect(presented.eventsOmitted).toBe(true)
    expect(presented.cursor).toBe(2)
    expect(presented.summary).toBe("done")
  })

  it("returns a pending prompt once when the client cannot show a form", async () => {
    let polls = 0

    const hub: SessionHubApi = {
      ...failingHub(),
      events: () => {
        polls += 1

        return Effect.die("should not poll")
      },
    }

    const started: TurnResult = {
      sessionId: "s1",
      status: "running",
      cursor: 4,
      truncated: false,
      events: [{ seq: 4, kind: "pending_permission", requestId: "p1" }],
    }

    const result = await Effect.runPromise(
      blockUntilSettled("s1", started, "low", 1_000).pipe(
        Effect.provideService(SessionHubService, hub),
      ),
    )

    expect(polls).toBe(0)
    expect(result.events).toEqual([{ seq: 4, kind: "pending_permission", requestId: "p1" }])
    expect(result.uri).toBe("droid://sessions/s1")
  })
})
