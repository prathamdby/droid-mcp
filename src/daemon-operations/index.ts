/**
 * Level 3 `daemon-operations`: daemon reachability evidence, operation
 * semantics, replay restrictions and enforceable settings.
 *
 * The module binds only reviewed, served wire methods as capability entries.
 * Session-owned methods stay with the session runtime, unserved reads are
 * never advertised, and the connection handshake is transport evidence,
 * never a public operation. A method absent from the reviewed manifest has
 * no binding and cannot be dispatched; a reviewed binding alone never
 * publishes a capability.
 *
 * Authority invariants are enforced before any dispatch:
 *
 *   - explicit excess autonomy in a settings or initialize request is a
 *     known denial, decided by `authority` before the link ever sees a frame
 *   - initialize omissions are narrowed from exactly one read of the peer's
 *     settings snapshot onto the request's explicit effective fields; the
 *     persistent defaults are never written to serve a single request
 *   - below `high`, an omitted `skipPermissionsUnsafe` is pinned to `false`
 *     on the wire
 *   - saved-session loads and queued work carry unprovable effective
 *     authority: they fail closed with `authority_unverifiable` before any
 *     RPC unless the operator enabled the passthrough, which never bypasses
 *     a known denial and is never reported as verified
 *
 * Replay discipline is strict: pure reads may replay after handoff because
 * they are idempotent; every write, mutation or destructive operation is
 * sent exactly once and an uncertain outcome is never replayed.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { Authority } from "../authority/index.ts"
import { Callers } from "../caller/index.ts"
import { Capabilities } from "../capabilities/index.ts"
import type { BoundOperation } from "../capabilities/index.ts"
import { DaemonLink } from "../daemon-link/index.ts"
import type { LinkHealth, ProbeUnavailable } from "../daemon-link/index.ts"
import { Disclosure } from "../disclosure/index.ts"
import { Dialect } from "../factory-dialect/index.ts"
import type { Binding, DialectApi } from "../factory-dialect/index.ts"
import { Guidance } from "../guidance/index.ts"
import { bindEntries } from "./private/bind.ts"
import {
  DAEMON_UNSERVED_METHODS,
  SESSION_OWNED_METHODS,
  TRANSPORT_METHODS,
} from "./private/entries.ts"

// ---------------------------------------------------------------------------
// Tagged errors owned by this module
// ---------------------------------------------------------------------------

/**
 * A requested or manifest binding is not reviewed, or is reviewed but not
 * served by this surface. Raised when an installation's served-method
 * override names a method this module cannot bind; it never means the
 * method may be forwarded anyway.
 */
export class UnsupportedBinding extends Schema.TaggedError<UnsupportedBinding>()(
  "UnsupportedBinding",
  {
    message: Schema.String,
    method: Schema.String,
  },
) {}

/**
 * No runnable daemon facet is verified for this installation. Owned strictly
 * by this module: `local-exec` and `placement` never construct it.
 */
export class DaemonFacetUnsupported extends Schema.TaggedError<DaemonFacetUnsupported>()(
  "DaemonFacetUnsupported",
  {
    message: Schema.String,
    facet: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  },
) {}

// ---------------------------------------------------------------------------
// Installation and facet types
// ---------------------------------------------------------------------------

/**
 * A verified daemon peer plus the operator and credential scope the
 * installation permits. `peerId` is opaque installation identity; it never
 * doubles as proof of access. `allowUnverifiedDaemonAuthority` is the
 * explicit operator opt-in mirroring `--allow-unverified-daemon-authority`.
 * `servedMethods`, when present, restricts binding to that subset of the
 * reviewed served methods — a test or embedding can install a narrow peer.
 */
export interface DaemonInstallation {
  readonly peerId: string
  readonly allowUnverifiedDaemonAuthority?: boolean
  readonly guidanceRequired?: boolean
  readonly servedMethods?: ReadonlySet<string>
}

/**
 * Runnable behavior exposed only where it is tested and verified against a
 * live peer — never one facet per native operation. `probe` is the one
 * facet this module can verify: it exercises reachability and
 * authentication without starting anything.
 */
