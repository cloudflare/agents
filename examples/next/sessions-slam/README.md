# Next: sessions slam

A stress test for the experimental `agents/sessions` capability on a deployed Durable Object with a real R2 tier. It is the measurement companion to [`examples/next/sessions`](../sessions): the same plain-`DurableObject` install, plus routes that time each operation and count the billed SQLite rows it wrote.

`SlamSession` wraps `ctx.storage.sql.exec` before Lifecycle installs, so every cursor's `rowsWritten` is summed, including capability migrations and maintenance. Each JSON route returns `{ ms, rowsWritten, ...result }`; `ms` is measured inside the Durable Object (Workers timers only advance across I/O, so treat the client-side column as the wall clock).

## Setup

```sh
pnpm install
wrangler r2 bucket create agents-sessions-slam
```

## Deploy

```sh
CLOUDFLARE_ACCOUNT_ID=543fbdef1eeaed8a02c251c8c4d9510b pnpm run deploy
```

Local runs work too (`pnpm run dev`, then use `http://localhost:8787`). Local R2 and SQLite behave differently from production, so record only deployed numbers.

## Run the slam

```sh
node slam.mjs https://agents-sessions-slam.<subdomain>.workers.dev <sessionName>
```

Every route is scoped to one named object: `/<sessionName>/<route>`. Use a fresh session name per run; the script starts with `POST /clear` and the uploads use fresh random bytes so nothing deduplicates.

Flags:

- `--quick` — small sizes and counts for a smoke test against `wrangler dev`.
- `--ref-32mib` — also append a message that points at the 32 MiB upload, so inline hydration of the recent window has to materialize a 32 MiB data URL.

Scenarios, in order:

1. `POST /clear`, `GET /stats`.
2. Uploads of 1 KiB, 100 KiB, 1,499,999, 1,500,000, 1,572,864, 1,572,865, 8 MiB, and 32 MiB bytes, each with a declared length (`bytes` passed to `attachments.put`) and an undeclared length (chunked request stream). Each is sha256-checked against the returned hash and against a `GET /attachment/<hash>` round trip.
3. 500 appends of 2 KiB text; 10 appends carrying the 100 KiB file pointer; 2 appends carrying the 8 MiB file pointer; 20 appends of 1.4 MiB text.
4. `append-large` with a single text part of 1,000,000 (expected inline), 1,600,000 and 5,000,000 bytes (expected pointer rows); `append-tool` with a 3,000,000-byte nested tool output (expected pointer).
5. `hydrate` with a 32 MiB budget in inline and pointer mode, recording hydrated JSON bytes against the budget.
6. `history` streamed as NDJSON in both modes, timed to first byte and to completion.
7. `fork`, `compact`, `stats`.

The script prints a markdown table (scenario, server ms, client ms, rows written, key result, check) and exits non-zero if any check fails.

## Routes

```
POST /<s>/upload?bytes=N&declared=true|false&mediaType=..&filename=..   body streamed to attachments.put
POST /<s>/append?count=N&textBytes=M&file=<hash>
POST /<s>/append-large?bytes=M
POST /<s>/append-tool?bytes=M
GET  /<s>/hydrate?budget=B&minRecent=K&mode=inline|pointer
GET  /<s>/history?mode=inline|pointer                                    NDJSON, last line is { done: true, ms, rowsWritten }
GET  /<s>/attachment/<hash>
POST /<s>/fork
POST /<s>/compact
POST /<s>/clear
GET  /<s>/stats                                                          stats() + databaseSize + per-table row counts
```

## Recording results

Paste the table, the R2 object count for the bucket (`wrangler r2 object list agents-sessions-slam` or the dashboard), and any memory-limit resets seen in Workers observability into `design/sessions.md` under the "Measured" section.
