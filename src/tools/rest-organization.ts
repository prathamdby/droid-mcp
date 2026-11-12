import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { Cursor, DESTRUCTIVE, Id, PageLimit, openStruct, restDomain, restTool } from "./rest-kit.ts"
import type { RestDomain, RestParams } from "./rest-kit.ts"

/** Organization administration tools on the hosted API (`/api/v0/organization`). */

const ORGANIZATION = "/api/v0/organization"
const LIMITS = ORGANIZATION + "/usage/limits"

const CreditLimit = Schema.NullOr(Schema.Int).annotate({
  description: "Credits limit (upstream minimum 1,000,000), or null to remove it.",
})

const Role = Schema.Literals(["user", "manager", "owner"])

const GroupLimits = Schema.NonEmptyArray(openStruct({ groupId: Id, limit: CreditLimit })).annotate({
  description: "Up to 100 { groupId, limit } entries, by directory group id.",
})

const UserLimits = Schema.NonEmptyArray(openStruct({ email: Id, limit: CreditLimit })).annotate({
  description: "Up to 100 { email, limit } entries, by user email.",
})

const SecretUpserts = Schema.Array(openStruct({ key: Id, value: Id })).annotate({
  description:
    "Secrets to create or replace as { key, value }; `key` is an uppercase POSIX name. " +
    "Values are sent upstream and never echoed back.",
})

const SecretDeletes = Schema.Array(Id).annotate({ description: "Secret keys to delete." })

const UpsertValues = Schema.Struct({
  body: Schema.Struct({ upsert: Schema.Array(Schema.Struct({ value: Schema.String })) }),
})

/** The secret values a computer-secrets update carries, scrubbed from anything returned. */
const upsertValues = (params: RestParams): ReadonlyArray<string> =>
  Option.match(Schema.decodeUnknownOption(UpsertValues)(params), {
    onNone: () => [],
    onSome: (decoded) => decoded.body.upsert.map((entry) => entry.value),
  })

const PAGED = " One call returns one page; pass `pagination.nextCursor` as `cursor` for the next."

export const organizationTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_list_organization_users",
      operation: "listOrganizationUsers",
      description: "List the organization's members." + PAGED,
      method: "GET",
      path: ORGANIZATION + "/users",
      inputs: { limit: Schema.optionalKey(PageLimit), cursor: Schema.optionalKey(Cursor) },
      query: ["limit", "cursor"],
    }),
    restTool({
      name: "rest_invite_organization_user",
      operation: "inviteUser",
      description:
        "Invite `email` to the organization, optionally with a `role` (user by default). " +
        "Sends an invitation email. " +
        DESTRUCTIVE,
      method: "POST",
      path: ORGANIZATION + "/users/invite",
      body: { email: Id, role: Schema.optionalKey(Role) },
    }),
    restTool({
      name: "rest_remove_organization_user",
      operation: "removeUser",
      description:
        "Remove the member `email` from the organization; it is sent as the `email` query " +
        "parameter. Returns { ok: true }. " +
        DESTRUCTIVE,
      method: "DELETE",
      path: ORGANIZATION + "/users",
      inputs: { email: Id },
      query: ["email"],
      response: "empty",
    }),
    restTool({
      name: "rest_get_organization_global_limit",
      operation: "getGlobalLimit",
      description: "Read the global per-user credits limit of the organization.",
      method: "GET",
      path: LIMITS + "/global",
    }),
    restTool({
      name: "rest_set_organization_global_limit",
      operation: "setGlobalLimit",
      description:
        "Set the global per-user credits limit, which applies to every member without a group " +
        "or individual limit; `limit: null` removes it.",
      method: "PUT",
      path: LIMITS + "/global",
      body: { limit: CreditLimit },
    }),
    restTool({
      name: "rest_get_organization_group_limits",
      operation: "getGroupLimits",
      description: "Read the per-member credits limits mapped to directory groups.",
      method: "GET",
      path: LIMITS + "/groups",
    }),
    restTool({
      name: "rest_set_organization_group_limits",
      operation: "setGroupLimits",
      description:
        "Set the per-member credits limit of each listed directory group; it applies to every " +
        "member of the group without an individual limit, and `limit: null` unmaps the group. " +
        "Returns the updated entries and per-group errors.",
      method: "PUT",
      path: LIMITS + "/groups",
      body: { groups: GroupLimits },
    }),
    restTool({
      name: "rest_get_organization_user_limits",
      operation: "getUserLimits",
      description: "Read the global limit and the individual credits limit overrides.",
      method: "GET",
      path: LIMITS + "/users",
    }),
    restTool({
      name: "rest_set_organization_user_limits",
      operation: "setUserLimits",
      description:
        "Set an individual credits limit for each listed member, overriding group and global " +
        "limits; `limit: null` removes the override. Returns the updated entries and per-user " +
        "errors.",
      method: "PUT",
      path: LIMITS + "/users",
      body: { users: UserLimits },
    }),
    restTool({
      name: "rest_list_organization_computer_secrets",
      operation: "listOrganizationComputerSecrets",
      description:
        "List the names of the secrets injected into the organization's computers; values " +
        "are never returned.",
      method: "GET",
      path: ORGANIZATION + "/computer-secrets",
    }),
    restTool({
      name: "rest_update_organization_computer_secrets",
      operation: "updateOrganizationComputerSecrets",
      description:
        "Create or replace the secrets in `upsert` and delete the keys in `delete` (both " +
        "required, either may be empty); `createOnly: true` refuses to replace. Every " +
        "organization computer receives the change. Returns the remaining secret names. " +
        DESTRUCTIVE,
      method: "PATCH",
      path: ORGANIZATION + "/computer-secrets",
      body: {
        upsert: SecretUpserts,
        delete: SecretDeletes,
        createOnly: Schema.optionalKey(Schema.Boolean),
      },
      secrets: upsertValues,
    }),
    restTool({
      name: "rest_list_organization_enterprise_control_history",
      operation: "listEnterpriseControlChangeHistory",
      description: "List changes to the organization's enterprise controls, newest first." + PAGED,
      method: "GET",
      path: ORGANIZATION + "/enterprise-controls/history",
      inputs: { limit: Schema.optionalKey(PageLimit), cursor: Schema.optionalKey(Cursor) },
      query: ["limit", "cursor"],
    }),
  ])
