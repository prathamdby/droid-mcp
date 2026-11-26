/**
 * Discovery text indexing and scoring, module-internal. Name hits weigh
 * three times description hits; every query token must hit somewhere.
 */

/** The minimal indexed shape of one operation's discovery facts. */
export interface Indexable {
  readonly id: string
  readonly description: string
}

export interface SearchEntry<D extends Indexable> {
  readonly description: D
  readonly words: string
}

export const indexOf = <D extends Indexable>(description: D): SearchEntry<D> => ({
  description,
  words: (description.id.replaceAll("_", " ") + " " + description.description).toLowerCase(),
})

export const tokensOf = (query: string): ReadonlyArray<string> =>
  query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)

export const scoreOf = (entry: SearchEntry<Indexable>, tokens: ReadonlyArray<string>): number => {
  let score = 0

  for (const token of tokens) {
    if (entry.description.id.includes(token)) score += 3
    else if (entry.words.includes(token)) score += 1
    else return 0
  }

  return score
}
