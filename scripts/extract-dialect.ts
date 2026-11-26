/**
 * Build-time extractor for the reviewed wire dialect.
 *
 * Reads the pinned SDK's bundled type declarations with the TypeScript
 * compiler API, verifies the pinned version and declaration digest, and emits
 * JSON Schema 2020-12 params/result codecs for exactly the methods the
 * reviewed manifest allows. A method absent from the manifest is never
 * extracted; an allowlisted method whose declaration is missing or uses
 * unsupported syntax fails the build. Runtime code under `src/` never
 * imports this script, the compiler or the declarations.
 *
 * Run `node --experimental-strip-types scripts/extract-dialect.ts` to write
 * the codecs, or pass `--check` to fail on pin drift, missing entries or a
 * stale output file.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { Schema } from "effect"
import { format } from "oxfmt"
import ts from "typescript"

import {
  PINNED_DECLARATION_SHA256,
  PINNED_SDK_VERSION,
  REVIEWED_ENTRIES,
} from "../src/factory-dialect/private/reviewed-manifest.ts"

const require = createRequire(import.meta.url)

const OUTPUT = "src/factory-dialect/private/generated-codecs.ts"

type JsonSchema =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonSchema>
  | { readonly [key: string]: JsonSchema }

const fail = (message: string): never => {
  throw new Error("extract-dialect: " + message)
}

/** Resolves the SDK's internal declaration file; the package exports only the entry. */
const declarationFile = (): string => {
  const entry = require.resolve("@factory/droid-sdk")
  const dist = dirname(entry)

  // SAFETY: the SDK ships a package.json with a string version field; the
  // version comparison immediately below rejects anything that is not the
  // pinned release, so a malformed manifest fails closed here.
  const manifest = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")) as {
    readonly version?: string
  }

  if (manifest.version !== PINNED_SDK_VERSION) {
    fail(
      "SDK version drift: pinned " +
        PINNED_SDK_VERSION +
        " but installed " +
        String(manifest.version),
    )
  }

  const name = readdirSync(dist).find((file) => /^index-.*\.d\.ts$/.test(file))

  if (name === undefined) return fail("no bundled declaration file next to " + entry)

  return join(dist, name)
}

const locatedFile = declarationFile()

const digest = createHash("sha256").update(readFileSync(locatedFile)).digest("hex")

if (digest !== PINNED_DECLARATION_SHA256) {
  fail("declaration digest drift: pinned " + PINNED_DECLARATION_SHA256 + " but computed " + digest)
}

const program = ts.createProgram([locatedFile], {
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
})

const checker = program.getTypeChecker()
const sourceFile = program.getSourceFile(locatedFile)

if (sourceFile === undefined) throw new Error("extract-dialect: declaration file did not load")

const source: ts.SourceFile = sourceFile

interface DeclarationEntry {
  readonly kind: "variable" | "type" | "interface"
  readonly node: ts.Node
  readonly type?: ts.TypeNode
  readonly members?: ReadonlyArray<ts.TypeElement>
}

const declarations = new Map<string, DeclarationEntry>()

for (const statement of source.statements) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue

      if (declaration.type === undefined) {
        declarations.set(declaration.name.text, { kind: "variable", node: declaration })
      } else {
        declarations.set(declaration.name.text, {
          kind: "variable",
          node: declaration,
          type: declaration.type,
        })
      }
    }

    continue
  }

  if (ts.isTypeAliasDeclaration(statement)) {
    declarations.set(statement.name.text, {
      kind: "type",
      node: statement,
      type: statement.type,
    })

    continue
  }

  if (ts.isInterfaceDeclaration(statement)) {
    declarations.set(statement.name.text, {
      kind: "interface",
      node: statement,
      members: statement.members,
    })
  }
}

/** A literal type or an enum member reference, resolved through the checker. */
const literalValue = (node: ts.TypeNode): string | undefined => {
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return node.literal.text

    if (ts.isNumericLiteral(node.literal)) return node.literal.text

    return undefined
  }

  if (!ts.isTypeReferenceNode(node)) return undefined

  const type = checker.getTypeAtLocation(node)

  if (type.isStringLiteral()) return type.value

  if (type.isNumberLiteral()) return String(type.value)

  return undefined
}

/** The literal inside `ZodLiteral<"daemon.list_crons">`. */
const zodLiteral = (node: ts.TypeNode): string | undefined => {
  if (!ts.isTypeReferenceNode(node)) return undefined

  const argument = node.typeArguments?.[0]

  return argument === undefined ? undefined : literalValue(argument)
}

