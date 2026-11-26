/**
 * Organization administration operations (`/api/v0/organization`): members,
 * credits limits, computer secrets and the enterprise-control change history.
 * Secret values carried by an update are declared per call so disclosure
 * scrubs them wherever they would reappear.
 */
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  destructiveAnnotations,
  hostedOperation,
  idempotentWriteAnnotations,
  jsonOutcome,
  hostedTransport,
  readOnlyAnnotations,
  schemaOf,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"
import { Cursor, firstIdProblem, HostedId, openStruct, PageLimit, queryEntries } from "./wire.ts"

const ORGANIZATION = "/api/v0/organization"
const LIMITS = ORGANIZATION + "/usage/limits"

const organizationTarget: TargetRef = { kind: "hosted", id: "organization" }

const CreditLimit = Schema.NullOr(Schema.Int).annotate({
  description: "Credits limit (upstream minimum 1,000,000), or null to remove it.",
})

const Role = Schema.Literals(["user", "manager", "owner"])

const GroupLimits = Schema.NonEmptyArray(
  openStruct({ groupId: Schema.NonEmptyString, limit: CreditLimit }),
).annotate({
  description: "Up to 100 { groupId, limit } entries, by directory group id.",
})

const UserLimits = Schema.NonEmptyArray(
  openStruct({ email: Schema.NonEmptyString, limit: CreditLimit }),
).annotate({
  description: "Up to 100 { email, limit } entries, by user email.",
})

const SecretUpserts = Schema.Array(
  openStruct({ key: Schema.NonEmptyString, value: Schema.NonEmptyString }),
).annotate({
  description:
    "Secrets to create or replace as { key, value }; `key` is an uppercase POSIX name. " +
    "Values are sent upstream and never echoed back.",
})

const SecretDeletes = Schema.Array(Schema.NonEmptyString).annotate({
  description: "Secret keys to delete.",
})

