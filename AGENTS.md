# AGENTS.md

This repository is decomposed by **information hiding**, not by execution order. The governing principle is Parnas (1972), _On the Criteria To Be Used in Decomposing Systems into Modules_: begin with the design decisions that are difficult or likely to change, and assign exactly one such decision to each module, hidden behind an interface that reveals as little as possible. Modules never correspond to steps in a flowchart, and they are arranged in an explicit acyclic "uses" hierarchy (`L0`–`L9`) so upper levels can be pruned while lower levels keep working.

Every rule below is enforced deterministically. Do not work around the gates; change the architecture deliberately or not at all.

## Module roster and hidden secrets

| Level | Module (`src/<module>/`) | Hidden design decision                                                                                               |
| ----- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| L0    | `caller`                 | how principals are admitted, authenticated and bound to conversations and owned resources                            |
| L0    | `disclosure`             | which payloads may leave the system and how protected values are scrubbed for each audience                          |
| L0    | `custody`                | how resources are provisionally acquired, transferred across scopes and shut down within bounded time                |
| L0    | `factory-dialect`        | the exact wire versions, method strings, encodings and peer correlation formats of the Factory protocol              |
| L1    | `workspace`              | which filesystem roots are permitted and how checkouts are isolated, borrowed and cleaned up                         |
| L1    | `authority`              | how required effects are compared, narrowed and granted per principal, target and evidence strength                  |
| L1    | `guidance`               | the embedded operator guide content and the proof that its root instructions were delivered                          |
| L1    | `observations`           | how observations are stored, retained, paged and woken up under backpressure                                         |
| L1    | `artifacts`              | how artifacts are selected, encoded, budgeted inline, retained and continued across pages                            |
| L1    | `daemon-link`            | how the daemon connection is dialed, authenticated, negotiated, handed off, reconnected and replayed                 |
| L2    | `capabilities`           | how operations are typed, bound, assembled and invoked — independent of any concrete operation list                  |
| L2    | `decisions`              | how outstanding offers are tracked, validated against the original choices and resolved with one-winner reply rights |
| L2    | `local-exec`             | how the local executable is spawned, challenged, correlated and spoken to over its typed peer protocol               |
| L3    | `daemon-operations`      | which operations the daemon serves, their replay restrictions and their enforceable settings                         |
| L3    | `hosted-factory`         | which hosted operations exist at the configured origin and how their REST shapes are bound                           |
| L3    | `prem-context`           | which Context operations exist at the configured origin and how spaces, documents and session records are bound      |
| L4    | `placement`              | how a runnable provider is selected and a live lease is bound to caller, grant, workspace and credential             |
| L5    | `turns`                  | how turn lifecycles race, reconcile completion, snapshot observations atomically and interrupt honestly              |
| L6    | `sessions`               | how public session references are owned, filtered per caller, subscribed to and retained after completion            |
| L7    | `presentation`           | how operations are ranked, aliased, composed into compact or full views and recovered in sequential batches          |
| L8    | `mcp`                    | the MCP negotiation, tool, resource, prompt and notification encodings exposed to clients                            |
| L9    | `products`               | operator configuration, ambient process state, transport carriers and product lifecycle wiring                       |

This table mirrors `MODULE_SPECS` in `scripts/check-boundaries.ts`; the script is the source of truth the gates check, so keep the two in sync when one changes.

## Rules for modifying or adding code

1. **Place changes by hidden secret, not by workflow step.** Code belongs to the module whose decision it implements, even if it executes in another module's workflow. If a new volatile design decision appears, introduce a new module at the lowest valid level in `scripts/check-boundaries.ts`: give it a documented `secret` and an explicit dependency list, never a home inside an unrelated module.

2. **Keep `src/<module>/index.ts` minimal, abstract and immutable.**
   - Explicit named exports only — never `export *`, in either direction.
   - Every exported type member is `readonly`; use `ReadonlyArray`/`readonly T[]`/`ReadonlyMap`/`ReadonlySet` instead of their mutable counterparts.
   - No `export let`/`export var`, no mutable public class fields, no shared mutable containers.
   - Opaque branded handles over leaked storage layouts, wire formats or child-process details.

3. **Keep imports strictly downward and entry-only.** `level(target) < level(source)`, always through `../<other>/index.ts`, never `../<other>/private/*`. Optional providers stay behind type-only edges (`import type`) where lower layers reference them, so upper/optional layers remain prunable — the DAG in `scripts/check-boundaries.ts` declares which edges are type-only.

4. **Keep transport carriers and ambient process I/O inside `src/products/`.** `node:http`, `effect/http`, `effect/ai` and all reads of `process.env`, `process.argv`, `process.stdin`/`stdout`/`stderr`, `process.exit`/`exitCode` exist only there. Lower modules receive configuration, streams and lifecycle control as explicit constructor inputs (see `LocalExecOptions.baseEnv`).

5. **Keep runtime code free of dynamic evaluation and compiler internals.** No `typescript`, `node:module`, `node:vm`, dynamic `import()` with non-literal specifiers, `require`/`createRequire`, `eval` or `Function` anywhere under `src/`.

## Deterministic enforcement

| Gate                                | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                         | `oxlint --deny-warnings` with the first-party plugins: `modularity/no-private-import` (no cross-module `private/` access, no escaping `src/`), `modularity/no-export-star` (explicit named exports only), `modularity/no-mutable-public-surface` (immutable public entry surfaces), `modularity/no-ambient-process-io` (ambient process state confined to `src/products/`), plus the `anti-slop/*` and `anti-slop-effect/*` rule sets. |
| `pnpm check:boundaries`             | The full 22-module DAG: every cross-module import points strictly downward, enters through `index.ts`, carries a `.ts` extension, honors type-only provider edges, never re-exports across modules, never uses `export *` (`wildcard_export`), and never touches transport/toolkit/compiler packages below its level. Also verifies the secrets manifest is complete.                                                                  |
| `pnpm codegen:check`                | The generated SDK dialect in `factory-dialect` matches the pinned upstream extraction exactly.                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test:lint-rules`              | Every custom Oxlint rule passes its `RuleTester` suite under `tools/oxlint/`.                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test`                         | All unit suites plus the four executable architectural proofs in `test/proofs/`.                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm typecheck` / `pnpm fmt:check` | Strict TypeScript (`tsc --noEmit`) and `oxfmt` formatting.                                                                                                                                                                                                                                                                                                                                                                             |

Run this exact block before every commit; all of it must exit 0:

```sh
pnpm fmt
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm codegen:check
pnpm check:boundaries
pnpm test:lint-rules
pnpm test
```

## Style

TypeScript, strict mode, no build step (Node type stripping). No semicolons, 2-space indentation, 100-column width, trailing commas — `oxfmt` owns layout; never hand-format around it. Match the surrounding module's documentation density: each module's `index.ts` opens with the invariants its secret depends on.
