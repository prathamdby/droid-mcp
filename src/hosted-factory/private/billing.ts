/**
 * Billing operations: subscription token rate-limit windows and the overage
 * preference. These live on the CLI `/api` routes of the same hosted origin,
 * not under `/api/v0`.
 */
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  hostedOperation,
  hostedTransport,
  idempotentWriteAnnotations,
  jsonOutcome,
  readOnlyAnnotations,
  schemaOf,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"

const BILLING_TARGET: TargetRef = { kind: "hosted", id: "billing" }

/** Builds the billing operation binding thunks against one validated installation. */
export const billingBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  type EmptyInput = Readonly<Record<string, never>>

  const getBillingLimits: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_billing_limits",
    description:
      "Read the subscription token rate-limit windows (`/limits`: Standard and Droid Core " +
      "5-hour, weekly, and monthly `usedPercent`, `windowEnd`, and `secondsRemaining`), " +
      "`extraUsageBalanceCents`, `extraUsageAllowed`, `canManageOverage`, and " +
      "`overagePreference`.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(Schema.Struct({}), "arguments must be an empty object"),
    target: () => BILLING_TARGET,
    perform: () =>
      jsonOutcome(transport, "rest_get_billing_limits", {
        method: "GET",
        path: "/api/billing/limits",
        query: [],
      }),
  })

  interface SetOverageInput {
    readonly body: {
      readonly overagePreference: "droidCore" | "extraUsage"
    }
  }

  const setOveragePreference: Definition<SetOverageInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_set_billing_overage_preference",
    description:
      "Set the subscription overage preference (`/limits`) to `droidCore` or `extraUsage` " +
      "for turns after Standard token rate limits reach 100%; requires `canManageOverage`.",
    inputSchema: schemaOf({ body: { type: "object" } }),
    annotations: idempotentWriteAnnotations,
    effect: "write",
    replay: "no_retry",
    demand: () => ({ effect: "configure" }),
    decode: checkedDecode(
      Schema.Struct({
        body: Schema.Struct({
          overagePreference: Schema.Literals(["droidCore", "extraUsage"]),
        }),
      }),
      "arguments do not match the schema",
    ),
    target: () => BILLING_TARGET,
    perform: (input) =>
      jsonOutcome(transport, "rest_set_billing_overage_preference", {
        method: "POST",
        path: "/api/organization/subscription/set-overage-preference",
        query: [],
        body: { overagePreference: input.body.overagePreference },
      }),
  })

  return [binderOf(getBillingLimits), binderOf(setOveragePreference)]
}
