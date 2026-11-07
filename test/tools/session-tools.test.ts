import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { sessionMcpTools } from "../../src/tools/session-mcp.ts"
import { withTools } from "../support/tools.ts"

describe("session admin tools", () => {
  it("sends settings with the session id and only the requested fields", async () => {
    const echoed = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_update_settings", {
          sessionId: harness.sessionId,
          autonomyLevel: "low",
          modelId: "gpt-6.1-sol",
        }),
      ),
    )

    expect(echoed).toEqual({
      method: "droid.update_session_settings",
      params: {
        sessionId: "fake-session",
        autonomyLevel: "low",
        modelId: "gpt-6.1-sol",
      },
    })
  })

  it("rejects an autonomy above the server cap", async () => {
    const failure = await Effect.runPromise(
      withTools(
        (harness) =>
          harness
            .call("session_update_settings", {
              sessionId: harness.sessionId,
              autonomyLevel: "high",
            })
            .pipe(Effect.flip),
        { maxAutonomy: "low" },
      ),
    )

    expect(failure.code).toBe("autonomy_exceeds_cap")
  })

  it("validates a new working directory", async () => {
    const failure = await Effect.runPromise(
      withTools((harness) =>
        harness
          .call("session_change_cwd", {
            sessionId: harness.sessionId,
            cwd: "relative/path",
          })
          .pipe(Effect.flip),
      ),
    )

    expect(failure.code).toBe("invalid_cwd")
  })

  it("switches interaction modes", async () => {
    const spec = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_enter_spec_mode", { sessionId: harness.sessionId }),
      ),
    )

    const auto = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_exit_spec_mode", { sessionId: harness.sessionId }),
      ),
    )

    expect(spec).toMatchObject({ params: { interactionMode: "spec" } })
    expect(auto).toMatchObject({ params: { interactionMode: "auto" } })
  })

  it("renames a session", async () => {
    const echoed = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_rename", { sessionId: harness.sessionId, title: "nightly fix" }),
      ),
    )

    expect(echoed).toMatchObject({ params: { title: "nightly fix" } })
  })
})

