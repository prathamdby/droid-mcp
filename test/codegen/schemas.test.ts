import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { LoadSessionResultSchema } from "@factory/droid-sdk"
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

  it("decodes the SDK's intersected load-session result without losing either side", () => {
    const entry = SURFACE.find((value) => value.method === "droid.load_session")

    if (entry === undefined) throw new Error("no load_session entry")

    const payload = {
      session: { messages: [] },
      settings: { modelId: "fake-model", reasoningEffort: "low" },
    }

    expect(LoadSessionResultSchema.safeParse(payload).success).toBe(true)
    expect(decode(schemaOf(entry.result), payload)).toEqual(payload)
  })

  it.each([
    ["missing session", { settings: { modelId: "fake-model", reasoningEffort: "low" } }],
    ["missing settings", { session: { messages: [] } }],
    [
      "invalid messages",
      {
        session: { messages: "not an array" },
        settings: { modelId: "fake-model", reasoningEffort: "low" },
      },
    ],
    [
      "invalid model",
      { session: { messages: [] }, settings: { modelId: 1, reasoningEffort: "low" } },
    ],
    [
      "invalid reasoning effort",
      {
        session: { messages: [] },
        settings: { modelId: "fake-model", reasoningEffort: "highest" },
      },
    ],
  ])("rejects an SDK-invalid load-session result: %s", (_name, payload) => {
    const entry = SURFACE.find((value) => value.method === "droid.load_session")

    if (entry === undefined) throw new Error("no load_session entry")

    expect(LoadSessionResultSchema.safeParse(payload).success).toBe(false)
    expect(() => decode(schemaOf(entry.result), payload)).toThrow()
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

describe("codegen optional guards", () => {
  it("keeps bare wrappers and non-reference types required without changing their schemas", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const directory = mkdtempSync(join(tmpdir(), "droid-mcp-codegen-"))

    try {
      const modules = join(directory, "node_modules")
      const sdk = join(modules, "@factory/droid-sdk")
      mkdirSync(sdk, { recursive: true })
      mkdirSync(join(directory, "src/generated"), { recursive: true })
      writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }))
      copyFileSync(join(root, "scripts/codegen.ts"), join(directory, "codegen.ts"))

      for (const dependency of ["effect", "oxfmt", "typescript"]) {
        symlinkSync(join(root, "node_modules", dependency), join(modules, dependency), "dir")
      }

      writeFileSync(join(sdk, "package.json"), JSON.stringify({ main: "index.js" }))
      writeFileSync(join(sdk, "index.js"), "")
      writeFileSync(
        join(sdk, "index-fixture.d.ts"),
        `declare const GuardRequestSchema: z.ZodObject<{
  method: z.ZodLiteral<"daemon.guard">;
  params: z.ZodObject<{
    bare: z.ZodReadonly;
    union: z.ZodString | z.ZodNumber;
    literal: "fixed";
    wrappedUnion: z.ZodReadonly<z.ZodString | z.ZodNumber>;
    wrappedLiteral: z.ZodReadonly<"fixed">;
    optional: z.ZodReadonly<z.ZodOptional<z.ZodString>>;
    defaulted: z.ZodReadonly<z.ZodDefault<z.ZodNumber>>;
  }>;
}>;
`,
      )

      execFileSync(process.execPath, ["--experimental-strip-types", "codegen.ts"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 20_000,
      })

      const output = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          'import { SURFACE } from "./src/generated/surface.ts"; console.log(JSON.stringify(SURFACE[0].params))',
        ],
        { cwd: directory, encoding: "utf8", timeout: 5_000 },
      )

      expect(JSON.parse(output)).toEqual({
        type: "object",
        properties: {
          bare: {},
          union: { anyOf: [{ type: "string" }, { type: "number" }] },
          literal: { const: "fixed" },
          wrappedUnion: { anyOf: [{ type: "string" }, { type: "number" }] },
          wrappedLiteral: { const: "fixed" },
          optional: { type: "string" },
          defaulted: { type: "number" },
        },
        additionalProperties: false,
        required: ["bare", "union", "literal", "wrappedUnion", "wrappedLiteral"],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
