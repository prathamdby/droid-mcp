import { RuleTester } from "oxlint/plugins-dev"

import { noAmbientProcessIoRule } from "./no-ambient-process-io.ts"

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })
const error = { messageId: "ambientIo" }

const MODULE = "src/caller/index.ts"
const PRIVATE = "src/local-exec/private/process.ts"
const PRODUCTS = "src/products/private/cli.ts"

tester.run("modularity/no-ambient-process-io", noAmbientProcessIoRule, {
  valid: [
    // The product composition root owns ambient process access.
    { code: "const path = process.env['PATH'];", filename: PRODUCTS },
    { code: "process.exitCode = 1;", filename: PRODUCTS },
    { code: "const args = process.argv.slice(2);", filename: "src/products/index.ts" },
    // Files outside src/ never participate.
    { code: "const path = process.env['PATH'];", filename: "tools/build.ts" },
    { code: "process.exit(1);", filename: "scripts/check.ts" },
    // Non-ambient runtime facts carry no configuration or I/O surface.
    { code: "const pid = process.pid;", filename: MODULE },
    { code: "const platform = process.platform;", filename: PRIVATE },
    { code: "const exe = process.execPath;", filename: PRIVATE },
    { code: "process.kill(pid, 'SIGTERM');", filename: PRIVATE },
    { code: "const version = process.version;", filename: MODULE },
    { code: "const cwd = process.cwd();", filename: PRIVATE },
    { code: "process.on('exit', cleanup);", filename: MODULE },
    // A locally bound `process` is explicit injection, not ambient access.
    {
      code: "function run(process: NodeJS.Process) { return process.env['PATH']; }",
      filename: MODULE,
    },
    {
      code: "const run = (process: { env: Record<string, string> }) => process.env['X'];",
      filename: MODULE,
    },
    { code: "const process = { env: {} }; process.env['X'];", filename: MODULE },
    { code: "import { process } from 'node:process'; const x = process.env;", filename: MODULE },
    { code: "for (const process of jobs) { process.env; }", filename: MODULE },
    // Non-process receivers are irrelevant.
    { code: "const env = config.env;", filename: MODULE },
    { code: "proc.env['PATH'];", filename: MODULE },
    // Computed non-literal access cannot be classified, so it is not reported
    // as ambient state (the boundary checker still governs the module).
    { code: "process[key];", filename: MODULE },
  ],
  invalid: [
    { code: "const path = process.env['PATH'];", filename: MODULE, errors: [error] },
    { code: "const path = process.env.PATH;", filename: MODULE, errors: [error] },
    { code: "const home = process.env.HOME ?? '/';", filename: PRIVATE, errors: [error] },
    { code: "process.env['FACTORY'] = 'x';", filename: MODULE, errors: [error] },
    { code: "const args = process.argv;", filename: MODULE, errors: [error] },
    { code: "process.argv.slice(2);", filename: MODULE, errors: [error] },
    { code: "process.stdin.pipe(out);", filename: PRIVATE, errors: [error] },
    { code: "process.stdout.write('x');", filename: MODULE, errors: [error] },
    { code: "process.stderr.write('x');", filename: MODULE, errors: [error] },
    { code: "process.exit(1);", filename: MODULE, errors: [error] },
    { code: "process.exitCode = 1;", filename: PRIVATE, errors: [error] },
    // Bracket access with string literals is the same ambient access.
    { code: "process['env'];", filename: MODULE, errors: [error] },
    { code: "process['argv'].slice(2);", filename: MODULE, errors: [error] },
    { code: "process['exit'](1);", filename: PRIVATE, errors: [error] },
    { code: "process['exitCode'] = 0;", filename: MODULE, errors: [error] },
    { code: "process['stdin'].pipe(out);", filename: MODULE, errors: [error] },
    // Multiple ambient reads report each access.
    {
      code: "const a = process.env['PATH']; const b = process.argv;",
      filename: MODULE,
      errors: [error, error],
    },
  ],
})
