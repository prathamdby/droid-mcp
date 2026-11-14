import * as Schema from "effect/Schema"

import { restDomain, restTool } from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"

/** Subscription token rate-limit windows and overage preference (`/limits` in Droid CLI). */

const OveragePreference = Schema.Literals(["droidCore", "extraUsage"]).annotate({
  description:
    "`droidCore` routes exhausted Standard usage to Droid Core; `extraUsage` draws from " +
    "prepaid Extra Usage balance.",
})

export const billingTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_get_billing_limits",
      operation: "getBillingLimits",
      description:
        "Read the subscription token rate-limit windows (`/limits`: Standard and Droid Core " +
        "5-hour, weekly, and monthly `usedPercent`, `windowEnd`, and `secondsRemaining`), " +
        "`extraUsageBalanceCents`, `extraUsageAllowed`, `canManageOverage`, and " +
        "`overagePreference`.",
      method: "GET",
      path: "/api/billing/limits",
    }),
    restTool({
      name: "rest_set_billing_overage_preference",
      operation: "setOveragePreference",
      description:
        "Set the subscription overage preference (`/limits`) to `droidCore` or `extraUsage` " +
        "for turns after Standard token rate limits reach 100%; requires `canManageOverage`.",
      method: "POST",
      path: "/api/organization/subscription/set-overage-preference",
      body: { overagePreference: OveragePreference },
    }),
  ])
