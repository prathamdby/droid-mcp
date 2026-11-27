import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

/**
 * JSON credential scrubbing: drops credential keys and replaces protected
 * values inside strings and member names at any depth. A release may mark
 * exact protocol member names as fixed; unknown members remain data and are
 * scrubbed whole. Atomic protocol continuation values cross unchanged or not
 * at all, so redaction never rewrites an identifier into a different one.
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

/**
 * Canonical redaction policy for one JSON payload. The policy is a tree:
 * `members` carries the shape below a fixed object member, and `item` carries
 * the shape below an array element. Unknown members receive neither shape nor
 * atomic treatment, no matter what their names are.
 */
export interface RedactionPolicy {
  readonly fixedKeys?: ReadonlyArray<string>
  readonly atomicKeys?: ReadonlyArray<string>
  readonly members?: { readonly [key: string]: RedactionPolicy }
  readonly item?: RedactionPolicy
  readonly atomic?: boolean
}

export const EMPTY_REDACTION_POLICY: RedactionPolicy = { fixedKeys: [], atomicKeys: [] }

/** Schema.Json objects are plain records; arrays are a separate JSON case. */
const isJsonObject = (value: Schema.Json): value is { [x: string]: Schema.Json } =>
  Predicate.isObject(value) && !Array.isArray(value)

const isSecretKey = (key: string, sensitiveKeys: ReadonlyArray<string>): boolean => {
  const lower = key.toLowerCase()

  return SECRET_KEYS.includes(lower) || sensitiveKeys.some((s) => s.toLowerCase() === lower)
}

type Automaton = {
  readonly offsets: Int32Array
  readonly codes: Uint16Array
  readonly targets: Int32Array
  readonly failure: Int32Array
  readonly longest: Int32Array
  readonly depth: Int32Array
}

type MatchRange = {
  start: number
  end: number
}

/** Follows one edge by binary search in the node's sorted transition slice. */
const transition = (automaton: Automaton, node: number, code: number): number => {
  let low = automaton.offsets[node] ?? 0
  let high = automaton.offsets[node + 1] ?? 0

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = automaton.codes[middle] ?? 0

    if (candidate === code) return automaton.targets[middle] ?? -1

    if (candidate < code) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return -1
}

/**
 * Builds an Aho-Corasick matcher over UTF-16 code units in flat typed
 * arrays. Memory is a small constant per pattern character rather than a
 * node object and transition map per character. Scanning reports the longest
 * pattern ending at each position without retrying a long shared prefix at
 * every later position; shorter patterns ending at the same position are
 * contained in that longest match and cannot change the union.
 */
