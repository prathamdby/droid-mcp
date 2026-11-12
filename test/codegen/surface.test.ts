import { describe, expect, it } from "vitest"

import { SURFACE, SURFACE_COUNT } from "../../src/generated/surface.ts"

describe("generated surface", () => {
  it("matches its advertised count", () => {
    expect(SURFACE).toHaveLength(SURFACE_COUNT)
  })

  it("names every method once", () => {
    const methods = SURFACE.map((entry) => entry.method)

    expect(new Set(methods).size).toBe(methods.length)
  })

  it("names every tool once, in snake case", () => {
    const tools = SURFACE.map((entry) => entry.tool)

    expect(new Set(tools).size).toBe(tools.length)

    for (const tool of tools) expect(tool).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it("only carries daemon and droid methods", () => {
    for (const entry of SURFACE) {
      expect(/^(daemon|droid)\./.test(entry.method)).toBe(true)
      expect(entry.tool).toBe(entry.method.replaceAll(".", "_"))
    }
  })

  it("wraps every params schema as an object root, which MCP requires", () => {
    for (const entry of SURFACE) expect(entry.params.type).toBe("object")
  })

  it("requires the fields the SDK requires", () => {
    const acks = SURFACE.find(
      (entry) => entry.method === "daemon.acknowledge_mission_readiness_warning",
    )

    expect(acks?.params).toMatchObject({ required: ["cwd"] })
    expect(acks?.description).toBe(
      "Acknowledge mission readiness warning (SDK method " +
        "daemon.acknowledge_mission_readiness_warning).",
    )
  })

  it("marks destructive methods and not their harmless inverses", () => {
    const sentence = "Destructive; confirm before calling."
    const marked: Array<string> = []

    for (const entry of SURFACE) {
      if (entry.description.includes(sentence)) marked.push(entry.method)
    }

    const expected = [
      "daemon.apply_automation_config",
      "daemon.apply_user_preferences",
      "daemon.archive_session",
      "daemon.cleanup_worktree",
      "daemon.delete_automation",
      "daemon.delete_cron",
      "daemon.delete_custom_model",
      "daemon.delete_worktree_setup_profile",
      "daemon.execute_rewind",
      "daemon.git_push",
      "daemon.kill_worker_session",
      "daemon.remove_marketplace",
      "daemon.remove_mcp_server",
      "daemon.sf.delete_workstream",
      "daemon.uninstall_plugin",
      "daemon.update_mcp_config",
      "daemon.write_terminal_data",
      "daemon.write_workspace_file_content",
      "droid.execute_rewind",
      "droid.kill_worker_session",
      "droid.remove_mcp_server",
    ]

    expect([...marked].sort()).toEqual([...expected].sort())

    for (const method of expected) {
      const entry = SURFACE.find((candidate) => candidate.method === method)

      expect(entry?.description, method).toContain(sentence)
    }

    for (const method of [
      "daemon.unarchive_session",
      "daemon.list_skills",
      "droid.list_skills",
      "daemon.set_skill_disabled",
      "droid.set_skill_disabled",
      "daemon.inspect_worktree_deletion",
      "daemon.get_rewind_info",
      "droid.get_rewind_info",
      "daemon.close_session",
      "droid.close_session",
      "daemon.cancel_mcp_auth",
      "droid.clear_mcp_auth",
    ]) {
      const entry = SURFACE.find((candidate) => candidate.method === method)

      expect(entry, method).toBeDefined()
      expect(entry?.description, method).not.toContain(sentence)
    }
  })

  it("groups every method into a family", () => {
    for (const entry of SURFACE) {
      expect(entry.family).toBe(entry.method.split(".")[1])
      expect(entry.family.length).toBeGreaterThan(0)
    }
  })

  it("covers the delegation namespaces the design names", () => {
    const families = new Set(SURFACE.map((entry) => entry.family))

    for (const family of [
      "list_available_sessions",
      "list_crons",
      "git_commit",
      "create_automation",
    ]) {
      expect(families.has(family)).toBe(true)
    }
  })
})
