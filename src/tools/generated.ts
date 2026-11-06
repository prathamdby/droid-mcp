import * as Tool from "effect/ai/Tool"
import * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

import { DaemonService } from "../droid/daemon-service.ts"
import { errorCode, errorMessage } from "../droid/errors.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { SURFACE } from "../generated/surface.ts"
import type { JsonSchemaObject, WireEntry } from "../generated/surface.ts"
import { ToolFailure } from "./failure.ts"

/** Methods the hand-written session tools own; the generated surface skips them. */
export const SESSION_OWNED_METHODS: ReadonlyArray<string> = [
  "droid.initialize_session",
  "droid.add_user_message",
  "droid.interrupt_session",
  "droid.close_session",
  "droid.request_permission",
  "droid.ask_user",
  "droid.pick_options",
  "droid.session_notification",
]

/** The SDK's JSON Schema, as `effect/SchemaRepresentation` accepts it. */
const asDocument = (value: JsonSchemaObject): JsonSchema.JsonSchema =>
  // SAFETY: the document was emitted by scripts/codegen.ts from the SDK's own Zod
  // declarations, so it is a JSON Schema object; the cast only drops the wider
  // recursive value type this module carries for rendering.
  value as JsonSchema.JsonSchema

/** Wraps a root schema as the 2020-12 document `SchemaRepresentation` reads. */
const documentOf = (value: JsonSchemaObject): JsonSchema.Document<"draft-2020-12"> => ({
  dialect: "draft-2020-12",
  schema: asDocument(value),
  definitions: {},
})

const schemaOf = (value: JsonSchemaObject) =>
  SchemaRepresentation.fromJsonSchemaDocument(documentOf(value))

/** Decodes against a schema whose decoding requirements are empty by construction. */
const decode = (schema: Schema.Top, input: JsonValue | undefined): Option.Option<unknown> =>
  // SAFETY: `fromJsonSchemaDocument` builds a schema with no decoding services;
  // `Schema.Top` types those services as `unknown`, so widen to a codec.
  Schema.decodeUnknownOption(schema as Schema.Codec<unknown>)(input)

/** Wire parameters: the decoded tool input, minus anything the daemon rejects. */
const wireParams = (
  entry: WireEntry,
  params: JsonSchemaObject | undefined,
): Effect.Effect<JsonValue | undefined, ToolFailure> => {
  if (params === undefined) return Effect.succeed(undefined)

  const schema = schemaOf(entry.params)

  return Option.match(decode(schema, params), {
    onNone: () =>
      Effect.fail({
        code: "invalid_params",
        message: "parameters do not match " + entry.method + "'s schema",
      }),
    // SAFETY: the decoded value passed the SDK schema, so it is JSON by construction.
    onSome: (decoded) => Effect.succeed(decoded as JsonValue),
  })
}

/**
 * One handler: validate, send the wire request, map failures to the tool
 * contract. The reply is checked here because a reply the success schema
 * rejects would otherwise fail in the encoder, past any failure mapping.
 */
const handlerFor = (entry: WireEntry) => {
  const resultSchema = schemaOf(entry.result)

  return (params: JsonSchemaObject | undefined) =>
    Effect.gen(function* () {
      const daemon = yield* DaemonService
      const requestParams = yield* wireParams(entry, params)

      const reply = yield* daemon
        .request({ method: entry.method, params: requestParams })
        .pipe(
          Effect.mapError((error) => ({ code: errorCode(error), message: errorMessage(error) })),
        )

      return yield* Option.match(decode(resultSchema, reply), {
        onNone: () =>
          Effect.fail({
            code: "daemon_protocol_error",
            message: entry.method + " returned a result that does not match its schema",
          }),
        // SAFETY: the decoded value passed the SDK schema, so it is JSON by construction.
        onSome: (decoded) => Effect.succeed(decoded as JsonValue),
      })
    })
}

export type GeneratedHandlers = Record<
  string,
  (
    params: JsonSchemaObject | undefined,
  ) => Effect.Effect<JsonValue | undefined, ToolFailure, DaemonService>
>

/**
 * One tool per SDK wire method. The advertised input schema is the SDK's own,
 * so a client sees exactly the fields the daemon accepts.
 */
export const generatedSurface = () => {
  const entries = SURFACE.filter((entry) => !SESSION_OWNED_METHODS.includes(entry.method))

  const tools: Array<Tool.Any> = entries.map((entry) =>
    Tool.dynamic(entry.tool, {
      description: entry.description,
      parameters: asDocument(entry.params),
      success: schemaOf(entry.result),
      // Without a failure schema a typed failure becomes a defect, and the client
      // sees "internal server error" instead of the daemon's error code.
      failure: ToolFailure,
    }),
  )

  const handlers: GeneratedHandlers = {}

  for (const entry of entries) handlers[entry.tool] = handlerFor(entry)

  return { tools, handlers, count: entries.length }
}