const buildMatcher = <Unit extends { readonly length: number }>(
  needles: ReadonlyArray<Unit>,
  codeAt: (needle: Unit, index: number) => number,
): Automaton => {
  const compare = (left: Unit, right: Unit): number => {
    const shared = Math.min(left.length, right.length)

    for (let index = 0; index < shared; index += 1) {
      const difference = codeAt(left, index) - codeAt(right, index)

      if (difference !== 0) return difference
    }

    return left.length - right.length
  }

  const sorted = [...needles].sort(compare)
  const unique: Array<Unit> = []

  for (const needle of sorted) {
    const previous = unique[unique.length - 1]

    if (previous === undefined || compare(previous, needle) !== 0) unique.push(needle)
  }

  let edgeCapacity = 0

  for (const needle of unique) {
    edgeCapacity += needle.length
  }

  const firstChild = new Int32Array(edgeCapacity + 1).fill(-1)
  const nextSibling = new Int32Array(edgeCapacity).fill(-1)
  const insertionCodes = new Uint16Array(edgeCapacity)
  const terminalLongest = new Int32Array(edgeCapacity + 1)
  const insertionDepth = new Int32Array(edgeCapacity + 1)
  let maxNeedleLength = 0

  for (const needle of unique) {
    maxNeedleLength = Math.max(maxNeedleLength, needle.length)
  }

  const path = new Int32Array(maxNeedleLength + 1)
  let nodeCount = 1
  let edgeCount = 0
  let previous: Unit | undefined

  path[0] = 0

  for (const needle of unique) {
    let prefix = 0

    if (previous !== undefined) {
      const shared = Math.min(previous.length, needle.length)

      while (prefix < shared && codeAt(previous, prefix) === codeAt(needle, prefix)) {
        prefix += 1
      }
    }

    for (let index = prefix; index < needle.length; index += 1) {
      const node = path[index] ?? 0
      const child = nodeCount
      nodeCount += 1

      const edge = edgeCount
      edgeCount += 1
      insertionCodes[edge] = codeAt(needle, index)
      nextSibling[edge] = firstChild[node] ?? -1
      firstChild[node] = edge
      path[index + 1] = child
      insertionDepth[child] = index + 1
    }

    const terminal = path[needle.length] ?? 0

    terminalLongest[terminal] = Math.max(terminalLongest[terminal] ?? 0, needle.length)
    previous = needle
  }

  const offsets = new Int32Array(nodeCount + 1)

  for (let node = 0; node < nodeCount; node += 1) {
    let degree = 0

    for (let edge = firstChild[node] ?? -1; edge !== -1; edge = nextSibling[edge] ?? -1) {
      degree += 1
    }

    offsets[node + 1] = degree
  }

  for (let node = 0; node < nodeCount; node += 1) {
    offsets[node + 1] = (offsets[node + 1] ?? 0) + (offsets[node] ?? 0)
  }

  const codes = new Uint16Array(edgeCount)
  const targets = new Int32Array(edgeCount)

  for (let node = 0; node < nodeCount; node += 1) {
    const first = firstChild[node] ?? -1
    const degree = (offsets[node + 1] ?? 0) - (offsets[node] ?? 0)
    let position = offsets[node] ?? 0

    if (degree === 1) {
      codes[position] = insertionCodes[first] ?? 0
      targets[position] = first + 1
      continue
    }

    const edges: Array<number> = []

    for (let edge = first; edge !== -1; edge = nextSibling[edge] ?? -1) {
      edges.push(edge)
    }

    edges.sort((left, right) => (insertionCodes[left] ?? 0) - (insertionCodes[right] ?? 0))

    for (const edge of edges) {
      codes[position] = insertionCodes[edge] ?? 0
      targets[position] = edge + 1
      position += 1
    }
  }

  const failure = new Int32Array(nodeCount)
  const longest = terminalLongest.slice(0, nodeCount)
  const depth = insertionDepth.slice(0, nodeCount)
  const automaton: Automaton = { offsets, codes, targets, failure, longest, depth }
  const queue = new Int32Array(Math.max(1, nodeCount))
  let head = 0
  let tail = 0

  for (let position = offsets[0] ?? 0; position < (offsets[1] ?? 0); position += 1) {
    const child = targets[position] ?? 0

    failure[child] = 0
    queue[tail] = child
    tail += 1
  }

  while (head < tail) {
    const node = queue[head] ?? 0
    head += 1

    for (let position = offsets[node] ?? 0; position < (offsets[node + 1] ?? 0); position += 1) {
      const code = codes[position] ?? 0
      const child = targets[position] ?? 0
      let parentFailure = failure[node] ?? 0
      let candidate = transition(automaton, parentFailure, code)

      while (candidate === -1 && parentFailure !== 0) {
        parentFailure = failure[parentFailure] ?? 0
        candidate = transition(automaton, parentFailure, code)
      }

      failure[child] = candidate !== -1 && candidate !== child ? candidate : 0
      longest[child] = Math.max(longest[child] ?? 0, longest[failure[child] ?? 0] ?? 0)
      queue[tail] = child
      tail += 1
    }
  }

  return automaton
}

