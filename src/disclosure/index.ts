import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import {
  atomicValueContainsSecret,
  compileScrubber,
  EMPTY_REDACTION_POLICY,
  maximumMatchableTextLength,
  mediaContainsProtectedBytes,
  mintedValuesInRecords,
  mintedValuesInValue,
  openScrubStream,
  redactJsonValue,
  scrubTextWith,
  unredactableScalarContainsSecret,
  visibleObjectMembers,
  type RedactionPolicy,
} from "./private/scrub.ts"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Sink = "client" | "event" | "error" | "log"

export type PolicyRevision = number

export type Audience<S extends Sink> = {
  readonly sink: S
  readonly recipientId: string
  /**
   * The revision observed when the audience was opened; a release stamps
   * the revision it actually enforces.
   */
  readonly policyRevision: PolicyRevision
}

export type MediaPayload = {
  readonly contentType: string
  readonly bytes: Uint8Array
  readonly protected?: boolean
  readonly filename?: string
}

export type ReleasePayload = Data.TaggedEnum<{
  readonly Empty: {}
  readonly JsonValue: { readonly value: Schema.Json }
  readonly Records: { readonly items: ReadonlyArray<Schema.Json> }
  readonly Media: { readonly media: MediaPayload }
}>

export const ReleasePayload = Data.taggedEnum<ReleasePayload>()

/**
 * Field sensitivity for a JSON protocol payload. `fixedKeys` are exact member
 * names that belong to the protocol structure and therefore cross unchanged;
 * every other member name remains data and is scrubbed. `atomicKeys` are
 * fixed scalar continuation values — identifiers, cursors and counters a
 * caller must reuse exactly — that redaction must never rewrite. If a
 * protected value appears inside one, the release is refused instead of
 * emitting a corrupted continuation value or leaking the secret. `members`
 * carries the shape beneath a fixed object member and
 * `item` beneath array elements, so treatment is scoped to exact protocol
 * positions. `atomic` marks the value at the current position itself, which
 * matters when an already-released subtree is narrowed to one scalar.
 * Unknown extension members never inherit either treatment, even when they
 * reuse a fixed name below the protocol shape.
 */
export type JsonProtection = {
  readonly fixedKeys?: ReadonlyArray<string>
  readonly atomicKeys?: ReadonlyArray<string>
  readonly members?: { readonly [key: string]: JsonProtection }
  readonly item?: JsonProtection
  readonly atomic?: boolean
}

export type ReleaseInput = {
  readonly payload: ReleasePayload
  readonly sensitiveValues?: ReadonlyArray<string>
  readonly sensitiveKeys?: ReadonlyArray<string>
  readonly jsonProtection?: JsonProtection
}

/** The redaction marker substituted for protected values. */
export const REDACTED = "[REDACTED]"

/**
 * A stateful scrubber for text crossing the boundary in ordered fragments.
 * `push` returns the newly final scrubbed text, which may be empty while a
 * possible protected prefix is withheld and may cover text from earlier
 * pushes once that prefix resolves. `flush` ends the stream and releases
 * the scrubbed remainder. Concatenating every output in order yields
 * exactly the scrubbed stream: no complete protected value can be
 * reassembled from the fragments, even one split across pushes.
 */
export interface TextScrubStream {
  readonly push: (text: string) => string
  readonly flush: () => string
}

/**
 * Brand key for the opaque `Released` handle. The symbol itself is
 * module-private, so the field cannot be forged outside this module.
 */
const brand: unique symbol = Symbol("droid-mcp-v2/disclosure/Released")
const protectionBrand: unique symbol = Symbol("droid-mcp-v2/disclosure/JsonProtection")

export type Released<S extends Sink> = {
  readonly [brand]: S
  readonly [protectionBrand]: JsonProtection
  readonly sink: S
  readonly recipientId: string
  /** The policy revision whose protected values were enforced into `payload`. */
  readonly policyRevision: PolicyRevision
  readonly payload: ReleasePayload
}

export const releasedPayload = <S extends Sink>(value: Released<S>): ReleasePayload => value.payload

