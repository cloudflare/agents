# Postgres Session Example

Agent with session history stored in an external Postgres database via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) instead of Durable Object SQLite.

## Why external Postgres?

DO SQLite is great for per-user state, but sessions live and die with the DO. An external database gives you:

- **Cross-DO queries** — search across all conversations from any Worker
- **Analytics** — run SQL against your conversation data directly
- **Decoupled lifecycle** — session data survives DO eviction, migration, and resets
- **Shared state** — multiple DOs or services can read/write the same session tables

## Setup

### 1. Create a Postgres database

Use any Postgres provider (Neon, Supabase, PlanetScale, etc.) and copy the connection string.

### 2. Create a Hyperdrive config

```bash
npx wrangler hyperdrive create my-session-db \
  --connection-string="postgresql://user:password@host:port/dbname"
```

Update `wrangler.jsonc` with the returned Hyperdrive ID.

### 3. Create the tables

Run the migration SQL from [docs/sessions.md](../../docs/sessions.md#3-create-the-tables) in your database console. The providers do not auto-create tables — migrations are managed by you.

### 4. Deploy

```bash
npm install
npm run deploy
```

## How it works

The key difference from the standard `session-memory` example:

```ts
// Standard: auto-wires to DO SQLite
const session = Session.create(this)
  .withContext("memory", { maxTokens: 1100 })
  .withCachedPrompt();

// Postgres: pass providers explicitly
const conn = wrapPgClient(pgClient);

const session = Session.create(new PostgresSessionProvider(conn, sessionId))
  .withContext("memory", {
    maxTokens: 1100,
    provider: new PostgresContextProvider(conn, `memory_${sessionId}`)
  })
  .withContext("knowledge", {
    provider: new PostgresSearchProvider(conn)
  })
  .withCachedPrompt(new PostgresContextProvider(conn, `_prompt_${sessionId}`));
```

When `Session.create()` receives a `SessionProvider` (not a `SqlProvider`), it skips all SQLite auto-wiring. Context blocks and the prompt cache need explicit providers since there's no DO storage to fall back to.

## Connection interface

The providers use `?` placeholders internally. This example wraps the `pg` driver to convert them to `$1, $2, ...`:

```ts
interface PostgresConnection {
  execute(
    query: string,
    args?: (string | number | boolean | null)[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
```

Any Postgres driver with a compatible `execute()` method works.
