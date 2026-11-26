/**
 * Executable CLI entry point invoked by `pnpm start` and `pnpm run doctor`.
 * Delegates all argument parsing and lifecycle management to `runCli`.
 */
import { runCli } from "./parse.ts"

const exitCode = await runCli(process.argv.slice(2), process.env, {
  input: process.stdin,
  output: process.stdout,
  stderr: process.stderr,
  onSignal: (handler) => {
    process.once("SIGINT", handler)
    process.once("SIGTERM", handler)
  },
})

process.exitCode = exitCode
