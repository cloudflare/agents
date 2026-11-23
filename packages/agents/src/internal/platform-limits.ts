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
