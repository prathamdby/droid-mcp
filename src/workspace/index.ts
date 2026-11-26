/**
 * Level 1 `workspace` module: permitted roots, borrowed checkouts, isolated
 * checkout creation and cleanup.
 *
 * A `WorkspaceIntent` requests a borrowed checkout (an existing directory the
 * caller already controls), an ephemeral isolated checkout (created for the
 * lease and removed when it closes) or a persistent isolated checkout (created
 * for the lease and left in place after it closes). A `WorkspaceLease` keeps
 * acquisition identity separate from the current working location: `describe`
 * reports both `acquiredPath` (fixed at acquisition) and `location` (mutable
 * through `changeLocation`), and changing location never transfers cleanup
 * rights — closing an ephemeral lease removes only the originally acquired
 * checkout, never a directory it was later pointed at.
 *
 * Permitted roots are enforced on canonicalized paths at both acquisition and
 * `changeLocation`: a path outside every root, or a symlink inside a root
 * that resolves outside it, fails with `RootDenied` before any checkout is
 * created or any location is changed. A borrowed checkout is never deleted
 * or mutated. Ephemeral cleanup is registered before the lease escapes, so a
 * scope closed immediately after `acquire` still removes exactly the created
 * checkout; `adopt` transfers that ownership into a `Lifetime`, and `drain`
 * of the lifetime runs the same single cleanup execution.
 */

import { statSync } from "node:fs"
import { join } from "node:path"

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"

import type { Caller } from "../caller/index.ts"
import { Custody, type Lease, type Lifetime } from "../custody/index.ts"
import {
  createIsolatedCheckout,
  type IsolatedResult,
  removeIsolatedCheckout,
} from "./private/git.ts"
import {
  canonicalizeAncestor,
  canonicalizePath,
  canonicalizeRoots,
  insideRoots,
} from "./private/roots.ts"

declare const workspaceLeaseBrand: unique symbol

/**
 * An opaque workspace handle, issued only by this module. Acquisition
 * identity and current working location are both reachable through
 * `describe`; the handle itself never exposes checkout internals.
 */
export interface WorkspaceLease {
  readonly [workspaceLeaseBrand]: true
  readonly id: string
}

export type WorkspaceIntent =
  | { readonly kind: "borrowed"; readonly path: string }
  | {
      readonly kind: "ephemeral"
      readonly repoPath: string
      readonly worktreeDir?: string | undefined
      readonly branchMode?: "copy" | "existing" | undefined
      readonly baseBranch?: string | undefined
      readonly baseBranchFromOrigin?: boolean | undefined
      readonly newBranch?: string | undefined
    }
  | {
      readonly kind: "persistent"
      readonly repoPath: string
      readonly worktreeDir?: string | undefined
      readonly branchMode?: "copy" | "existing" | undefined
      readonly baseBranch?: string | undefined
      readonly baseBranchFromOrigin?: boolean | undefined
      readonly newBranch?: string | undefined
    }

export interface WorkspaceView {
  /** The canonicalized path fixed at acquisition time. Never changes. */
  readonly acquiredPath: string
  /** The current working location; starts as `acquiredPath`. */
  readonly location: string
  /** How the checkout is owned: borrowed, or owned as ephemeral/persistent. */
  readonly ownership: "borrowed" | "ephemeral" | "persistent"
  /** Principal identity of the acquiring caller. */
  readonly callerId: string
  /** Branch the checkout was created on; absent for borrowed checkouts. */
  readonly branch?: string | undefined
  /** True for isolated checkouts created by acquisition. */
  readonly isolated: boolean
}

export class RootDenied extends Schema.TaggedError<RootDenied>()("RootDenied", {
  message: Schema.String,
  path: Schema.String,
}) {}

export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()("CheckoutFailed", {
  message: Schema.String,
  path: Schema.String,
  reason: Schema.String,
}) {}

export class InvalidLocation extends Schema.TaggedError<InvalidLocation>()("InvalidLocation", {
  message: Schema.String,
  path: Schema.String,
  reason: Schema.String,
}) {}

export class WorkspaceClosed extends Schema.TaggedError<WorkspaceClosed>()("WorkspaceClosed", {
  message: Schema.String,
  workspaceId: Schema.String,
}) {}

/** The mutable per-lease state; disposal rights stay inside the custody lease. */
interface WorkspaceState {
  readonly callerId: string
  readonly ownership: "borrowed" | "ephemeral" | "persistent"
  readonly isolated: boolean
  readonly acquiredPath: string
  readonly branch: string | undefined
  location: string
}

export interface WorkspacesApi {
  readonly acquire: (
    caller: Caller,
    intent: WorkspaceIntent,
  ) => Effect.Effect<WorkspaceLease, RootDenied | CheckoutFailed, Scope.Scope>
  readonly changeLocation: (
    lease: WorkspaceLease,
    location: string,
  ) => Effect.Effect<WorkspaceView, RootDenied | InvalidLocation | WorkspaceClosed>
  readonly describe: (lease: WorkspaceLease) => Effect.Effect<WorkspaceView, WorkspaceClosed>
  /** Transfers the workspace into a lifetime; the acquiring scope no longer closes it. */
  readonly adopt: (
    lease: WorkspaceLease,
    lifetime: Lifetime,
  ) => Effect.Effect<void, WorkspaceClosed>
  /** Ends the lease, joining the same single cleanup execution as scope close or drain. */
  readonly release: (lease: WorkspaceLease) => Effect.Effect<void>
}

