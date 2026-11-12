import * as Tool from "effect/ai/Tool"
import * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

import type { AutonomyLevel, Config } from "../config.ts"
import { DaemonService } from "../droid/daemon-service.ts"
import type { DaemonApi } from "../droid/daemon-service.ts"
import { errorCode, errorMessage } from "../droid/errors.ts"
import type { JsonValue } from "../droid/protocol.ts"
import { SURFACE } from "../generated/surface.ts"
import type { JsonSchemaObject, WireEntry } from "../generated/surface.ts"
import { ToolFailure } from "./failure.ts"
import { autonomyWithinCap, requireAutonomy } from "./guards.ts"

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

/** Exec-session reads that the daemon socket does not serve, with supported replacements. */
export const DAEMON_UNSERVED_METHODS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["droid.list_skills", ["session_list_skills", "daemon_list_skills"]],
  ["droid.list_tools", ["session_list_tools"]],
  ["droid.list_mcp_tools", ["session_list_mcp_tools", "daemon_list_mcp_tools"]],
  ["droid.list_mcp_registry", ["daemon_list_mcp_registry"]],
])

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

const JsonRecord = Schema.Record(Schema.String, Schema.Json)

const AutonomyLevelSchema = Schema.Literals(["off", "low", "medium", "high"])

const AutonomyModeSchema = Schema.Literals([
  "normal",
  "spec",
  "auto-low",
  "auto-medium",
  "auto-high",
])

const SubagentAutonomySchema = Schema.Literals(["off", "low", "medium", "high", "inherit"])

/**
 * Methods whose parameters can raise session authority.
 *
 * Omitted initialize authority is copied from one `daemon.get_default_settings`
 * read onto that request. A lower observed value is kept. A missing field
 * becomes `off`, `normal`, or `skipPermissionsUnsafe: false` when the cap is
 * below high. Persistent defaults are not written.
 *
 * This is not a universal ceiling. Saved-session loads cannot be capped, and
 * initialize has no `subagentAutonomyLevel` field.
 */
const AUTHORITY_METHODS: ReadonlyArray<string> = [
  "daemon.initialize_session",
  "daemon.load_session",
  "daemon.update_session_defaults",
  "daemon.update_session_settings",
  "droid.initialize_session",
  "droid.update_session_settings",
]

/** The server default from `config.ts`, used until a caller passes config. */
const DEFAULT_MAX_AUTONOMY = "medium" satisfies AutonomyLevel

const modeLevel = (
  mode: "normal" | "spec" | "auto-low" | "auto-medium" | "auto-high",
): AutonomyLevel | undefined => {
  if (mode === "auto-low") return "low"

  if (mode === "auto-medium") return "medium"

  if (mode === "auto-high") return "high"

  return undefined
}

const pushLevel = (levels: Array<AutonomyLevel>, level: AutonomyLevel | undefined): void => {
  if (level !== undefined) levels.push(level)
}

/**
 * Authority the decoded params name explicitly. Omitted initialize fields are
 * handled by `materializeInitializeAuthority`. `skipPermissionsUnsafe` counts
 * only when it is true. `inherit` is the parent's level, not a new one.
 */
const authorityLevels = (
  params: Readonly<Record<string, JsonValue>>,
): ReadonlyArray<AutonomyLevel> => {
  const levels: Array<AutonomyLevel> = []

  const autonomyLevel = Option.getOrUndefined(
    Schema.decodeUnknownOption(AutonomyLevelSchema)(params["autonomyLevel"]),
  )

  pushLevel(levels, autonomyLevel)

  const mode = Option.getOrUndefined(
    Schema.decodeUnknownOption(AutonomyModeSchema)(params["autonomyMode"]),
  )

  if (mode !== undefined) pushLevel(levels, modeLevel(mode))

  const subagent = Option.getOrUndefined(
    Schema.decodeUnknownOption(SubagentAutonomySchema)(params["subagentAutonomyLevel"]),
  )

  if (subagent !== undefined && subagent !== "inherit") pushLevel(levels, subagent)

  if (params["skipPermissionsUnsafe"] === true) pushLevel(levels, "high")

  return levels
}

const enforceAutonomy = (
  cap: AutonomyLevel,
  method: string,
  params: JsonValue | undefined,
): Effect.Effect<void, ToolFailure> => {
  if (!AUTHORITY_METHODS.includes(method) || params === undefined) return Effect.void

  if (!Schema.is(JsonRecord)(params)) return Effect.void

  return Effect.gen(function* () {
    for (const level of authorityLevels(params)) {
      yield* requireAutonomy(cap, level)
    }
  })
}

/** Initialize requests that can inherit settings.json when a field is omitted. */
const INITIALIZE_METHODS: ReadonlyArray<string> = [
  "daemon.initialize_session",
  "droid.initialize_session",
]

const capMode = (cap: AutonomyLevel): "normal" | "auto-low" | "auto-medium" | "auto-high" => {
  if (cap === "low") return "auto-low"

  if (cap === "medium") return "auto-medium"

  if (cap === "high") return "auto-high"

  return "normal"
}

const presentLevel = (value: JsonValue | undefined): boolean =>
  Option.isSome(Schema.decodeUnknownOption(AutonomyLevelSchema)(value))

const presentMode = (value: JsonValue | undefined): boolean =>
  Option.isSome(Schema.decodeUnknownOption(AutonomyModeSchema)(value))

