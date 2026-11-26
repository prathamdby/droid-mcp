import { RuleTester } from "oxlint/plugins-dev"

import { noPrivateImportRule } from "./no-private-import.ts"

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })
const privateImport = { messageId: "privateImport" }
const escapesRoot = { messageId: "escapesRoot" }

const ENTRY = "src/caller/index.ts"
const PRIVATE = "src/caller/private/store.ts"

tester.run("modularity/no-private-import", noPrivateImportRule, {
  valid: [
    // Non-src files are out of scope for the decomposition.
    { code: "import x from '../other/private/thing.ts';", filename: "tools/build.ts" },
    { code: "import x from '../other/private/thing.ts';", filename: "test/unit/thing.test.ts" },
    // Same-module private access from the module's own entry is the whole point.
    { code: "import { helper } from './private/helper.ts';", filename: ENTRY },
    { code: "export { helper } from './private/helper.ts';", filename: ENTRY },
    { code: "const mod = import('./private/helper.ts');", filename: ENTRY },
    // Sibling access between private files of the same module.
    { code: "import { peer } from './peer.ts';", filename: PRIVATE },
    {
      code: "import { peer } from '../private/peer.ts';",
      filename: "src/caller/private/nested/deep.ts",
    },
    { code: "import { entry } from '../index.ts';", filename: PRIVATE },
    {
      code: "import { entry } from '../../index.ts';",
      filename: "src/caller/private/nested/deep.ts",
    },
    // Cross-module entry-point access is exactly what the boundary allows.
    { code: "import { x } from '../authority/index.ts';", filename: ENTRY },
    { code: "import { x } from '../../authority/index.ts';", filename: PRIVATE },
    { code: "export { x } from '../authority/index.ts';", filename: ENTRY },
    // Package specifiers are not local references.
    { code: "import { Effect } from 'effect';", filename: ENTRY },
    { code: "import http from 'node:http';", filename: ENTRY },
    // Dynamic import with a non-literal is not a statically analyzable reference here.
    { code: "const mod = import(name);", filename: ENTRY },
    { code: "const mod = import(`./private/${name}.ts`);", filename: ENTRY },
  ],
  invalid: [
    {
      code: "import { secret } from '../authority/private/secret.ts';",
      filename: ENTRY,
      errors: [privateImport],
    },
    {
      code: "import { secret } from '../../authority/private/secret.ts';",
      filename: PRIVATE,
      errors: [privateImport],
    },
    {
      code: "import { secret } from '../../../authority/private/secret.ts';",
      filename: "src/caller/private/nested/deep.ts",
      errors: [privateImport],
    },
    {
      code: "export { secret } from '../authority/private/secret.ts';",
      filename: ENTRY,
      errors: [privateImport],
    },
    {
      code: "export type { secret } from '../authority/private/secret.ts';",
      filename: ENTRY,
      errors: [privateImport],
    },
    {
      code: "export * from '../authority/private/secret.ts';",
      filename: ENTRY,
      errors: [privateImport],
    },
    {
      code: "const mod = import('../authority/private/secret.ts');",
      filename: ENTRY,
      errors: [privateImport],
    },
    // Escapes above the module root.
    {
      code: "import { helper } from '../../scripts/helper.ts';",
      filename: ENTRY,
      errors: [escapesRoot],
    },
    {
      code: "import { helper } from '../../../scripts/helper.ts';",
      filename: PRIVATE,
      errors: [escapesRoot],
    },
    {
      code: "export { helper } from '../../scripts/helper.ts';",
      filename: ENTRY,
      errors: [escapesRoot],
    },
    {
      code: "const mod = import('../../scripts/helper.ts');",
      filename: ENTRY,
      errors: [escapesRoot],
    },
  ],
})
