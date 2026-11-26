# Restore CLI daemon authentication metadata

## Assumptions

- [Issue #18](https://github.com/prathamdby/droid-mcp/issues/18) records the failure on Droid 1.21.1 and Factory protocol `1.269.0`. A live smoke test needs an already-running compatible daemon and the operator's existing Factory API key. The automated regression test must need neither.
- [PR #17](https://github.com/prathamdby/droid-mcp/pull/17) moved CLI configuration into `products`. Before the merge, `src/droid/daemon-client.ts` sent `metadata.sdk.language: "typescript"` and `metadata.sdk.version` from the CLI version (`8f0d799^1`). The refactored `parseCliArgs` resolves the same API key but builds daemon auth with only `apiKey`.
- No ADR was found in the repository's ADR directories. `AGENTS.md` and `scripts/check-boundaries.ts` govern ownership and dependencies.

## Shape

**Restore the CLI identity where `products` already derives daemon credentials.** Reuse the existing `DaemonLinkOptions.auth.metadata` contract. The CLI supplies identity values; `daemon-link` keeps ownership of request serialization, authentication errors, and protocol negotiation.

## Layer map

| Layer                             | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L9 `products`, changed            | In `src/products/private/parse.ts`, use one CLI version constant for `runCli --version` and the metadata built by `parseCliArgs`. Make `CliConfig.daemonAuth` use the shared product `DaemonAuthOptions`; add optional readonly metadata to that type in `src/products/private/types.ts`. Omit the auth object when no key is configured. Both existing `runCli` branches already pass the same resolved auth through `doctor.ts` or `assembly.ts`. |
| L1 `daemon-link`, unchanged       | `daemonLinkLayer` already forwards optional metadata to `authenticateConnection` in `src/daemon-link/private/session.ts`. The handshake continues to supply the default `caller: "sdk"` and handle negotiation and failures as before.                                                                                                                                                                                                              |
| L3 `daemon-operations`, unchanged | Do not alter operation bindings, authority checks, or reply validation.                                                                                                                                                                                                                                                                                                                                                                             |
| Tests                             | Extend the executable CLI coverage in `test/unit/products.test.ts` using `startFakeDaemon` and its existing per-test `onRequest` handler. Do not change the shared fake's defaults.                                                                                                                                                                                                                                                                 |

## Sequence

1. **Reproduce through the executable CLI.** Parameterize the existing `doctor` Unix-socket test for a flag key (with a different synthetic environment key to prove precedence) and an environment-only key. Capture the executable's `--version` output. Have the fake daemon accept `daemon.authenticate` only when the wire request has the expected synthetic key, `caller: "sdk"`, and `metadata.sdk` with the TypeScript language and that version; otherwise reply with `Parse error`. Do not import the implementation's identity constant into the test. On the refactored baseline, both cases must reach authentication, be rejected, and report `reachable: false` with exit status 1.
2. **Restore the configuration.** Add the metadata once when a key is resolved. Reuse the optional product auth shape for both callers, keep existing endpoint and spawn wiring, and leave programmatic callers' metadata optional. Keep the parser checks for key resolution and absent auth without duplicating the wire identity assertion.
3. **Verify reachability and the probe boundary.** The strict fake must now accept both executable `doctor` cases, which return exit status 0 and `{"transport":"daemon","reachable":true}`. Preserve existing product probe tests. Also exercise executable `doctor` without `--daemon-url`, with a temporary runtime directory and a test executable that records any launch. Against the absent runtime socket, require exit status 1, `reachable: false`, and no launch marker. An explicit endpoint would already disable spawning and would not prove this property.
4. **Verify serving.** Start executable `serve --http` on an ephemeral port with a synthetic MCP bearer and the strict Unix-socket fake. Call `skill_read` as the same caller to satisfy the default guidance gate, then invoke `daemon_list_opened_sessions` through the default compact profile's `tool_call`. Require an accepted handshake before the listing request and a known listing result rather than `target_unavailable`. Use bounded startup and teardown. If an existing compatible Droid endpoint and configured credential are available, repeat `doctor` and the read against it without displaying credentials or session data. Otherwise record the live smoke test as not run.

## Risks

| Judgment                         | Risk and mitigation                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High likelihood, high impact     | The executable can start successfully while daemon tools fail. The permissive fake in `products.test.ts` currently misses that distinction. Steps 1 and 4 make daemon acceptance and the downstream read observable.                                               |
| Medium likelihood, high impact   | Changing credential precedence, auth rejection, or probe lifecycle could mask the fix or launch a daemon during diagnostics. Preserve config resolution, `probeExisting`, and lower-layer auth behavior; exercise precedence and no-spawn explicitly in steps 1–3. |
| Medium likelihood, medium impact | A separate SDK version literal could drift from `--version`. Share a CLI constant and independently compare it to executable output in step 1.                                                                                                                     |
| Low likelihood, high impact      | Real credentials or live session data could leak into fixtures or logs. Use synthetic keys in automated tests; use existing environment configuration for the optional smoke test and record only reachability and read success.                                   |

Compatibility and operations: no new flags, deployment order, client migration, persistence change, or retry. Reverting the small change restores prior behavior, including the affected daemon's failure; no data repair is needed. No new dependency, authority grant, or tenant scope. Data and cost lenses are not applicable: the plan changes neither storage nor the number of network exchanges.

## Milestone

One fix PR: the strict executable tests fail before the change and pass after it; the absent-daemon probe cannot spawn; a daemon-backed read succeeds over MCP HTTP. Run the targeted `products` suite, then the exact `AGENTS.md` gate block: `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm codegen:check`, `pnpm check:boundaries`, `pnpm test:lint-rules`, and `pnpm test`. Report the live smoke test separately.

## Non-goals

No systemd migration, SDK or protocol pin change, authority-policy change, or changes to reply validation for `daemon_get_default_settings` and `daemon_list_available_sessions`.
