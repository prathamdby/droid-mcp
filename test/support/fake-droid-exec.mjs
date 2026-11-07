#!/usr/bin/env node
/**
 * A stand-in for `droid exec --input-format stream-jsonrpc --output-format
 * stream-jsonrpc`. It speaks the same envelope and scripts a handful of turn
 * shapes so the hub and client can be tested without a model.
 *
 * Prompt texts select the scenario:
 *   "hello"       one text block, one tool pair, a completed turn
 *   "split"       writes one JSON line across two pipe writes
 *   "burst:<n>"   emits n assistant-text events, then completes
 *   "crash"       writes stderr and exits 3 mid-turn
 *   "hang"        accepts the message and never answers
 *   "permission"  asks to write two files, then reports what it was told
 *   "deny"        asks, and completes as permission_rejected on cancel
 *   "ask"         asks one single-select and one multi-select question
 *   "pick"        offers three rows, single-select
 *   "spec"        asks to leave spec mode with an edited plan
 *   "interrupt"   stays running until `droid.interrupt_session`
 *   "echo:<text>" completes with <text> as structured output
 *
 * Environment:
 *   FAKE_DROID_INIT=hang       never answer initialize
 *   FAKE_DROID_SETTINGS=reject reject the settings update
 *   FAKE_DROID_CLOSE=hang      ignore droid.close_session and stay up
 *   FAKE_DROID_CLOSE_MARKER    file written when that ignored close arrives
 *   FAKE_DROID_PIDFILE         write this process's pid
 *   FAKE_DROID_PIDDIR          one file per pid, so concurrent children stay visible
 *
 * Every answered prompt is echoed back as the turn's `structuredOutput`, so a
 * test can assert exactly what reached the CLI.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const pidfile = process.env.FAKE_DROID_PIDFILE

if (pidfile !== undefined && pidfile.length > 0) writeFileSync(pidfile, String(process.pid))

const piddir = process.env.FAKE_DROID_PIDDIR

if (piddir !== undefined && piddir.length > 0) {
  mkdirSync(piddir, { recursive: true })
  writeFileSync(join(piddir, String(process.pid)), "")
}

const PROTOCOL = "1.299.0"
const SESSION_ID = "fake-session"

const base = {
  jsonrpc: "2.0",
  factoryApiVersion: "1.0.0",
  factoryProtocolVersion: PROTOCOL,
}

const write = (value) => {
  process.stdout.write(JSON.stringify({ ...base, ...value }) + "\n")
}

const respond = (id, result) => write({ type: "response", id, result })

const notify = (notification) =>
  write({
    type: "notification",
    method: "droid.session_notification",
    params: { sessionId: SESSION_ID, notification },
  })

const request = (id, method, params) => write({ type: "request", id, method, params })

const toolUse = (id, name, input) => ({
  toolUse: { type: "tool_use", id, name, input, thoughtSignature: "" },
  confirmationType: "edit",
  details: { type: "file", path: input.path },
})

const PERMISSION_LABELS = new Map([
  ["proceed_once", "Yes, allow"],
  ["proceed_always", "Yes, and always allow low impact commands"],
  ["proceed_edit", "Yes, and edit the plan"],
  ["cancel", "No, cancel"],
])

/**
 * The installed CLI sends permission outcomes as `{ label, value }` objects, not
 * bare strings. Matching that shape here is what keeps a decoding regression
 * visible: a string-only decoder turns every real prompt into an unanswerable
 * generic event.
 */
const permissionOptions = (values) =>
  values.map((value) => ({
    label: PERMISSION_LABELS.get(value) ?? value,
    value,
    selectedColor: "#d78700",
  }))

const pendingPermission = (id, options = ["proceed_once", "proceed_always", "cancel"]) =>
  request(id, "droid.request_permission", {
    toolUses: [toolUse("tool-1", "Write", { path: "a.txt", content: "hi" })],
    options: permissionOptions(options),
  })

const pendingBatch = (id) =>
  request(id, "droid.request_permission", {
    toolUses: [
      toolUse("tool-1", "Write", { path: "a.txt" }),
      toolUse("tool-2", "Write", { path: "b.txt" }),
    ],
    options: permissionOptions(["proceed_once", "cancel"]),
  })

const pendingQuestions = (id) =>
  request(id, "droid.ask_user", {
    toolCallId: "call-1",
    questions: [
      {
        index: 0,
        topic: "Test framework",
        question: "Which runner?",
        options: [{ label: "vitest" }, { label: "node:test" }],
        multiSelect: false,
      },
      {
        index: 1,
        topic: "Checks",
        question: "Which checks?",
        options: [{ label: "lint" }, { label: "types" }],
        multiSelect: true,
      },
    ],
  })

const pendingOptions = (id) =>
  request(id, "droid.pick_options", {
    toolCallId: "call-2",
    title: "Pick a repo",
    rows: [
      { id: "repo-a", label: "repo-a", detail: "first" },
      { id: "repo-b", label: "repo-b", detail: "second" },
      { id: "repo-c", label: "repo-c", detail: "third" },
    ],
    multi: false,
  })

