import { defineRule } from "@oxlint/plugins"
import type { ESTree, SourceCode } from "@oxlint/plugins"

import { isInsideProducts, isInsideSrc } from "../shared/modules.ts"
import { resolveVariable } from "../shared/scope.ts"

/**
 * Ambient process surfaces hidden inside the product composition root:
 * process configuration (`env`), command-line shape (`argv`), stdio streams
 * and lifecycle control (`exit`, `exitCode`). Everything below `src/products`
 * must receive these through explicit construction parameters instead.
 */
const AMBIENT_PROPERTIES = new Set(["env", "argv", "stdin", "stdout", "stderr", "exit", "exitCode"])

type MemberAccess = ESTree.StaticMemberExpression | ESTree.ComputedMemberExpression

/** Narrow out private-field access (`obj.#field`), which is never `process` state. */
function isMemberAccess(node: ESTree.MemberExpression): node is MemberAccess {
  return node.property.type !== "PrivateIdentifier"
}

function propertyNameOf(node: MemberAccess): string | null {
  if (node.computed) {
    const property = node.property
    if (property.type === "Literal" && typeof property.value === "string") return property.value
    return null
  }

  return node.property.type === "Identifier" ? node.property.name : null
}

function isUnshadowedProcess(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (node.type !== "Identifier") return false
  if (node.name !== "process") return false
  if (sourceCode.isGlobalReference(node)) return true

  // A locally bound `process` (parameter, variable, import) is explicit
  // dependency injection, not ambient access — exactly what this rule wants.
  const variable = resolveVariable(sourceCode, node as ESTree.IdentifierReference)
  return variable === null || variable.defs.length === 0
}

/**
 * Keeps ambient process configuration, stdio and lifecycle control inside
 * `src/products/`, the product composition root. Modules below it must
 * receive environment entries, streams and exit control as constructor
 * inputs, so they stay testable and free of hidden global coupling.
 * Non-ambient runtime facts (`process.pid`, `process.platform`,
 * `process.execPath`, `process.kill`) carry no configuration or I/O surface
 * and remain legal everywhere.
 */
export const noAmbientProcessIoRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ambient process.env/argv/stdio/exit access below src/products/; pass configuration and streams in explicitly from the product composition root.",
    },
    messages: {
      ambientIo:
        "process.{{property}} is ambient process state and may only be read inside src/products/. Pass it in as an explicit option so this module stays free of hidden global coupling.",
    },
  },
  createOnce(context) {
    // `context.filename` is per-file state under `createOnce`; read it lazily
    // inside the visitors rather than at registration time.
    const inScope = (): boolean =>
      isInsideSrc(context.filename) && !isInsideProducts(context.filename)

    return {
      MemberExpression(node) {
        if (!inScope()) return
        if (!isMemberAccess(node)) return
        checkMember(context.sourceCode, node, context)
      },
    }

    function checkMember(
      sourceCode: SourceCode,
      node: MemberAccess,
      ruleContext: typeof context,
    ): void {
      if (!isUnshadowedProcess(sourceCode, node.object)) return

      const property = propertyNameOf(node)
      if (property === null || !AMBIENT_PROPERTIES.has(property)) return

      ruleContext.report({ node, messageId: "ambientIo", data: { property } })
    }
  },
})
