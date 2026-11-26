import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { isModuleEntrypoint } from "../shared/modules.ts"

type Node = ESTree.Node
type TypeNode = ESTree.TSType

const MUTABLE_COLLECTIONS = new Set(["Array", "Map", "Set", "WeakMap", "WeakSet"])

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  )
}

function childNodes(node: Node): Array<Node> {
  const children: Array<Node> = []

  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "range" || key === "loc") continue
    const value = (node as unknown as Record<string, unknown>)[key]

    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) children.push(child)
      }
    } else if (isNode(value)) {
      children.push(value)
    }
  }

  return children
}

function keyName(key: ESTree.PropertyKey): string {
  if (key.type === "Identifier") return key.name
  if (key.type === "PrivateIdentifier") return "#" + key.name
  if (key.type === "Literal") return String(key.value)
  return "computed"
}

function patternName(pattern: ESTree.BindingPattern): string {
  if (pattern.type === "Identifier") return pattern.name
  return "destructured binding"
}

/**
 * Names the mutable collection a type node directly is, or null. A
 * `readonly T[]` array — a `TSTypeOperator` wrapping the `TSArrayType` — is
 * immutable for consumers, as are the `ReadonlyArray`/`ReadonlyMap`/
 * `ReadonlySet` references, so none of them count.
 */
function mutableCollectionShape(typeNode: TypeNode): string | null {
  if (typeNode.type === "TSTypeReference" && typeNode.typeName.type === "Identifier") {
    const name = typeNode.typeName.name
    return MUTABLE_COLLECTIONS.has(name) ? name + "<...>" : null
  }

  if (typeNode.type === "TSArrayType") {
    const parent = typeNode.parent
    if (
      parent.type === "TSTypeOperator" &&
      (parent as ESTree.TSTypeOperator).operator === "readonly" &&
      (parent as ESTree.TSTypeOperator).typeAnnotation === typeNode
    ) {
      return null
    }
    return "T[]"
  }

  return null
}

/**
 * Enforces Parnas Criterion 1 on every module's public entry: a data
 * structure, its accessing procedures and its modifying procedures are part
 * of a single module, never shared across modules. Exported `let`/`var`
 * bindings, mutable interface members, mutable public class fields and
 * mutable collection types would all hand consumers shared mutable state.
 *
 * Only type positions and signatures are scanned; function bodies and local
 * variables inside exported functions are implementation details and are
 * never flagged.
 */
export const noMutablePublicSurfaceRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow mutable state and mutable collection types in a module's public index.ts; exported surfaces must be readonly so no data structure is shared mutably across modules.",
    },
    messages: {
      mutableExport:
        'Exported `{{kind}}` binding "{{name}}" is mutable shared state. Export a const or an opaque accessor instead; a module\'s data must never be shared mutably across module boundaries.',
      mutableMember:
        'Exported type member "{{name}}" must be readonly. A mutable property in a public type hands every consumer a shared mutable container.',
      mutableField:
        'Public field "{{name}}" of an exported class must be readonly or private. A mutable public field exposes the module\'s internal state to every consumer.',
      mutableCollection:
        "Mutable collection type {{shape}} crosses the module boundary here. Use the readonly form (ReadonlyArray, readonly T[], ReadonlyMap, ReadonlySet) so consumers cannot mutate shared data.",
    },
  },
  createOnce(context) {
    // `context.filename` is per-file state under `createOnce`; check it lazily
    // inside the visitors rather than at registration time.
    const isEntry = (): boolean => isModuleEntrypoint(context.filename)

    /**
     * Deep scan of a pure-type subtree: mutable collection types and mutable
     * members of type literals. Everything in the subtree is a type position,
     * so runtime code is never reached. A node already flagged as a mutable
     * collection is not descended into — nested type arguments belong to the
     * same violation.
     */
    const scanTypeTree = (node: Node): void => {
      if (
        node.type === "TSTypeReference" ||
        node.type === "TSArrayType" ||
        node.type === "TSTypeOperator"
      ) {
        const shape = mutableCollectionShape(node as TypeNode)
        if (shape !== null) {
          context.report({ node, messageId: "mutableCollection", data: { shape } })
          return
        }
      }

      if (node.type === "TSPropertySignature") {
        const property = node as ESTree.TSPropertySignature
        if (!property.readonly) {
          context.report({
            node: property,
            messageId: "mutableMember",
            data: { name: keyName(property.key) },
          })
        }
      } else if (node.type === "TSIndexSignature") {
        const index = node as ESTree.TSIndexSignature
        if (!index.readonly) {
          context.report({
            node: index,
            messageId: "mutableMember",
            data: { name: "index signature" },
          })
        }
      }

      for (const child of childNodes(node)) {
        scanTypeTree(child)
      }
    }

    /** Scan a type annotation position, when present. */
    const scanAnnotation = (annotation: ESTree.TSTypeAnnotation | null | undefined): void => {
      if (annotation != null) scanTypeTree(annotation.typeAnnotation)
    }

    /** Scan the annotated patterns of a parameter list. */
    const scanParams = (params: ReadonlyArray<ESTree.ParamPattern>): void => {
      for (const param of params) {
        // Assignment patterns wrap the annotated pattern.
        const unwrapped = param.type === "AssignmentPattern" ? param.left : param
        if ("typeAnnotation" in unwrapped) {
          scanAnnotation(
            (unwrapped as { typeAnnotation?: ESTree.TSTypeAnnotation | null }).typeAnnotation,
          )
        }
      }
    }

    /** Scan a function type signature: parameters and the return annotation. */
    const scanSignature = (fn: {
      readonly returnType?: ESTree.TSTypeAnnotation | null
      readonly params: ReadonlyArray<ESTree.ParamPattern>
    }): void => {
      scanAnnotation(fn.returnType)
      scanParams(fn.params)
    }

    const scanClass = (classNode: ESTree.Class): void => {
      for (const element of classNode.body.body) {
        if (
          element.type === "PropertyDefinition" ||
          element.type === "TSAbstractPropertyDefinition"
        ) {
          const property = element as ESTree.PropertyDefinition
          const isPrivate =
            property.key.type === "PrivateIdentifier" || property.accessibility === "private"

          if (!isPrivate) {
            if (property.readonly !== true) {
              context.report({
                node: property,
                messageId: "mutableField",
                data: { name: keyName(property.key) },
              })
            }
            scanAnnotation(property.typeAnnotation)
          }
        } else if (
          element.type === "MethodDefinition" ||
          element.type === "TSAbstractMethodDefinition"
        ) {
          const method = element as ESTree.MethodDefinition
          const isPrivate =
            method.key.type === "PrivateIdentifier" || method.accessibility === "private"

          if (!isPrivate) {
            scanSignature(method.value)
          }
        } else if (element.type === "TSIndexSignature") {
          scanTypeTree(element)
        }
      }
    }

    const scanExportedDeclaration = (declaration: Node): void => {
      if (declaration.type === "VariableDeclaration") {
        const variable = declaration as ESTree.VariableDeclaration

        if (variable.kind === "let" || variable.kind === "var") {
          const first = variable.declarations[0]
          context.report({
            node: variable,
            messageId: "mutableExport",
            data: {
              kind: variable.kind,
              name: first === undefined ? "binding" : patternName(first.id),
            },
          })
        }

        for (const declarator of variable.declarations) {
          if ("typeAnnotation" in declarator.id) {
            scanAnnotation(declarator.id.typeAnnotation)
          }

          // An exported const arrow function's explicit annotations are part
          // of the public signature; its body is not scanned, so local
          // mutable temporaries inside the implementation stay legal.
          if (declarator.init !== null && declarator.init.type === "ArrowFunctionExpression") {
            scanSignature(declarator.init)
          }
        }
      } else if (declaration.type === "TSInterfaceDeclaration") {
        // The interface body is a pure-type subtree: every member signature,
        // nested type literal and heritage clause within it is public surface.
        scanTypeTree((declaration as ESTree.TSInterfaceDeclaration).body)
      } else if (declaration.type === "TSTypeAliasDeclaration") {
        scanTypeTree((declaration as ESTree.TSTypeAliasDeclaration).typeAnnotation)
      } else if (
        declaration.type === "ClassDeclaration" ||
        declaration.type === "ClassExpression"
      ) {
        scanClass(declaration as ESTree.Class)
      } else if (
        declaration.type === "FunctionDeclaration" ||
        declaration.type === "TSDeclareFunction"
      ) {
        scanSignature(declaration as ESTree.Function)
      }
    }

    return {
      ExportNamedDeclaration(node) {
        if (!isEntry()) return
        if (node.declaration !== null) scanExportedDeclaration(node.declaration)
      },
      ExportDefaultDeclaration(node) {
        if (!isEntry()) return
        const declaration = node.declaration
        if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
          scanClass(declaration)
        } else if (
          declaration.type === "FunctionDeclaration" ||
          declaration.type === "TSDeclareFunction"
        ) {
          scanSignature(declaration)
        } else if (declaration.type === "TSInterfaceDeclaration") {
          scanTypeTree(declaration.body)
        }
      },
    }
  },
})
