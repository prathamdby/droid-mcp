import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

/**
 * JSON credential scrubbing: drops credential keys and replaces protected
 * values inside strings and member names at any depth.
 */

/**
 * Credential keys dropped at any depth. `apiKey` is dropped whole: its
 * `value` member is a minted credential, collected by `mintedValuesInValue`
 * before scrubbing so echoes of it are replaced everywhere. `secrets` and
 * `upsert` carry secret entries, so they are dropped whole as well.
 */
const SECRET_KEYS: ReadonlyArray<string> = [
  "apikey",
  "api_key",
  "secret",
  "secrets",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "authorization",
  "privatekey",
  "private_key",
  "clientsecret",
  "bearer",
  "upsert",
]

/** Keys whose `value` member is a freshly minted credential, read before the member is dropped. */
const MINTED_VALUE_PARENTS: ReadonlyArray<string> = ["apikey", "api_key"]

/** Schema.Json objects are plain records; arrays are a separate JSON case. */
const isJsonObject = (value: Schema.Json): value is { [x: string]: Schema.Json } =>
  Predicate.isObject(value) && !Array.isArray(value)

const isSecretKey = (key: string, sensitiveKeys: ReadonlyArray<string>): boolean => {
  const lower = key.toLowerCase()

  return SECRET_KEYS.includes(lower) || sensitiveKeys.some((s) => s.toLowerCase() === lower)
}

/** Replaces every occurrence of a non-empty secret. Longer secrets first, so one containing a shorter is replaced whole. */
export const scrubText = (text: string, secrets: ReadonlyArray<string>, marker: string): string => {
  let result = text

  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) result = result.split(secret).join(marker)
  }

  return result
}

/**
 * Member names are scrubbed like values. When a scrubbed name repeats one
 * already kept, the later member is dropped, so neither value is overwritten.
 */
const redactObject = (
  value: { [x: string]: Schema.Json },
  secrets: ReadonlyArray<string>,
  sensitiveKeys: ReadonlyArray<string>,
  marker: string,
): { [x: string]: Schema.Json } => {
  const members: Array<readonly [string, Schema.Json]> = []
  const kept = new Set<string>()

  for (const [key, member] of Object.entries(value)) {
    if (isSecretKey(key, sensitiveKeys)) continue

    const name = scrubText(key, secrets, marker)

    if (kept.has(name)) continue

    kept.add(name)

    members.push([name, redactJsonValue(member, secrets, sensitiveKeys, marker)])
  }

  // `fromEntries` defines own members, so a `__proto__` member stays data.
  return Object.fromEntries(members)
}

/** Drops credential fields and replaces protected values in strings and member names, recursively. */
export const redactJsonValue = (
  value: Schema.Json,
  secrets: ReadonlyArray<string>,
  sensitiveKeys: ReadonlyArray<string>,
  marker: string,
): Schema.Json => {
  if (Predicate.isString(value)) return scrubText(value, secrets, marker)

  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, secrets, sensitiveKeys, marker))
  }

  if (isJsonObject(value)) return redactObject(value, secrets, sensitiveKeys, marker)

  return value
}

/** Every `apiKey.value` string in a JSON value, read from the original payload before its key is dropped. */
export const mintedValuesInValue = (value: Schema.Json): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(mintedValuesInValue)

  if (!isJsonObject(value)) return []

  return Object.entries(value).flatMap(([key, member]) => {
    const own =
      MINTED_VALUE_PARENTS.includes(key.toLowerCase()) &&
      isJsonObject(member) &&
      Predicate.isString(member.value)
        ? [member.value]
        : []

    return [...own, ...mintedValuesInValue(member)]
  })
}

/** Every minted credential value across a whole records list, so secrets propagate across records. */
export const mintedValuesInRecords = (items: ReadonlyArray<Schema.Json>): ReadonlyArray<string> =>
  items.flatMap(mintedValuesInValue)

/** Whether any protected value appears as a UTF-8 byte sequence inside binary data. */
export const mediaContainsProtectedBytes = (
  bytes: Uint8Array,
  protectedValues: ReadonlyArray<string>,
): boolean => {
  const encoder = new TextEncoder()

  for (const secret of protectedValues) {
    if (secret.length === 0) continue

    const needle = encoder.encode(secret)

    if (needle.length === 0 || needle.length > bytes.length) continue

    outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer
      }

      return true
    }
  }

  return false
}

/**
 * A stateful scrubber for text that crosses the boundary in ordered
 * fragments. Atomic scrubbing cannot see a protected value split across
 * fragments, so the scrubber withholds every suffix that might still grow
 * into one: the longest proper secret prefix at the tail, widened leftward
 * over any protected occurrence that straddles the cut. Widening covers
 * self-overlapping values such as `abab`, where one occurrence can end
 * inside the prefix span of the next. Everything before the cut is final:
 * no occurrence straddles it, so scrubbing it atomically is exact, and the
 * concatenation of all released output is exactly the scrubbed stream.
 */
export const openScrubStream = (secretsFor: () => ReadonlyArray<string>, marker: string) => {
  let pending = ""

  const properPrefixHold = (text: string, secrets: ReadonlyArray<string>): number => {
    let hold = 0

    for (const secret of secrets) {
      for (let length = 1; length < secret.length; length++) {
        if (length <= text.length && length > hold && text.endsWith(secret.slice(0, length))) {
          hold = length
        }
      }
    }

    return hold
  }

  const push = (text: string): string => {
    pending += text

    const secrets = secretsFor().filter((secret) => secret.length > 0)
    let cut = pending.length - properPrefixHold(pending, secrets)

    let widened = true

    while (widened) {
      widened = false

      for (const secret of secrets) {
        let index = pending.indexOf(secret)

        while (index !== -1) {
          if (index < cut && index + secret.length > cut) {
            cut = index
            widened = true
          }

          index = pending.indexOf(secret, index + 1)
        }
      }
    }

    const head = pending.slice(0, cut)
    pending = pending.slice(cut)

    return scrubText(head, secrets, marker)
  }

  const flush = (): string => {
    const secrets = secretsFor().filter((secret) => secret.length > 0)
    const out = scrubText(pending, secrets, marker)
    pending = ""

    return out
  }

  return { push, flush }
}
