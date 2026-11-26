import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { classifyLocalSpecifier, moduleNameOf } from "../shared/modules.ts"

type ModuleDeclarationNode =
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration

/**
 * Reports a module specifier that reaches into another module's `private/`
 * interior or escapes the `src/` module root. Same-module relative imports —
 * including `./private/...` from the module's own `index.ts` and sibling
 * references between private files — are exactly the decomposition Parnas
 * requires, so they stay legal.
 */
export const noPrivateImportRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow imports and re-exports that reach into another module's private/ directory or escape the src/ module root; modules may only enter through their index.ts.",
    },
    messages: {
      privateImport:
        '"{{specifier}}" reaches into module "{{module}}"\'s private interior. Other modules may only enter through its public index.ts; private files hide the module\'s design decisions.',
      escapesRoot:
        '"{{specifier}}" escapes the src/ module root. Modules under src/ must reference only sibling modules through their public index.ts.',
    },
  },
  createOnce(context) {
    // `context.filename` is per-file state under `createOnce`; read it lazily
    // inside the visitors rather than at registration time.
    const filename = (): string => context.filename

    const check = (
      node: ESTree.Node,
      specifierNode: ESTree.StringLiteral | ESTree.Expression,
    ): void => {
      // Only files inside src/<module>/ participate in the decomposition.
      if (moduleNameOf(filename()) === null) return
      if (specifierNode.type !== "Literal" || typeof specifierNode.value !== "string") return
      const specifier = specifierNode.value
      const verdict = classifyLocalSpecifier(filename(), specifier)
      if (verdict === "cross_module_private") {
        context.report({
          node,
          messageId: "privateImport",
          data: { specifier, module: targetModuleName(specifier) },
        })
      } else if (verdict === "escapes_src") {
        context.report({ node, messageId: "escapesRoot", data: { specifier } })
      }
    }

    const checkDeclaration = (node: ModuleDeclarationNode): void => {
      const source = node.source
      if (source !== null) check(node, source)
    }

    return {
      ImportDeclaration: checkDeclaration,
      ExportNamedDeclaration(node) {
        // `export { x }` without a source carries no module reference.
        if (node.source !== null) checkDeclaration(node)
      },
      ExportAllDeclaration: checkDeclaration,
      ImportExpression(node) {
        check(node, node.source)
      },
    }
  },
})

/** Extract `other` from a specifier like `../other/private/thing.ts`. */
function targetModuleName(specifier: string): string {
  const segments = specifier
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
  return segments[0] ?? specifier
}
