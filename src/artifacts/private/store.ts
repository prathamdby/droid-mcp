import * as Context from "effect/Context"

/**
 * Retention store for encoded artifact bytes.
 *
 * Insertion order is eviction order: entries live in a `Map`, whose iteration
 * is insertion-ordered, so the oldest surviving entry is evicted first.
 * A value that cannot fit under both byte bounds is refused before eviction.
 */

export interface StoredEntry<A> {
  readonly ref: string
  readonly value: A
  readonly bytes: number
  expiresAt: number
}

export interface ArtifactStoreApi<A> {
  readonly retentionByteLimit: number
  readonly lookup: (ref: string) => StoredEntry<A> | undefined
  readonly insert: (ref: string, value: A, bytes: number, ttlMs: number) => boolean
  readonly sweep: () => void
  readonly touch: (entry: StoredEntry<A>, ttlMs: number) => void
}

/** Internal service tag; constructed only inside the owning module's layer. */
export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreApi<never>>()(
  "droid-mcp-v2/artifacts/ArtifactStore",
) {}

export interface ArtifactStoreConfig {
  readonly aggregateByteLimit: number
  readonly singleValueByteLimit: number
  readonly now: () => number
}

export const openArtifactStore = <A>(config: ArtifactStoreConfig): ArtifactStoreApi<A> => {
  const retentionByteLimit = Math.min(config.singleValueByteLimit, config.aggregateByteLimit)
  const entries = new Map<string, StoredEntry<A>>()
  let held = 0

  const drop = (entry: StoredEntry<A>): void => {
    entries.delete(entry.ref)
    held -= entry.bytes
  }

  const sweep = (): void => {
    const at = config.now()

    for (const entry of entries.values()) {
      if (entry.expiresAt <= at) drop(entry)
    }
  }

  return {
    retentionByteLimit,
    lookup: (ref) => entries.get(ref),

    insert: (ref, value, bytes, ttlMs) => {
      if (bytes > retentionByteLimit) return false

      sweep()

      for (const entry of entries.values()) {
        if (held + bytes <= config.aggregateByteLimit) break

        drop(entry)
      }

      const entry: StoredEntry<A> = { ref, value, bytes, expiresAt: config.now() + ttlMs }

      entries.set(ref, entry)
      held += bytes

      return true
    },

    sweep,

    touch: (entry, ttlMs) => {
      entry.expiresAt = config.now() + ttlMs
    },
  }
}