/** Advances the automaton by one UTF-16 code unit. */
const advanceMatcher = (automaton: Automaton, node: number, code: number): number => {
  let current = node
  let next = transition(automaton, current, code)

  while (next === -1 && current !== 0) {
    current = automaton.failure[current] ?? 0
    next = transition(automaton, current, code)
  }

  return next === -1 ? 0 : next
}

const rangesTouch = (left: MatchRange, right: MatchRange): boolean =>
  left.start <= right.end && right.start <= left.end

/** A compiled multi-pattern scrubber shared by every string in one disclosure pass. */
export interface TextScrubber {
  readonly automaton: Automaton
  readonly maxLength: number
  readonly minLength: number
  readonly patternCount: number
  readonly marker: string
}

/**
 * Compiles the distinct non-empty secrets that can fit in an eligible text,
 * iterating lengths rather than spreading them. A pattern longer than every
 * string, member name, or serialized scalar that the pass can inspect can
 * never match there; omitting it keeps installation input size from deciding
 * matcher memory before scanning begins.
 */
export const compileScrubber = (
  secrets: ReadonlyArray<string>,
  marker: string,
  maximumTextLength: number = Number.POSITIVE_INFINITY,
): TextScrubber => {
  const needles = [
    ...new Set(secrets.filter((secret) => secret.length > 0 && secret.length <= maximumTextLength)),
  ]

  let maxLength = 0
  let minLength = 0

  for (const needle of needles) {
    maxLength = Math.max(maxLength, needle.length)
    minLength = minLength === 0 ? needle.length : Math.min(minLength, needle.length)
  }

  return {
    automaton: buildMatcher(needles, (needle, index) => needle.charCodeAt(index)),
    maxLength,
    minLength,
    patternCount: needles.length,
    marker,
  }
}

/**
 * Replaces occurrences of secrets from ranges found in the original text.
 * Overlapping or adjacent ranges merge into one marker, duplicates run once,
 * and inserted markers are never rescanned — otherwise one short secret
 * could expand every later marker again or leave the overlapping suffix of
 * another visible. Matches arrive at most once per text position; because no
 * match is longer than the longest secret, disjoint merged ranges are emitted
 * as soon as a future match can no longer reach them, rather than being
 * retained for the whole input.
 */
export const scrubTextWith = (text: string, scrubber: TextScrubber): string => {
  if (scrubber.patternCount === 0 || text.length < scrubber.minLength) return text

  const { automaton, maxLength, marker } = scrubber
  let active: Array<MatchRange> = []
  let activeStart = 0
  let result = ""
  let cursor = 0

  const flushReachable = (minimumFutureStart: number): void => {
    for (;;) {
      const first = active[activeStart]

      if (first === undefined || first.end >= minimumFutureStart) return

      result += text.slice(cursor, first.start) + marker
      cursor = first.end
      activeStart += 1

      if (activeStart === active.length) {
        active = []
        activeStart = 0
      } else if (activeStart >= 64 && activeStart * 2 >= active.length) {
        active = active.slice(activeStart)
        activeStart = 0
      }
    }
  }

  /*
   * Matches are reported in nondecreasing end position. Consequently every
   * active range a new match touches is a suffix of the active disjoint
   * ranges: a later disjoint range cannot end before the new match, so the
   * new match reaches it too. Merging only that suffix is amortized
   * constant-time rather than another scan of the active window.
   */
  const insertRange = (start: number, end: number): void => {
    if (activeStart === active.length) {
      active = []
      activeStart = 0
    }

    let merged = { start, end }

    for (;;) {
      const last = active[active.length - 1]

      if (last === undefined || !rangesTouch(merged, last)) break

      merged = {
        start: Math.min(merged.start, last.start),
        end: Math.max(merged.end, last.end),
      }
      active.pop()
    }

    active.push(merged)
  }

  let node = 0

  for (let index = 0; index < text.length; index += 1) {
    node = advanceMatcher(automaton, node, text.charCodeAt(index))

    const longest = automaton.longest[node] ?? 0

    if (longest > 0) {
      insertRange(index - longest + 1, index + 1)
    }

    flushReachable(index - maxLength + 2)
  }

  flushReachable(Number.POSITIVE_INFINITY)

  if (cursor === 0) return text

  return result + text.slice(cursor)
}

