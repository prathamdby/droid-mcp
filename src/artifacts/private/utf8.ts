/**
 * UTF-8 boundary-safe byte slicing.
 *
 * Pages slice encoded bytes directly; no string re-encoding happens per page.
 * Slice ends land on character boundaries, so concatenating consecutive
 * pages reproduces the original bytes exactly.
 */

/** Whether `bytes[index]` is a UTF-8 continuation byte (`0x80..0xBF`). */
export const isContinuationByte = (bytes: Uint8Array, index: number): boolean =>
  index > 0 && index < bytes.length && (bytes[index] & 0xc0) === 0x80

/**
 * Largest end index in `[start, start + maxLength]` capped at `bytes.length`
 * that does not split a multi-byte UTF-8 character.
 */
export const cleanEnd = (bytes: Uint8Array, start: number, maxLength: number): number => {
  let end = Math.min(start + maxLength, bytes.length)

  while (end > start && isContinuationByte(bytes, end)) end -= 1

  return end
}

/** Fits the page budget unless one complete character is needed to make progress. */
export const pageEnd = (bytes: Uint8Array, start: number, length: number): number => {
  let end = cleanEnd(bytes, start, length)

  if (end === start && length >= 1 && start < bytes.length) {
    end += 1

    while (isContinuationByte(bytes, end)) end += 1
  }

  return end
}

/** Decodes `bytes[start, end)` as UTF-8 text. */
export const decodeRange = (bytes: Uint8Array, start: number, end: number): string =>
  new TextDecoder().decode(bytes.subarray(start, end))
