# Duplication clusters

Aroma scan of every function in `src`, `test`, `scripts`, and `tools`, skipping `node_modules`, build output, coverage, and caches. Aroma was cloned to a temp folder outside this repo and was not added as a dependency.

A function is indexed when its body has at least 30 features. That is Aroma's floor for a snippet too small to compare. Local names are `#VAR`. An exact copy is the same simplified parse tree after that rename. A near copy has similarity `|A∩B|/|A|` and `|A∩B|/|B|` of at least 0.8 both ways, or at least 0.9 one way with a feature-size ratio of at least 0.75. Linked functions are one cluster.

## Before

- Source lines (`src`, `test`, `scripts`, `tools`, TypeScript and JavaScript): 65235
- Files scanned: 184
- Functions parsed: 998
- Indexed: 864
- Skipped as too small: 131
- Exact groups: 26
- Near pairs: 32
- Clusters: 40 (21 exact, 14 near, 5 mixed)
- `pnpm test`: 618 passed, 5 skipped, 0 failed, vitest duration 90.56s

The five skipped tests are the live suite. They skip unless `DROID_MCP_LIVE_DAEMON=1`. That was the suite before this change, not a failure.

## After

- Source lines, counted the same way: 64997 (238 fewer)
- Files scanned: 189
- Functions parsed: 973
- Indexed: 832
- Skipped as too small: 138
- Exact groups: 5
- Near pairs: 10
- Clusters: 15 (5 exact, 10 near, 0 mixed)
- `pnpm test`: 618 passed, 5 skipped, 0 failed, vitest duration 89.66s

The same five live tests skipped. No test failed before the change, and none failed after. The 15 clusters that remain are the ones marked kept below. There is no emit build. `pnpm typecheck` is the compile check, and it passed, as did lint, format check, and codegen check.

## Clusters

### C1 mixed

5 functions, 2 exact links, 7 near links.

- `test/turn/lifecycle.test.ts:7-10` `scoped` (86 features, 4 lines)
- `test/turn/ownership.test.ts:132-140` `scoped` (86 features, 9 lines)
- `test/turn/prompt-lifecycle.test.ts:8-13` `scoped` (92 features, 6 lines)
- `test/turn/retention.test.ts:12-15` `scoped` (86 features, 4 lines)
- `test/turn/submission.test.ts:7-10` `scoped` (86 features, 4 lines)

Merged into `scopedHub` in `test/support/hub.ts`. The prompt-lifecycle call that passed `200` now passes `fakeHub({ promptTimeoutMs: 200 })`.

### C2 exact

5 functions, 4 exact links, 0 near links.

- `src/droid/redact.ts:23-24` `<anonymous>` (34 features, 2 lines)
- `src/droid/rest-http.ts:39-40` `<anonymous>` (34 features, 2 lines)
- `src/tools/results.ts:129-130` `<anonymous>` (34 features, 2 lines)
- `test/support/fake-context-api.ts:175-176` `<anonymous>` (34 features, 2 lines)
- `test/support/fake-factory-api.ts:244-245` `<anonymous>` (34 features, 2 lines)

Kept. Same predicate, different JSON brands and layers (`droid`, `tools`, test fakes). A shared helper would couple those layers.

### C3 mixed

4 functions, 2 exact links, 3 near links.

- `src/tools/session-admin.ts:33-46` `send` (120 features, 14 lines)
- `src/tools/session-discover.ts:23-32` `send` (94 features, 10 lines)
- `src/tools/session-history.ts:12-21` `send` (94 features, 10 lines)
- `src/tools/session-mcp.ts:57-66` `send` (94 features, 10 lines)

Merged into `commandSession` in `src/tools/session.ts`. Admin still passes a params object and forwards `sessionId`.

### C4 exact

4 functions, 3 exact links, 0 near links.

- `test/acceptance/flow.test.ts:82-93` `freePort` (192 features, 12 lines)
- `test/http/generated-failure.test.ts:21-32` `closedPort` (192 features, 12 lines)
- `test/process/server.test.ts:44-54` `freePort` (192 features, 11 lines)
- `test/tools/compact.test.ts:128-139` `closedPort` (192 features, 12 lines)

Merged into `freePort` in `test/support/port.ts`. `closedPort` is the same probe.

### C5 exact

4 functions, 3 exact links, 0 near links.

