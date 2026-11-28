/**
 * Service accounts and their API keys (`/api/v0/service-accounts`). Minted
 * one-time key values are classified through disclosure's minted-value
 * handling — the `apiKey.value` member is dropped and its string is scrubbed
 * wherever it reappears — and the reply gains a notice that the value was
 * never exposed.
 */
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  destructiveAnnotations,
  destructiveIdempotentAnnotations,
  hostedOperation,
  jsonOutcome,
  hostedTransport,
  readOnlyAnnotations,
  schemaOf,
  join,
  segment,
  writeAnnotations,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"
import { firstIdProblem, HostedId } from "./wire.ts"

const ACCOUNTS = "/api/v0/service-accounts"

const accountPath = (serviceAccountId: string): string | undefined => {
  const encoded = segment(serviceAccountId)

  return encoded === undefined ? undefined : ACCOUNTS + "/" + encoded
}

const keysPath = (serviceAccountId: string): string | undefined => {
  const account = accountPath(serviceAccountId)

  return account === undefined ? undefined : account + "/api-keys"
}

const accountsTarget: TargetRef = { kind: "hosted", id: "service-accounts" }

const accountTarget = (serviceAccountId: string): TargetRef => ({
  kind: "hosted",
  id: "service-account",
  scope: serviceAccountId,
})

const Status = Schema.Literals(["active", "inactive"])

const ExpiresAt = Schema.Int.annotate({ description: "Expiry as Unix epoch milliseconds." })

const GracePeriodMinutes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })).annotate(
  {
    description:
      "Minutes (0-10) the old key stays valid after rotation; omitted or 0 revokes it at once.",
  },
)