export interface DaemonFacet {
  readonly kind: "probe"
  readonly run: () => Effect.Effect<LinkHealth, ProbeUnavailable>
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface DaemonOperationsService {
  readonly entries: (
    peer: DaemonInstallation,
  ) => Effect.Effect<ReadonlyArray<BoundOperation>, UnsupportedBinding>
  readonly facets: (
    peer: DaemonInstallation,
  ) => Effect.Effect<ReadonlyArray<DaemonFacet>, DaemonFacetUnsupported>
  readonly probeExisting: () => Effect.Effect<LinkHealth, ProbeUnavailable>
}

export class DaemonOperations extends Context.Service<DaemonOperations, DaemonOperationsService>()(
  "droid-mcp/daemon-operations",
) {}

// ---------------------------------------------------------------------------
// Binding selection
// ---------------------------------------------------------------------------

/**
 * Resolves the reviewed, served bindings this installation may publish.
 * Session-owned methods, unserved exec reads and the transport handshake are
 * excluded before the peer's own restriction is applied. A peer override
 * naming anything outside the reviewed served set fails with
 * `UnsupportedBinding`: the installation asked for a binding this module
 * cannot honor, and nothing is forwarded on best effort.
 */
const resolveBindings = (
  dialect: DialectApi,
  peer: DaemonInstallation,
): Effect.Effect<ReadonlyArray<Binding<Schema.Json, Schema.Json>>, UnsupportedBinding> =>
  Effect.gen(function* () {
    const excluded = (method: string): boolean =>
      SESSION_OWNED_METHODS.has(method) ||
      DAEMON_UNSERVED_METHODS.has(method) ||
      TRANSPORT_METHODS.has(method)

    const candidates = dialect.reviewedMethods().filter((method) => !excluded(method))

    const served = new Set(candidates)

    if (peer.servedMethods !== undefined) {
      for (const method of peer.servedMethods) {
        if (!served.has(method)) {
          return yield* Effect.fail(
            new UnsupportedBinding({
              message:
                "the installation requests " +
                method +
                ", which has no reviewed served binding on this surface",
              method,
            }),
          )
        }
      }
    }

    const selected =
      peer.servedMethods === undefined
        ? candidates
        : candidates.filter((method) => peer.servedMethods?.has(method) === true)

    const bindings: Array<Binding<Schema.Json, Schema.Json>> = []

    for (const method of selected) {
      const bound = yield* dialect
        .reviewedBinding(method)
        .pipe(
          Effect.mapError(
            (unreviewed) =>
              new UnsupportedBinding({ message: unreviewed.message, method: unreviewed.method }),
          ),
        )

      bindings.push(bound)
    }

    return bindings
  })

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Builds the per-layer `DaemonOperations` service. Entries close over the
 * `DaemonLink` the layer was given, so every invocation passes through the
 * same custody, handoff and replay discipline; `authority`, `caller`,
 * `disclosure` and `guidance` act through the capabilities pipeline rather
 * than here directly, and the layer dependency keeps the boundary explicit.
 */
export const daemonOperationsLayer: Layer.Layer<
  DaemonOperations,
  never,
  Capabilities | DaemonLink | Dialect | Authority | Disclosure | Guidance | Callers
> = Layer.effect(
  DaemonOperations,
  Effect.gen(function* () {
    const capabilities = yield* Capabilities
    const link = yield* DaemonLink
    const dialect = yield* Dialect
    const authority = yield* Authority

    /*
     * Caller admission, disclosure release and guidance receipts are reached
     * through the capabilities gates, never invoked here directly; yielding
     * the services keeps the module edge explicit without adding a second
     * enforcement path.
     */
    yield* Callers
    yield* Disclosure
    yield* Guidance

    const entries: DaemonOperationsService["entries"] = (peer) =>
      Effect.gen(function* () {
        const bindings = yield* resolveBindings(dialect, peer)

        const installation = {
          peerId: peer.peerId,
          allowUnverifiedDaemonAuthority: peer.allowUnverifiedDaemonAuthority ?? false,
          guidanceRequired: peer.guidanceRequired ?? true,
          servedMethods: peer.servedMethods,
        }

        const defaultsServed =
          peer.servedMethods === undefined || peer.servedMethods.has("daemon.get_default_settings")

        const defaultsOption = defaultsServed
          ? yield* Effect.option(dialect.reviewedBinding("daemon.get_default_settings"))
          : Option.none<Binding<Schema.Json, Schema.Json>>()

        const defaults = Option.getOrUndefined(defaultsOption)

        return bindEntries(
          capabilities,
          link,
          installation,
          authority.ceiling(),
          bindings,
          defaults,
        )
      })

    const facets: DaemonOperationsService["facets"] = (peer) =>
      Effect.gen(function* () {
        // `probeExisting` exercises exactly one verified behavior — dialing
        // and authenticating the peer that exists — independent of which
        // operations the installation serves. It is the only facet this
        // module can vouch for; anything further would claim behavior no
        // test has verified. A peer that cannot serve even the probe —
        // because its installation is empty — gets no runnable facet.
        if (peer.servedMethods !== undefined && peer.servedMethods.size === 0) {
          return yield* Effect.fail(
            new DaemonFacetUnsupported({
              message:
                "the installation serves no methods, so no daemon facet is verified runnable",
              reason: "no_verified_facet",
            }),
          )
        }

        const probe: DaemonFacet = { kind: "probe", run: () => link.probeExisting() }

        return [probe]
      })

    const probeExisting: DaemonOperationsService["probeExisting"] = () => link.probeExisting()

    return { entries, facets, probeExisting }
  }),
)
