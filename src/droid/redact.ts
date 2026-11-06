import * as Predicate from "effect/Predicate"

import type { JsonValue } from "./protocol.ts"
import { REDACTED } from "./rest-http.ts"

/** Keys whose values never leave the server, at any depth. */
const SECRET_KEYS: ReadonlyArray<string> = [
  "authorization",
  "cookie",
  "password",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "privatekey",
]

/** Objects whose `value` member is a credential: a minted key, or a secret entry. */
const VALUE_PARENTS: ReadonlyArray<string> = ["apikey"]
const VALUE_ARRAYS: ReadonlyArray<string> = ["secrets", "upsert"]

const isSecretKey = (key: string): boolean => SECRET_KEYS.includes(key.toLowerCase())

const containsSecret = (text: string, secrets: ReadonlyArray<string>): boolean =>
  secrets.some((secret) => secret.length > 0 && text.includes(secret))

interface JsonObject {
  readonly [key: string]: JsonValue
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const withoutValue = (value: JsonValue, secrets: ReadonlyArray<string>): JsonValue =>
  isJsonObject(value) ? redactObject(value, secrets, true) : redactValue(value, secrets)

const redactObject = (
  value: JsonObject,
  secrets: ReadonlyArray<string>,
  dropValue: boolean,
): JsonValue => {
  const result: Record<string, JsonValue> = {}

  for (const [key, member] of Object.entries(value)) {
    if (isSecretKey(key)) continue

    if (dropValue && key === "value") continue

    const lower = key.toLowerCase()

    if (VALUE_PARENTS.includes(lower)) {
      result[key] = withoutValue(member, secrets)
    } else if (VALUE_ARRAYS.includes(lower) && Array.isArray(member)) {
      result[key] = member.map((entry) => withoutValue(entry, secrets))
    } else {
      result[key] = redactValue(member, secrets)
    }
  }

  return result
}

const redactValue = (value: JsonValue, secrets: ReadonlyArray<string>): JsonValue => {
  if (Predicate.isString(value)) return containsSecret(value, secrets) ? REDACTED : value

  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets))

  if (isJsonObject(value)) return redactObject(value, secrets, false)

  return value
}

/** Every `apiKey.value` string in a body, so a minted key echoed elsewhere is scrubbed too. */
const mintedValues = (value: JsonValue): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(mintedValues)

  if (!isJsonObject(value)) return []

  return Object.entries(value).flatMap(([key, member]) => {
    const own =
      VALUE_PARENTS.includes(key.toLowerCase()) &&
      isJsonObject(member) &&
      Predicate.isString(member.value)
        ? [member.value]
        : []

    return [...own, ...mintedValues(member)]
  })
}

/**
 * Drops credential fields and replaces any string that contains a configured
 * secret or a minted key value. Runs on every success body before it reaches a
 * client.
 */
export const redact = (value: JsonValue, secrets: ReadonlyArray<string>): JsonValue =>
  redactValue(value, [...secrets, ...mintedValues(value)])