- `tools/oxlint/anti-slop/rules/no-unsafe-dictionary-type.ts:57-59` `typeReferenceName` (48 features, 3 lines)
- `tools/oxlint/anti-slop/rules/no-widen-then-assert.ts:30-32` `typeReferenceName` (48 features, 3 lines)
- `tools/oxlint/anti-slop/shared/dictionary-types.ts:77-79` `typeReferenceName` (48 features, 3 lines)
- `tools/oxlint/anti-slop/shared/type-alias-resolution.ts:186-188` `typeReferenceName` (48 features, 3 lines)

Merged into `typeReferenceName` in `tools/oxlint/anti-slop/shared/type-alias-resolution.ts`.

### C6 near

3 functions, 0 exact links, 3 near links.

- `tools/oxlint/anti-slop/rules/no-module-mocking.ts:70-79` `noModuleMockingRule.createOnce` (126 features, 10 lines)
- `tools/oxlint/anti-slop/rules/no-reflect-apply.ts:18-27` `noReflectApplyRule.createOnce` (132 features, 10 lines)
- `tools/oxlint/anti-slop/rules/no-reflect-get.ts:18-27` `noReflectGetRule.createOnce` (132 features, 10 lines)

Merged the two Reflect visitors into `reportGlobalReflectCall` in `shared/reflect-method.ts`. `no-module-mocking` stays: it matches a different call.

### C7 mixed

3 functions, 1 exact links, 2 near links.

- `src/droid/ws.ts:65-72` `concat` (132 features, 8 lines)
- `test/support/fake-daemon.ts:85-92` `concat` (132 features, 8 lines)
- `test/unit/ws-handshake.test.ts:79-85` `concatBytes` (104 features, 7 lines)

Merged by exporting `concat` from `src/droid/ws.ts` and using it in the fake daemon and the handshake test.

### C8 mixed

3 functions, 1 exact links, 2 near links.

- `test/prompts/ask-user.test.ts:54-60` `pending` (100 features, 7 lines)
- `test/prompts/permission.test.ts:7-14` `pending` (120 features, 8 lines)
- `test/prompts/timeout.test.ts:7-13` `pending` (100 features, 7 lines)

Merged into `pendingEvent` in `test/support/prompts.ts`. The permission test keeps its cursor in the failure message.

### C9 mixed

3 functions, 1 exact links, 2 near links.

- `tools/oxlint/anti-slop/rules/no-chained-type-assertions.ts:10-16` `unwrapParenthesizedExpression` (57 features, 7 lines)
- `tools/oxlint/anti-slop/rules/no-conditional-empty-object-spread.ts:4-10` `unwrapParentheses` (57 features, 7 lines)
- `tools/oxlint/anti-slop/rules/no-widen-then-assert.ts:18-22` `unwrapExpressionParentheses` (57 features, 5 lines)

Merged into `unwrapParenthesizedExpression` in `tools/oxlint/anti-slop/shared/parentheses.ts`.

### C10 near

2 functions, 0 exact links, 1 near links.

- `test/support/fake-context-api.ts:955-1069` `startFakeContextApi` (1594 features, 115 lines)
- `test/support/fake-factory-api.ts:1792-1916` `startFakeFactoryApi` (1762 features, 125 lines)

Kept. The two starters differ in body decoding, miss-error envelopes, and `failNext`. A shared server would have to parameterize those.

### C11 near

2 functions, 0 exact links, 1 near links.

- `test/process/server.test.ts:56-90` `start` (346 features, 35 lines)
- `test/process/server.test.ts:104-133` `exitOf` (335 features, 30 lines)

Merged the shared spawn into `spawnServe` in `test/process/server.test.ts`. Waiting for the port and waiting for exit stay separate.

### C12 exact

2 functions, 1 exact links, 0 near links.

- `test/support/fake-context-api.ts:858-879` `matchPath` (240 features, 22 lines)
- `test/support/fake-factory-api.ts:1690-1711` `matchPath` (240 features, 22 lines)

Merged into `matchPath` in `test/support/fake-route.ts`.

### C13 near

2 functions, 0 exact links, 1 near links.

- `tools/oxlint/anti-slop/rules/no-known-value-widening.ts:22-34` `unwrapExpression` (137 features, 13 lines)
- `tools/oxlint/anti-slop/shared/array-method.ts:4-16` `unwrapArrayExpression` (145 features, 13 lines)

Kept. One unwraps chain expressions; the other unwraps assertions. The wrapper sets differ.

### C14 near

2 functions, 0 exact links, 1 near links.

- `src/droid/exec-protocol.ts:74-85` `responseEnvelope` (56 features, 12 lines)
- `src/droid/exec-protocol.ts:87-99` `errorResponseEnvelope` (69 features, 13 lines)

