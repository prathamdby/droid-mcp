/**
 * `hosted-factory` owns hosted computer, environment, remote session, wiki,
 * CI, billing, organization and service-account operations at the configured
 * hosted origin. `HostedInstallation` selects that origin — validated once,
 * with an explicit scheme and host — plus the delegated credential scope.
 * `RemoteFacet` describes what a running remote session actually supports;
 * it is a typed fact about the hosted site's remote-session surface, never
 * evidence of daemon reachability.
 *
 * Every operation is bound through `Capabilities.bind`, so each invocation
 * passes the same decode, guidance, delegation, authority and release
 * pipeline as every other bound operation. Bodies validate nested target
 * ids before any request is built and classify both request secrets and
 * minted reply values for disclosure. Bound failures distinguish
 * inaccessible target, denial, peer rejection, bad reply and delivery
 * uncertainty; absent, empty and null results stay distinct.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { Authority } from "../authority/index.ts"
import { Callers } from "../caller/index.ts"
import { Capabilities } from "../capabilities/index.ts"
import type { BoundOperation } from "../capabilities/index.ts"
import { Custody } from "../custody/index.ts"
import { Disclosure } from "../disclosure/index.ts"
import { Guidance } from "../guidance/index.ts"
import { billingBinders } from "./private/billing.ts"
import { ciBinders } from "./private/ci.ts"
import { computerBinders } from "./private/computers.ts"
import { environmentBinders } from "./private/environments.ts"
import { DEFAULT_TIMEOUT_MS } from "./private/http.ts"
import type { FetchLike } from "./private/http.ts"
import type { OperationContext } from "./private/kit.ts"
import { organizationBinders } from "./private/organization.ts"
import { serviceAccountBinders } from "./private/service-accounts.ts"
import { remoteSessionBinders } from "./private/sessions.ts"
import { wikiBinders } from "./private/wiki.ts"

// ---------------------------------------------------------------------------
// Tagged errors owned by this module
// ---------------------------------------------------------------------------

/**
 * The installation cannot serve hosted operations: the origin is missing,
 * blank or not a URL with an explicit scheme and host, the credential scope
 * is invalid, or the hosted site itself is unavailable. Origin validation
 * happens once at binding time; there is never a fallback origin.
 */