/** Builds the service-account operation binding thunks against one validated installation. */
export const serviceAccountBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  type EmptyInput = Readonly<Record<string, never>>

  const listServiceAccounts: Definition<EmptyInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_service_accounts",
    description: "List the organization's service accounts.",
    inputSchema: schemaOf({}),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(Schema.Struct({}), "arguments must be an empty object"),
    target: () => accountsTarget,
    perform: () =>
      jsonOutcome(transport, "rest_list_service_accounts", {
        method: "GET",
        path: ACCOUNTS,
        query: [],
      }),
  })

  interface CreateAccountInput {
    readonly body: {
      readonly name: string
      readonly status: "active" | "inactive"
      readonly description?: string
    }
  }

  const createServiceAccount: Definition<CreateAccountInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_create_service_account",
    description:
      "Create a service account from `name` and `status` (active or inactive), with an " +
      "optional `description`. It has no API key until rest_create_service_account_api_key.",
    inputSchema: schemaOf({ body: { type: "object" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        body: Schema.Struct({
          name: Schema.NonEmptyString,
          status: Status,
          description: Schema.optionalKey(Schema.String),
        }),
      }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["body.name", input.body.name]]),
    ),
    target: () => accountsTarget,
    perform: (input) => {
      const body: Schema.Json =
        input.body.description === undefined
          ? { name: input.body.name, status: input.body.status }
          : {
              name: input.body.name,
              status: input.body.status,
              description: input.body.description,
            }

      return jsonOutcome(transport, "rest_create_service_account", {
        method: "POST",
        path: ACCOUNTS,
        query: [],
        body,
      })
    },
  })

  interface AccountInput {
    readonly serviceAccountId: string
  }

  const accountInputSchema = Schema.Struct({ serviceAccountId: HostedId })

  const accountCheck = (input: AccountInput): string | undefined =>
    firstIdProblem([["serviceAccountId", input.serviceAccountId]])

  const getServiceAccount: Definition<AccountInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_service_account",
    description: "Read one service account's status and metadata.",
    inputSchema: schemaOf({ serviceAccountId: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(accountInputSchema, "arguments do not match the schema", accountCheck),
    target: (input) => accountTarget(input.serviceAccountId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_service_account", {
        method: "GET",
        path: accountPath(input.serviceAccountId),
        query: [],
      }),
  })

  interface UpdateAccountInput extends AccountInput {
    readonly body: {
      readonly description?: string
      readonly status?: "active" | "inactive"
    }
  }

  const updateServiceAccount: Definition<UpdateAccountInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_update_service_account",
    description:
      "Change a service account's `description` or `status`; an inactive account's keys " +
      "stop working.",
    inputSchema: schemaOf({ serviceAccountId: { type: "string" }, body: { type: "object" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        serviceAccountId: HostedId,
        body: Schema.Struct({
          description: Schema.optionalKey(Schema.String),
          status: Schema.optionalKey(Status),
        }),
      }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["serviceAccountId", input.serviceAccountId]]),
    ),
    target: (input) => accountTarget(input.serviceAccountId),
    perform: (input) => {
      const entries: Array<readonly [string, Schema.Json]> = []

      if (input.body.description !== undefined) {
        entries.push(["description", input.body.description])
      }

      if (input.body.status !== undefined) entries.push(["status", input.body.status])

      return jsonOutcome(transport, "rest_update_service_account", {
        method: "PATCH",
        path: accountPath(input.serviceAccountId),
        query: [],
        body: Object.fromEntries(entries),
      })
    },
  })

  const deleteServiceAccount: Definition<AccountInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_delete_service_account",
    description:
      "Delete a service account and disable its keys. Destructive; confirm before calling.",
    inputSchema: schemaOf({ serviceAccountId: { type: "string" } }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(accountInputSchema, "arguments do not match the schema", accountCheck),
    target: (input) => accountTarget(input.serviceAccountId),
    perform: (input) =>
      jsonOutcome(transport, "rest_delete_service_account", {
        method: "DELETE",
        path: accountPath(input.serviceAccountId),
        query: [],
      }),
  })

  const listServiceAccountApiKeys: Definition<AccountInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_service_account_api_keys",
    description:
      "List a service account's API keys as metadata: id, name, fingerprint, expiry, and " +
      "revocation. Key values are never returned.",
    inputSchema: schemaOf({ serviceAccountId: { type: "string" } }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(accountInputSchema, "arguments do not match the schema", accountCheck),
    target: (input) => accountTarget(input.serviceAccountId),
    perform: (input) =>
      jsonOutcome(transport, "rest_list_service_account_api_keys", {
        method: "GET",
        path: keysPath(input.serviceAccountId),
        query: [],
      }),
  })

  interface CreateKeyInput extends AccountInput {
    readonly body: {
      readonly name: string
      readonly expiresAt?: number
    }
  }

  const createServiceAccountApiKey: Definition<CreateKeyInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_create_service_account_api_key",
      description:
        "Mint an API key named `name` for a service account, optionally expiring at " +
        "`expiresAt` (epoch ms). Returns its metadata and a notice; the one-time value is " +
        "dropped, so hand out keys from the hosted app when a value is needed. " +
        "Destructive; confirm before calling.",
      inputSchema: schemaOf({ serviceAccountId: { type: "string" }, body: { type: "object" } }),
      annotations: destructiveAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          serviceAccountId: HostedId,
          body: Schema.Struct({
            name: Schema.NonEmptyString,
            expiresAt: Schema.optionalKey(ExpiresAt),
          }),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["serviceAccountId", input.serviceAccountId],
            ["body.name", input.body.name],
          ]),
      ),
      target: (input) => accountTarget(input.serviceAccountId),
      perform: (input) => {
        const body: Schema.Json =
          input.body.expiresAt === undefined
            ? { name: input.body.name }
            : { name: input.body.name, expiresAt: input.body.expiresAt }

        return jsonOutcome(transport, "rest_create_service_account_api_key", {
          method: "POST",
          path: keysPath(input.serviceAccountId),
          query: [],
          body,
        })
      },
      withKeyNotice: true,
    },
  )

  interface RotateKeyInput extends AccountInput {
    readonly keyId: string
    readonly body?: {
      readonly expiresAt?: number
      readonly gracePeriodMinutes?: number
    }
  }

  const rotateServiceAccountApiKey: Definition<RotateKeyInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_rotate_service_account_api_key",
      description:
        "Replace an API key with a new one. `body` is optional: `expiresAt` sets the new " +
        "key's expiry and `gracePeriodMinutes` keeps the old key valid; without them the old " +
        "key is revoked at once. Returns the new key's metadata and a notice; " +
        "the one-time value is dropped. Destructive; confirm before calling.",
      inputSchema: schemaOf({
        serviceAccountId: { type: "string" },
        keyId: { type: "string" },
        body: { type: "object" },
      }),
      annotations: destructiveAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          serviceAccountId: HostedId,
          keyId: HostedId,
          body: Schema.optionalKey(
            Schema.Struct({
              expiresAt: Schema.optionalKey(ExpiresAt),
              gracePeriodMinutes: Schema.optionalKey(GracePeriodMinutes),
            }),
          ),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["serviceAccountId", input.serviceAccountId],
            ["keyId", input.keyId],
          ]),
      ),
      target: (input) => accountTarget(input.serviceAccountId),
      perform: (input) => {
        const entries: Array<readonly [string, Schema.Json]> = []

        if (input.body?.expiresAt !== undefined) entries.push(["expiresAt", input.body.expiresAt])

        if (input.body?.gracePeriodMinutes !== undefined) {
          entries.push(["gracePeriodMinutes", input.body.gracePeriodMinutes])
        }

        const body: Schema.Json | undefined =
          entries.length === 0 ? undefined : Object.fromEntries(entries)

        return jsonOutcome(transport, "rest_rotate_service_account_api_key", {
          method: "POST",
          path: join(keysPath(input.serviceAccountId), "/", segment(input.keyId), "/rotate"),
          query: [],
          body,
        })
      },
      withKeyNotice: true,
    },
  )

  interface RevokeKeyInput extends AccountInput {
    readonly keyId: string
  }

  const revokeServiceAccountApiKey: Definition<RevokeKeyInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_revoke_service_account_api_key",
      description:
        "Revoke an API key so it stops working at once. Destructive; confirm before calling.",
      inputSchema: schemaOf({ serviceAccountId: { type: "string" }, keyId: { type: "string" } }),
      annotations: destructiveIdempotentAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({ serviceAccountId: HostedId, keyId: HostedId }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["serviceAccountId", input.serviceAccountId],
            ["keyId", input.keyId],
          ]),
      ),
      target: (input) => accountTarget(input.serviceAccountId),
      perform: (input) =>
        jsonOutcome(
          transport,
          "rest_revoke_service_account_api_key",
          {
            method: "POST",
            path: join(keysPath(input.serviceAccountId), "/", segment(input.keyId), "/revoke"),
            query: [],
          },
          { emptyResponse: true },
        ),
    },
  )

  return [
    binderOf(listServiceAccounts),
    binderOf(createServiceAccount),
    binderOf(getServiceAccount),
    binderOf(updateServiceAccount),
    binderOf(deleteServiceAccount),
    binderOf(listServiceAccountApiKeys),
    binderOf(createServiceAccountApiKey),
    binderOf(rotateServiceAccountApiKey),
    binderOf(revokeServiceAccountApiKey),
  ]
}
