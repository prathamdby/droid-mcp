/**
 * Composition of the caller-scoped capability pipeline shared by every
 * server product. The assembly is built once per product root: custody,
 * workspaces, authority, callers, guidance, disclosure, dialect, daemon
 * link, capabilities, decisions, observations, artifacts, local exec,
 * placement, turns, sessions, presentation — and only then, inside the
 * carrier-specific roots, MCP.
 *
 * Optional providers are exact omissions, never stubs: `includeDaemon:
 * false` drops the daemon entries, facets and connection entirely; a
 * missing hosted or Context origin contributes zero operations. A provider
 * failure at binding time is reported, not hidden.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"

import { artifactsLayer } from "../../artifacts/index.ts"
import { authorityLayer } from "../../authority/index.ts"
import { Callers, callersLayer } from "../../caller/index.ts"
import { Capabilities, capabilitiesLayer } from "../../capabilities/index.ts"
import type { BoundOperation } from "../../capabilities/index.ts"
import { custodyLayer } from "../../custody/index.ts"
import { decisionsLayer } from "../../decisions/index.ts"
import { disclosureLayer } from "../../disclosure/index.ts"
import { dialectLayer } from "../../factory-dialect/index.ts"
import { Guidance, guidanceLayer } from "../../guidance/index.ts"
import { localExecLayer } from "../../local-exec/index.ts"
import { observationsLayer } from "../../observations/index.ts"
import { placementLayer } from "../../placement/index.ts"
import {
  Presentation,
  buildRoster,
  createView,
  presentationLayer,
} from "../../presentation/index.ts"
import type { OperationRoster, View } from "../../presentation/index.ts"
import { Sessions, sessionsLayer } from "../../sessions/index.ts"
import { turnsLayer } from "../../turns/index.ts"
import { workspacesLayer } from "../../workspace/index.ts"
import { bindServerInfo } from "./server-info.ts"
import { bindSkillRead } from "./skill-read.ts"
import type { AssemblyOptions } from "./types.ts"

/** The assembled pipeline a product root consumes. */
export interface Assembly {
  readonly view: View
  readonly roster: OperationRoster
  readonly scope: Scope.Scope
  readonly callers: Callers["Service"]
  readonly capabilities: Capabilities["Service"]
  readonly sessions: Sessions["Service"]
  readonly guidance: Guidance["Service"]
  readonly presentation: Presentation["Service"]
  readonly close: () => Promise<void>
}

/**
 * Builds one scoped pipeline, loading only the configured providers.
 */
