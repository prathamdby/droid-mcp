/**
 * `prem-context` owns spaces, documents, stored session records and file
 * parts at the configured Context origin. `ContextInstallation` carries that
 * origin — validated once, with an explicit scheme and host, never a hosted
 * fallback and never a caller-supplied URL — plus its scoped credential
 * capability. Each operation is bound through the same capabilities
 * invocation checks; there is no runnable provider contribution.
 *
 * Conditional writes keep their expected versions and sequences end to end,
 * decimal counters travel as exact decimal strings past 2^53, file bytes are
 * bounded canonically, and a conflict is never erased by retrying.
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
import { DEFAULT_TIMEOUT_MS } from "./private/http.ts"
import type { FetchLike } from "./private/http.ts"
import { contextDefinitions } from "./private/operations.ts"

// ---------------------------------------------------------------------------
// Tagged errors owned by this module
// ---------------------------------------------------------------------------

/**
 * The installation carries no usable origin: the value is missing, blank or
 * not a URL with an explicit scheme and host. There is never a hosted
 * fallback origin.
 */
export class ContextOriginMissing extends Schema.TaggedError<ContextOriginMissing>()(
  "ContextOriginMissing",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * The Context peer answered in a shape this module cannot interpret:
 * malformed JSON, an unexpected non-JSON body, missing required response
 * fields or an invalid decimal integer. Distinct from a conflict, from
 * protected bytes and from uncertain delivery.
 */
export class ContextBadReply extends Schema.TaggedError<ContextBadReply>()("ContextBadReply", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

/** Safe conflict fields a conditional write surfaces; decimal strings stay exact. */
export interface ContextConflictFields {
  readonly currentVersion?: string
  readonly currentSequence?: string
}

/**
 * A conditional write conflicted with the current state of the target. The
 * safe conflict fields are retained so the caller can reread and continue;
 * the conflict is never erased by retrying.
 */
export class ContextConflict extends Schema.TaggedError<ContextConflict>()("ContextConflict", {
  message: Schema.String,
  currentVersion: Schema.optional(Schema.String),
  currentSequence: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * The configured Context origin plus its scoped credential capability.
 *
 * `origin` is validated once at binding time: it must parse as a URL with an
 * explicit scheme and host. Nothing here ever falls back to a hosted origin,
 * and no operation accepts a caller-supplied URL.
 *
 * `token` is the scoped bearer getter; it is the only credential path, and
 * its value is scrubbed from anything that crosses a boundary. `headers` are
 * static operator-configured additions (such as a tenant marker); their
 * values are scrubbed the same way. `fetch` and `timeoutMs` exist so a test
 * or embedding product can inject transport behavior; `maxFileBytes` bounds
 * file downloads and uploads.
 */
export interface ContextInstallation {
  readonly origin?: string
  readonly token?: () => Effect.Effect<string | undefined>
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly maxFileBytes?: number
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ContextOperationsService {
  readonly entries: (
    site: ContextInstallation,
  ) => Effect.Effect<ReadonlyArray<BoundOperation>, ContextOriginMissing | ContextBadReply>
}

export class ContextOperations extends Context.Service<
  ContextOperations,
  ContextOperationsService
>()("droid-mcp/prem-context") {}

// ---------------------------------------------------------------------------
// Origin validation
// ---------------------------------------------------------------------------

/**
 * Validates the configured origin exactly once. A valid origin parses as a
 * URL, has an explicit `http:` or `https:` scheme, and has a non-empty host.
 * Anything else — missing, blank, scheme-relative, opaque-scheme or hostless —
 * is `ContextOriginMissing`; nothing falls back to a hosted origin.
 */
const validateOrigin = (raw: string | undefined): Effect.Effect<string, ContextOriginMissing> => {
  if (raw === undefined || raw.trim().length === 0) {
    return Effect.fail(
      new ContextOriginMissing({
        message: "the Context installation carries no origin",
        reason: "missing",
      }),
    )
  }

  const trimmed = raw.trim()

  let parsed: URL

  try {
    parsed = new URL(trimmed)
  } catch {
    return Effect.fail(
      new ContextOriginMissing({
        message: "the Context origin is not a valid URL",
        reason: "invalid-url",
      }),
    )
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Effect.fail(
      new ContextOriginMissing({
        message: "the Context origin must use an explicit http or https scheme",
        reason: "invalid-scheme",
      }),
    )
  }

  if (parsed.host.length === 0) {
    return Effect.fail(
      new ContextOriginMissing({
        message: "the Context origin must name a host",
        reason: "missing-host",
      }),
    )
  }

  return Effect.succeed(parsed.origin)
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Builds the per-layer `ContextOperations` service. The gate services are
 * closed over once; every `entries` call validates its installation and binds
 * the eighteen operations against it through `Capabilities.bind`, so each
 * operation passes through the same decode, guidance, delegation, authority
 * and release pipeline as every other bound operation.
 */
export const contextOperationsLayer: Layer.Layer<
  ContextOperations,
  never,
  Capabilities | Authority | Disclosure | Custody | Guidance | Callers
> = Layer.effect(
  ContextOperations,
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

    const entries: ContextOperationsService["entries"] = (site) =>
      Effect.gen(function* () {
        const origin = yield* validateOrigin(site.origin)

        const binders = contextDefinitions({
          origin,
          timeoutMs: site.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          headers: site.headers,
          token: site.token,
          fetch: site.fetch,
        })

        return binders.map((bind) => bind(capabilities))
      })

    return { entries }
  }),
)