Merged the shared response fields into `responseFields` in `src/droid/exec-protocol.ts`.

### C15 exact

2 functions, 1 exact links, 0 near links.

- `test/support/fake-context-api.ts:845-856` `routeOf` (170 features, 12 lines)
- `test/support/fake-factory-api.ts:1677-1688` `routeOf` (170 features, 12 lines)

Merged into `routeOf` in `test/support/fake-route.ts`.

### C16 exact

2 functions, 1 exact links, 0 near links.

- `test/support/fake-context-api.ts:909-917` `headerRecord` (130 features, 9 lines)
- `test/support/fake-factory-api.ts:1737-1745` `headerRecord` (130 features, 9 lines)

Merged into `headerRecord` in `test/support/fake-route.ts`.

### C17 near

2 functions, 0 exact links, 1 near links.

- `test/acceptance/flow.test.ts:73-80` `shim` (108 features, 8 lines)
- `test/daemon/host.test.ts:29-36` `shim` (108 features, 8 lines)

Kept. One shim forwards arguments (`"$@"`); the other drops them.

### C18 exact

2 functions, 1 exact links, 0 near links.

- `tools/oxlint/anti-slop/shared/lexical-type-parameters.ts:5-12` `isNode` (58 features, 8 lines)
- `tools/oxlint/anti-slop/shared/type-alias-resolution.ts:34-41` `isNode` (58 features, 8 lines)

Merged into `isNode` in `tools/oxlint/anti-slop/shared/lexical-type-parameters.ts`.

### C19 exact

2 functions, 1 exact links, 0 near links.

- `test/http/generated-autonomy.test.ts:21-27` `<anonymous>` (77 features, 7 lines)
- `test/http/tool-failures.test.ts:23-29` `<anonymous>` (77 features, 7 lines)

Kept. Each file closes its own client, daemon, and temp directory.

### C20 exact

2 functions, 1 exact links, 0 near links.

- `test/prompts/autonomy.test.ts:8-14` `pending` (86 features, 7 lines)
- `test/turn/prompt-lifecycle.test.ts:15-21` `permissionEvent` (86 features, 7 lines)

Merged into `pendingEvent`. The failure text stays `missing pending permission`.

### C21 near

2 functions, 0 exact links, 1 near links.

- `tools/oxlint/anti-slop/rules/no-runtime-typeof.ts:7-13` `isRuntimeFunction` (56 features, 7 lines)
- `tools/oxlint/anti-slop/vendor/eslint-stylistic/padding-line-ast.ts:25-28` `isFunction` (55 features, 4 lines)

Kept. Vendored stylistic predicate versus a type guard, across the vendor boundary.

### C22 exact

2 functions, 1 exact links, 0 near links.

- `test/http/transport.test.ts:56-61` `stateless` (44 features, 6 lines)
- `test/skill/skill.test.ts:65-70` `stateless` (44 features, 6 lines)

Merged into `stateless` in `test/support/mcp-http.ts`.

### C23 exact

2 functions, 1 exact links, 0 near links.

- `test/skill/drift.test.ts:13-18` `walk` (103 features, 6 lines)
- `scripts/embed-skill.ts:15-20` `walk` (103 features, 6 lines)

Kept. The drift test walks the skill tree itself so a broken embed walker cannot hide missing files.

### C24 exact

2 functions, 1 exact links, 0 near links.

- `test/unit/daemon-client.test.ts:17-22` `<anonymous>` (34 features, 6 lines)
- `test/unit/daemon-service.test.ts:20-25` `<anonymous>` (34 features, 6 lines)

Kept. Each unit file owns its daemon slot.

### C25 exact

2 functions, 1 exact links, 0 near links.

- `src/droid/daemon-client.ts:199-203` `broadcast` (117 features, 5 lines)
- `src/droid/exec-client.ts:95-99` `broadcast` (117 features, 5 lines)

Merged into `broadcast` in `src/droid/broadcast.ts`, with `publishItem` and `endBroadcast`.

### C26 near

2 functions, 0 exact links, 1 near links.

- `test/support/fake-context-api.ts:264-268` `fileOf` (87 features, 5 lines)
- `test/support/fake-context-api.ts:270-274` `sessionOf` (87 features, 5 lines)

Kept. Different stores and id parameters (`fileId` versus `sessionId`).

### C27 near

2 functions, 0 exact links, 1 near links.

- `test/support/fake-context-api.ts:729-733` `SESSION_ROUTES` (67 features, 5 lines)
- `test/support/fake-factory-api.ts:806-810` `SESSION_ROUTES` (61 features, 5 lines)

