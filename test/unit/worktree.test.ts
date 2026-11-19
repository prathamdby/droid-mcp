import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { afterEach, describe, expect, it } from "vitest"

import type { TurnResult } from "../../src/droid/turns.ts"
import { createWorktree, removeWorktree } from "../../src/droid/worktree.ts"
import { presentTurn } from "../../src/tools/session-delivery.ts"

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
    })
  })
})
