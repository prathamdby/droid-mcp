import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import { describe, expect, it } from "vitest"

import { SURFACE } from "../../src/generated/surface.ts"
import type { JsonSchemaObject } from "../../src/generated/surface.ts"

/**
 * The generated documents are the SDK's own request and response schemas. The
 * runtime turns each one into an Effect schema on every call, so a document
 * that `fromJsonSchemaDocument` rejects would only fail when a tool is used.
 * These checks do that conversion for all 165 methods up front.
 */

const documentOf = (value: JsonSchemaObject): JsonSchema.Document<"draft-2020-12"> => ({
  dialect: "draft-2020-12",
  // SAFETY: codegen emits JSON Schema objects; the cast only widens the value
  // type this module carries to `JsonSchema.JsonSchema`.
  schema: value as JsonSchema.JsonSchema,
  definitions: {},
})

const schemaOf = (value: JsonSchemaObject) =>
  SchemaRepresentation.fromJsonSchemaDocument(documentOf(value))

/** Decodes a payload against a converted schema, failing on a mismatch. */
const decode = (schema: Schema.Top, input: JsonSchemaObject): Schema.Json => {
  // SAFETY: `fromJsonSchemaDocument` builds a schema with no decoding services,
  // and every generated document describes a JSON payload; widen to that codec.
  return Schema.decodeUnknownSync(schema as Schema.Codec<Schema.Json>)(input)
}

describe("generated schemas", () => {
  it("converts every params schema", () => {
    let converted = 0

    for (const entry of SURFACE) {
      expect(() => schemaOf(entry.params), entry.method + " params").not.toThrow()
      converted += 1
    }

    expect(converted).toBe(SURFACE.length)
  })

  it("converts every result schema", () => {
    for (const entry of SURFACE) {
      expect(() => schemaOf(entry.result), entry.method + " result").not.toThrow()
    }
  })

  it("validates a real payload against its own schema", () => {
    const entry = SURFACE.find((value) => value.method === "droid.update_session_settings")

    if (entry === undefined) throw new Error("no update_session_settings entry")

    const schema = schemaOf(entry.params)

    expect(decode(schema, { autonomyLevel: "low" })).toMatchObject({ autonomyLevel: "low" })
  })

  it("rejects a payload the SDK would reject", () => {
    const entry = SURFACE.find((value) => value.method === "droid.update_session_settings")

    if (entry === undefined) throw new Error("no update_session_settings entry")

    expect(() => decode(schemaOf(entry.params), { autonomyLevel: "highest" })).toThrow()
  })

  it("keeps required fields required after conversion", () => {
    const entry = SURFACE.find(
      (value) => value.method === "daemon.acknowledge_mission_readiness_warning",
    )

    if (entry === undefined) throw new Error("no acknowledge_mission_readiness_warning entry")

    expect(() => decode(schemaOf(entry.params), {})).toThrow()
    expect(() => decode(schemaOf(entry.params), { cwd: "/tmp" })).not.toThrow()
  })
})
