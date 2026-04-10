# PlanetScale Session Example

Agent with session history stored in PlanetScale (MySQL) instead of Durable Object SQLite.

## Why PlanetScale?

DO SQLite is great for per-user state, but sessions live and die with the DO. PlanetScale gives you:

- **Cross-DO queries** — search across all conversations from any Worker
- **Analytics** — run SQL against your conversation data directly
- **Decoupled lifecycle** — session data survives DO eviction, migration, and resets
- **Shared state** — multiple DOs or services can read/write the same session tables

## Setup

### 1. Create a PlanetScale database

Sign up at [planetscale.com](https://planetscale.com) and create a database. The free hobby tier works fine for development.

### 2. Get connection credentials

In the PlanetScale dashboard → your database → **Connect** → choose `@planetscale/database` → copy the host, username, and password.

### 3. Set Worker secrets

```bash
wrangler secret put PLANETSCALE_HOST
# paste: your-db-xxxxxxx.us-east-2.psdb.cloud

wrangler secret put PLANETSCALE_USERNAME
# paste: your username

wrangler secret put PLANETSCALE_PASSWORD
# paste: your password
```

### 4. Deploy

```bash
npm install
wrangler deploy
```

Tables (`assistant_messages`, `assistant_compactions`, `cf_agents_context_blocks`) are auto-created on first request.

## How it works

The key difference from the standard `session-memory` example:

```ts
// Standard: auto-wires to DO SQLite
const session = Session.create(this)
  .withContext("memory", { maxTokens: 1100 })
  .withCachedPrompt();

// PlanetScale: pass providers explicitly
const conn = connect({ host, username, password });

const session = Session.create(
  new PlanetScaleSessionProvider(conn, sessionId)
)
  .withContext("memory", {
    maxTokens: 1100,
    provider: new PlanetScaleContextProvider(conn, `memory_${sessionId}`)
  })
  .withCachedPrompt(
    new PlanetScaleContextProvider(conn, `_prompt_${sessionId}`)
  );
```

When `Session.create()` receives a `SessionProvider` (not a `SqlProvider`), it skips all SQLite auto-wiring. Context blocks and the prompt cache need explicit providers since there's no DO storage to fall back to.

## Connection interface

The providers work with `@planetscale/database` out of the box, but any driver matching this interface works:

```ts
interface PlanetScaleConnection {
  execute(
    query: string,
    args?: (string | number | boolean | null)[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
```

This means you can also use [Neon](https://neon.tech), [Turso](https://turso.tech), or any MySQL/Postgres driver with a compatible `execute()` method.