/** Compiles a one-off scrubber; recursive passes use `compileScrubber` once and reuse it. */
export const scrubText = (text: string, secrets: ReadonlyArray<string>, marker: string): string =>
  scrubTextWith(text, compileScrubber(secrets, marker, text.length))

/** Whether the compiled matcher finds any pattern in `text`, stopping at the first match. */
export const textContainsMatch = (text: string, scrubber: TextScrubber): boolean => {
  if (scrubber.patternCount === 0 || text.length < scrubber.minLength) return false

  let node = 0

  for (let index = 0; index < text.length; index += 1) {
    node = advanceMatcher(scrubber.automaton, node, text.charCodeAt(index))

    if ((scrubber.automaton.longest[node] ?? 0) > 0) return true
  }

  return false
}

/**
 * Whether a non-string scalar still carries a protected value after tree
 * redaction. Strings and member names are redactable and are handled before
 * this scan; numbers, booleans and null cannot be partially rewritten without
 * changing their JSON type, so any match must refuse the release instead.
 */
export const unredactableScalarContainsSecret = (
  value: Schema.Json,
  scrubber: TextScrubber,
): boolean => {
  if (Predicate.isNumber(value) || Predicate.isBoolean(value) || value === null) {
    return textContainsMatch(JSON.stringify(value), scrubber)
  }

  if (Array.isArray(value)) {
    return value.some((entry) => unredactableScalarContainsSecret(entry, scrubber))
  }

  if (isJsonObject(value)) {
    return Object.values(value).some((member) => unredactableScalarContainsSecret(member, scrubber))
  }

  return false
}

const containsSecret = (value: Schema.Json, scrubber: TextScrubber): boolean => {
  if (Predicate.isString(value)) return textContainsMatch(value, scrubber)

  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, scrubber))

  if (isJsonObject(value)) {
    return Object.entries(value).some(
      ([key, member]) => textContainsMatch(key, scrubber) || containsSecret(member, scrubber),
    )
  }

  return false
}

/**
 * Whether an atomic protocol field contains a protected value. The walk follows
 * only fixed protocol members; once an unknown extension member is entered,
 * everything beneath it is ordinary data and never gains atomic treatment by
 * reusing a protocol field name.
 */
export const atomicValueContainsSecret = (
  value: Schema.Json,
  scrubber: TextScrubber,
  policy: RedactionPolicy,
): boolean => {
  if (policy.atomic === true && containsSecret(value, scrubber)) return true

  if (Array.isArray(value)) {
    const itemPolicy = policy.item ?? EMPTY_REDACTION_POLICY

    return value.some((entry) => atomicValueContainsSecret(entry, scrubber, itemPolicy))
  }

  if (!isJsonObject(value)) return false

  return Object.entries(value).some(([key, member]) => {
    const fixed = policy.fixedKeys?.includes(key) === true

    if (fixed && policy.atomicKeys?.includes(key) === true && containsSecret(member, scrubber)) {
      return true
    }

    const childPolicy =
      fixed === true ? (policy.members?.[key] ?? EMPTY_REDACTION_POLICY) : EMPTY_REDACTION_POLICY

    return atomicValueContainsSecret(member, scrubber, childPolicy)
  })
}

export interface VisibleObjectMember {
  /** The member name in the stored payload. */
  readonly key: string
  /** The member name visible after the current policy is applied. */
  readonly name: string
  readonly value: Schema.Json
  readonly fixed: boolean
}

/**
 * The object members visible under one policy, in insertion order. This is
 * the single key-selection algorithm used both to redact objects and to
 * resolve selections later, so a tightened policy cannot create two different
 * views of the same member name. Credential members are dropped, fixed names
 * cross exactly, unknown names are scrubbed, and the first member wins when
 * two names collapse onto the same visible key.
 */