/**
 * The values of a TypeScript enum, read from the checker. The SDK uses
 * `z.ZodNativeEnum<typeof SomeEnum>`, which carries no values of its own.
 */
const nativeEnumValues = (node: ts.TypeNode): ReadonlyArray<string> => {
  const type = checker.getTypeAtLocation(node)

  return checker.getPropertiesOfType(type).flatMap((symbol) => {
    const value = checker.getTypeOfSymbol(symbol)

    if (value.isStringLiteral()) return [value.value]

    if (value.isNumberLiteral()) return [String(value.value)]

    return []
  })
}

/** Strips a namespace qualifier: the declarations qualify Zod as `z$1.ZodString`. */
const shortName = (name: string): string => name.slice(name.lastIndexOf(".") + 1)

const referenceName = (node: ts.TypeNode): string | undefined =>
  ts.isTypeReferenceNode(node) ? shortName(node.typeName.getText(source)) : undefined

/** Keys a `Pick`/`Omit` names: a string literal, or a union of them. */
const literalKeys = (node: ts.TypeNode | undefined): ReadonlyArray<string> | undefined => {
  if (node === undefined) return undefined

  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text]

  if (ts.isUnionTypeNode(node)) {
    const each = node.types.map(literalKeys)

    if (each.some((keys) => keys === undefined)) return undefined

    return each.flatMap((keys) => keys ?? [])
  }

  return undefined
}

