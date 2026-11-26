import { eslintCompatPlugin } from "@oxlint/plugins"

import { noAmbientProcessIoRule } from "./rules/no-ambient-process-io.ts"
import { noExportStarRule } from "./rules/no-export-star.ts"
import { noMutablePublicSurfaceRule } from "./rules/no-mutable-public-surface.ts"
import { noPrivateImportRule } from "./rules/no-private-import.ts"

/** Oxlint rules enforcing the Parnas (1972) information-hiding decomposition of `src/`. */
const modularityPlugin = eslintCompatPlugin({
  meta: { name: "modularity" },
  rules: {
    "no-private-import": noPrivateImportRule,
    "no-export-star": noExportStarRule,
    "no-mutable-public-surface": noMutablePublicSurfaceRule,
    "no-ambient-process-io": noAmbientProcessIoRule,
  },
})

export default modularityPlugin
