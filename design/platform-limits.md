# Platform limits

`packages/agents/src/internal/platform-limits.ts` holds the SQLite row budget and the budgets derived from it. Streams, event logs, chat message compaction and chunk storage, held-message pieces, Sessions chunks and attachments, and the chat and harness stream segments take their row ceiling from it. Tasks sets its run-row caps (inline input 500,000 units, framework metadata 1.9 MB) together, because one run row holds several of them. The harness store splits at its own 256 K units. The module is internal. It is not exported to apps and has no docs page.

## How it works

`SQLITE_ROW_BYTES` is the row size every budget is computed from. The budgets callers use are derived from it in the same file, never restated. For example, `ROW_VALUE_BYTES` is the largest single value in a row whose other columns are small (ids, sequence numbers, timestamps), and it is `SQLITE_ROW_BYTES - 100_000`. The Streams flush, the event log's highest `maxEventBytes`, and the chat and harness stream segments all use it.

The module holds constants only. It owns no storage and pushes no jobs, so it is a plain module, not a capability.

## What the platform enforces

Measured 23 Nov 2026 on a deployed SQLite-backed Durable Object, and on local workerd. The probe binary-searches each limit inside one object. The [limits page](https://developers.cloudflare.com/durable-objects/platform/limits/) gives the documented figures.

| Limit                                               | Production                                                                   | Local workerd                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| One row, all columns together, and each bound value | 8,388,637 bytes                                                              | 8,388,637 bytes from 1.20260930. 4,194,299 in 1.20260820 and 1.20260908. 2,199,995 up to 1.20260804 |
| KV value or key (`storage.put`, `storage.kv.put`)   | the same row cap, key and value together                                     | the same                                                                                            |
| SQL statement                                       | 100,000 bytes                                                                | the same                                                                                            |
| Bound parameters per statement                      | 100                                                                          | the same                                                                                            |
| Columns per table                                   | 100                                                                          | the same                                                                                            |
| Arguments per SQL function                          | 127 (the docs say 32)                                                        | the same                                                                                            |
| WebSocket message, either direction                 | 33,554,359 bytes (32 MiB less 73). A larger send is dropped without an error | 32 MiB in, no cap seen out                                                                          |
| RPC argument or return value                        | about 32 MiB less 200 bytes                                                  | about 32 MiB less 20 bytes                                                                          |

Past the row cap SQLite throws `string or blob too big: SQLITE_TOOBIG`. Inside `transactionSync`, a caught TOOBIG leaves the transaction usable. An uncaught one rolls it back.

A runtime cannot read a row larger than its own cap. A 5 MB value written by workerd 1.20261012 and read by 1.20260722 from the same storage fails with TOOBIG, even for `SELECT length(v)`.

**Row size is not item size.** The floor sets how much fits in one row. What the SDK keeps to replay later (a stream chunk, an event, a chat chunk body, the indexed text of a search hit) is capped by `REPLAY_ITEM_BYTES`, 1.9 MB, which did not move with the floor. Replays, search results and `getAgentToolChunks` send many items at once, and each WebSocket message or RPC reply holds 32 MiB at most (production drops a larger outbound message without an error). So those readers also page by bytes: at most `REPLAY_PAGE_BYTES` (16 MiB) per frame, reply or search result, as well as by count.

## Key decisions

**The budget is the lowest cap of the runtimes the SDK supports.** `wrangler dev` and the Vitest pool run the workerd the developer installed. A row above a runtime's cap cannot be read by that runtime. `SQLITE_ROW_BYTES` is 8,000,000: production, wrangler 4.145.0 and later, and `@cloudflare/vitest-plugin` 1.9.1 and later all hold 8,388,637 bytes, which leaves 388,637 bytes for a row's other columns. Until 24 Nov 2026 it was 2,000,000, because the Vitest pool then (`@cloudflare/vitest-pool-workers`) held 2.2 MB. Local runtimes older than workerd 1.20260930 are not supported. On them, a large write fails with `SQLITE_TOOBIG`, and `SqlError` says to upgrade.

**Raising it is one edit, once every runtime the SDK runs on holds 8 MiB.** The condition: the Vitest pool and the `wrangler` this repo installs both ship workerd 1.20260930 or later. Both do now. Wrangler ^4.145.0 ships 1.20260930.2. The pool is `@cloudflare/vitest-plugin` 1.9.1, which ships 1.20261123.1, measured at 8,388,637 bytes. It replaced the deprecated `@cloudflare/vitest-pool-workers`, whose last release (0.23.0) ships 1.20260815.1, measured at 2,199,995 bytes. A floor above the pool's cap would make our tests, and every app's tests, fail with `SQLITE_TOOBIG` on rows production accepts.

`packages/agents/src/tests/platform-limits.test.ts` binds an 8,000,000-byte value in the installed pool, without writing a row, and fails if the pool can no longer hold it. Size errors in tests use values over every cap: `sql-error.test.ts` and the State capability test bind 9,000,000 bytes. `sql-error.test.ts` checks the size message against `SQLITE_ROW_BYTES`; the State test checks the production cap in it. The raising change:

- Edit only `SQLITE_ROW_BYTES`. Every budget follows: `ROW_VALUE_BYTES`, `ROW_MAX_BYTES`, `ROW_PIECE_UNITS`, and through them the Streams flush, event log, chat stream and harness stream ceilings, chat message compaction, held-message and Tasks input pieces, and Sessions chunks. Keep a margin under the measured 8,388,637 bytes for the other columns in a row. 8,000,000 leaves 388 KB.
- Add a boundary test per budget: a value exactly at it is stored in one row, and one byte more splits, is compacted, or is refused, as that caller does today.
- Put cost in the PR: rows written per 2, 5 and 10 MB value, before and after.
- Probe on a deployment: write 2-8 MB values with the new code, then deploy the previous SDK release over the same objects and read them back. Sessions has been measured reading slices of either size; Streams, chat and Tasks need the same check.
- In the changeset and in the docs where the SDK lists its requirements, state the minimum wrangler and pool versions for local development. #3065's `SqlError` message already names the caps and says an older local runtime must be upgraded.

**No runtime detection.** A probe per isolate would be cheap: one `SELECT length(?)` binding about 8 MB, writing no row, around 9 ms on a deployment. But it measures the runtime that writes, and the risk is a different runtime that reads later. It would also make tests and production take different split paths.

**No per-deployment option.** Nothing in the repo needs one, and a figure above the floor brings back the unreadable-row risk.

## Tradeoffs

The splitters stay. Values over 8 MB, such as files and long transcripts, still need them. One row read can now bring up to 8 MB into memory, against 2 MB before, out of an isolate's 128 MB. Readers that page by row (Sessions history in 4 MiB batches, Streams replay one block at a time) hold one such row at a time. Local runtimes older than workerd 1.20260930 cannot read rows this code writes.