describe("session MCP tools", () => {
  it("adds a stdio server with its command, args, and env", async () => {
    const echoed = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_add_mcp_server", {
          sessionId: harness.sessionId,
          name: "paper",
          type: "stdio",
          command: "paper-mcp",
          args: ["--stdio"],
          env: { PAPER_TOKEN: "x" },
        }),
      ),
    )

    expect(echoed).toMatchObject({
      method: "droid.add_mcp_server",
      params: {
        sessionId: "fake-session",
        name: "paper",
        type: "stdio",
        command: "paper-mcp",
        args: ["--stdio"],
        env: { PAPER_TOKEN: "x" },
      },
    })
  })

  it("toggles and removes a server at the user settings level", async () => {
    const toggled = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_toggle_mcp_server", {
          sessionId: harness.sessionId,
          serverName: "paper",
          enabled: false,
          settingsLevel: "user",
        }),
      ),
    )

    const removed = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_remove_mcp_server", {
          sessionId: harness.sessionId,
          serverName: "paper",
          settingsLevel: "user",
        }),
      ),
    )

    expect(toggled).toMatchObject({
      params: { serverName: "paper", enabled: false, settingsLevel: "user" },
    })
    expect(removed).toMatchObject({
      method: "droid.remove_mcp_server",
      params: { serverName: "paper", settingsLevel: "user" },
    })
  })

  it("defaults an omitted settings level to user", async () => {
    const toggled = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_toggle_mcp_server", {
          sessionId: harness.sessionId,
          serverName: "paper",
          enabled: true,
        }),
      ),
    )

    const removed = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_remove_mcp_server", {
          sessionId: harness.sessionId,
          serverName: "paper",
        }),
      ),
    )

    expect(toggled).toMatchObject({
      params: { serverName: "paper", enabled: true, settingsLevel: "user" },
    })
    expect(removed).toMatchObject({
      params: { serverName: "paper", settingsLevel: "user" },
    })
  })

  it("infers stdio from command and http from url", async () => {
    const stdio = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_add_mcp_server", {
          sessionId: harness.sessionId,
          name: "paper",
          command: "paper-mcp",
          args: ["--stdio"],
        }),
      ),
    )

    const http = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_add_mcp_server", {
          sessionId: harness.sessionId,
          name: "paper",
          url: "https://paper.example/mcp",
        }),
      ),
    )

    const sse = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_add_mcp_server", {
          sessionId: harness.sessionId,
          name: "paper",
          type: "sse",
          url: "https://paper.example/sse",
        }),
      ),
    )

    expect(stdio).toMatchObject({
      method: "droid.add_mcp_server",
      params: { type: "stdio", command: "paper-mcp", args: ["--stdio"] },
    })
    expect(http).toMatchObject({
      params: { type: "http", url: "https://paper.example/mcp" },
    })
    expect(sse).toMatchObject({
      params: { type: "sse", url: "https://paper.example/sse" },
    })
  })

  it("rejects a missing or ambiguous MCP transport before the daemon", async () => {
    const missing = await Effect.runPromise(
      withTools((harness) =>
        harness
          .call("session_add_mcp_server", {
            sessionId: harness.sessionId,
            name: "paper",
          })
          .pipe(Effect.flip),
      ),
    )

    const ambiguous = await Effect.runPromise(
      withTools((harness) =>
        harness
          .call("session_add_mcp_server", {
            sessionId: harness.sessionId,
            name: "paper",
            command: "paper-mcp",
            url: "https://paper.example/mcp",
          })
          .pipe(Effect.flip),
      ),
    )

    expect(missing).toMatchObject({ code: "invalid_params" })
    expect(ambiguous).toMatchObject({ code: "invalid_params" })
  })

  it("forwards an oauth config and a required auth state", async () => {
    const added = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_add_mcp_server", {
          sessionId: harness.sessionId,
          name: "paper",
          type: "http",
          url: "https://paper.example/mcp",
          oauth: { clientId: "paper", tokenEndpointAuthMethod: "none" },
        }),
      ),
    )

    const disabled = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_add_mcp_server", {
          sessionId: harness.sessionId,
          name: "paper",
          type: "http",
          url: "https://paper.example/mcp",
          oauth: false,
        }),
      ),
    )

    const submitted = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_submit_mcp_auth_code", {
          sessionId: harness.sessionId,
          serverName: "paper",
          code: "auth-code",
          state: "auth-state",
        }),
      ),
    )

    expect(added).toMatchObject({
      method: "droid.add_mcp_server",
      params: {
        oauth: { clientId: "paper", tokenEndpointAuthMethod: "none" },
      },
    })
    expect(disabled).toMatchObject({ params: { oauth: false } })
    expect(submitted).toMatchObject({
      method: "droid.submit_mcp_auth_code",
      params: { serverName: "paper", code: "auth-code", state: "auth-state" },
    })
  })

  it("lists servers and tools", async () => {
    const servers = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_list_mcp_servers", { sessionId: harness.sessionId }),
      ),
    )

    const tools = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_list_mcp_tools", { sessionId: harness.sessionId }),
      ),
    )

    expect(servers).toMatchObject({ method: "droid.list_mcp_servers" })
    expect(tools).toMatchObject({ method: "droid.list_mcp_tools" })
  })

  it("accepts the SDK wire shapes and rejects the ones it does not", () => {
    const parametersOf = (name: string): Schema.Codec<unknown> => {
      const tool = sessionMcpTools().tools.find((entry) => entry.name === name)

      if (tool === undefined) throw new Error("missing " + name)

      // SAFETY: Tool.Any erases each parameter schema to Schema.Top. These tools
      // are Struct schemas with no decoding services.
      return tool.parametersSchema as Schema.Codec<unknown>
    }

    const accepts = (name: string, input: Schema.Json): boolean =>
      Option.isSome(Schema.decodeUnknownOption(parametersOf(name))(input))

    expect(
      accepts("session_submit_mcp_auth_code", {
        sessionId: "s",
        serverName: "paper",
        code: "c",
        state: "st",
      }),
    ).toBe(true)
    expect(
      accepts("session_submit_mcp_auth_code", {
        sessionId: "s",
        serverName: "paper",
        code: "c",
      }),
    ).toBe(false)

    expect(
      accepts("session_remove_mcp_server", {
        sessionId: "s",
        serverName: "paper",
        settingsLevel: "user",
      }),
    ).toBe(true)
    expect(
      accepts("session_remove_mcp_server", {
        sessionId: "s",
        serverName: "paper",
      }),
    ).toBe(true)
    expect(
      accepts("session_toggle_mcp_server", {
        sessionId: "s",
        serverName: "paper",
        enabled: true,
      }),
    ).toBe(true)
    expect(
      accepts("session_toggle_mcp_server", {
        sessionId: "s",
        serverName: "paper",
        enabled: true,
        settingsLevel: "project",
      }),
    ).toBe(false)
    expect(
      accepts("session_remove_mcp_server", {
        sessionId: "s",
        serverName: "paper",
        settingsLevel: "local",
      }),
    ).toBe(false)

    expect(
      accepts("session_add_mcp_server", {
        sessionId: "s",
        name: "paper",
        type: "http",
        oauth: false,
      }),
    ).toBe(true)
    expect(
      accepts("session_add_mcp_server", {
        sessionId: "s",
        name: "paper",
        type: "http",
        oauth: { clientId: "paper", resource: false },
      }),
    ).toBe(true)
    expect(
      accepts("session_add_mcp_server", {
        sessionId: "s",
        name: "paper",
        type: "http",
        oauth: true,
      }),
    ).toBe(false)
    expect(
      accepts("session_add_mcp_server", {
        sessionId: "s",
        name: "paper",
        command: "paper-mcp",
      }),
    ).toBe(true)
    expect(
      accepts("session_add_mcp_server", {
        sessionId: "s",
        name: "paper",
        url: "https://paper.example/mcp",
      }),
    ).toBe(true)
  })
})

