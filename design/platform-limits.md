# Platform limits

`packages/agents/src/internal/platform-limits.ts` holds the SQLite row budget and the budgets derived from it. Streams, event logs, and the chat and harness stream segments take their row ceiling from it. Other row-sized constants still restate the 2 MB figure and are moving to it one area at a time. The module is internal. It is not exported to apps and has no docs page.

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

## Key decisions

**The budget is the lowest cap, not production's.** `wrangler dev` and the vitest pool run the workerd the developer installed, and older releases cap rows at 2.2 MB. Data written above that cap would be unreadable after a wrangler downgrade with persisted local state, or in a test pool on an older release. So `SQLITE_ROW_BYTES` is 2,000,000 today. That is below every runtime measured, even though production allows 8 MiB.

**Raising it is one edit.** When the SDK requires a runtime with the 8 MiB cap (workerd 1.20260930 or later), `SQLITE_ROW_BYTES` can go up in one change, with a boundary test for each budget. Rolling back the SDK after that is safe: the runtime enforces the cap, not our code.

**No runtime detection.** A probe per isolate would be cheap: one `SELECT length(?)` binding about 8 MB, writing no row, around 9 ms on a deployment. But it measures the runtime that writes, and the risk is a different runtime that reads later. It would also make tests and production take different split paths.

**No per-deployment option.** Nothing in the repo needs one, and a figure above the floor brings back the unreadable-row risk.

## Tradeoffs

A value between 2 MB and 8 MiB takes several rows where production could store it in one. Raising the floor would not remove the splitting code. Values over 8 MiB, such as files and long transcripts, still need the admissions, Sessions and Tasks splitters and the chat message compaction.
