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
 *   "permission:flood" asks, then emits enough tool results to evict that event
 *   "permission:flood-drop" evicts that prompt, then reuses its CLI id
 *   "permission:late" reuses one CLI id and delays the first resolution
 *   "permission:toolid" resolves with toolUseId tool-1 and no request id
 *   "permission:opaque" resolves with requestId hub-99, which is not a public id
 *   "permission:batch-ids" resolves a two-tool prompt with toolUseIds only
 *   "permission:queue:<n>" holds n distinct resolutions until every one is answered
 *   "permission:stale:<cap>" answers one id, fills the cap, then reuses that id
 *   "permission:ambiguous" answers two prompts that share a CLI id and tool id
 *   "permission:triple" answers three prompts that share one id, then resolves once
 *   "permission:evicted:<n>" evicts one id with n later prompts, then reuses it
 *   "permission:after-timeout" times out, reuses the id, then emits a late resolution
 *   "permission:after-cancel" cancels, reuses the id, then emits a late resolution
 *   "ask:stray" answers a question, then emits a permission_resolved for its CLI id
 *   "deny"        asks, and completes as permission_rejected on cancel
 *   "ask"         asks one single-select and one multi-select question
 *   "ask:huge"    asks one question whose text is several kilobytes
 *   "pick"        offers three rows, single-select
 *   "pick:huge"   offers one oversized row and one short row
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