export const visibleObjectMembers = (
  value: { [x: string]: Schema.Json },
  scrubber: TextScrubber,
  sensitiveKeys: ReadonlyArray<string>,
  policy: RedactionPolicy,
): ReadonlyArray<VisibleObjectMember> => {
  const members: Array<VisibleObjectMember> = []
  const kept = new Set<string>()

  for (const [key, member] of Object.entries(value)) {
    if (isSecretKey(key, sensitiveKeys)) continue

    const fixed = policy.fixedKeys?.includes(key) === true
    const name = fixed ? key : scrubTextWith(key, scrubber)

    if (kept.has(name)) continue

    kept.add(name)
    members.push({ key, name, value: member, fixed })
  }

  return members
}

/**
 * Member names are data unless the active protocol shape fixes them exactly.
 * Unknown members never re-enable the protocol shape beneath them, so an
 * extension object cannot bypass scrubbing by reusing a fixed field name.
 */
const redactObject = (
  value: { [x: string]: Schema.Json },
  scrubber: TextScrubber,
  sensitiveKeys: ReadonlyArray<string>,
  policy: RedactionPolicy,
): { [x: string]: Schema.Json } => {
  const members: Array<readonly [string, Schema.Json]> = []

  for (const member of visibleObjectMembers(value, scrubber, sensitiveKeys, policy)) {
    const atomic = member.fixed && policy.atomicKeys?.includes(member.key) === true

    const childPolicy =
      member.fixed === true
        ? (policy.members?.[member.key] ?? EMPTY_REDACTION_POLICY)
        : EMPTY_REDACTION_POLICY

    const child =
      atomic && Predicate.isString(member.value)
        ? member.value
        : redactJsonValue(member.value, scrubber, sensitiveKeys, childPolicy)

    members.push([member.name, child])
  }

  // `fromEntries` defines own members, so a `__proto__` member stays data.
  return Object.fromEntries(members)
}

/** Drops credential fields and replaces protected values in strings and data member names, recursively. */
export const redactJsonValue = (
  value: Schema.Json,
  scrubber: TextScrubber,
  sensitiveKeys: ReadonlyArray<string>,
  policy: RedactionPolicy = EMPTY_REDACTION_POLICY,
): Schema.Json => {
  if (Predicate.isString(value)) return scrubTextWith(value, scrubber)

  if (Array.isArray(value)) {
    const itemPolicy = policy.item ?? EMPTY_REDACTION_POLICY

    return value.map((entry) => redactJsonValue(entry, scrubber, sensitiveKeys, itemPolicy))
  }

  if (isJsonObject(value)) {
    return redactObject(value, scrubber, sensitiveKeys, policy)
  }

  return value
}

/**
 * The longest text position a disclosure pass can inspect. Credential members
 * are dropped before inspection, so neither their names nor anything beneath
 * them makes an impossible long pattern eligible; visible member names,
 * visible strings, and serialized non-string scalars do.
 */
export const maximumMatchableTextLength = (
  value: Schema.Json,
  sensitiveKeys: ReadonlyArray<string>,
): number => {
  if (Predicate.isString(value)) return value.length

  if (Predicate.isNumber(value) || Predicate.isBoolean(value) || value === null) {
    return JSON.stringify(value).length
  }

  if (Array.isArray(value)) {
    let maximum = 0

    for (const entry of value) {
      maximum = Math.max(maximum, maximumMatchableTextLength(entry, sensitiveKeys))
    }

    return maximum
  }

  if (!isJsonObject(value)) return 0

  let maximum = 0

  for (const [key, member] of Object.entries(value)) {
    if (isSecretKey(key, sensitiveKeys)) continue

    maximum = Math.max(maximum, key.length, maximumMatchableTextLength(member, sensitiveKeys))
  }

  return maximum
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

/** The Latin-1 wire encoding of a header value, when every UTF-16 code unit fits in one byte. */
const latin1Encoding = (value: string): Uint8Array | undefined => {
  const bytes = new Uint8Array(value.length)

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code > 0xff) return undefined

    bytes[index] = code
  }

  return bytes
}

