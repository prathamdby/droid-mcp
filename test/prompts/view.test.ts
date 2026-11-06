import { describe, expect, it } from "vitest"

import { viewOf } from "../../src/droid/prompts.ts"

/**
 * The installed CLI sends permission options as `{ label, value }` objects while
 * the SDK types and older builds send bare strings. Both must produce an
 * answerable `pending_permission` event; a missed decode degrades to a generic
 * `prompt` event with no options, which an agent cannot answer.
 */
describe("prompt views", () => {
  it("reads object options from the CLI", () => {
    const view = viewOf("droid.request_permission", {
      toolUses: [
        {
          toolUse: { id: "call-1", name: "Create", input: { file_path: "a.txt" } },
          confirmationType: "create",
          details: { type: "create", filePath: "a.txt" },
        },
      ],
      options: [
        { label: "Yes, allow", value: "proceed_once", selectedColor: "#d78700" },
        { label: "No, cancel", value: "cancel", selectedPrefix: "✕ " },
      ],
      _meta: { traceparent: "00-abc-def-01" },
    })

    if (view?.kind !== "permission") throw new Error("expected a permission view")

    expect(view.options).toEqual(["proceed_once", "cancel"])
    expect(view.toolUses).toHaveLength(1)
    expect(view.toolUses[0]?.toolUse?.name).toBe("Create")
  })

  it("reads bare string options", () => {
    const view = viewOf("droid.request_permission", {
      toolUses: [],
      options: ["proceed_once", "proceed_always", "cancel"],
    })

    if (view?.kind !== "permission") throw new Error("expected a permission view")

    expect(view.options).toEqual(["proceed_once", "proceed_always", "cancel"])
  })

  it("drops outcomes this server does not accept", () => {
    const view = viewOf("droid.request_permission", {
      options: [{ value: "proceed_once" }, { value: "something_new" }],
    })

    if (view?.kind !== "permission") throw new Error("expected a permission view")

    expect(view.options).toEqual(["proceed_once"])
  })

  it("has no view for an unknown method or a malformed payload", () => {
    expect(viewOf("droid.other", {})).toBeUndefined()
    expect(viewOf("droid.ask_user", { questions: "no" })).toBeUndefined()
  })
})