const readLevel = (value: JsonValue | undefined): AutonomyLevel | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(AutonomyLevelSchema)(value))

const readMode = (
  value: JsonValue | undefined,
): "normal" | "spec" | "auto-low" | "auto-medium" | "auto-high" | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(AutonomyModeSchema)(value))

/** Absent snapshot level. `off` is inside every cap and grants no auto authority. */
const boundedLevel = (cap: AutonomyLevel, observed: AutonomyLevel | undefined): AutonomyLevel => {
  if (observed === undefined) return "off"

  if (autonomyWithinCap(cap, observed)) return observed

  return cap
}

/**
 * Absent snapshot mode. `normal` and `spec` are kept as read. An auto mode
 * above the cap becomes the cap's mode; a lower auto mode is kept.
 */
const boundedMode = (
  cap: AutonomyLevel,
  observed: "normal" | "spec" | "auto-low" | "auto-medium" | "auto-high" | undefined,
): "normal" | "spec" | "auto-low" | "auto-medium" | "auto-high" => {
  if (observed === undefined) return "normal"

  const level = modeLevel(observed)

  if (level !== undefined && !autonomyWithinCap(cap, level)) return capMode(cap)

  return observed
}

/**
 * `skipPermissionsUnsafe` is not in `get_default_settings` and has no proven
 * daemon default of false. Under a cap below high, an omission is not safe.
 */
const pinOmittedSkip = (fields: Readonly<Record<string, JsonValue>>, cap: AutonomyLevel): boolean =>
  fields["skipPermissionsUnsafe"] === undefined && cap !== "high"

/**
 * Copy omitted initialize authority from the settings snapshot onto this
 * request so a later settings.json change cannot fill the gap. Keep a
 * within-cap observed value and clamp only an observed value above the cap.
 */
const materializeInitializeAuthority = (
  daemon: DaemonApi,
  cap: AutonomyLevel,
  method: string,
  params: JsonValue | undefined,
): Effect.Effect<JsonValue | undefined, ToolFailure> => {
  if (!INITIALIZE_METHODS.includes(method) || params === undefined) return Effect.succeed(params)

  const requestFields = Option.getOrUndefined(Schema.decodeUnknownOption(JsonRecord)(params))

  if (requestFields === undefined) return Effect.succeed(params)

  const levelOmitted = !presentLevel(requestFields["autonomyLevel"])
  const modeOmitted = !presentMode(requestFields["autonomyMode"])

  if (!levelOmitted && !modeOmitted) {
    if (!pinOmittedSkip(requestFields, cap)) return Effect.succeed(params)

    return Effect.succeed({ ...requestFields, skipPermissionsUnsafe: false })
  }

  const cwd = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(requestFields["cwd"]))

  return Effect.gen(function* () {
    const defaults = yield* daemon
      .request({
        method: "daemon.get_default_settings",
        params: cwd === undefined ? {} : { cwd },
      })
      .pipe(Effect.mapError((error) => ({ code: errorCode(error), message: errorMessage(error) })))

    const defaultsFields = Option.getOrUndefined(Schema.decodeUnknownOption(JsonRecord)(defaults))

    if (defaultsFields === undefined) {
      return yield* Effect.fail({
        code: "daemon_protocol_error",
        message: "daemon.get_default_settings returned no settings object",
      })
    }

    let next = { ...requestFields }

    if (levelOmitted) {
      next = {
        ...next,
        autonomyLevel: boundedLevel(cap, readLevel(defaultsFields["autonomyLevel"])),
      }
    }

    if (modeOmitted) {
      next = { ...next, autonomyMode: boundedMode(cap, readMode(defaultsFields["autonomyMode"])) }
    }

    if (pinOmittedSkip(requestFields, cap)) next = { ...next, skipPermissionsUnsafe: false }

    return next
  })
}

/**
 * One handler: validate, enforce the autonomy ceiling, send the wire request,
 * map failures to the tool contract. The reply is checked here because a reply
 * the success schema rejects would otherwise fail in the encoder, past any
 * failure mapping.
 */
const handlerFor = (entry: WireEntry, maxAutonomy: AutonomyLevel) => {
  const resultSchema = schemaOf(entry.result)

  return (params: JsonSchemaObject | undefined) =>
    Effect.gen(function* () {
      const daemon = yield* DaemonService
      const requestParams = yield* wireParams(entry, params)

      yield* enforceAutonomy(maxAutonomy, entry.method, requestParams)

      const boundedParams = yield* materializeInitializeAuthority(
        daemon,
        maxAutonomy,
        entry.method,
        requestParams,
      )

      const reply = yield* daemon
        .request({ method: entry.method, params: boundedParams })
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
 *
 * `maxAutonomy` is the server ceiling. Callers that have not been given a
 * Config yet use the same default `config.ts` uses (`medium`).
 */
export const generatedSurface = (config?: Pick<Config, "maxAutonomy">) => {
  const maxAutonomy = config?.maxAutonomy ?? DEFAULT_MAX_AUTONOMY

  const entries = SURFACE.filter(
    (entry) =>
      !SESSION_OWNED_METHODS.includes(entry.method) && !DAEMON_UNSERVED_METHODS.has(entry.method),
  )

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

  for (const entry of entries) handlers[entry.tool] = handlerFor(entry, maxAutonomy)

  return { tools, handlers, count: entries.length }
}