export const releasedJson = <S extends Sink>(value: Released<S>): Option.Option<Schema.Json> =>
  ReleasePayload.$match(value.payload, {
    Empty: () => Option.none<Schema.Json>(),
    JsonValue: (variant) => Option.some(variant.value),
    Records: () => Option.none<Schema.Json>(),
    Media: () => Option.none<Schema.Json>(),
  })

export const releasedRecords = <S extends Sink>(
  value: Released<S>,
): Option.Option<ReadonlyArray<Schema.Json>> =>
  ReleasePayload.$match(value.payload, {
    Empty: () => Option.none<ReadonlyArray<Schema.Json>>(),
    JsonValue: () => Option.none<ReadonlyArray<Schema.Json>>(),
    Records: (variant) => Option.some(variant.items),
    Media: () => Option.none<ReadonlyArray<Schema.Json>>(),
  })

export const releasedMedia = <S extends Sink>(value: Released<S>): Option.Option<MediaPayload> =>
  ReleasePayload.$match(value.payload, {
    Empty: () => Option.none<MediaPayload>(),
    JsonValue: () => Option.none<MediaPayload>(),
    Records: () => Option.none<MediaPayload>(),
    Media: (variant) => Option.some(variant.media),
  })

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class DisclosureRefused extends Schema.TaggedError<DisclosureRefused>()(
  "DisclosureRefused",
  {
    message: Schema.String,
    sink: Schema.String,
    reason: Schema.String,
  },
) {}