export class Workspaces extends Context.Service<Workspaces, WorkspacesApi>()(
  "droid-mcp/workspace",
) {}

export interface WorkspacesOptions {
  /**
   * Canonicalized permitted roots. An empty list denies every acquisition
   * and every location change; there is no implicit root.
   */
  readonly allowedRoots: ReadonlyArray<string>
}

let nextWorkspaceSequence = 0

const nextWorkspaceId = (): string => "workspace:" + String(++nextWorkspaceSequence)

const rootDenied = (path: string): RootDenied =>
  new RootDenied({ message: "path is outside the permitted roots", path })

const workspaceClosed = (workspaceId: string): WorkspaceClosed =>
  new WorkspaceClosed({ message: "workspace is closed", workspaceId })

const viewOf = (state: WorkspaceState): WorkspaceView => ({
  acquiredPath: state.acquiredPath,
  location: state.location,
  ownership: state.ownership,
  callerId: state.callerId,
  branch: state.branch,
  isolated: state.isolated,
})

/**
 * Builds the per-layer `Workspaces` service. Canonicalized roots and the
 * workspace registry are local to each layer instance.
 */
export const workspacesLayer = (
  options: WorkspacesOptions,
): Layer.Layer<Workspaces, never, Custody> => {
  const roots = canonicalizeRoots(options.allowedRoots)

  return Layer.effect(
    Workspaces,
    Effect.gen(function* () {
      const custody = yield* Custody

      interface Entry {
        readonly state: WorkspaceState
        inner: Lease<WorkspaceState> | undefined
      }

      const entries = new WeakMap<WorkspaceLease, Entry>()

      /**
       * The live entry for a handle, or none once its lease has closed.
       * Liveness is read from custody on every lookup, so scope close,
       * release, adoption drain and idle expiry are all reflected without
       * any bookkeeping in this module.
       */
      const liveEntry = (lease: WorkspaceLease): Effect.Effect<Entry, WorkspaceClosed> =>
        Effect.suspend(() => {
          const entry = entries.get(lease)
          const inner = entry?.inner

          if (entry === undefined || inner === undefined) {
            return Effect.fail(workspaceClosed(lease.id))
          }

          return Effect.flatMap(custody.isActive(inner), (active) =>
            active ? Effect.succeed(entry) : Effect.fail(workspaceClosed(lease.id)),
          )
        })

      /**
       * Canonicalizes `path` and checks it against the permitted roots.
       * An unresolvable path is denied as an outside path: admission never
       * creates or trusts anything it cannot canonicalize.
       */
      const admitPath = (path: string): Effect.Effect<string, RootDenied> =>
        Effect.suspend(() => {
          const canonical = canonicalizePath(path)

          if (Option.isNone(canonical) || !insideRoots(canonical.value, roots)) {
            return Effect.fail(rootDenied(path))
          }

          return Effect.succeed(canonical.value)
        })

      /**
       * Validates an isolated intent: the repository must already exist
       * inside the permitted roots, and the checkout parent — which may not
       * exist yet — must resolve through its nearest existing ancestor into
       * the roots as well. Both are decided before any checkout is created.
       */
      const admitIsolated = (
        intent: Extract<WorkspaceIntent, { readonly kind: "ephemeral" | "persistent" }>,
      ): Effect.Effect<{ readonly repoPath: string; readonly parent: string }, RootDenied> =>
        Effect.gen(function* () {
          const repoPath = yield* admitPath(intent.repoPath)

          const parentInput = intent.worktreeDir ?? join(repoPath, ".workspace-checkouts")
          const parentCanonical = canonicalizeAncestor(parentInput)

          if (Option.isNone(parentCanonical) || !insideRoots(parentCanonical.value, roots)) {
            return yield* Effect.fail(rootDenied(parentInput))
          }

          return { repoPath, parent: parentCanonical.value }
        })

      const acquire: WorkspacesApi["acquire"] = (caller, intent) =>
        Effect.gen(function* () {
          const callerId = String(caller.id)

          if (intent.kind === "borrowed") {
            const canonical = yield* admitPath(intent.path)

            const state: WorkspaceState = {
              callerId,
              ownership: "borrowed",
              isolated: false,
              acquiredPath: canonical,
              branch: undefined,
              location: canonical,
            }

            const lease = yield* Effect.mapError(
              custody.borrow({
                name: nextWorkspaceId(),
                connect: Effect.succeed(state),
                /*
                 * A borrowed checkout is never deleted or mutated: ending the
                 * borrowing only ends local use.
                 */
                disconnect: () => Effect.void,
              }),
              () =>
                new CheckoutFailed({
                  message: "borrowing the checkout failed",
                  path: canonical,
                  reason: "custody_unavailable",
                }),
            )

            const workspace = mintWorkspace(lease.id)
            entries.set(workspace, { state, inner: lease })

            return workspace
          }

          const admitted = yield* admitIsolated(intent)
          const ephemeral = intent.kind === "ephemeral"

          const outcome = yield* Effect.mapError(
            createIsolatedCheckout({
              repoPath: admitted.repoPath,
              worktreeParent: admitted.parent,
              branchMode: intent.branchMode ?? "copy",
              baseBranch: intent.baseBranch,
              baseBranchFromOrigin: intent.baseBranchFromOrigin,
              newBranch: intent.newBranch,
            }),
            (error) =>
              new CheckoutFailed({
                message: error.message,
                path: intent.repoPath,
                reason: error.reason,
              }),
          )

          const state: WorkspaceState = {
            callerId,
            ownership: ephemeral ? "ephemeral" : "persistent",
            isolated: true,
            acquiredPath: outcome.path,
            branch: outcome.branch,
            location: outcome.path,
          }

          const lease = yield* Effect.mapError(
            custody.acquire({
              name: nextWorkspaceId(),
              acquire: Effect.succeed(state),
              /*
               * Cleanup removal is registered before the lease escapes and is
               * confined to exactly the created checkout path. Persistent
               * checkouts are left in place; ephemeral ones are removed once,
               * joined by every closing path. The repository directory is
               * never a removal target.
               */
              dispose: () =>
                ephemeral
                  ? removeIsolatedCheckout({ repoPath: admitted.repoPath, path: outcome.path })
                  : Effect.void,
            }),
            () =>
              new CheckoutFailed({
                message: "registering checkout cleanup failed",
                path: outcome.path,
                reason: "custody_unavailable",
              }),
          )

          const workspace = mintWorkspace(lease.id)
          entries.set(workspace, { state, inner: lease })

          return workspace
        })

      const changeLocation: WorkspacesApi["changeLocation"] = (lease, location) =>
        Effect.flatMap(
          liveEntry(lease),
          (entry): Effect.Effect<WorkspaceView, RootDenied | InvalidLocation> =>
            Effect.suspend((): Effect.Effect<WorkspaceView, RootDenied | InvalidLocation> => {
              const canonical = canonicalizePath(location)

              if (Option.isNone(canonical)) {
                return Effect.fail(
                  new InvalidLocation({
                    message: "location does not exist",
                    path: location,
                    reason: "missing",
                  }),
                )
              }

              const target = canonical.value

              if (!insideRoots(target, roots)) {
                return Effect.fail(rootDenied(location))
              }

              try {
                if (!statSync(target).isDirectory()) {
                  return Effect.fail(
                    new InvalidLocation({
                      message: "location is not a directory",
                      path: location,
                      reason: "not_a_directory",
                    }),
                  )
                }
              } catch {
                return Effect.fail(
                  new InvalidLocation({
                    message: "location does not exist",
                    path: location,
                    reason: "missing",
                  }),
                )
              }

              /*
               * Only the working location moves. `acquiredPath` and ownership
               * are fixed, and cleanup rights never transfer: closing the
               * lease still acts only on the originally acquired checkout.
               */
              entry.state.location = target

              return Effect.succeed(viewOf(entry.state))
            }),
        )

      const describe: WorkspacesApi["describe"] = (lease) =>
        Effect.map(liveEntry(lease), (entry) => viewOf(entry.state))

      const adopt: WorkspacesApi["adopt"] = (lease, lifetime) =>
        Effect.flatMap(liveEntry(lease), (entry) =>
          Effect.suspend(() => {
            const inner = entry.inner

            if (inner === undefined) {
              return Effect.fail(workspaceClosed(lease.id))
            }

            /*
             * Ownership moves into the lifetime: closing the acquiring scope
             * no longer closes the lease, and draining the lifetime runs the
             * same single cleanup execution. The handle stays live for
             * `describe` and `changeLocation` until the lease itself closes.
             */
            return Effect.mapError(custody.adopt(inner, lifetime), () => workspaceClosed(lease.id))
          }),
        )

      const release: WorkspacesApi["release"] = (lease) =>
        Effect.suspend(() => {
          const entry = entries.get(lease)

          if (entry === undefined) return Effect.void

          const inner = entry.inner

          if (inner === undefined) return Effect.void

          return Effect.andThen(
            Effect.ignore(custody.release(inner)),
            Effect.sync(() => {
              entries.delete(lease)
            }),
          )
        })

      function mintWorkspace(id: string): WorkspaceLease {
        // SAFETY: workspace handles are constructed only inside this module,
        // so the private brand cannot be reproduced by outside code.
        return { id } as WorkspaceLease
      }

      return { acquire, changeLocation, describe, adopt, release }
    }),
  )
}

/*
 * Scoped-close wiring: the registry entries above are dropped only through
 * `release`/`adopt`. A scope close without either leaves the custody lease's
 * own scope finalizer to run cleanup; the workspace entry remains weakly
 * held and unreachable once the handle is unreferenced.
 */
export type { IsolatedResult }