/** Builds the organization operation binding thunks against one validated installation. */
export const organizationBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  type EmptyInput = Readonly<Record<string, never>>

  const emptyDecode = checkedDecode(Schema.Struct({}), "arguments must be an empty object")

  interface PageInput {
    readonly limit?: number
    readonly cursor?: string
  }

  const pageInputSchema = Schema.Struct({
    limit: Schema.optionalKey(PageLimit),
    cursor: Schema.optionalKey(Cursor),
  })

  const pageInputJsonSchema = schemaOf({ limit: { type: "number" }, cursor: { type: "string" } })

  const pageQuery = (input: PageInput): ReadonlyArray<readonly [string, string]> =>
    queryEntries([
      ["limit", input.limit],
      ["cursor", input.cursor],
    ])

  const listOrganizationUsers: Definition<PageInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_organization_users",
    description:
      "List the organization's members. One call returns one page; pass " +
      "`pagination.nextCursor` as `cursor` for the next.",
    inputSchema: pageInputJsonSchema,
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(pageInputSchema, "arguments do not match the schema"),
    target: () => organizationTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_list_organization_users", {
        method: "GET",
        path: ORGANIZATION + "/users",
        query: pageQuery(input),
      }),
  })

  interface InviteUserInput {
    readonly body: {
      readonly email: string
      readonly role?: "user" | "manager" | "owner"
    }
  }

  const inviteOrganizationUser: Definition<InviteUserInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_invite_organization_user",
    description:
      "Invite `email` to the organization, optionally with a `role` (user by default). " +
      "Sends an invitation email. Destructive; confirm before calling.",
    inputSchema: schemaOf({ body: { type: "object" } }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        body: Schema.Struct({
          email: Schema.NonEmptyString,
          role: Schema.optionalKey(Role),
        }),
      }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["body.email", input.body.email]]),
    ),
    target: () => organizationTarget,
    perform: (input) => {
      const body: Schema.Json =
        input.body.role === undefined
          ? { email: input.body.email }
          : { email: input.body.email, role: input.body.role }

      return jsonOutcome(transport, "rest_invite_organization_user", {
        method: "POST",
        path: ORGANIZATION + "/users/invite",
        query: [],
        body,
      })
    },
  })

  interface RemoveUserInput {
    readonly email: string
  }

  const removeOrganizationUser: Definition<RemoveUserInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_remove_organization_user",
    description:
      "Remove the member `email` from the organization; it is sent as the `email` query " +
      "parameter. Returns { ok: true }. Destructive; confirm before calling.",
    inputSchema: schemaOf({ email: { type: "string" } }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({ email: HostedId }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["email", input.email]]),
    ),
    target: () => organizationTarget,
    perform: (input) =>
      jsonOutcome(
        transport,
        "rest_remove_organization_user",
        {
          method: "DELETE",
          path: ORGANIZATION + "/users",
          query: queryEntries([["email", input.email]]),
        },
        { emptyResponse: true },
      ),
  })

  const getOrganizationGlobalLimit: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_organization_global_limit",
    description: "Read the global per-user credits limit of the organization.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: emptyDecode,
    target: () => organizationTarget,
    perform: () =>
      jsonOutcome(transport, "rest_get_organization_global_limit", {
        method: "GET",
        path: LIMITS + "/global",
        query: [],
      }),
  })

  interface SetGlobalLimitInput {
    readonly body: {
      readonly limit: number | null
    }
  }

  const setOrganizationGlobalLimit: Definition<SetGlobalLimitInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_set_organization_global_limit",
      description:
        "Set the global per-user credits limit, which applies to every member without a group " +
        "or individual limit; `limit: null` removes it.",
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: idempotentWriteAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({ body: Schema.Struct({ limit: CreditLimit }) }),
        "arguments do not match the schema",
      ),
      target: () => organizationTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_set_organization_global_limit", {
          method: "PUT",
          path: LIMITS + "/global",
          query: [],
          body: { limit: input.body.limit },
        }),
    })

  const getOrganizationGroupLimits: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_organization_group_limits",
    description: "Read the per-member credits limits mapped to directory groups.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: emptyDecode,
    target: () => organizationTarget,
    perform: () =>
      jsonOutcome(transport, "rest_get_organization_group_limits", {
        method: "GET",
        path: LIMITS + "/groups",
        query: [],
      }),
  })

  interface SetGroupLimitsInput {
    readonly body: {
      readonly groups: ReadonlyArray<
        { readonly groupId: string; readonly limit: number | null } & {
          readonly [key: string]: Schema.Json
        }
      >
    }
  }

  const setOrganizationGroupLimits: Definition<SetGroupLimitsInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_set_organization_group_limits",
      description:
        "Set the per-member credits limit of each listed directory group; it applies to every " +
        "member of the group without an individual limit, and `limit: null` unmaps the group. " +
        "Returns the updated entries and per-group errors.",
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: idempotentWriteAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({ body: Schema.Struct({ groups: GroupLimits }) }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem(
            input.body.groups.map(
              (entry, index) =>
                ["body.groups[" + String(index) + "].groupId", entry.groupId] as const,
            ),
          ),
      ),
      target: () => organizationTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_set_organization_group_limits", {
          method: "PUT",
          path: LIMITS + "/groups",
          query: [],
          body: { groups: input.body.groups },
        }),
    })

  const getOrganizationUserLimits: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_organization_user_limits",
    description: "Read the global limit and the individual credits limit overrides.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: emptyDecode,
    target: () => organizationTarget,
    perform: () =>
      jsonOutcome(transport, "rest_get_organization_user_limits", {
        method: "GET",
        path: LIMITS + "/users",
        query: [],
      }),
  })

  interface SetUserLimitsInput {
    readonly body: {
      readonly users: ReadonlyArray<
        { readonly email: string; readonly limit: number | null } & {
          readonly [key: string]: Schema.Json
        }
      >
    }
  }

  const setOrganizationUserLimits: Definition<SetUserLimitsInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_set_organization_user_limits",
      description:
        "Set an individual credits limit for each listed member, overriding group and global " +
        "limits; `limit: null` removes the override. Returns the updated entries and per-user " +
        "errors.",
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: idempotentWriteAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({ body: Schema.Struct({ users: UserLimits }) }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem(
            input.body.users.map(
              (entry, index) => ["body.users[" + String(index) + "].email", entry.email] as const,
            ),
          ),
      ),
      target: () => organizationTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_set_organization_user_limits", {
          method: "PUT",
          path: LIMITS + "/users",
          query: [],
          body: { users: input.body.users },
        }),
    },
  )

  const listOrganizationComputerSecrets: Definition<EmptyInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_list_organization_computer_secrets",
      description:
        "List the names of the secrets injected into the organization's computers; values " +
        "are never returned.",
      inputSchema: schemaOf({}),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: emptyDecode,
      target: () => organizationTarget,
      perform: () =>
        jsonOutcome(transport, "rest_list_organization_computer_secrets", {
          method: "GET",
          path: ORGANIZATION + "/computer-secrets",
          query: [],
        }),
    },
  )

  interface UpdateSecretsInput {
    readonly body: {
      readonly upsert: ReadonlyArray<
        { readonly key: string; readonly value: string } & { readonly [key: string]: Schema.Json }
      >
      readonly delete: ReadonlyArray<string>
      readonly createOnly?: boolean
    }
  }

  const updateOrganizationComputerSecrets: Definition<UpdateSecretsInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_update_organization_computer_secrets",
      description:
        "Create or replace the secrets in `upsert` and delete the keys in `delete` (both " +
        "required, either may be empty); `createOnly: true` refuses to replace. Every " +
        "organization computer receives the change. Returns the remaining secret names. " +
        "Destructive; confirm before calling.",
      inputSchema: schemaOf({ body: { type: "object" } }),
      annotations: destructiveAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          body: Schema.Struct({
            upsert: SecretUpserts,
            delete: SecretDeletes,
            createOnly: Schema.optionalKey(Schema.Boolean),
          }),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ...input.body.upsert.map(
              (entry, index) => ["body.upsert[" + String(index) + "].key", entry.key] as const,
            ),
            ...input.body.delete.map(
              (key, index) => ["body.delete[" + String(index) + "]", key] as const,
            ),
          ]),
      ),
      target: () => organizationTarget,
      perform: (input) => {
        const body: Schema.Json =
          input.body.createOnly === undefined
            ? { upsert: input.body.upsert, delete: input.body.delete }
            : {
                upsert: input.body.upsert,
                delete: input.body.delete,
                createOnly: input.body.createOnly,
              }

        return jsonOutcome(transport, "rest_update_organization_computer_secrets", {
          method: "PATCH",
          path: ORGANIZATION + "/computer-secrets",
          query: [],
          body,
        })
      },
      sensitiveValues: (input) => input.body.upsert.map((entry) => entry.value),
    })

  const listOrganizationEnterpriseControlHistory: Definition<PageInput, HostedOutcome> =
    hostedOperation(ctx, {
      id: "rest_list_organization_enterprise_control_history",
      description:
        "List changes to the organization's enterprise controls, newest first. One call " +
        "returns one page; pass `pagination.nextCursor` as `cursor` for the next.",
      inputSchema: pageInputJsonSchema,
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(pageInputSchema, "arguments do not match the schema"),
      target: () => organizationTarget,
      perform: (input) =>
        jsonOutcome(transport, "rest_list_organization_enterprise_control_history", {
          method: "GET",
          path: ORGANIZATION + "/enterprise-controls/history",
          query: pageQuery(input),
        }),
    })

  return [
    binderOf(listOrganizationUsers),
    binderOf(inviteOrganizationUser),
    binderOf(removeOrganizationUser),
    binderOf(getOrganizationGlobalLimit),
    binderOf(setOrganizationGlobalLimit),
    binderOf(getOrganizationGroupLimits),
    binderOf(setOrganizationGroupLimits),
    binderOf(getOrganizationUserLimits),
    binderOf(setOrganizationUserLimits),
    binderOf(listOrganizationComputerSecrets),
    binderOf(updateOrganizationComputerSecrets),
    binderOf(listOrganizationEnterpriseControlHistory),
  ]
}
