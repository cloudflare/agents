# PlanetScale Postgres Session Example

Agent with session history stored in an external Postgres database via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) instead of Durable Object SQLite.

## Why external Postgres?

DO SQLite is great for per-user state and persists across hibernation and eviction. An external database is useful when you need access outside one Durable Object's local storage:

- **Cross-DO queries** — search across all conversations from any Worker
- **Analytics** — run SQL against your conversation data directly
- **Decoupled ownership** — session data can be managed outside a single DO identity
- **Shared state** — multiple DOs or services can read/write the same session tables

## Setup

### 1. Create a Postgres database

Use PlanetScale Postgres or another Postgres provider (Neon, Supabase, etc.) and copy the connection string.

### 2. Create a Hyperdrive config

```bash
npx wrangler hyperdrive create my-session-db \
  --connection-string="postgresql://user:password@host:port/dbname"
```

Update `wrangler.jsonc` with the returned Hyperdrive ID. The checked-in config intentionally uses a placeholder so deploys fail until you configure your own database.

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
const session = Session.create(new PostgresSessionProvider(pgClient, sessionId))
  .withContext("memory", {
    maxTokens: 1100,
    provider: new PostgresContextProvider(pgClient, `memory_${sessionId}`)
  })
  .withContext("knowledge", {
    provider: new PostgresSearchProvider(pgClient)
  })
  .withCachedPrompt(
    new PostgresContextProvider(pgClient, `_prompt_${sessionId}`)
  );
```

When `Session.create()` receives a `SessionProvider` (not a `SqlProvider`), it skips all SQLite auto-wiring. Context blocks and the prompt cache need explicit providers since there's no DO storage to fall back to.

## Connection interface

The providers accept a raw `pg.Client` or any custom driver that implements `PostgresConnection`. When a `pg`-style client is passed, the provider adapter rewrites internal `?` placeholders to `$1, $2, ...` automatically:

```ts
interface PostgresConnection {
  execute(
    query: string,
    args?: (string | number | boolean | null)[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
```

Use `PostgresConnection` for tests or bespoke drivers; use raw `pg.Client` for Hyperdrive.
