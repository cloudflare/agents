/**
 * Row chunking for the Sessions capability.
 *
 * SQLite on a Durable Object caps how many bytes one row may hold, so a
 * message whose serialized JSON exceeds the budget is split across the
 * message row and numbered continuation rows. Reads concatenate the slices
 * back into the original string, so a round-trip is exact and nothing is
 * ever truncated or too large to store.
 *
 * The split is on BYTES, not characters: SQLite's limit is a byte limit and
 * one character can be up to four of them. A boundary is never placed
 * between a high surrogate and its low surrogate either, because a lone
 * surrogate is not valid UTF-8 and would not survive the round-trip.
 * `splitContent(s).join("")` always equals `s`.
 */

/**
 * Serialized byte ceiling for one stored row. A message larger than this is
 * split across continuation rows; the overwhelmingly common message fits in
 * one row and costs exactly one billed row write, as it always has.
 */
export const MAX_INLINE_ROW_BYTES = 1536 * 1024;

/**
 * Split a serialized message into row-sized slices, root slice first.
 *
 * Always returns at least one slice, and never an empty slice unless the
 * input itself is empty. Slice 0 lives in the message row; the rest become
 * continuation rows numbered from 1.
 */
export function splitContent(
  json: string,
  budget: number = MAX_INLINE_ROW_BYTES
): string[] {
  if (json.length === 0) return [""];

  const slices: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;

  while (index < json.length) {
    const code = json.charCodeAt(index);
    let width: number;
    let step = 1;
    if (code < 0x80) {
      width = 1;
    } else if (code < 0x800) {
      width = 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < json.length) {
      const low = json.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        // A surrogate PAIR is one 4-byte code point and moves as a unit, so
        // a boundary can never land between its halves.
        width = 4;
        step = 2;
      } else {
        width = 3;
      }
    } else {
      width = 3;
    }

    // `bytes > 0` keeps a single character that alone exceeds the budget in
    // its own slice rather than emitting an empty one.
    if (bytes > 0 && bytes + width > budget) {
      slices.push(json.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += step;
  }

  slices.push(json.slice(start));
  return slices;
}
