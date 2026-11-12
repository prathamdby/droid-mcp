/**
 * Generates `src/generated/surface.ts` from the Droid SDK's type declarations.
 *
 * The SDK declares one Zod request schema per wire method. Each declaration is
 * a `ZodObject<Shape, …>` whose `Shape` carries the method literal and the
 * params schema reference. This script reads those declarations with the
 * TypeScript compiler API and converts the Zod types back into JSON Schema
 * 2020-12 documents, which `effect/SchemaRepresentation` turns into Effect
 * schemas at runtime.
 *
 * Run `pnpm codegen` to write the file, `pnpm codegen:check` to fail on drift.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { Schema } from "effect"
import { format } from "oxfmt"
import ts from "typescript"

const require = createRequire(import.meta.url)

/** A JSON Schema document, as far as this generator produces one. */
type JsonSchema =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonSchema>
  | { readonly [key: string]: JsonSchema }

interface WireEntry {
  readonly tool: string
  readonly method: string
  readonly kind: "daemon" | "droid"
  readonly family: string
  readonly description: string
  readonly params: JsonSchema
  readonly result: JsonSchema
}

const OUTPUT = "src/generated/surface.ts"

/** Resolves the SDK's internal declaration file; the package exports only the entry. */
const declarationFile = (): string => {
  const entry = require.resolve("@factory/droid-sdk")
  const dist = dirname(entry)
  const name = readdirSync(dist).find((file) => /^index-.*\.d\.ts$/.test(file))

  if (name === undefined) throw new Error("no bundled declaration file next to " + entry)

  return join(dist, name)
}

const program = ts.createProgram([declarationFile()], {
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
})

const checker = program.getTypeChecker()
const source = program.getSourceFile(declarationFile())

if (source === undefined) throw new Error("declaration file did not load")

interface DeclarationEntry {
  kind: "variable" | "type" | "interface"
  node: ts.Node
  type?: ts.TypeNode
  members?: ReadonlyArray<ts.TypeElement>
}

const declarations = new Map<string, DeclarationEntry>()

for (const statement of source.statements) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const entry: DeclarationEntry = { kind: "variable", node: declaration }

      if (declaration.type !== undefined) entry.type = declaration.type
      declarations.set(declaration.name.text, entry)
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

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))

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

    node = node.typeArguments?.[0]
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
      wrapper !== undefined && TRANSPARENT_ZOD.has(wrapper)
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

