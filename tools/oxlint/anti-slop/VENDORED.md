# Vendored anti-slop plugin

Source: `/home/prathamd/.agents/skills/box/sandbox/anti-slop` (skill revision `13909c9`).
Copied: 2026-11-06.

`src/` is a verbatim copy. Do not edit it here; update the source skill and re-copy.

Compatibility: the plugin imports `eslintCompatPlugin` from `@oxlint/plugins`, pinned at
`1.91.0` in the root `package.json` together with `oxlint@1.91.0`. The skill's own
`package.json` pins `1.78.0`; both load, but the repository pin is what `pnpm lint` runs.

Both configs ignore this directory (`.oxlintrc.jsonc` and `.oxfmtrc.jsonc`), and
`tsconfig.json` does not include it, so the vendored TypeScript is neither linted,
formatted, nor type-checked.
