import { createInterface } from "node:readline"

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"

import { trustedEvidence } from "../../caller/index.ts"
import { assemblePipeline } from "./assembly.ts"
import { buildMcp, encodeNotification, receiveRpc, rpcError } from "./rpc.ts"
import type { StdioOptions, StdioServerHandle } from "./types.ts"

export const stdioServer = async (options: StdioOptions): Promise<StdioServerHandle> => {
  const evidence = trustedEvidence(options.principal ?? "stdio")

  if (Option.isNone(evidence)) {
    throw new Error("stdioServer requires a non-blank trusted principal name")
  }

  const assembly = await assemblePipeline(options)

  try {
    const mcp = await buildMcp(assembly, options)

    // stdio is a bidirectional channel, so this carrier can honestly claim
    // subscription support and forward the notification stream.
    const endpoint = Effect.runSync(
      Effect.gen(function* () {
        const caller = yield* assembly.callers.admit(evidence.value)
        const conversation = yield* assembly.callers.conversation(caller)

        return yield* mcp.bind(assembly.view, caller, conversation, {
          supportsForms: false,
          supportsSubscriptions: true,
        })
      }),
    )

    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    const lines = createInterface({ input, crlfDelay: Infinity, terminal: false })
    let pending = Promise.resolve()
    let closing: Promise<void> | undefined

    // The notification pump shares the reply channel's serialized writes,
    // so a notification frame never interleaves with a reply mid-line. It
    // ends when the endpoint closes, never by itself dropping frames.
    const forwarded = Effect.runPromise(
      endpoint.notifications().pipe(
        Stream.runForEach((notification) =>
          Effect.sync(() => {
            pending = pending.then(() => {
              output.write(JSON.stringify(encodeNotification(notification)) + "\n")
            })
          }),
        ),
      ),
    ).catch(() => undefined)

    const shutdown = async (): Promise<void> => {
      lines.close()

      try {
        await pending
      } finally {
        try {
          await Effect.runPromise(endpoint.close())
          await forwarded
          await pending
        } finally {
          await assembly.close()
        }
      }
    }

    // Defer shutdown so readline's synchronous close event sees the same promise.
    const close = (): Promise<void> => (closing ??= Promise.resolve().then(shutdown))

    const closeFromInput = (): void => {
      void close().catch(() => undefined)
    }

    lines.on("close", closeFromInput)
    lines.on("error", closeFromInput)
    lines.on("line", (line) => {
      if (closing !== undefined || line.trim().length === 0) return

      pending = pending.then(async () => {
        const reply = await receiveRpc(endpoint, line).catch(() =>
          rpcError(null, -32_603, "internal error"),
        )

        if (reply !== undefined) output.write(JSON.stringify(reply) + "\n")
      })
    })

    return { close }
  } catch (failure) {
    await assembly.close().catch(() => undefined)

    throw failure
  }
}
