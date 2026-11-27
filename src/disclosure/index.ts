import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import {
  openScrubStream,
  mediaContainsProtectedBytes,
  mintedValuesInRecords,
  mintedValuesInValue,
  redactJsonValue,
  scrubText,
} from "./private/scrub.ts"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Sink = "client" | "event" | "error" | "log"

export type PolicyRevision = number

export type Audience<S extends Sink> = {
  readonly sink: S
  readonly recipientId: string
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

export type ReleaseInput = {
  readonly payload: ReleasePayload
  readonly sensitiveValues?: ReadonlyArray<string>
  readonly sensitiveKeys?: ReadonlyArray<string>
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

export type Released<S extends Sink> = {
  readonly [brand]: S
  readonly sink: S
  readonly recipientId: string
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

const makeDisclosure = (options: DisclosureOptions): DisclosureApi => {
  let state: DisclosureState = {
    revision: 0,
    protectedValues: options.protectedValues ?? [],
    protectedKeyNames: options.protectedKeyNames ?? [],
  }

  const secretsFor = (
    inputSensitiveValues: ReadonlyArray<string>,
    minted: ReadonlyArray<string>,
  ): ReadonlyArray<string> => [...state.protectedValues, ...inputSensitiveValues, ...minted]

  const keysFor = (inputSensitiveKeys: ReadonlyArray<string>): ReadonlyArray<string> => [
    ...state.protectedKeyNames,
    ...inputSensitiveKeys,
  ]

  const scrubJsonValue = (
    value: Schema.Json,
    inputSensitiveValues: ReadonlyArray<string>,
    inputSensitiveKeys: ReadonlyArray<string>,
  ): Schema.Json =>
    redactJsonValue(
      value,
      secretsFor(inputSensitiveValues, mintedValuesInValue(value)),
      keysFor(inputSensitiveKeys),
      REDACTED,
    )

  const scrubRecords = (
    items: ReadonlyArray<Schema.Json>,
    inputSensitiveValues: ReadonlyArray<string>,
    inputSensitiveKeys: ReadonlyArray<string>,
  ): ReadonlyArray<Schema.Json> => {
    const secrets = secretsFor(inputSensitiveValues, mintedValuesInRecords(items))
    const keys = keysFor(inputSensitiveKeys)

    return items.map((item) => redactJsonValue(item, secrets, keys, REDACTED))
  }

  const scrubMedia = (
    media: MediaPayload,
    inputSensitiveValues: ReadonlyArray<string>,
  ): Effect.Effect<MediaPayload, ProtectedBytes> => {
    const secrets = secretsFor(inputSensitiveValues, [])
    const contentType = scrubText(media.contentType, secrets, REDACTED)
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
        : { ...released, filename: scrubText(filename, secrets, REDACTED) },
    )
  }

  const makeReleased = <S extends Sink>(
    audience: Audience<S>,
    payload: ReleasePayload,
  ): Released<S> => ({
    [brand]: audience.sink,
    sink: audience.sink,
    recipientId: audience.recipientId,
    policyRevision: audience.policyRevision,
    payload,
  })

  const scrubPayload = <S extends Sink>(
    payload: ReleasePayload,
    audience: Audience<S>,
    inputSensitiveValues: ReadonlyArray<string>,
    inputSensitiveKeys: ReadonlyArray<string>,
  ): Effect.Effect<Released<S>, ProtectedBytes> =>
    ReleasePayload.$match(payload, {
      Empty: () => Effect.succeed(makeReleased(audience, payload)),
      JsonValue: (variant) =>
        Effect.succeed(
          makeReleased(
            audience,
            ReleasePayload.JsonValue({
              value: scrubJsonValue(variant.value, inputSensitiveValues, inputSensitiveKeys),
            }),
          ),
        ),
      Records: (variant) =>
        Effect.succeed(
          makeReleased(
            audience,
            ReleasePayload.Records({
              items: scrubRecords(variant.items, inputSensitiveValues, inputSensitiveKeys),
            }),
          ),
        ),
      Media: (variant) =>
        Effect.map(scrubMedia(variant.media, inputSensitiveValues), (media) =>
          makeReleased(audience, ReleasePayload.Media({ media })),
        ),
    })

  const scrubStream = (): TextScrubStream => openScrubStream(() => state.protectedValues, REDACTED)

  return {
    scrubStream,

    release: (input, to) =>
      scrubPayload(input.payload, to, input.sensitiveValues ?? [], input.sensitiveKeys ?? []),

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

        return yield* scrubPayload(value.payload, to, [], [])
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
