import { RuleTester } from "oxlint/plugins-dev"

import { noExportStarRule } from "./no-export-star.ts"

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })
const error = { messageId: "exportStar" }

const ENTRY = "src/caller/index.ts"
const PRIVATE = "src/caller/private/store.ts"

tester.run("modularity/no-export-star", noExportStarRule, {
  valid: [
    // Files outside src/ are not part of the module decomposition.
    { code: "export * from './helpers.ts';", filename: "tools/build.ts" },
    { code: "export * from './fixtures.ts';", filename: "test/unit/fixtures.ts" },
    // Explicitly named exports are the required form.
    { code: "export { helper } from './private/helper.ts';", filename: ENTRY },
    { code: "export type { Helper } from './private/helper.ts';", filename: ENTRY },
    { code: "export { a, b as c } from '../authority/index.ts';", filename: ENTRY },
    { code: "const value = 1; export { value };", filename: ENTRY },
    { code: "export const value = 1;", filename: ENTRY },
    { code: "export default 1;", filename: ENTRY },
  ],
  invalid: [
    {
      code: "export * from './private/helper.ts';",
      filename: ENTRY,
      errors: [error],
    },
    {
      code: "export * as ns from './private/helper.ts';",
      filename: ENTRY,
      errors: [error],
    },
    {
      code: "export type * from './private/helper.ts';",
      filename: ENTRY,
      errors: [error],
    },
    {
      code: "export type * as ns from './private/helper.ts';",
      filename: ENTRY,
      errors: [error],
    },
    {
      code: "export * from '../authority/index.ts';",
      filename: ENTRY,
      errors: [error],
    },
    {
      code: "export * from './sibling.ts';",
      filename: PRIVATE,
      errors: [error],
    },
  ],
})
