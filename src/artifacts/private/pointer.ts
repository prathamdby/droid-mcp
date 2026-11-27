/**
 * RFC 6901 JSON Pointer token parsing.
 *
 * A pointer is either the empty string (the whole value) or a sequence of
 * `/`-prefixed reference tokens. Within a token, `~1` decodes to `/` and
 * `~0` decodes to `~`. Parsing is total: a malformed pointer yields
 * `undefined` instead of throwing. Resolution belongs with disclosure,
 * because object member names must be interpreted under the policy visible
 * at selection time rather than the spelling stored before a tightening.
 */

const unescapeToken = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~")

/**
 * Parses `pointer` into reference tokens without resolving them. Container
 * types decide during resolution whether a numeric token is an array index
 * or an object member literally named by those digits.
 */
export const pointerTokens = (pointer: string): ReadonlyArray<string> | undefined => {
  if (pointer === "") return []

  if (!pointer.startsWith("/")) return undefined

  return pointer
    .slice(1)
    .split("/")
    .map((token) => unescapeToken(token))
}
