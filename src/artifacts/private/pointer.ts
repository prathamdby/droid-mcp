import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

/**
 * RFC 6901 JSON Pointer resolution over `Schema.Json` values.
 *
 * A pointer is either the empty string (the whole value) or a sequence of
 * `/`-prefixed reference tokens. Within a token, `~1` decodes to `/` and `~0`
 * decodes to `~`. Resolution is total: a malformed pointer or a missing path
 * segment yields `undefined` instead of throwing.
 */

type JsonObject = { readonly [key: string]: Schema.Json }

const isJsonObject = (value: Schema.Json): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const unescapeToken = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~")

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/

/**
 * Resolves `pointer` against `value`; `undefined` when the pointer is
 * malformed or any step does not exist. The empty pointer selects `value`.
 */
export const pointerGet = (value: Schema.Json, pointer: string): Schema.Json | undefined => {
  if (pointer === "") return value

  if (!pointer.startsWith("/")) return undefined

  let current: Schema.Json | undefined = value

  for (const raw of pointer.slice(1).split("/")) {
    const token = unescapeToken(raw)

    if (Array.isArray(current)) {
      current = ARRAY_INDEX.test(token) ? current[Number(token)] : undefined
    } else if (isJsonObject(current)) {
      current = Object.hasOwn(current, token) ? current[token] : undefined
    } else {
      return undefined
    }

    if (current === undefined) return undefined
  }

  return current
}
