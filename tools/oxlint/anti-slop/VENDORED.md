# Vendored anti-slop plugin

Source: <https://github.com/dmmulroy/anti-slop>, base revision
`13909c9e07590f5a85d93c62712259fe14a883f7` (the plugin's `src/` tree, minus the
`src/` nesting level). Copied: 2026-11-06. The upstream MIT license is retained
in `LICENSE` next to this file.

Local edits: commit `7e7ab31` ("refactor: share duplicated helpers") deduplicated
helpers the rules repeated. It is no longer a verbatim copy:

- Modified `rules/no-chained-type-assertions.ts`, `rules/no-conditional-empty-object-spread.ts`,
  `rules/no-reflect-apply.ts`, `rules/no-reflect-get.ts`, `rules/no-unsafe-dictionary-type.ts`,
  `rules/no-widen-then-assert.ts` to import the shared helpers below.
- Added `shared/parentheses.ts` (`unwrapParenthesizedExpression`).
- Added `reportGlobalReflectCall` to `shared/reflect-method.ts`.
- Exported `typeReferenceName` from `shared/type-alias-resolution.ts` and `isNode` from
  `shared/lexical-type-parameters.ts`; `shared/dictionary-types.ts` now uses the shared
  `typeReferenceName`.

When updating from upstream, re-apply or reconcile these shared helpers instead of
overwriting them.

Compatibility: the plugin imports `eslintCompatPlugin` from `@oxlint/plugins`, pinned at
`1.93.0` in the root `package.json` together with `oxlint@1.93.0`. Upstream pins
`1.78.0`; the repository pin is what `pnpm lint` runs.

The plugin's own rule tests (`*.test.ts` beside each rule) run through
`scripts/test-lint-rules.ts` via `pnpm test:lint-rules`. The runner discovers the test
files itself and executes each with `node --experimental-strip-types`, matching upstream's
sequential `tsx` runner. `.oxlintrc.jsonc` and `.oxfmtrc.jsonc` ignore this directory so the
vendored TypeScript is neither linted nor formatted as application source; `tsconfig.json`
does type-check it.
