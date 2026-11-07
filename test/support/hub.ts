import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import * as Effect from "effect/Effect"

import type { AutonomyLevel } from "../../src/config.ts"
import { SessionProblem, sessionHub } from "../../src/droid/turns.ts"
import type { SessionHub, SessionHubOptions } from "../../src/droid/turns.ts"

const here = dirname(fileURLToPath(import.meta.url))
const fakePath = join(here, "..", "support", "fake-droid-exec.mjs")

export interface FakeHubOptions {
  readonly idleMs?: number
  readonly reaperIntervalMs?: number
  readonly promptTimeoutMs?: number
  readonly waitMs?: number
  readonly requestTimeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** A hub backed by `fake-droid-exec.mjs`, so tests never need a model. */
export const fakeHub = (overrides: FakeHubOptions = {}): Effect.Effect<SessionHub> =>
  sessionHub({
    droidPath: process.execPath,
    args: [fakePath],
    version: "0.1.0",
    waitMs: overrides.waitMs ?? 2_000,
    idleMs: overrides.idleMs ?? 30 * 60 * 1000,
    reaperIntervalMs: overrides.reaperIntervalMs ?? 60_000,
    promptTimeoutMs: overrides.promptTimeoutMs ?? 5_000,
    requestTimeoutMs: overrides.requestTimeoutMs,
    env: overrides.env,
  } satisfies SessionHubOptions)

export const tempCwd = (): string => here

export const createSession = (
  hub: SessionHub,
  cwd: string = here,
  maxAutonomy?: AutonomyLevel,
): Effect.Effect<string, SessionProblem> => {
  const options = { cwd, autonomyLevel: "low" as const }

  if (maxAutonomy === undefined) {
    return hub.api.create(options).pipe(Effect.map((created) => created.sessionId))
  }

  return hub.api
    .create({ ...options, maxAutonomy })
    .pipe(Effect.map((created) => created.sessionId))
}