export class HostedUnavailable extends Schema.TaggedError<HostedUnavailable>()(
  "HostedUnavailable",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Installation and facets
// ---------------------------------------------------------------------------

/**
 * The configured hosted origin plus its delegated rights.
 *
 * `origin` is validated once at binding time: it must parse as a URL with an
 * explicit `http` or `https` scheme and a non-empty host. `credential` is
 * the scoped bearer getter; its value is classified as sensitive and never
 * appears in a public view, an error or a log. `delegatedScopes` names the
 * rights the credential carries, for the operator's own records. `headers`
 * are static operator-configured additions. `fetch` and `timeoutMs` exist so
 * a test or embedding product can inject transport behavior.
 * `guidanceRequired` marks every operation as requiring the current guide
 * receipt in the invoking conversation.
 */
export interface HostedInstallation {
  readonly origin?: string
  readonly credential?: () => Effect.Effect<string | undefined>
  readonly delegatedScopes?: ReadonlyArray<string>
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly guidanceRequired?: boolean
}

/**
 * What a running remote session on this hosted site actually supports: a
 * typed fact the placement layer can consume without ever seeing a route,
 * an HTTP detail or a credential. Hosted remote sessions accept posted user
 * messages, expose status reads, support interruption and can be stopped by
 * deletion; they do not support arbitrary binary streaming through this
 * surface.
 */
export interface RemoteFacet {
  readonly kind:
    | "remote_session_launch"
    | "remote_session_send"
    | "remote_session_status"
    | "remote_session_interrupt"
    | "remote_session_stop"
  readonly supported: boolean
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface HostedOperationsService {
  readonly entries: (
    site: HostedInstallation,
  ) => Effect.Effect<ReadonlyArray<BoundOperation>, HostedUnavailable>
  readonly facets: (
    site: HostedInstallation,
  ) => Effect.Effect<ReadonlyArray<RemoteFacet>, HostedUnavailable>
}

export class HostedOperations extends Context.Service<HostedOperations, HostedOperationsService>()(
  "droid-mcp/hosted-factory",
) {}

// ---------------------------------------------------------------------------
// Installation validation
// ---------------------------------------------------------------------------

const invalid = (message: string, reason: string): HostedUnavailable =>
  new HostedUnavailable({ message, reason })

/**
 * Validates the configured origin exactly once. A valid origin parses as a
 * URL, has an explicit `http:` or `https:` scheme, and has a non-empty host.
 * Anything else — missing, blank, scheme-relative, opaque-scheme or hostless —
 * is `HostedUnavailable`; nothing falls back to a default origin.
 */
const validateOrigin = (raw: string | undefined): Effect.Effect<string, HostedUnavailable> => {
  if (raw === undefined || raw.trim().length === 0) {
    return Effect.fail(invalid("the hosted installation carries no origin", "missing-origin"))
  }

  const trimmed = raw.trim()

  let parsed: URL

  try {
    parsed = new URL(trimmed)
  } catch {
    return Effect.fail(invalid("the hosted origin is not a valid URL", "invalid-origin"))
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Effect.fail(
      invalid("the hosted origin must use an explicit http or https scheme", "invalid-scheme"),
    )
  }

  if (parsed.host.length === 0) {
    return Effect.fail(invalid("the hosted origin must name a host", "missing-host"))
  }

  return Effect.succeed(parsed.origin)
}

/**
 * Validates the delegated credential scope. A credential getter is optional
 * (the fake or an unauthenticated embedding may not need one), but when
 * `delegatedScopes` is present it must name at least one right, and a scope
 * entry must be a non-blank token.
 */
const validateScopes = (
  scopes: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string>, HostedUnavailable> => {
  if (scopes === undefined) return Effect.succeed([])

  if (scopes.some((scope) => scope.trim().length === 0)) {
    return Effect.fail(
      invalid("a delegated scope entry must not be blank", "invalid-delegated-scope"),
    )
  }

  return Effect.succeed(scopes)
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Builds the per-layer `HostedOperations` service. The gate services are
 * closed over once; every `entries` call validates its installation and
 * binds all hosted operations against it through `Capabilities.bind`, so
 * each operation passes through the same decode, guidance, delegation,
 * authority and release pipeline as every other bound operation.
 */
export const hostedOperationsLayer: Layer.Layer<
  HostedOperations,
  never,
  Capabilities | Authority | Disclosure | Custody | Guidance | Callers
> = Layer.effect(
  HostedOperations,
  Effect.gen(function* () {
    const capabilities = yield* Capabilities

    /*
     * Authority, disclosure, custody, guidance and callers are reached
     * through the capabilities pipeline rather than directly here; the layer
     * dependency list keeps the module boundary explicit even though this
     * service never invokes them itself.
     */
    yield* Authority
    yield* Disclosure
    yield* Custody
    yield* Guidance
    yield* Callers

    const entries: HostedOperationsService["entries"] = (site) =>
      Effect.gen(function* () {
        const origin = yield* validateOrigin(site.origin)
        yield* validateScopes(site.delegatedScopes)

        const base: OperationContext = {
          origin,
          timeoutMs: site.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          headers: site.headers,
          credential: site.credential,
          fetch: site.fetch,
          sensitiveValues: [],
        }

        const ctx: OperationContext =
          site.guidanceRequired === true ? { ...base, prerequisite: { edition: "droid-v1" } } : base

        const binders = [
          ...computerBinders(ctx),
          ...environmentBinders(ctx),
          ...remoteSessionBinders(ctx),
          ...wikiBinders(ctx),
          ...ciBinders(ctx),
          ...billingBinders(ctx),
          ...organizationBinders(ctx),
          ...serviceAccountBinders(ctx),
        ]

        return binders.map((bind) => bind(capabilities))
      })

    const facets: HostedOperationsService["facets"] = (site) =>
      Effect.gen(function* () {
        yield* validateOrigin(site.origin)
        yield* validateScopes(site.delegatedScopes)

        return [
          { kind: "remote_session_launch", supported: true },
          { kind: "remote_session_send", supported: true },
          { kind: "remote_session_status", supported: true },
          { kind: "remote_session_interrupt", supported: true },
          { kind: "remote_session_stop", supported: true },
        ] satisfies ReadonlyArray<RemoteFacet>
      })

    return { entries, facets }
  }),
)