/** Converts any type node. Zod constructors get a structural schema. */
const convertNode = (node: ts.TypeNode, context: ConvertContext): JsonSchema => {
  if (context.depth > MAX_DEPTH) return anySchema

  if (ts.isTypeLiteralNode(node)) return objectOfMembers(node.members, context)

  if (ts.isIntersectionTypeNode(node)) {
    return {
      allOf: node.types.map((part) => convertNode(part, context)),
    }
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

interface ParamsAndResult {
  readonly params: JsonSchema
  readonly result: JsonSchema
}

const paramsAndResult = (
  schemaName: string,
  method: string,
  members: ReadonlyArray<ts.TypeElement>,
): ParamsAndResult => {
  const context: ConvertContext = { seen: new Set([schemaName]), depth: 0 }
  let params: JsonSchema = { type: "object", properties: {}, additionalProperties: false }

  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue

    const key = member.name !== undefined ? member.name.getText(source) : ""

    if (key === "params") params = convertNode(member.type, context)
  }

  return { params: paramsRoot(params), result: resultOf(schemaName, method) }
}

const EMPTY_PARAMS: JsonSchema = { type: "object", properties: {}, additionalProperties: false }

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
 * MCP requires an object root. A union or intersection of objects merges into
 * one object: every property any branch declares, all optional, because the
 * daemon validates the combination it actually receives.
 */
const paramsRoot = (value: JsonSchema): JsonSchema => {
  if (!isRecord(value)) return EMPTY_PARAMS

  if (value.type === "object") return value

  const properties = new Map<string, JsonSchema>()

  for (const branch of objectBranches(value)) {
    if (!isRecord(branch) || branch.type !== "object") continue

    if (!isRecord(branch.properties)) continue

    for (const [name, field] of Object.entries(branch.properties)) {
      if (!properties.has(name)) properties.set(name, field)
    }
  }

  if (properties.size === 0) return EMPTY_PARAMS

  return {
    type: "object",
    properties: Object.fromEntries(properties),
    additionalProperties: false,
  }
}

const resultOf = (schemaName: string, method: string): JsonSchema => {
  const resultName = schemaName.replace(/RequestSchema$/, "ResultSchema")
  const resultEntry = declarations.get(resultName)
  const resultMembers = objectNodeOf(resultEntry?.type)

  if (resultMembers !== undefined) {
    return convertNode(resultMembers, { seen: new Set([resultName]), depth: 0 })
  }

  const result = convertReference(resultName, { seen: new Set(), depth: 0 })

  return result === anySchema ? anySchemaOf(method) : result
}

/** Result schema fallback: any object, with a note pointing at the wire method. */
const anySchemaOf = (method: string): JsonSchema => ({
  type: "object",
  additionalProperties: true,
  description: "Result of " + method + "; its shape is declared by the daemon.",
})

const familyOf = (method: string): string => {
  const segments = method.split(".")
  const rest = segments.slice(1)

  if (rest.length === 0) return "misc"

  return rest[0]
}

/**
 * Verbs that remove or discard state. Matched on the method's last segment
 * so `unarchive_session` is not `archive` and `list_skills` is not `kill`.
 */
const DESTRUCTIVE_VERBS = new Set(["delete", "remove", "kill", "uninstall", "archive", "discard"])

/**
 * Actions that delete or overwrite state without using those verbs.
 * `cleanup_worktree` can delete local and remote branches, including with
 * force. `execute_rewind` restores and deletes files. `git_push` publishes
 * commits to a shared remote. `write_workspace_file_content` replaces a
 * file. `write_terminal_data` types into a live shell. `apply_automation_config`,
 * `apply_user_preferences`, and `update_mcp_config` replace stored configuration.
 */
const DESTRUCTIVE_ACTIONS = new Set([
  "cleanup_worktree",
  "execute_rewind",
  "git_push",
  "write_workspace_file_content",
  "write_terminal_data",
  "apply_automation_config",
  "apply_user_preferences",
  "update_mcp_config",
])

const isDestructive = (method: string): boolean => {
  const action = method.slice(method.lastIndexOf(".") + 1)
  const separator = action.indexOf("_")
  const verb = separator === -1 ? action : action.slice(0, separator)

  if (DESTRUCTIVE_VERBS.has(verb)) return true

  return DESTRUCTIVE_ACTIONS.has(action)
}

/** `daemon.sf.delete_workstream` reads as "Sf delete workstream". */
const summaryOf = (method: string): string => {
  const words = method.split(".").slice(1).join(" ").replaceAll("_", " ")

  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The input schema already names every field, so the description carries the
 * action, the wire method, and the destructive warning only.
 */
const descriptionOf = (method: string): string => {
  const lines = [summaryOf(method) + " (SDK method " + method + ")."]

  if (isDestructive(method)) lines.push("Destructive; confirm before calling.")

  return lines.join(" ")
}

const entries: Array<WireEntry> = []

for (const [schemaName, entry] of declarations) {
  if (!schemaName.endsWith("RequestSchema") || entry.kind !== "variable") continue

  const members = objectMembers(objectNodeOf(entry.type))

  if (members.length === 0) continue

  let method: string | undefined

  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue

    const key = member.name !== undefined ? member.name.getText(source) : ""

    if (key === "method") method = zodLiteral(member.type)
  }

  if (method === undefined) continue

  if (!method.startsWith("daemon.") && !method.startsWith("droid.")) continue

  const converted = paramsAndResult(schemaName, method, members)

  entries.push({
    tool: method.replace(/\./g, "_"),
    method,
    kind: method.startsWith("daemon.") ? "daemon" : "droid",
    family: familyOf(method),
    description: descriptionOf(method),
    params: converted.params,
    result: converted.result,
  })
}

entries.sort((left, right) => (left.tool < right.tool ? -1 : 1))

const unique = new Map(entries.map((entry) => [entry.tool, entry]))

if (unique.size !== entries.length) throw new Error("duplicate tool names generated")

const sourceText = `// Generated by scripts/codegen.ts. Do not edit.
//
// Every measured wire method the SDK declares, with JSON Schema 2020-12
// documents for its params and result. \`src/tools/generated.ts\` turns each
// entry into one MCP tool.

/** A JSON Schema document as this generator emits it. */
export type JsonSchemaDocument =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonSchemaDocument>
  | { readonly [key: string]: JsonSchemaDocument }

/** Every schema this generator emits has an object root. */
export type JsonSchemaObject = { readonly [key: string]: JsonSchemaDocument }

export interface WireEntry {
  readonly tool: string
  readonly method: string
  readonly kind: "daemon" | "droid"
  readonly family: string
  readonly description: string
  readonly params: JsonSchemaObject
  readonly result: JsonSchemaObject
}

/** The SDK surface: ${entries.length} wire methods. */
export const SURFACE: ReadonlyArray<WireEntry> = ${JSON.stringify(entries, null, 2)}

export const SURFACE_COUNT = ${entries.length}
`

const formatted = await format(OUTPUT, sourceText, { printWidth: 100, semi: false })

if (formatted.errors.length > 0) {
  throw new Error("codegen: oxfmt failed: " + JSON.stringify(formatted.errors))
}

const file = formatted.code

const check = process.argv.includes("--check")

if (check) {
  const existing = (() => {
    try {
      return readFileSync(OUTPUT, "utf8")
    } catch {
      return ""
    }
  })()

  if (existing !== file) {
    process.stderr.write("codegen: " + OUTPUT + " is out of date; run pnpm codegen\n")
    process.exit(1)
  }

  process.stdout.write(
    "codegen: " + OUTPUT + " is current (" + String(entries.length) + " methods)\n",
  )
} else {
  writeFileSync(OUTPUT, file)
  process.stdout.write("codegen: wrote " + OUTPUT + " (" + String(entries.length) + " methods)\n")
}