export class ProtectedBytes extends Schema.TaggedError<ProtectedBytes>()("ProtectedBytes", {
  message: Schema.String,
  contentType: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type DisclosureState = {
  readonly revision: number
  readonly protectedValues: ReadonlyArray<string>
  readonly protectedKeyNames: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

/** Deep-copies the caller-supplied policy so later mutation cannot rewrite a released value's contract. */
const protectionOf = (input: JsonProtection | undefined): RedactionPolicy => {
  if (input === undefined) return { fixedKeys: [], atomicKeys: [] }

  const members =
    input.members === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.members).map(([key, member]) => [key, protectionOf(member)]),
        )

  const copied: RedactionPolicy = {
    fixedKeys: [...(input.fixedKeys ?? [])],
    atomicKeys: [...(input.atomicKeys ?? [])],
  }

  const withAtomic = input.atomic === true ? { ...copied, atomic: true } : copied
  const withMembers = members === undefined ? withAtomic : { ...withAtomic, members }

  return input.item === undefined ? withMembers : { ...withMembers, item: protectionOf(input.item) }
}

type JsonObject = { readonly [key: string]: Schema.Json }

const isJsonObject = (value: Schema.Json): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/**
 * Narrows a policy along one already-validated descent step. Object members
 * carry shape only when the protocol fixes them exactly; array elements use
 * the item shape, and an atomic member marks the child value itself. Unknown
 * members and every position beneath them stay ordinary data.
 */
const childProtection = (policy: RedactionPolicy, step: string | number): RedactionPolicy => {
  if (Predicate.isNumber(step)) return policy.item ?? EMPTY_REDACTION_POLICY

  if (policy.fixedKeys?.includes(step) !== true) return EMPTY_REDACTION_POLICY

  const child = policy.members?.[step] ?? EMPTY_REDACTION_POLICY

  return policy.atomicKeys?.includes(step) === true ? { ...child, atomic: true } : child
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/

/**
 * Narrows an already-released JSON value to one of its subtrees, carrying
 * exactly the protection shape of that subtree. Object member steps resolve
 * against the names visible under the current policy after a tightening:
 * otherwise a retained selection would confirm the spelling of a key the
 * current policy hides, while the redacted key a caller can actually see
 * would not resolve. At the release's own policy revision the stored object
 * keys are already the visible view, so they are used exactly rather than
 * scrubbed a second time. Values themselves are not revalidated here;
 * selecting is not a new disclosure decision and cannot widen the original
 * release.
 */
const narrowJsonReleased = <S extends Sink>(
  released: Released<S>,
  path: ReadonlyArray<string | number>,
  protectedValues: ReadonlyArray<string>,
  protectedKeyNames: ReadonlyArray<string>,
  currentRevision: number,
): Option.Option<Released<S>> => {
  if (!ReleasePayload.$is("JsonValue")(released.payload)) return Option.none()

  if (path.length === 0) return Option.some(released)

  let current: Schema.Json = released.payload.value
  let policy = released[protectionBrand]
  const secrets = [...protectedValues, ...mintedValuesInValue(current)]

  const scrubber = compileScrubber(
    secrets,
    REDACTED,
    maximumMatchableTextLength(current, protectedKeyNames),
  )

  for (const step of path) {
    if (Array.isArray(current)) {
      const index = Predicate.isNumber(step) ? step : ARRAY_INDEX.test(step) ? Number(step) : -1

      if (!Number.isInteger(index) || index < 0 || index >= current.length) return Option.none()

      policy = childProtection(policy, index)
      current = current[index]
    } else if (isJsonObject(current) && Predicate.isString(step)) {
      if (released.policyRevision === currentRevision) {
        if (!Object.hasOwn(current, step)) return Option.none()

        policy = childProtection(policy, step)
        current = current[step]
        continue
      }

      const member = visibleObjectMembers(current, scrubber, protectedKeyNames, policy).find(
        (entry) => entry.name === step,
      )

      if (member === undefined) return Option.none()

      policy = childProtection(policy, member.key)
      current = member.value
    } else {
      return Option.none()
    }
  }

  return Option.some({
    [brand]: released[brand],
    [protectionBrand]: policy,
    sink: released.sink,
    recipientId: released.recipientId,
    policyRevision: released.policyRevision,
    payload: ReleasePayload.JsonValue({ value: current }),
  })
}

const makeDisclosure = (options: DisclosureOptions): DisclosureApi => {
  let state: DisclosureState = {
    revision: 0,
    protectedValues: [...(options.protectedValues ?? [])],
    protectedKeyNames: [...(options.protectedKeyNames ?? [])],
  }

  const secretsFor = (
    protectedValues: ReadonlyArray<string>,
    inputSensitiveValues: ReadonlyArray<string>,
    minted: ReadonlyArray<string>,
  ): ReadonlyArray<string> => [...protectedValues, ...inputSensitiveValues, ...minted]

  const keysFor = (
    protectedKeyNames: ReadonlyArray<string>,
    inputSensitiveKeys: ReadonlyArray<string>,
  ): ReadonlyArray<string> => [...protectedKeyNames, ...inputSensitiveKeys]

  const atomicRefusal = <S extends Sink>(audience: Audience<S>): DisclosureRefused =>
    new DisclosureRefused({
      message: "A protected value occupies an atomic protocol field and cannot be redacted safely",
      sink: audience.sink,
      reason: "protected-atomic-field",
    })

  const unredactableRefusal = <S extends Sink>(audience: Audience<S>): DisclosureRefused =>
    new DisclosureRefused({
      message: "A protected value remains in the serialized payload outside a redactable string",
      sink: audience.sink,
      reason: "protected-unredactable-scalar",
    })

  const scrubJsonValue = <S extends Sink>(
    value: Schema.Json,
    audience: Audience<S>,
    protectedValues: ReadonlyArray<string>,
    protectedKeyNames: ReadonlyArray<string>,
    inputSensitiveValues: ReadonlyArray<string>,
    inputSensitiveKeys: ReadonlyArray<string>,
    policy: RedactionPolicy,
  ): Effect.Effect<Schema.Json, DisclosureRefused> => {
    const secrets = secretsFor(protectedValues, inputSensitiveValues, mintedValuesInValue(value))
    const keys = keysFor(protectedKeyNames, inputSensitiveKeys)
    const scrubber = compileScrubber(secrets, REDACTED, maximumMatchableTextLength(value, keys))

    if (atomicValueContainsSecret(value, scrubber, policy)) {
      return Effect.fail(atomicRefusal(audience))
    }

    const redacted = redactJsonValue(value, scrubber, keys, policy)

    return unredactableScalarContainsSecret(redacted, scrubber)
      ? Effect.fail(unredactableRefusal(audience))
      : Effect.succeed(redacted)
  }

  const scrubRecords = <S extends Sink>(
    items: ReadonlyArray<Schema.Json>,
    audience: Audience<S>,
    protectedValues: ReadonlyArray<string>,
    protectedKeyNames: ReadonlyArray<string>,
    inputSensitiveValues: ReadonlyArray<string>,
    inputSensitiveKeys: ReadonlyArray<string>,
    policy: RedactionPolicy,
  ): Effect.Effect<ReadonlyArray<Schema.Json>, DisclosureRefused> => {
    const secrets = secretsFor(protectedValues, inputSensitiveValues, mintedValuesInRecords(items))
    const keys = keysFor(protectedKeyNames, inputSensitiveKeys)
    let maximumTextLength = 0

    for (const item of items) {
      maximumTextLength = Math.max(maximumTextLength, maximumMatchableTextLength(item, keys))
    }

    const scrubber = compileScrubber(secrets, REDACTED, maximumTextLength)

    if (items.some((item) => atomicValueContainsSecret(item, scrubber, policy))) {
      return Effect.fail(atomicRefusal(audience))
    }

    const redacted = items.map((item) => redactJsonValue(item, scrubber, keys, policy))

    return redacted.some((item) => unredactableScalarContainsSecret(item, scrubber))
      ? Effect.fail(unredactableRefusal(audience))
      : Effect.succeed(redacted)
  }

  const scrubMedia = (
    media: MediaPayload,
    protectedValues: ReadonlyArray<string>,
    inputSensitiveValues: ReadonlyArray<string>,
  ): Effect.Effect<MediaPayload, ProtectedBytes> => {
    const secrets = secretsFor(protectedValues, inputSensitiveValues, [])
    const maximumTextLength = Math.max(media.contentType.length, media.filename?.length ?? 0)
    const scrubber = compileScrubber(secrets, REDACTED, maximumTextLength)
    const contentType = scrubTextWith(media.contentType, scrubber)
    const { protected: isProtected, filename } = media

    if (isProtected === true) {
      return Effect.fail(
        new ProtectedBytes({
          message: "Media is marked as protected and cannot cross a trust boundary",
          contentType,
        }),
      )
    }

    const bytes = new Uint8Array(media.bytes)

    if (mediaContainsProtectedBytes(bytes, secrets)) {
      return Effect.fail(
        new ProtectedBytes({
          message: "Media bytes contain a protected value and cannot be redacted safely",
          contentType,
        }),
      )
    }

    const base = { contentType, bytes }
    const released = isProtected === undefined ? base : { ...base, protected: isProtected }

    return Effect.succeed(
      filename === undefined
        ? released
        : { ...released, filename: scrubTextWith(filename, scrubber) },
    )
  }

  const makeReleased = <S extends Sink>(
    audience: Audience<S>,
    policyRevision: number,
    policy: RedactionPolicy,
    payload: ReleasePayload,
  ): Released<S> => ({
    [brand]: audience.sink,
    sink: audience.sink,
    recipientId: audience.recipientId,
    policyRevision,
    [protectionBrand]: policy,
    payload,
  })

  const scrubPayload = <S extends Sink>(
    payload: ReleasePayload,
    audience: Audience<S>,
    inputSensitiveValues: ReadonlyArray<string>,
    inputSensitiveKeys: ReadonlyArray<string>,
    policy: RedactionPolicy,
  ): Effect.Effect<Released<S>, DisclosureRefused | ProtectedBytes> =>
    Effect.suspend(() => {
      // Release construction is lazy, so the policy snapshot must be too:
      // scrubbing and revision stamping use the state visible when the
      // returned Effect actually runs, never a mixture of construction-time
      // secrets with a later execution-time revision.
      const snapshot = state

      return ReleasePayload.$match(payload, {
        Empty: () => Effect.succeed(makeReleased(audience, snapshot.revision, policy, payload)),
        JsonValue: (variant) =>
          Effect.map(
            scrubJsonValue(
              variant.value,
              audience,
              snapshot.protectedValues,
              snapshot.protectedKeyNames,
              inputSensitiveValues,
              inputSensitiveKeys,
              policy,
            ),
            (value) =>
              makeReleased(
                audience,
                snapshot.revision,
                policy,
                ReleasePayload.JsonValue({ value }),
              ),
          ),
        Records: (variant) =>
          Effect.map(
            scrubRecords(
              variant.items,
              audience,
              snapshot.protectedValues,
              snapshot.protectedKeyNames,
              inputSensitiveValues,
              inputSensitiveKeys,
              policy,
            ),
            (items) =>
              makeReleased(audience, snapshot.revision, policy, ReleasePayload.Records({ items })),
          ),
        Media: (variant) =>
          Effect.map(
            scrubMedia(variant.media, snapshot.protectedValues, inputSensitiveValues),
            (media) =>
              makeReleased(audience, snapshot.revision, policy, ReleasePayload.Media({ media })),
          ),
      })
    })

  const scrubStream = (): TextScrubStream => openScrubStream(() => state.protectedValues, REDACTED)

  return {
    scrubStream,

    release: (input, to) =>
      scrubPayload(
        input.payload,
        to,
        input.sensitiveValues ?? [],
        input.sensitiveKeys ?? [],
        protectionOf(input.jsonProtection),
      ),

    narrowJson: (released, path) =>
      narrowJsonReleased(
        released,
        path,
        state.protectedValues,
        state.protectedKeyNames,
        state.revision,
      ),

    revalidate: (value, to) =>
      Effect.gen(function* () {
        if (value.sink !== to.sink) {
          return yield* Effect.fail(
            new DisclosureRefused({
              message: "A value released for one sink cannot cross to another",
              sink: to.sink,
              reason: `value was released for sink "${value.sink}", not "${to.sink}"`,
            }),
          )
        }

        if (value.recipientId !== to.recipientId) {
          return yield* Effect.fail(
            new DisclosureRefused({
              message: "A value released for one recipient cannot cross to another",
              sink: to.sink,
              reason: `value was released for recipient "${value.recipientId}", not "${to.recipientId}"`,
            }),
          )
        }

        return yield* scrubPayload(value.payload, to, [], [], value[protectionBrand])
      }),

    policyRevision: () => Effect.succeed(state.revision),

    tightenPolicy: (extraProtectedValues) =>
      Effect.sync(() => {
        state = {
          revision: state.revision + 1,
          protectedValues: [...state.protectedValues, ...extraProtectedValues],
          protectedKeyNames: state.protectedKeyNames,
        }

        return state.revision
      }),

    audience: (sink, recipientId) =>
      Effect.succeed({
        sink,
        recipientId,
        policyRevision: state.revision,
      }),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DisclosureApi {
  scrubStream(): TextScrubStream

  release<S extends Sink>(
    input: ReleaseInput,
    to: Audience<S>,
  ): Effect.Effect<Released<S>, DisclosureRefused | ProtectedBytes>

  /**
   * Narrows an already-released JSON value to a subtree. String steps are
   * reference tokens interpreted by the container at that position: object
   * member names resolve as they are visible under the current policy after
   * tightening, or exactly as stored when the value is already at that
   * revision; numeric tokens index arrays, and number steps remain array
   * indices. The result carries the protection shape of that exact subtree
   * rather than the root shape, and still must be revalidated before a later
   * disclosure.
   */
  narrowJson<S extends Sink>(
    value: Released<S>,
    path: ReadonlyArray<string | number>,
  ): Option.Option<Released<S>>

  revalidate<S extends Sink>(
    value: Released<S>,
    to: Audience<S>,
  ): Effect.Effect<Released<S>, DisclosureRefused | ProtectedBytes>

  policyRevision(): Effect.Effect<PolicyRevision>

  tightenPolicy(extraProtectedValues: ReadonlyArray<string>): Effect.Effect<PolicyRevision>

  audience<S extends Sink>(sink: S, recipientId: string): Effect.Effect<Audience<S>>
}

export class Disclosure extends Context.Service<Disclosure, DisclosureApi>()(
  "droid-mcp-v2/Disclosure",
) {}

export type DisclosureOptions = {
  readonly protectedValues?: ReadonlyArray<string>
  readonly protectedKeyNames?: ReadonlyArray<string>
}

export const disclosureLayer = (options?: DisclosureOptions): Layer.Layer<Disclosure> =>
  Layer.succeed(Disclosure, makeDisclosure(options ?? {}))
