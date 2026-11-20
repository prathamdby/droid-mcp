import * as Effect from "effect/Effect"

import { DaemonService } from "../../src/droid/daemon-service.ts"
import type { DaemonApi } from "../../src/droid/daemon-service.ts"

export const runDaemon = <A, E>(effect: Effect.Effect<A, E, DaemonService>, api: DaemonApi) =>
  Effect.runPromise(Effect.provideService(effect, DaemonService, api))