const pendingPermission = (
  id,
  options = ["proceed_once", "proceed_always", "cancel"],
  toolId = "tool-1",
) =>
  request(id, "droid.request_permission", {
    toolUses: [toolUse(toolId, "Write", { path: "a.txt", content: "hi" })],
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

const pendingHugeQuestion = (id) =>
  request(id, "droid.ask_user", {
    toolCallId: "call-huge",
    questions: [
      {
        index: 0,
        topic: "Size",
        question: HUGE_TEXT,
        options: [{ label: "ok" }],
        multiSelect: false,
      },
    ],
  })

const pendingHugeOptions = (id) =>
  request(id, "droid.pick_options", {
    toolCallId: "call-huge-pick",
    title: "Pick a wide row",
    rows: [
      { id: "wide", label: HUGE_TEXT, detail: HUGE_TEXT },
      { id: "narrow", label: "narrow", detail: "small" },
    ],
    multi: false,
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
let resolveMode = "request"
let latePhase = "idle"
let holdGoal = 0
let staleLimit = 0
let stalePhase = "idle"
let ambiguousPhase = "idle"
let triplePhase = "idle"
let evictFill = 0
let evictPhase = "idle"
let evictAnswered = 0
const heldResolutions = []
const toolByCli = new Map()

/** Multibyte text past the hub's 1024-byte field cap. */
const HUGE_TEXT = "😀".repeat(400)

/** Enough ~4KiB tool results to push a prior event out of the 256KiB ring. */
const FLOOD_RESULTS = 80

/** Server-initiated requests carry their own ids, not the message's. */
const nextPromptId = () => {
  promptCount += 1

  return "prompt-" + String(promptCount)
}

const handlePrompt = (text) => {
  const id = nextPromptId()
  resolveMode = "request"
  latePhase = "idle"
  holdGoal = 0
  staleLimit = 0
  stalePhase = "idle"
  ambiguousPhase = "idle"
  triplePhase = "idle"
  evictFill = 0
  evictPhase = "idle"
  evictAnswered = 0
  heldResolutions.length = 0
  toolByCli.clear()

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

  if (text === "permission:flood" || text === "permission:flood-drop") {
    const cliId = text === "permission:flood-drop" ? "prompt-same" : id
    pendingPermission(cliId)
    setTimeout(() => {
      for (let index = 0; index < FLOOD_RESULTS; index += 1) {
        notify({
          type: "tool_result",
          toolUseId: "flood-" + String(index),
          isError: false,
          result: "z".repeat(8000),
        })
      }
    }, 40)

    if (text === "permission:flood-drop") {
      setTimeout(() => {
        request("prompt-same", "droid.request_permission", {
          toolUses: [toolUse("tool-2", "Second", { path: "b.txt", content: "hi" })],
          options: permissionOptions(["proceed_once", "cancel"]),
        })
      }, 700)
    }

    return true
  }

  if (text === "permission:late") {
    pendingPermission("prompt-same")
    latePhase = "armed"

    return true
  }

  if (text === "permission:toolid") {
    pendingPermission(id)
    resolveMode = "tool"

    return true
  }

  if (text === "permission:opaque") {
    pendingPermission(id)
    resolveMode = "opaque"

    return true
  }

  if (text === "permission:batch-ids") {
    pendingBatch(id)
    resolveMode = "batch"

    return true
  }

  if (text === "permission:ambiguous") {
    pendingPermission("prompt-same")
    resolveMode = "ambiguous"
    ambiguousPhase = "first"

    return true
  }

  if (text === "permission:triple") {
    pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")
    resolveMode = "triple"
    triplePhase = "first"

    return true
  }

  if (text.startsWith("permission:evicted:")) {
    evictFill = Number(text.slice("permission:evicted:".length))
    resolveMode = "evicted"
    evictPhase = "await-first"
    toolByCli.set("prompt-same", "tool-1")
    pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")

    return true
  }

  if (text === "permission:after-timeout" || text === "permission:after-cancel") {
    pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")
    resolveMode = text === "permission:after-timeout" ? "after-timeout" : "after-cancel"

    return true
  }

  if (text === "ask:stray") {
    pendingQuestions(id)
    resolveMode = "stray"

    return true
  }

  if (text.startsWith("permission:queue:")) {
    const count = Number(text.slice("permission:queue:".length))
    resolveMode = "hold"
    holdGoal = count

    for (let index = 1; index <= count; index += 1) {
      const cliId = "prompt-q-" + String(index)
      const toolId = "tool-q-" + String(index)
      toolByCli.set(cliId, toolId)
      pendingPermission(cliId, ["proceed_once", "cancel"], toolId)
    }

    return true
  }

  if (text.startsWith("permission:stale:")) {
    staleLimit = Number(text.slice("permission:stale:".length))
    resolveMode = "hold"
    holdGoal = staleLimit + 1
    stalePhase = "await-first"
    toolByCli.set("prompt-same", "tool-1")
    pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")

    return true
  }

  if (text === "ask:huge") {
    pendingHugeQuestion(id)

    return true
  }

  if (text === "pick:huge") {
    pendingHugeOptions(id)

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

const finishPrompt = (id, result) => {
  if (result === undefined) return

  const selected = result.selectedOption

  if (selected === "cancel") {
    if (resolveMode === "after-timeout" || resolveMode === "after-cancel") {
      pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")

      return
    }

    complete("permission_rejected", { structuredOutput: result })

    return
  }

  if (selected !== undefined) {
    if (latePhase === "armed") {
      latePhase = "second"
      pendingPermission(id)
      setTimeout(() => {
        notify({
          type: "permission_resolved",
          requestId: id,
          toolUseId: "tool-1",
          selectedOption: selected,
        })
      }, 350)

      return
    }

    if (resolveMode === "tool") {
      notify({ type: "permission_resolved", toolUseId: "tool-1", selectedOption: selected })
    } else if (resolveMode === "opaque") {
      notify({ type: "permission_resolved", requestId: "hub-99", selectedOption: selected })
    } else if (resolveMode === "batch") {
      notify({
        type: "permission_resolved",
        toolUseIds: ["tool-2", "tool-1"],
        selectedOption: selected,
      })
    } else if (resolveMode === "ambiguous") {
      if (ambiguousPhase === "first") {
        ambiguousPhase = "second"
        pendingPermission("prompt-same")

        return
      }

      notify({
        type: "permission_resolved",
        requestId: id,
        toolUseId: "tool-1",
        selectedOption: selected,
      })
      notify({
        type: "permission_resolved",
        requestId: id,
        toolUseId: "tool-1",
        selectedOption: selected,
      })
    } else if (resolveMode === "triple") {
      if (triplePhase === "first" || triplePhase === "second") {
        triplePhase = triplePhase === "first" ? "second" : "third"
        pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")

        return
      }

      notify({
        type: "permission_resolved",
        requestId: id,
        toolUseId: "tool-1",
        selectedOption: selected,
      })
    } else if (resolveMode === "evicted") {
      if (evictPhase === "await-first") {
        evictPhase = "fills"

        for (let index = 1; index <= evictFill; index += 1) {
          const cliId = "prompt-evict-" + String(index)
          const toolId = "tool-evict-" + String(index)
          toolByCli.set(cliId, toolId)
          pendingPermission(cliId, ["proceed_once", "cancel"], toolId)
        }

        return
      }

      if (evictPhase === "fills") {
        evictAnswered += 1

        if (evictAnswered === evictFill) {
          evictPhase = "reuser"
          toolByCli.set("prompt-same", "tool-1")
          pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")
        }

        return
      }

      notify({
        type: "permission_resolved",
        requestId: "prompt-same",
        toolUseId: "tool-1",
        selectedOption: selected,
      })
    } else if (resolveMode === "after-timeout" || resolveMode === "after-cancel") {
      notify({
        type: "permission_resolved",
        requestId: "prompt-same",
        toolUseId: "tool-1",
        selectedOption: selected,
      })
    } else if (resolveMode === "hold") {
      if (stalePhase === "await-first") {
        stalePhase = "filling"

        for (let index = 1; index < staleLimit; index += 1) {
          const cliId = "prompt-fill-" + String(index)
          const toolId = "tool-fill-" + String(index)
          toolByCli.set(cliId, toolId)
          pendingPermission(cliId, ["proceed_once", "cancel"], toolId)
        }

        toolByCli.set("prompt-same", "tool-1")
        pendingPermission("prompt-same", ["proceed_once", "cancel"], "tool-1")
      }

      heldResolutions.push({
        type: "permission_resolved",
        requestId: id,
        toolUseId: toolByCli.get(id) ?? "tool-1",
        selectedOption: selected,
      })

      if (heldResolutions.length >= holdGoal) {
        const notes = heldResolutions.splice(0, heldResolutions.length)

        for (const note of notes) notify(note)

        complete("completed", { structuredOutput: { resolved: notes.length } })
        holdGoal = 0
      }

      return
    } else {
      notify({
        type: "permission_resolved",
        requestId: id,
        toolUseId: "tool-1",
        selectedOption: selected,
      })
    }

    complete("completed", { structuredOutput: result })
    latePhase = "idle"

    return
  }

  if (result.answers !== undefined || result.cancelled === true) {
    if (resolveMode === "stray") {
      notify({
        type: "permission_resolved",
        requestId: id,
        toolUseId: "tool-1",
        selectedOption: "proceed_once",
      })
    }

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
    const id = message.id === undefined || message.id === null ? "" : String(message.id)
    finishPrompt(id, message.result)

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
