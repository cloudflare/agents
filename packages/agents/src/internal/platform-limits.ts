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
 * The row size every budget below is computed from: the lowest cap of any
 * runtime this SDK may run on (`wrangler dev` and the test pool use the
 * installed workerd), not production's 8 MiB. A row within it can be read
 * by every such runtime, so a downgrade or rollback never leaves a row
 * nothing can read. Raise it only together with the minimum runtime.
 *
 * @internal
 */
export const SQLITE_ROW_BYTES = 2_000_000;

/**
 * The largest single value in a row whose other columns are small (ids,
 * sequence numbers, timestamps).
 *
 * @internal
 */
export const ROW_VALUE_BYTES = SQLITE_ROW_BYTES - 100_000;

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
 * The longest piece of split text kept in one row, in UTF-16 code units: at
 * most 1.5 MB of UTF-8, which leaves 500 KB for the row's other columns.
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
