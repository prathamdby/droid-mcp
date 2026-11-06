import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { JsonValue } from "../droid/protocol.ts"
import type { RestResult } from "../droid/rest-service.ts"
import { DESTRUCTIVE, Id, JsonBody, restDomain, restTool } from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"

/** Service accounts and their API keys on the hosted API (`/api/v0/service-accounts`). */

const ACCOUNT = "/api/v0/service-accounts/{serviceAccountId}"
const KEYS = ACCOUNT + "/api-keys"

export const KEY_NOTICE =
  "The one-time key value was not exposed and cannot be recovered through this tool."

const Status = Schema.Literals(["active", "inactive"])

const ExpiresAt = Schema.Int.annotate({
  description: "Expiry as Unix epoch milliseconds.",
})

const GracePeriodMinutes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })).annotate(
  {
    description:
      "Minutes (0–10) the old key stays valid after rotation; omitted or 0 revokes it at once.",
  },
)

/** `RestService` already dropped `apiKey.value`; this says so in the result. */
const withKeyNotice = (json: RestResult): JsonValue =>
  Option.match(Schema.decodeUnknownOption(JsonBody)(json), {
    onNone: () => ({ ok: true, notice: KEY_NOTICE }),
    onSome: (object) => ({ ...object, notice: KEY_NOTICE }),
  })

export const serviceAccountTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_list_service_accounts",
      operation: "listServiceAccounts",
      description: "List the organization's service accounts.",
      method: "GET",
      path: "/api/v0/service-accounts",
    }),
    restTool({
      name: "rest_create_service_account",
      operation: "createServiceAccount",
      description:
        "Create a service account from `name` and `status` (active or inactive), with an " +
        "optional `description`. It has no API key until rest_create_service_account_api_key.",
      method: "POST",
      path: "/api/v0/service-accounts",
      body: { name: Id, status: Status, description: Schema.optional(Schema.String) },
    }),
    restTool({
      name: "rest_get_service_account",
      operation: "getServiceAccount",
      description: "Read one service account's status and metadata.",
      method: "GET",
      path: ACCOUNT,
      inputs: { serviceAccountId: Id },
    }),
    restTool({
      name: "rest_update_service_account",
      operation: "updateServiceAccount",
      description:
        "Change a service account's `description` or `status`; an inactive account's keys " +
        "stop working.",
      method: "PATCH",
      path: ACCOUNT,
      inputs: { serviceAccountId: Id },
      body: { description: Schema.optional(Schema.String), status: Schema.optional(Status) },
    }),
    restTool({
      name: "rest_delete_service_account",
      operation: "deleteServiceAccount",
      description: "Delete a service account and disable its keys. " + DESTRUCTIVE,
      method: "DELETE",
      path: ACCOUNT,
      inputs: { serviceAccountId: Id },
    }),
    restTool({
      name: "rest_list_service_account_api_keys",
      operation: "listServiceAccountApiKeys",
      description:
        "List a service account's API keys as metadata: id, name, fingerprint, expiry, and " +
        "revocation. Key values are never returned.",
      method: "GET",
      path: KEYS,
      inputs: { serviceAccountId: Id },
    }),
    restTool({
      name: "rest_create_service_account_api_key",
      operation: "createServiceAccountApiKey",
      description:
        "Mint an API key named `name` for a service account, optionally expiring at " +
        "`expiresAt` (epoch ms). Returns its metadata and a notice; the one-time value is " +
        "dropped, so hand out keys from the Factory app when a value is needed. " +
        DESTRUCTIVE,
      method: "POST",
      path: KEYS,
      inputs: { serviceAccountId: Id },
      body: { name: Id, expiresAt: Schema.optional(ExpiresAt) },
      result: withKeyNotice,
    }),
    restTool({
      name: "rest_rotate_service_account_api_key",
      operation: "rotateServiceAccountApiKey",
      description:
        "Replace an API key with a new one. `body` is optional: `expiresAt` sets the new " +
        "key's expiry and `gracePeriodMinutes` keeps the old key valid; without them the old " +
        "key is revoked at once. Returns the new key's metadata and a notice; " +
        "the one-time value is dropped. " +
        DESTRUCTIVE,
      method: "POST",
      path: KEYS + "/{keyId}/rotate",
      inputs: { serviceAccountId: Id, keyId: Id },
      body: {
        expiresAt: Schema.optional(ExpiresAt),
        gracePeriodMinutes: Schema.optional(GracePeriodMinutes),
      },
      bodyOptional: true,
      result: withKeyNotice,
    }),
    restTool({
      name: "rest_revoke_service_account_api_key",
      operation: "revokeServiceAccountApiKey",
      description:
        "Revoke an API key so it stops working at once. Returns { ok: true }. " + DESTRUCTIVE,
      method: "POST",
      path: KEYS + "/{keyId}/revoke",
      inputs: { serviceAccountId: Id, keyId: Id },
      response: "empty",
    }),
  ])
