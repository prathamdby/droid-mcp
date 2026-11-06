import * as Predicate from "effect/Predicate"

import type { JsonFields, JsonValue } from "./protocol.ts"
import { decodeJsonText, scrubSecrets } from "./rest-http.ts"

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

const isJsonObject = (value: JsonValue): value is JsonFields =>
  Predicate.isObject(value) && !Array.isArray(value)

const withoutValue = (value: JsonValue, secrets: ReadonlyArray<string>): JsonValue =>
  isJsonObject(value) ? redactObject(value, secrets, true) : redactWith(value, secrets)

/**
 * Member names are scrubbed like values. When a scrubbed name repeats one
 * already kept, the later member is dropped, so neither value is overwritten.
 */
const redactObject = (
  value: JsonFields,
  secrets: ReadonlyArray<string>,
  dropValue: boolean,
): JsonFields => {
  const members: Array<readonly [string, JsonValue]> = []
  const kept = new Set<string>()

  for (const [key, member] of Object.entries(value)) {
    if (isSecretKey(key)) continue

    if (dropValue && key === "value") continue

    const name = scrubSecrets(key, secrets)

    if (kept.has(name)) continue

    kept.add(name)

    const lower = key.toLowerCase()

    if (VALUE_PARENTS.includes(lower)) {
      members.push([name, withoutValue(member, secrets)])
    } else if (VALUE_ARRAYS.includes(lower) && Array.isArray(member)) {
      members.push([name, member.map((entry) => withoutValue(entry, secrets))])
    } else {
      members.push([name, redactWith(member, secrets)])
    }
  }

  // `fromEntries` defines own members, so a `__proto__` member stays data.
  return Object.fromEntries(members)
}

/**
 * Drops credential fields and replaces each occurrence of `secrets` in
 * strings and member names. `secrets` must already include minted values;
 * see `protectedValues`.
 */
export const redactWith = (value: JsonValue, secrets: ReadonlyArray<string>): JsonValue => {
  if (Predicate.isString(value)) return scrubSecrets(value, secrets)

  if (Array.isArray(value)) return value.map((entry) => redactWith(entry, secrets))

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

/** `secrets` plus every key value minted in `value`, which may be absent or not JSON. */
export const protectedValues = (
  value: JsonValue | undefined,
  secrets: ReadonlyArray<string>,
): ReadonlyArray<string> => (value === undefined ? secrets : [...secrets, ...mintedValues(value)])

/**
 * Drops credential fields and replaces each occurrence of a configured secret
 * or a minted key value inside strings and member names. Runs on every
 * success body before it reaches a client.
 */
export const redact = (value: JsonValue, secrets: ReadonlyArray<string>): JsonValue =>
  redactWith(value, protectedValues(value, secrets))

const RECORDS_FIELD = "contentJsonl"

const jsonlLines = (text: string): ReadonlyArray<string> | undefined => {
  if (text === "") return []

  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : undefined
}

/**
 * Redacts a page whose `contentJsonl` member is JSONL, record by record, as
 * the JSON each record is: the page stays valid JSONL, an escape cannot hide a
 * secret, and a secret matching a literal such as `true` changes nothing. A
 * record redaction leaves alone is returned byte for byte, keeping number
 * precision; any other is re-serialized. `undefined` when the page or a
 * record is not JSON.
 */
export const redactRecords = (
  page: JsonValue,
  secrets: ReadonlyArray<string>,
): JsonValue | undefined => {
  if (!isJsonObject(page)) return undefined

  const text = page[RECORDS_FIELD]
  const lines = Predicate.isString(text) ? jsonlLines(text) : undefined

  if (lines === undefined) return undefined

  const records: Array<JsonValue> = []

  for (const line of lines) {
    const record = decodeJsonText(line)

    if (record === undefined) return undefined

    records.push(record)
  }

  const others = Object.fromEntries(Object.entries(page).filter(([key]) => key !== RECORDS_FIELD))
  const scrub = protectedValues([others, ...records], secrets)

  const kept = records.map((record, index) => {
    const safe = JSON.stringify(redactWith(record, scrub))

    return safe === JSON.stringify(record) ? (lines[index] ?? safe) : safe
  })

  return Object.fromEntries([
    ...Object.entries(redactObject(others, scrub, false)),
    [RECORDS_FIELD, kept.map((line) => line + "\n").join("")],
  ])
}