export const assemblePipeline = async (options: AssemblyOptions): Promise<Assembly> => {
  const scope = Effect.runSync(Scope.make())

  const sharedSessions = options.sharedSessions ?? false
  const guidanceRequired = options.guidanceRequired ?? true
  const maxAutonomy = options.maxAutonomy ?? "medium"

  const disclosureLive = disclosureLayer({})

  const authorityLive = authorityLayer({
    maxAutonomy,
    allowUnverifiedDaemonAuthority: options.allowUnverifiedDaemonAuthority,
  })

  const callersLive = callersLayer({ sharedSessions })
  const guidanceLive = guidanceLayer({ required: guidanceRequired })

  const workspacesLive = Layer.provideMerge(
    workspacesLayer({ allowedRoots: options.workspaceRoots ?? [process.cwd()] }),
    custodyLayer,
  )

  const baseDeps = Layer.mergeAll(
    custodyLayer,
    workspacesLive,
    authorityLive,
    callersLive,
    guidanceLive,
    disclosureLive,
    dialectLayer,
  )

  const capabilitiesLive = Layer.provideMerge(capabilitiesLayer, baseDeps)
  const decisionsLive = Layer.provideMerge(decisionsLayer, baseDeps)
  const observationsLive = Layer.provideMerge(observationsLayer, baseDeps)
  const artifactsLive = Layer.provideMerge(artifactsLayer(), disclosureLive)

  const localLive = Layer.provideMerge(
    localExecLayer({
      droidPath: options.droidPath ?? "droid",
      args: options.droidArgs,
      env: options.droidEnv,
    }),
    baseDeps,
  )

  const placementLive = Layer.provideMerge(placementLayer({}), Layer.mergeAll(localLive, baseDeps))

  const turnsLive = Layer.provideMerge(
    turnsLayer(),
    Layer.mergeAll(decisionsLive, observationsLive, baseDeps),
  )

  const sessionsLive = Layer.provideMerge(
    sessionsLayer({ sharedSessions, guidanceRequired, defaultWaitMs: 20_000 }),
    Layer.mergeAll(turnsLive, placementLive, capabilitiesLive, baseDeps),
  )

  const presentationLive = Layer.provideMerge(
    presentationLayer,
    Layer.merge(capabilitiesLive, artifactsLive),
  )

  const providerDeps = Layer.merge(capabilitiesLive, baseDeps)
  const core = Layer.mergeAll(sessionsLive, presentationLive, providerDeps)

  try {
    const memo = Layer.makeMemoMapUnsafe()
    const context = await Effect.runPromise(Layer.buildWithMemoMap(core, memo, scope))
    const providerEntries: Array<BoundOperation> = []

    if (options.includeDaemon ?? true) {
      const [{ daemonLinkLayer }, { DaemonOperations, daemonOperationsLayer }] = await Promise.all([
        import("../../daemon-link/index.ts"),
        import("../../daemon-operations/index.ts"),
      ])

      const daemonLinkLive = Layer.provideMerge(
        daemonLinkLayer({
          endpoint: options.daemonEndpoint,
          auth: options.daemonAuth,
        }),
        providerDeps,
      )

      const daemonLive = Layer.provideMerge(daemonOperationsLayer, daemonLinkLive)
      const daemonContext = await Effect.runPromise(Layer.buildWithMemoMap(daemonLive, memo, scope))

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const daemon = yield* DaemonOperations

          return yield* daemon.entries({
            peerId: "daemon",
            allowUnverifiedDaemonAuthority: options.allowUnverifiedDaemonAuthority ?? false,
            guidanceRequired,
            servedMethods: options.daemonServedMethods,
          })
        }).pipe(Effect.provide(daemonContext)),
      )

      providerEntries.push(...entries)
    }

    const { factoryApiKey, factoryBaseUrl, contextBaseUrl } = options
    const credential = factoryApiKey === undefined ? undefined : () => Effect.succeed(factoryApiKey)

    if (factoryBaseUrl !== undefined) {
      const { HostedOperations, hostedOperationsLayer } =
        await import("../../hosted-factory/index.ts")

      const hostedLive = Layer.provideMerge(hostedOperationsLayer, providerDeps)
      const hostedContext = await Effect.runPromise(Layer.buildWithMemoMap(hostedLive, memo, scope))

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const hosted = yield* HostedOperations

          return yield* hosted.entries({ origin: factoryBaseUrl, guidanceRequired, credential })
        }).pipe(Effect.provide(hostedContext)),
      )

      providerEntries.push(...entries)
    }

    if (contextBaseUrl !== undefined) {
      const { ContextOperations, contextOperationsLayer } =
        await import("../../prem-context/index.ts")

      const contextLive = Layer.provideMerge(contextOperationsLayer, providerDeps)

      const providerContext = await Effect.runPromise(
        Layer.buildWithMemoMap(contextLive, memo, scope),
      )

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const contextOps = yield* ContextOperations

          return yield* contextOps.entries({
            origin: contextBaseUrl,
            headers: options.contextHeaders,
            token: credential,
          })
        }).pipe(Effect.provide(providerContext)),
      )

      providerEntries.push(...entries)
    }

    const built = Effect.runSync(
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const capabilities = yield* Capabilities
        const callers = yield* Callers
        const guidance = yield* Guidance
        const presentation = yield* Presentation

        const allEntries = [
          bindServerInfo(capabilities, maxAutonomy, () => view),
          bindSkillRead(capabilities, guidance),
          ...sessions.entries(),
          ...providerEntries,
        ]

        const catalog = yield* capabilities.assemble(allEntries)
        const roster = buildRoster(catalog, allEntries)

        const view = createView({
          roster,
          profile: options.profile ?? "compact",
          serverName: options.serverName ?? "droid-mcp",
        })

        return { view, roster, callers, capabilities, sessions, guidance, presentation }
      }).pipe(Effect.provide(context)),
    )

    let closing: Promise<void> | undefined

    return {
      ...built,
      scope,
      close: () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void))),
    }
  } catch (failure) {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined)

    throw failure
  }
}