Kept. Different response bodies (`sessionJson` versus the session record).

### C28 exact

2 functions, 1 exact links, 0 near links.

- `src/droid/daemon-client.ts:177-180` `notificationOf` (75 features, 4 lines)
- `src/droid/exec-client.ts:109-112` `notificationOf` (75 features, 4 lines)

Merged into `notificationOf` in `src/droid/protocol.ts`.

### C29 exact

2 functions, 1 exact links, 0 near links.

- `src/droid/daemon-client.ts:182-185` `serverRequestOf` (115 features, 4 lines)
- `src/droid/exec-client.ts:114-117` `requestOf` (115 features, 4 lines)

Merged into `requestOf` in `src/droid/protocol.ts`.

### C30 exact

2 functions, 1 exact links, 0 near links.

- `src/droid/ws.ts:292-295` `computeAccept` (38 features, 4 lines)
- `test/support/fake-daemon.ts:46-49` `serverAccept` (38 features, 4 lines)

Merged by importing the exported `computeAccept` from `src/droid/ws.ts`.

### C31 exact

2 functions, 1 exact links, 0 near links.

- `src/droid/daemon-client.ts:205-207` `publishItem` (34 features, 3 lines)
- `src/droid/exec-client.ts:101-103` `publishItem` (34 features, 3 lines)

Merged into `publishItem` in `src/droid/broadcast.ts`.

### C32 exact

2 functions, 1 exact links, 0 near links.

- `test/http/transport.test.ts:39-41` `<anonymous>` (33 features, 3 lines)
- `test/skill/skill.test.ts:49-51` `<anonymous>` (33 features, 3 lines)

Kept. Each file binds its own server and key.

### C33 near

2 functions, 0 exact links, 1 near links.

- `src/http/auth.ts:16-17` `digest` (32 features, 2 lines)
- `test/context/context.test.ts:59-59` `sha256` (32 features, 1 lines)

Kept. Different inputs and encodings (UTF-8 bytes versus a hex digest of bytes).

### C34 near

2 functions, 0 exact links, 1 near links.

- `src/tools/rest-kit.ts:100-101` `placeholdersOf` (52 features, 2 lines)
- `test/skill/counts.test.ts:87-88` `backtickedIdentifiers` (52 features, 2 lines)

Kept. Different patterns: path placeholders versus backticked identifiers.

### C35 exact

2 functions, 1 exact links, 0 near links.

- `test/daemon/long-tail.test.ts:15-16` `generated` (48 features, 2 lines)
- `test/skill/counts.test.ts:133-134` `generated` (48 features, 2 lines)

Merged into `isAdvertisedMethod` in `src/tools/generated.ts`.

### C36 exact

2 functions, 1 exact links, 0 near links.

- `test/daemon/tools.test.ts:33-34` `run` (38 features, 2 lines)
- `test/tools/generated-autonomy.test.ts:34-35` `run` (38 features, 2 lines)

Merged into `runDaemon` in `test/support/daemon.ts`.

### C37 near

2 functions, 0 exact links, 1 near links.

- `test/unit/ws-handshake.test.ts:73-74` `timeouts` (40 features, 2 lines)
- `test/unit/ws-handshake.test.ts:76-77` `pipeWraps` (40 features, 2 lines)

Merged into `resourceCount` in `test/unit/ws-handshake.test.ts`.

### C38 near

2 functions, 0 exact links, 1 near links.

- `tools/oxlint/anti-slop/vendor/eslint-stylistic/padding-line-ast.ts:10-11` `isClosingBraceToken` (34 features, 2 lines)
- `tools/oxlint/anti-slop/vendor/eslint-stylistic/padding-line-ast.ts:14-15` `isSemicolonToken` (34 features, 2 lines)

Kept. Different punctuation predicates in the vendored port.

### C39 near

2 functions, 0 exact links, 1 near links.

- `tools/oxlint/anti-slop/vendor/eslint-stylistic/padding-line-ast.ts:21-22` `isTokenOnSameLine` (44 features, 2 lines)
- `tools/oxlint/anti-slop/vendor/eslint-stylistic/padding-line-ast.ts:31-32` `isSingleLine` (46 features, 2 lines)

Kept. Different line boundaries in the vendored port.

### C40 exact

2 functions, 1 exact links, 0 near links.

- `test/daemon/long-tail.test.ts:23-23` `surface` (32 features, 1 lines)
- `test/tools/inventory.test.ts:150-150` `toolNames` (32 features, 1 lines)

Merged into `registeredToolNames` in `test/support/tools.ts`.
