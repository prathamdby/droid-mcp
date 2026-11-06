import * as Effect from "effect/Effect"

import type { AutonomyLevel } from "../config.ts"
import { SessionProblem, checkCwd } from "../droid/turns.ts"
import type { ToolFailure } from "./failure.ts"

const RANK = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
} satisfies { readonly [Level in AutonomyLevel]: number }

export const autonomyWithinCap = (cap: AutonomyLevel, requested: AutonomyLevel): boolean =>
  RANK[requested] <= RANK[cap]

/** The server's `--max-autonomy` is a ceiling, not a default. */
export const requireAutonomy = (
  cap: AutonomyLevel,
  requested: AutonomyLevel,
): Effect.Effect<AutonomyLevel, ToolFailure> =>
  autonomyWithinCap(cap, requested)
    ? Effect.succeed(requested)
    : Effect.fail({
        code: "autonomy_exceeds_cap",
        message: "requested " + requested + " but the server caps autonomy at " + cap,
      })

export const toolFailure = (problem: SessionProblem): ToolFailure => ({
  code: problem.code,
  message: problem.message,
})

export const requireCwd = (cwd: string): Effect.Effect<string, ToolFailure> =>
  checkCwd(cwd).pipe(Effect.mapError(toolFailure))