const memberName = (member: ts.TypeElement): string | undefined =>
  ts.isPropertySignature(member) && member.name !== undefined
    ? member.name.getText(source).replace(/^["']|["']$/g, "")
    : undefined

/**
 * Members of an object type, flattening `A & B` intersections and applying
 * `Pick`/`Omit` to the literal they wrap. The SDK's session schemas are written
 * as `ZodObject<Omit<{ … }, "sessionId">>`, so the keys have to be filtered
 * here; TypeScript would otherwise leave the shape unresolved.
 */
const objectMembers = (node: ts.TypeNode | undefined): ReadonlyArray<ts.TypeElement> => {
  if (node === undefined) return []

  if (ts.isTypeLiteralNode(node)) return node.members

  if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(objectMembers)

  if (ts.isParenthesizedTypeNode(node)) return objectMembers(node.type)

  if (ts.isTypeReferenceNode(node)) {
    const name = shortName(node.typeName.getText(source))
    const arguments_ = node.typeArguments ?? []
    const keys = literalKeys(arguments_[1])

    if ((name !== "Pick" && name !== "Omit") || keys === undefined) return []

    const base = objectMembers(arguments_[0])
    const keep = name === "Pick"

    return base.filter((member) => {
      const current = memberName(member)

      return current !== undefined && keys.includes(current) === keep
    })
  }

  return []
}

/** Skips wrappers that do not change the wire value. */
const TRANSPARENT_ZOD = new Set([
  "ZodOptional",
  "ZodNullable",
  "ZodDefault",
  "ZodCatch",
  "ZodReadonly",
  "ZodBranded",
  "ZodEffects",
  "ZodPipeline",
  "ZodPromise",
])

const transitiveZod = new Set(["ZodLazy"])

interface ConvertContext {
  readonly seen: ReadonlySet<string>
  readonly depth: number
}

const MAX_DEPTH = 48

const JsonValueSchema = Schema.Record(Schema.String, Schema.Json)

const isRecord = (value: JsonSchema): value is { readonly [key: string]: JsonSchema } =>
  Schema.is(JsonValueSchema)(value) && !Array.isArray(value)

const withSeen = (context: ConvertContext, name: string): ConvertContext => ({
  seen: new Set([...context.seen, name]),
  depth: context.depth + 1,
})

const anySchema: JsonSchema = {}

/** Converts a declared Zod schema type reference into JSON Schema. */
const convertReference = (name: string, context: ConvertContext): JsonSchema => {
  if (context.depth > MAX_DEPTH || context.seen.has(name)) return anySchema

  const entry = declarations.get(name)

  if (entry === undefined) return anySchema

  // `type X = z.infer<typeof XSchema>`: follow the schema constant.
  if (entry.kind === "type" && entry.type !== undefined && ts.isTypeReferenceNode(entry.type)) {
    const inner = referenceName(entry.type)

    if (inner !== undefined && entry.type.typeArguments?.length === 1 && inner === "z.infer") {
      const argument = entry.type.typeArguments[0]

      if (argument !== undefined && ts.isTypeQueryNode(argument)) {
        return convertReference(argument.exprName.getText(source), withSeen(context, name))
      }
    }

    return convertNode(entry.type, withSeen(context, name))
  }

  if (entry.kind === "interface" && entry.members !== undefined) {
    return objectOfMembers(entry.members, withSeen(context, name))
  }

  if (entry.type !== undefined) return convertNode(entry.type, withSeen(context, name))

  return anySchema
}

/**
 * A member is optional when its type accepts `undefined`: either the property
 * itself is `?`, or the Zod schema is `ZodOptional`/`ZodDefault`, possibly
 * inside a transparent wrapper such as `ZodCatch` or `ZodEffects`.
 */
const isOptionalMember = (member: ts.PropertySignature): boolean => {
  if (member.questionToken !== undefined) return true

  let node = member.type

  for (let depth = 0; depth < MAX_DEPTH && node !== undefined; depth++) {
    const name = referenceName(node)

    if (name === undefined) return false

    if (name === "ZodOptional" || name === "ZodDefault") return true

    if (!TRANSPARENT_ZOD.has(name)) return false

    node = ts.isTypeReferenceNode(node) ? node.typeArguments?.[0] : undefined
  }

  return false
}

/** Object schema from a list of type members, honoring `ZodOptional`. */
const objectOfMembers = (
  members: ReadonlyArray<ts.TypeElement>,
  context: ConvertContext,
): JsonSchema => {
  const properties = new Map<string, JsonSchema>()
  const required: Array<string> = []

  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue

    const key = member.name !== undefined ? member.name.getText(source).replace(/"/g, "") : ""

    if (key.length === 0 || key.startsWith("__@")) continue

    const wrapper = referenceName(member.type)
    const optional = isOptionalMember(member)

    const inner =
      wrapper !== undefined && TRANSPARENT_ZOD.has(wrapper) && ts.isTypeReferenceNode(member.type)
        ? (member.type.typeArguments?.[0] ?? member.type)
        : member.type

    properties.set(
      key,
      convertNode(inner, {
        seen: context.seen,
        depth: context.depth + 1,
      }),
    )

    if (!optional) required.push(key)
  }

  const base = {
    type: "object",
    properties: Object.fromEntries(properties),
    additionalProperties: false,
  }

  return required.length === 0 ? base : { ...base, required }
}

const tupleOptions = (node: ts.TypeNode | undefined): ReadonlyArray<ts.TypeNode> =>
  node !== undefined && ts.isTupleTypeNode(node) ? node.elements : []

/** Closed object intersections must allow the keys declared by either side. */
const intersectionOf = (parts: ReadonlyArray<JsonSchema>): JsonSchema => {
  const properties = new Map<string, JsonSchema>()
  const required = new Set<string>()

  for (const part of parts) {
    if (
      !isRecord(part) ||
      part.type !== "object" ||
      !isRecord(part.properties) ||
      part.additionalProperties !== false
    ) {
      return { allOf: parts }
    }

    for (const [name, field] of Object.entries(part.properties)) {
      const previous = properties.get(name)
      properties.set(name, previous === undefined ? field : { allOf: [previous, field] })
    }

    if (Schema.is(Schema.Array(Schema.String))(part.required)) {
      for (const name of part.required) required.add(name)
    }
  }

  const object = {
    type: "object",
    properties: Object.fromEntries(properties),
    additionalProperties: false,
  }

  return required.size === 0 ? object : { ...object, required: [...required] }
}

/** Converts any type node. Zod constructors get a structural schema. */
const convertNode = (node: ts.TypeNode, context: ConvertContext): JsonSchema => {
  if (context.depth > MAX_DEPTH) return anySchema

  if (ts.isTypeLiteralNode(node)) return objectOfMembers(node.members, context)

  if (ts.isIntersectionTypeNode(node)) {
    return intersectionOf(node.types.map((part) => convertNode(part, context)))
  }

  if (ts.isUnionTypeNode(node)) {
    return { anyOf: node.types.map((part) => convertNode(part, context)) }
  }

  if (ts.isArrayTypeNode(node)) {
    return { type: "array", items: convertNode(node.elementType, context) }
  }

  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return { const: node.literal.text }

    if (ts.isNumericLiteral(node.literal)) return { const: Number(node.literal.text) }

    if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return { const: true }

    if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return { const: false }

    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { const: null }

    return anySchema
  }

  if (ts.isParenthesizedTypeNode(node)) return convertNode(node.type, context)

  if (!ts.isTypeReferenceNode(node)) return anySchema

  const name = shortName(node.typeName.getText(source))
  const argument = (index: number): ts.TypeNode | undefined => node.typeArguments?.[index]
  const next: ConvertContext = { seen: context.seen, depth: context.depth + 1 }

  switch (name) {
    case "ZodString":
      return { type: "string" }
    case "ZodNumber":
      return { type: "number" }
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodBigInt":
      return { type: "integer" }
    case "ZodDate":
      return { type: "string", format: "date-time" }
    case "ZodNull":
      return { type: "null" }
    case "ZodNever":
      return { not: {} }
    case "ZodLiteral": {
      const literal = zodLiteral(node)

      if (literal !== undefined) return { const: literal }

      if (argument(0) !== undefined) return convertNode(argument(0) ?? node, next)

      return anySchema
    }

    case "ZodEnum": {
      const values = tupleOptions(argument(0)).flatMap((element) => {
        const value = literalValue(element)

        return value === undefined ? [] : [value]
      })

      return values.length === 0 ? anySchema : { enum: values }
    }

    case "ZodNativeEnum": {
      const enumNode = argument(0)
      const values = enumNode === undefined ? [] : nativeEnumValues(enumNode)

      return values.length === 0 ? anySchema : { enum: values }
    }

    case "ZodArray": {
      const element = argument(0)
      const items = element === undefined ? anySchema : convertNode(element, next)

      return { type: "array", items }
    }

    case "ZodTuple": {
      const elements = tupleOptions(argument(0)).map((element) => convertNode(element, next))

      return { type: "array", prefixItems: elements }
    }

    case "ZodRecord": {
      const value = argument(1)

      return {
        type: "object",
        additionalProperties: value === undefined ? anySchema : convertNode(value, next),
      }
    }

    case "ZodMap":
      return { type: "object", additionalProperties: true }
    case "ZodSet":
      return {
        type: "array",
        items: argument(0) === undefined ? anySchema : convertNode(argument(0) ?? node, next),
      }
    case "ZodUnion": {
      const options = tupleOptions(argument(0)).map((option) => convertNode(option, next))

      return options.length === 0 ? anySchema : { anyOf: options }
    }

    case "ZodDiscriminatedUnion": {
      const options = tupleOptions(argument(1)).map((option) => convertNode(option, next))

      return options.length === 0 ? anySchema : { anyOf: options }
    }

    case "ZodObject": {
      const members = objectMembers(argument(0))

      return members.length === 0
        ? { type: "object", additionalProperties: false }
        : objectOfMembers(members, next)
    }

    case "ZodAny":
    case "ZodUnknown":
    case "ZodVoid":
    case "ZodUndefined":
    case "ZodFunction":
      return anySchema
    default:
      break
  }

  if (TRANSPARENT_ZOD.has(name)) {
    const inner = argument(0)

    return inner === undefined ? anySchema : convertNode(inner, next)
  }

  if (transitiveZod.has(name)) return anySchema

  return convertReference(name, next)
}

/** The `Shape` type argument of a `ZodObject`-typed declaration. */
const objectNodeOf = (node: ts.TypeNode | undefined): ts.TypeNode | undefined => {
  if (node === undefined || !ts.isTypeReferenceNode(node)) return undefined

  if (shortName(node.typeName.getText(source)) !== "ZodObject") return undefined

  return node.typeArguments?.[0]
}

interface ExtractedCodec {
  readonly params: JsonSchema
  readonly result: JsonSchema
}

const EMPTY_OBJECT: JsonSchema = { type: "object", properties: {}, additionalProperties: false }

const EMPTY_RESULT: JsonSchema = { type: "object", additionalProperties: true }

/**
 * The object branches under a union or intersection, however deeply the SDK
 * nests them (`ZodIntersection<ZodDiscriminatedUnion<…>, …>` is common).
 */
const objectBranches = (value: JsonSchema): ReadonlyArray<JsonSchema> => {
  if (!isRecord(value)) return []

  const anyOf = value.anyOf
  const allOf = value.allOf

  if (Array.isArray(anyOf)) return anyOf.flatMap(objectBranches)

  if (Array.isArray(allOf)) return allOf.flatMap(objectBranches)

  return [value]
}

/**
 * A union or intersection of objects merges into one object: every property
 * any branch declares, all optional, because the peer validates the
 * combination it actually receives.
 */
const paramsRoot = (value: JsonSchema): JsonSchema => {
  if (!isRecord(value)) return EMPTY_OBJECT

  if (value.type === "object") return value

  const properties = new Map<string, JsonSchema>()

  for (const branch of objectBranches(value)) {
    if (!isRecord(branch) || branch.type !== "object") continue

    if (!isRecord(branch.properties)) continue

    for (const [name, field] of Object.entries(branch.properties)) {
      if (!properties.has(name)) properties.set(name, field)
    }
  }

  if (properties.size === 0) return EMPTY_OBJECT

  return {
    type: "object",
    properties: Object.fromEntries(properties),
    additionalProperties: false,
  }
}

interface RequestDecl {
  readonly schemaName: string
  readonly paramsNode: ts.TypeNode | undefined
}

/**
 * Resolves the params node for an allowlisted method. Most methods declare a
 * request schema whose shape carries the method literal; server-directed
 * methods resolve their literal through the checker. Methods whose request
 * schema is missing fall back to a bare `<Name>RequestParamsSchema` constant.
 */
const requestDeclOf = (method: string): RequestDecl | undefined => {
  for (const [schemaName, entry] of declarations) {
    if (!schemaName.endsWith("RequestSchema") || entry.kind !== "variable") continue

    const members = objectMembers(objectNodeOf(entry.type))

    if (members.length === 0) continue

    let declared: string | undefined
    let paramsNode: ts.TypeNode | undefined

    for (const member of members) {
      if (!ts.isPropertySignature(member) || member.type === undefined) continue

      const key = member.name !== undefined ? member.name.getText(source) : ""

      if (key === "method") declared = zodLiteral(member.type)

      if (key === "params") paramsNode = member.type
    }

    if (declared === method) return { schemaName, paramsNode }
  }

  return undefined
}

/** Locates a bare params schema constant such as `DaemonAuthenticateRequestParamsSchema`. */
const bareParamsOf = (method: string): ts.TypeNode | undefined => {
  const candidates = Array.from(declarations.keys()).filter(
    (name) => name.endsWith("RequestParamsSchema") && declarations.get(name)?.kind === "variable",
  )

  for (const candidate of candidates) {
    const entry = declarations.get(candidate)

    if (entry?.type === undefined) continue

    // The constant is a params shape when converting it yields an object whose
    // sibling request schema names the method. We match by naming convention:
    // strip "ParamsSchema" and check the request schema resolves the method.
    const requestName = candidate.replace(/ParamsSchema$/, "Schema")
    const requestEntry = declarations.get(requestName)

    if (requestEntry === undefined) continue

    const members = objectMembers(objectNodeOf(requestEntry.type))

    let declared: string | undefined

    for (const member of members) {
      if (!ts.isPropertySignature(member) || member.type === undefined) continue

      if ((member.name !== undefined ? member.name.getText(source) : "") === "method") {
        declared = zodLiteral(member.type)
      }
    }

    if (declared === method) return entry.type
  }

  return undefined
}

const resultOf = (schemaName: string): JsonSchema => {
  const resultName = schemaName.replace(/RequestSchema$/, "ResultSchema")
  const resultEntry = declarations.get(resultName)
  const resultMembers = objectNodeOf(resultEntry?.type)

  if (resultMembers !== undefined) {
    return convertNode(resultMembers, { seen: new Set([resultName]), depth: 0 })
  }

  const result = convertReference(resultName, { seen: new Set(), depth: 0 })

  return result === anySchema ? EMPTY_RESULT : result
}

/** The methods this extraction must produce; everything else is ignored. */
const wanted = new Map(REVIEWED_ENTRIES.map((entry) => [entry.method, entry]))

const extracted = new Map<string, ExtractedCodec>()
const missing: Array<string> = []

for (const [method, entry] of wanted) {
  if (method === "droid.get_settings") {
    // Reviewed evidence: the pinned SDK declares no schema for this method.
    // No codec exists; the binding stays unusable.
    continue
  }

  if (entry.direction === "notification" || entry.direction === "server_request") {
    // Inbound bindings carry no result codec; validation is hand-written in
    // the dialect runtime because the notification shapes are open unions.
    extracted.set(method, { params: EMPTY_OBJECT, result: EMPTY_RESULT })

    continue
  }

  const decl = requestDeclOf(method)

  if (decl === undefined) {
    const bare = bareParamsOf(method)

    if (bare === undefined) {
      missing.push(method)

      continue
    }

    const params = convertNode(bare, { seen: new Set([method]), depth: 0 })

    extracted.set(method, { params: paramsRoot(params), result: EMPTY_RESULT })

    continue
  }

  const context: ConvertContext = { seen: new Set([decl.schemaName]), depth: 0 }

  const params =
    decl.paramsNode === undefined ? EMPTY_OBJECT : paramsRoot(convertNode(decl.paramsNode, context))

  extracted.set(method, { params, result: resultOf(decl.schemaName) })
}

if (missing.length > 0) {
  fail(
    "allowlisted methods missing from the pinned declarations: " +
      missing.sort().join(", ") +
      "; review the manifest against the SDK before allowing them",
  )
}

const codecs = Array.from(extracted.entries())
  .sort(([left], [right]) => (left < right ? -1 : 1))
  .map(([method, codec]) => {
    const entry = wanted.get(method) ?? fail("internal: extracted an unreviewed method " + method)

    return {
      method,
      direction: entry.direction,
      served: entry.served,
      params: codec.params,
      result: codec.result,
    }
  })

/** Serializes a JSON Schema value with stable indentation, no runtime types. */
const render = (value: JsonSchema, indent: string): string => {
  if (value === null) return "null"

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"

    const items = value.map((item) => indent + "  " + render(item, indent + "  "))

    return "[\n" + items.join(",\n") + "\n" + indent + "]"
  }

  if (isRecord(value)) {
    const keys = Object.keys(value)

    if (keys.length === 0) return "{}"

    const rows = keys.map(
      (key) => indent + "  " + JSON.stringify(key) + ": " + render(value[key], indent + "  "),
    )

    return "{\n" + rows.join(",\n") + "\n" + indent + "}"
  }

  return JSON.stringify(value)
}