const pendingSpec = (id) =>
  request(id, "droid.request_permission", {
    toolUses: [
      {
        toolUse: { type: "tool_use", id: "tool-spec", name: "ExitSpecMode", input: {} },
        confirmationType: "exit_spec_mode",
        details: { type: "exit_spec_mode", specContent: "# plan\n" },
      },
    ],
    options: permissionOptions(["proceed_edit", "cancel"]),
  })

const complete = (reason, extra = {}) =>
  notify({
    type: "agent_turn_completed",
    reason,
    turnId: "turn-1",
    tokenUsage: { inputTokens: 10, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ...extra,
  })

let interrupt
let promptCount = 0

/** Server-initiated requests carry their own ids, not the message's. */
const nextPromptId = () => {
  promptCount += 1

  return "prompt-" + String(promptCount)
}

const handlePrompt = (text) => {
  const id = nextPromptId()

  if (text === "permission") {
    pendingPermission(id)

    return true
  }

  if (text === "batch") {
    pendingBatch(id)

    return true
  }

  if (text === "deny") {
    pendingPermission(id)

    return true
  }

  if (text === "ask") {
    pendingQuestions(id)

    return true
  }

  if (text === "pick") {
    pendingOptions(id)

    return true
  }

  if (text === "spec") {
    pendingSpec(id)

    return true
  }

  if (text === "permission:huge") {
    request(id, "droid.request_permission", {
      toolUses: [toolUse("tool-1", "Write", { path: "a.txt", content: "x".repeat(300_000) })],
      options: permissionOptions(["proceed_once", "cancel"]),
    })

    return true
  }

  if (text === "permission:reuse") {
    pendingPermission("prompt-same")

    return true
  }

  if (text === "permission:dup") {
    request("prompt-dup", "droid.request_permission", {
      toolUses: [toolUse("tool-1", "First", { path: "a.txt", content: "hi" })],
      options: permissionOptions(["proceed_once", "cancel"]),
    })
    request("prompt-dup", "droid.request_permission", {
      toolUses: [toolUse("tool-2", "Second", { path: "b.txt", content: "hi" })],
      options: permissionOptions(["proceed_once", "cancel"]),
    })

    return true
  }

  if (text === "permission:levels") {
    pendingPermission(id, [
      "proceed_once",
      "proceed_edit",
      "cancel",
      "proceed_auto_run",
      "proceed_auto_run_high",
      "proceed_new_session",
      "proceed_new_session_low",
    ])

    return true
  }

  return false
}

const handleMessage = (text, id) => {
  if (text === "crash") {
    process.stderr.write("boom: fake crash\n")
    process.exit(3)
  }

  if (text === "reject") {
    write({ type: "response", id, error: { code: -32000, message: "message rejected" } })

    return
  }

  if (text === "structured") {
    respond(id, {})
    notify({ type: "structured_output", data: { old: true } })
    notify({
      type: "agent_turn_completed",
      reason: "completed",
      turnId: "turn-a",
      structuredOutput: { old: true },
    })

    return
  }

  respond(id, {})

  if (text === "done-exit") {
    notify({
      type: "agent_turn_completed",
      reason: "completed",
      turnId: "turn-done",
    })
    setTimeout(() => process.exit(0), 40)

    return
  }

  if (text.startsWith("deltas:")) {
    const count = Number(text.slice("deltas:".length))

    for (let index = 0; index < count; index += 1) {
      notify({
        type: "assistant_text_delta",
        messageId: "m-delta",
        blockIndex: 0,
        textDelta: "😀",
      })
    }

    notify({ type: "assistant_text_complete", messageId: "m-delta", blockIndex: 0 })
    complete("completed")

    return
  }

  if (text.startsWith("bulk:")) {
    const count = Number(text.slice("bulk:".length))

    for (let index = 0; index < count; index += 1) {
      notify({
        type: "tool_result",
        toolUseId: "t" + String(index),
        isError: false,
        result: "y".repeat(8000),
      })
    }

    complete("completed")

    return
  }

  if (text === "hang") return

  if (handlePrompt(text)) return

  if (text === "hello") {
    notify({ type: "create_message", message: { id: "m1", role: "assistant", content: [] } })
    notify({ type: "tool_call", toolUseId: "tool-1", name: "Read", input: { path: "a.txt" } })
    notify({ type: "tool_result", toolUseId: "tool-1", isError: false, result: "contents" })
    notify({ type: "assistant_text_delta", messageId: "m1", blockIndex: 0, textDelta: "hi" })
    notify({ type: "assistant_text_complete", messageId: "m1", blockIndex: 0 })
    complete("completed")

    return
  }

  if (text === "split") {
    const notification = JSON.stringify({
      ...base,
      type: "notification",
      method: "droid.session_notification",
      params: {
        sessionId: SESSION_ID,
        notification: {
          type: "assistant_text_delta",
          messageId: "m2",
          blockIndex: 0,
          textDelta: "ok",
        },
      },
    })

    const middle = Math.floor(notification.length / 2)
    process.stdout.write(notification.slice(0, middle))

    setTimeout(() => {
      process.stdout.write(notification.slice(middle) + "\n")
      notify({ type: "assistant_text_complete", messageId: "m2", blockIndex: 0 })
      complete("completed")
    }, 20)

    return
  }

  if (text.startsWith("burst:")) {
    const count = Number(text.slice(6))

    for (let index = 0; index < count; index += 1) {
      notify({
        type: "assistant_text_delta",
        messageId: "m" + String(index),
        blockIndex: 0,
        textDelta: "x",
      })
      notify({ type: "assistant_text_complete", messageId: "m" + String(index), blockIndex: 0 })
    }

    complete("completed")

    return
  }

  if (text === "interrupt") {
    interrupt = interrupt ?? (() => complete("cancelled"))

    return
  }

  if (text.startsWith("echo:")) {
    complete("completed", { structuredOutput: { echo: text.slice(5) } })

    return
  }

  complete("completed")
}

const finishPrompt = (result) => {
  if (result === undefined) return

  const selected = result.selectedOption

  if (selected === "cancel") {
    complete("permission_rejected", { structuredOutput: result })

    return
  }

  if (selected !== undefined) {
    notify({ type: "permission_resolved", toolUseId: "tool-1", selectedOption: selected })
    complete("completed", { structuredOutput: result })

    return
  }

  if (result.answers !== undefined || result.cancelled === true) {
    complete("completed", { structuredOutput: result })

    return
  }

  if (result.selectedIds !== undefined) {
    complete("completed", { structuredOutput: result })
  }
}

/** Admin methods echo what they were sent, so a test can assert the envelope. */
const ECHO_METHODS = new Set([
  "droid.rename_session",
  "droid.change_working_directory",
  "droid.compact_session",
  "droid.execute_rewind",
  "droid.get_context_stats",
  "droid.get_rewind_info",
  "droid.list_mcp_registry",
  "droid.list_mcp_servers",
  "droid.list_mcp_tools",
  "droid.list_tools",
  "droid.list_skills",
  "droid.add_mcp_server",
  "droid.remove_mcp_server",
  "droid.toggle_mcp_server",
  "droid.toggle_mcp_tool",
  "droid.set_skill_disabled",
  "droid.refresh_connector_tool_catalog",
  "droid.authenticate_mcp_server",
  "droid.submit_mcp_auth_code",
  "droid.submit_bug_report",
  "droid.append_messages",
  "droid.load_session",
])

const router = (message) => {
  if (message.method === "droid.silent") return

  if (ECHO_METHODS.has(message.method)) {
    respond(message.id, { method: message.method, params: message.params ?? null })

    return
  }

  if (message.method === "droid.fork_session") {
    respond(message.id, {
      sessionId: "forked-session",
      method: message.method,
      params: message.params ?? null,
    })

    return
  }

  if (message.method === "droid.update_session_settings") {
    if (process.env.FAKE_DROID_SETTINGS === "reject") {
      write({
        type: "response",
        id: message.id,
        error: { code: -32000, message: "settings rejected" },
      })

      return
    }

    respond(message.id, { method: message.method, params: message.params ?? null })
    notify({ type: "settings_updated", settings: message.params ?? {} })

    return
  }

  if (message.type === "response") {
    finishPrompt(message.result)

    return
  }

  if (message.method === "droid.initialize_session") {
    if (process.env.FAKE_DROID_INIT === "hang") return

    respond(message.id, {
      sessionId: SESSION_ID,
      hostId: "fake-host",
      session: { messages: [] },
      settings: { modelId: "fake-model", autonomyLevel: "low", interactionMode: "auto" },
      availableModels: [{ id: "fake-model" }],
    })

    return
  }

  if (message.method === "droid.add_user_message") {
    handleMessage(message.params?.text ?? "", message.id)

    return
  }

  if (message.method === "droid.interrupt_session") {
    respond(message.id, {})

    if (interrupt) {
      interrupt()
      interrupt = undefined
    } else {
      complete("cancelled")
    }

    return
  }

  if (message.method === "droid.close_session") {
    if (process.env.FAKE_DROID_CLOSE === "hang") {
      const marker = process.env.FAKE_DROID_CLOSE_MARKER

      if (marker !== undefined && marker.length > 0) writeFileSync(marker, "hung")

      return
    }

    respond(message.id, {})
    setTimeout(() => process.exit(0), 10)

    return
  }

  respond(message.id, {})
}

const input = createInterface({ input: process.stdin })

input.on("line", (line) => {
  if (line.trim().length === 0) return

  router(JSON.parse(line))
})

input.on("close", () => {
  setTimeout(() => process.exit(0), 20)
})
