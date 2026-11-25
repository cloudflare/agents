/**
 * Storage limits of the Durable Object platform, and the budgets derived
 * from them. Code that sizes what it writes to one SQLite row takes its
 * figure from here instead of restating it.
 *
 * Limits: https://developers.cloudflare.com/durable-objects/platform/limits/
 *
 * Measured 23 Nov 2026 on a deployed SQLite-backed Durable Object: a row
 * (all columns together) and each bound value hold at most 8,388,637 bytes;
 * past it SQLite throws `string or blob too big: SQLITE_TOOBIG`. Local
 * workerd releases cap lower: about 2.2 MB up to 1.20260804, 4 MiB in
 * 1.20260820 and 1.20260908, 8 MiB from 1.20260930. A runtime cannot read a
 * row larger than its own cap (`SELECT` throws `SQLITE_TOOBIG`).
 *
 * @internal
 * @packageDocumentation
 */

/**
 * The row size every budget below is computed from. It is the lowest cap of
 * any runtime this SDK supports, not only production's: a row larger than a
 * runtime's cap cannot be read there. Measured 23 Nov 2026, production and
 * workerd 1.20260930 or later (wrangler 4.145.0, `@cloudflare/vitest-plugin`
 * 1.9.1) hold 8,388,637 bytes per row. 8,000,000 leaves 388,637 bytes for a
 * row's other columns and its record header. Older local workerd (before
 * 1.20260930, every `@cloudflare/vitest-pool-workers` release) holds less and
 * throws `SQLITE_TOOBIG`, which `SqlError` explains.
 *
 * @internal
 */
export const SQLITE_ROW_BYTES = 8_000_000;

/**
 * The largest single value in a row whose other columns are small (ids,
 * sequence numbers, timestamps).
 *
 * @internal
 */
export const ROW_VALUE_BYTES = SQLITE_ROW_BYTES - 100_000;

/**
 * The largest single item the SDK keeps to replay later: a stream chunk, an
 * event-log event, a chat chunk body, the indexed text of a search hit.
 * Replays and search results send many items in one WebSocket message or
 * RPC reply, and each of those holds 32 MiB at most, so items stay small
 * whatever the row size. It is the row budget before the 8 MB floor, so
 * these limits did not change with it.
 *
 * @internal
 */
export const REPLAY_ITEM_BYTES = 1_900_000;

/**
 * The largest chat chunk body kept for replay, after JSON escaping. A larger
 * one is still sent live and left out of replay.
 *
 * @internal
 */
export const REPLAY_CHUNK_BYTES = REPLAY_ITEM_BYTES - 100_000;

/**
 * The largest WebSocket message a Durable Object sends. Measured 23 Nov
 * 2026: production delivered 33,554,359 bytes (32 MiB less 73) and dropped
 * anything larger without an error; local workerd delivered 128 MiB. Kept
 * 1 KiB under 32 MiB.
 *
 * @internal
 */
export const WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024 - 1024;

/**
 * The most text one replay frame, RPC reply or search result carries: half
 * a WebSocket message (an RPC reply holds 32 MiB too), so the envelope and
 * the JSON escaping of the items always fit. Readers that return a list
 * page it by this many bytes, not only by count.
 *
 * @internal
 */
export const REPLAY_PAGE_BYTES = Math.floor(WEBSOCKET_MESSAGE_BYTES / 2);

/**
 * UTF-8 bytes of `text`, counted without encoding it.
 *
 * @internal
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The largest serialized chat message, or stream chunk body, kept in one
 * row. Chat compacts a larger message and leaves a larger chunk out of
 * replay.
 *
 * @internal
 */
export const ROW_MAX_BYTES = SQLITE_ROW_BYTES - 200_000;

/** UTF-8 bytes one UTF-16 code unit takes at most. */
const UTF8_BYTES_PER_UNIT = 3;

/**
 * The longest piece of split text kept in one row, in UTF-16 code units: its
 * worst-case UTF-8 leaves 500 KB of the row for the other columns.
 *
 * @internal
 */
export const ROW_PIECE_UNITS = Math.floor(
  (SQLITE_ROW_BYTES - 500_000) / UTF8_BYTES_PER_UNIT
);

/**
 * `text` in pieces of at most `size` code units, never between the two
 * halves of a surrogate pair: SQLite stores text as UTF-8, which cannot
 * hold half a pair.
 *
 * @internal
 */
export function splitPieces(text: string, size: number): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}

/**
 * Bound parameters one SQL statement may carry (documented; measured the
 * same in production and locally). Statements that bind a list chunk it.
 *
 * @internal
 */
export const MAX_BOUND_PARAMS = 100;

/**
 * Keys one multi-key `storage.delete([...])` call takes, as the docs state.
 * Measured 23 Nov 2026, SQLite-backed objects accepted 20,000; the
 * documented figure is kept.
 *
 * @internal
 */
export const KV_DELETE_MAX_KEYS = 128;