const codecRows = codecs
  .map((codec) => {
    const lines = [
      "  {",
      "    method: " + JSON.stringify(codec.method) + ",",
      "    direction: " + JSON.stringify(codec.direction) + ",",
      "    served: " + String(codec.served) + ",",
      "    params: " + render(codec.params, "    ") + ",",
      "    result: " + render(codec.result, "    ") + ",",
      "  }",
    ]

    return lines.join("\n")
  })
  .join(",\n")

const sourceText = `// Generated by scripts/extract-dialect.ts. Do not edit.
//
// Reviewed wire codecs for exactly the methods the manifest in
// \`reviewed-manifest.ts\` allows, extracted from the pinned SDK declarations
// at build time. Server-directed methods are present for completeness; the
// runtime validates inbound notifications against hand-written schemas. An
// absent method has no binding and cannot be dispatched.

/** A JSON Schema document, as this generator emits it. */
export type JsonSchemaDocument =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonSchemaDocument>
  | { readonly [key: string]: JsonSchemaDocument }

/** Every schema this generator emits has an object root. */
export type JsonSchemaObject = { readonly [key: string]: JsonSchemaDocument }

export interface GeneratedCodec {
  readonly method: string
  readonly direction: "request" | "notification" | "server_request"
  readonly served: boolean
  readonly params: JsonSchemaObject
  readonly result: JsonSchemaObject
}

/** Reviewed codecs: ${String(codecs.length)} methods. */
export const GENERATED_CODECS: ReadonlyArray<GeneratedCodec> = [
${codecRows}
]
`

const formatted = await format(OUTPUT, sourceText, { printWidth: 100, semi: false })

if (formatted.errors.length > 0) {
  fail("oxfmt failed: " + JSON.stringify(formatted.errors))
}

const check = process.argv.includes("--check")

if (check) {
  const existing = (() => {
    try {
      return readFileSync(OUTPUT, "utf8")
    } catch {
      return ""
    }
  })()

  if (existing !== formatted.code) {
    process.stderr.write(
      "extract-dialect: " + OUTPUT + " is out of date; run the extractor without --check\n",
    )
    process.exit(1)
  }

  process.stdout.write(
    "extract-dialect: pins verified, " +
      OUTPUT +
      " is current (" +
      String(codecs.length) +
      " codecs)\n",
  )
} else {
  writeFileSync(OUTPUT, formatted.code)
  process.stdout.write(
    "extract-dialect: wrote " + OUTPUT + " (" + String(codecs.length) + " codecs)\n",
  )
}