/**
 * Whether any protected value appears inside binary data. JSON replies use
 * UTF-8, while a peer can also echo the exact Latin-1 bytes of a configured
 * header inside a file payload.
 */
export const mediaContainsProtectedBytes = (
  bytes: Uint8Array,
  protectedValues: ReadonlyArray<string>,
): boolean => {
  const encoder = new TextEncoder()
  const needles: Array<Uint8Array> = []

  for (const secret of protectedValues) {
    if (secret.length === 0) continue

    const utf8 = encoder.encode(secret)

    if (utf8.length <= bytes.length) needles.push(utf8)

    const latin1 = latin1Encoding(secret)

    if (latin1 !== undefined && latin1.length <= bytes.length) {
      needles.push(latin1)
    }
  }

  if (needles.length === 0) return false

  const automaton = buildMatcher(needles, (needle, index) => needle[index] ?? 0)
  let node = 0

  for (let index = 0; index < bytes.length; index += 1) {
    node = advanceMatcher(automaton, node, bytes[index] ?? 0)

    if ((automaton.longest[node] ?? 0) > 0) return true
  }

  return false
}

/**
 * A stateful scrubber for text that crosses the boundary in ordered
 * fragments. Scanning advances the same compiled automaton used by atomic
 * scrubbing once per input character. A trailing proper prefix of a protected
 * value is withheld, and a complete match touching the input end is withheld
 * with it because a later adjacent or overlapping match would merge with it
 * in one atomic scan. Everything before that final cut is emitted without
 * rescanning or scanning every protected value separately.
 *
 * Policy tightening replaces the secret array. The stream then recompiles and
 * rescans only the unreleased tail: already released output cannot be
 * retracted, while every character still inside the stream is matched against
 * the current value set. Pathological overlapping matches can still retain a
 * long tail because their atomic form is one merged range, but ordinary input
 * carries at most the longest proper protected prefix.
 */
