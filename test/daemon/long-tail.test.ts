import { describe, expect, it } from "vitest"

import { SURFACE } from "../../src/generated/surface.ts"
import { DAEMON_UNSERVED_METHODS, SESSION_OWNED_METHODS } from "../../src/tools/generated.ts"
import { toolsFor } from "../../src/tools/index.ts"
import { testConfig } from "../support/config.ts"

/**
 * Every SDK method except the explicitly suppressed methods has a tool.
 * A method that slips out of codegen would otherwise only show up when an
 * agent needed it.
 */

const generated = SURFACE.filter(
  (entry) =>
    !SESSION_OWNED_METHODS.includes(entry.method) && !DAEMON_UNSERVED_METHODS.has(entry.method),
)

const daemonMethods = generated.filter((entry) => entry.kind === "daemon")
const droidMethods = generated.filter((entry) => entry.kind === "droid")

/** The registered tool names. */
const surface = (): ReadonlyArray<string> => Object.keys(toolsFor(testConfig()).toolkit.tools)

describe("daemon long tail", () => {
  it("has a tool for every daemon method", () => {
    const tools = new Set(surface())

    expect(daemonMethods.length).toBeGreaterThan(100)

    for (const entry of daemonMethods) expect(tools.has(entry.tool), entry.method).toBe(true)
  })

  it("has a tool for every droid method not explicitly suppressed", () => {
    const tools = new Set(surface())

    expect(droidMethods.length).toBeGreaterThan(0)

    for (const entry of droidMethods) expect(tools.has(entry.tool), entry.method).toBe(true)
  })

  it("covers the namespaces the libraries divide themselves into", () => {
    const names = new Set(daemonMethods.map((entry) => entry.family))

    for (const family of [
      "list_available_sessions",
      "list_opened_sessions",
      "search_sessions",
      "create_automation",
      "list_managed_worktrees",
      "save_worktree_setup_profile",
      "list_mcp_servers",
      "toggle_mcp_tool",
      "list_models",
      "get_default_settings",
      "git_commit",
      "git_push",
      "create_pr",
      "list_terminals",
      "list_crons",
      "sf",
    ]) {
      expect(names.has(family), family).toBe(true)
    }
  })

  it("describes every tool with the SDK method it wraps", () => {
    for (const entry of generated) {
      expect(entry.description).toContain("SDK method " + entry.method)
    }
  })

  it("sends the tool's own parameters, unchanged, to the daemon", () => {
    const entry = daemonMethods.find((value) => value.method === "daemon.git_commit")

    if (entry === undefined) throw new Error("no git_commit entry")

    expect(entry.params.type).toBe("object")
    expect(Object.keys(entry.params.properties ?? {}).length).toBeGreaterThan(0)
  })
})