describe("session history tools", () => {
  it("asks for rewind info before rewinding", async () => {
    const info = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_get_rewind_info", {
          sessionId: harness.sessionId,
          messageId: "m-1",
        }),
      ),
    )

    expect(info).toMatchObject({ method: "droid.get_rewind_info", params: { messageId: "m-1" } })
  })

  it("rewinds with explicit file lists", async () => {
    const echoed = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_rewind", {
          sessionId: harness.sessionId,
          messageId: "m-1",
          filesToRestore: ["a.txt"],
          filesToDelete: ["b.txt"],
        }),
      ),
    )

    expect(echoed).toMatchObject({
      params: { filesToRestore: ["a.txt"], filesToDelete: ["b.txt"] },
    })
  })

  it("compacts a session", async () => {
    const echoed = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_compact", {
          sessionId: harness.sessionId,
          customInstructions: "keep decisions",
        }),
      ),
    )

    expect(echoed).toMatchObject({ method: "droid.compact_session" })
  })

  it("forks a session and returns the new id", async () => {
    const forked = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_fork", { sessionId: harness.sessionId, title: "branch" }),
      ),
    )

    expect(forked).toMatchObject({ sessionId: "forked-session" })
  })

  it("reads context stats", async () => {
    const stats = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_get_context_stats", { sessionId: harness.sessionId }),
      ),
    )

    expect(stats).toMatchObject({ method: "droid.get_context_stats" })
  })
})

describe("session discovery tools", () => {
  it("lists tools and skills", async () => {
    const tools = await Effect.runPromise(
      withTools((harness) => harness.call("session_list_tools", { sessionId: harness.sessionId })),
    )

    const skills = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_list_skills", {
          sessionId: harness.sessionId,
          includeContent: true,
        }),
      ),
    )

    expect(tools).toMatchObject({ method: "droid.list_tools" })
    expect(skills).toMatchObject({ params: { includeContent: true } })
  })

  it("reports the models the CLI announced", async () => {
    const models = await Effect.runPromise(
      withTools((harness) => harness.call("session_models", { sessionId: harness.sessionId })),
    )

    expect(models).toEqual({ models: [{ id: "fake-model" }] })
  })

  it("runs one turn and closes the session", async () => {
    const outcome = await Effect.runPromise(
      withTools((harness) =>
        Effect.gen(function* () {
          const result = yield* harness.call("session_run", {
            cwd: process.cwd(),
            prompt: "echo:one",
            autonomyLevel: "low",
          })

          return result
        }),
      ),
    )

    expect(outcome).toMatchObject({
      sessionId: "fake-session",
      status: "completed",
      result: { reason: "completed", structuredOutput: { echo: "one" } },
    })
  })

  it("rejects a run without an absolute cwd", async () => {
    const failure = await Effect.runPromise(
      withTools((harness) =>
        harness
          .call("session_run", { cwd: ".", prompt: "hi", autonomyLevel: "low" })
          .pipe(Effect.flip),
      ),
    )

    expect(failure.code).toBe("invalid_cwd")
  })
})
