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
    expect(acks?.description).toContain("Inputs: cwd")
  })

  it("marks destructive methods in their description", () => {
    const deletes = SURFACE.filter((entry) => /delete|remove|kill/.test(entry.method))

    expect(deletes.length).toBeGreaterThan(0)

    for (const entry of deletes) expect(entry.description).toContain("Destructive")
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
