import { defineRule } from "@oxlint/plugins"

import { isInsideSrc } from "../shared/modules.ts"

/**
 * Rejects every `export *` form under `src/`. A wildcard export forwards
 * whatever names the target happens to carry — including names added later —
 * so the re-exporting module no longer controls its own interface. Parnas
 * requires each module's interface to reveal as little as possible, which
 * means every symbol crossing a module boundary is explicitly named.
 */
export const noExportStarRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `export *` under src/; every symbol crossing a module boundary must be explicitly named.",
    },
    messages: {
      exportStar:
        "Replace `export *` with explicit named exports. A wildcard forwards every present and future name of the target, so this module no longer controls its own interface.",
    },
  },
  createOnce(context) {
    // `context.filename` is per-file state under `createOnce`; read it lazily
    // inside the visitors rather than at registration time.
    return {
      ExportAllDeclaration(node) {
        if (!isInsideSrc(context.filename)) return
        context.report({ node, messageId: "exportStar" })
      },
    }
  },
})