export const openScrubStream = (secretsFor: () => ReadonlyArray<string>, marker: string) => {
  type BufferChunk = {
    readonly text: string
    readonly start: number
    readonly offset: number
  }

  let secrets: ReadonlyArray<string> | undefined
  let scrubber: TextScrubber | undefined
  let node = 0
  let position = 0
  let cursor = 0
  let chunks: Array<BufferChunk> = []
  let firstChunk = 0
  let active: Array<MatchRange> = []
  let activeStart = 0

  const compactActive = (): void => {
    if (activeStart === active.length) {
      active = []
      activeStart = 0
    } else if (activeStart >= 64 && activeStart * 2 >= active.length) {
      active = active.slice(activeStart)
      activeStart = 0
    }
  }

  const compactChunks = (): void => {
    if (firstChunk === chunks.length) {
      chunks = []
      firstChunk = 0
    } else if (firstChunk >= 64 && firstChunk * 2 >= chunks.length) {
      chunks = chunks.slice(firstChunk)
      firstChunk = 0
    }
  }

  /** Drops final output before `cut` without flattening and rebuilding the unreleased tail. */
  const discardBefore = (cut: number): void => {
    while (firstChunk < chunks.length) {
      const chunk = chunks[firstChunk]

      if (chunk === undefined) break

      const end = chunk.start + (chunk.text.length - chunk.offset)

      if (end > cut) {
        if (cut > chunk.start) {
          chunks[firstChunk] = {
            text: chunk.text,
            start: cut,
            offset: chunk.offset + (cut - chunk.start),
          }
        }

        break
      }

      firstChunk += 1
    }

    compactChunks()
  }

  /** Reads a final span in order. Spans cross push boundaries without materializing the whole tail. */
  const bufferSlice = (start: number, end: number): string => {
    if (start === end) return ""

    let output = ""

    for (let index = firstChunk; index < chunks.length; index += 1) {
      const chunk = chunks[index]

      if (chunk === undefined || chunk.start >= end) break

      const chunkEnd = chunk.start + (chunk.text.length - chunk.offset)

      if (chunkEnd <= start) continue

      const from = chunk.offset + Math.max(start, chunk.start) - chunk.start
      const to = chunk.offset + Math.min(end, chunkEnd) - chunk.start
      output += chunk.text.slice(from, to)
    }

    return output
  }

  const insertRange = (start: number, end: number): void => {
    if (activeStart === active.length) {
      active = []
      activeStart = 0
    }

    let merged = { start, end }

    for (;;) {
      const last = active[active.length - 1]

      if (last === undefined || !rangesTouch(merged, last)) break

      merged = {
        start: Math.min(merged.start, last.start),
        end: Math.max(merged.end, last.end),
      }
      active.pop()
    }

    active.push(merged)
  }

  const scanChar = (compiled: TextScrubber, index: number, code: number): void => {
    node = advanceMatcher(compiled.automaton, node, code)

    const longest = compiled.automaton.longest[node] ?? 0

    if (longest > 0) {
      insertRange(index - longest + 1, index + 1)
    }
  }

  const scanBuffered = (compiled: TextScrubber): void => {
    for (let index = firstChunk; index < chunks.length; index += 1) {
      const chunk = chunks[index]

      if (chunk === undefined) continue

      for (let offset = chunk.offset; offset < chunk.text.length; offset += 1) {
        scanChar(compiled, chunk.start + (offset - chunk.offset), chunk.text.charCodeAt(offset))
      }
    }
  }

  const currentScrubber = (): TextScrubber => {
    const nextSecrets = secretsFor()

    if (scrubber !== undefined && secrets === nextSecrets) return scrubber

    secrets = nextSecrets
    scrubber = compileScrubber(nextSecrets, marker)
    node = 0
    active = []
    activeStart = 0
    scanBuffered(scrubber)

    return scrubber
  }

  /** The longest unreleased suffix that is a proper prefix of at least one pattern. */
  const properPrefixHold = (compiled: TextScrubber): number => {
    let current = node

    while (current !== 0) {
      const hasChild =
        (compiled.automaton.offsets[current + 1] ?? 0) > (compiled.automaton.offsets[current] ?? 0)

      if (hasChild) return compiled.automaton.depth[current] ?? 0

      current = compiled.automaton.failure[current] ?? 0
    }

    return 0
  }

  /** Emits final input through `cut`, substituting complete disjoint match ranges. */
  const emitThrough = (cut: number): string => {
    let output = ""

    while (cursor < cut) {
      const range = active[activeStart]

      if (range === undefined || range.start >= cut) {
        output += bufferSlice(cursor, cut)
        cursor = cut
        break
      }

      if (range.end <= cursor) {
        activeStart += 1
        compactActive()
        continue
      }

      if (range.start > cursor) {
        output += bufferSlice(cursor, range.start)
        cursor = range.start
      }

      output += marker
      cursor = range.end
      activeStart += 1
      compactActive()
    }

    return output
  }

  const push = (text: string): string => {
    const compiled = currentScrubber()

    if (text.length > 0) {
      chunks.push({ text, start: position, offset: 0 })
    }

    for (let index = 0; index < text.length; index += 1) {
      scanChar(compiled, position, text.charCodeAt(index))
      position += 1
    }

    let cut = position - properPrefixHold(compiled)

    for (let index = activeStart; index < active.length; index += 1) {
      const range = active[index]

      if (range === undefined || range.start >= cut) break

      if (range.end >= cut) {
        cut = range.start
        break
      }
    }

    const output = emitThrough(cut)

    discardBefore(cursor)

    return output
  }

  const flush = (): string => {
    currentScrubber()
    const output = emitThrough(position)

    chunks = []
    firstChunk = 0
    active = []
    activeStart = 0

    return output
  }

  return { push, flush }
}
