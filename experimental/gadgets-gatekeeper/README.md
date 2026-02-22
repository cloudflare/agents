# Gatekeeper — Approval Queue with Durable Object Facets

An AI agent that manages a customer database, where **reads are free but writes require human approval**. The database lives in a **facet** — a child Durable Object with its own isolated SQLite — so the agent cannot bypass the approval queue.

## The Pattern

```
  ┌─────────── GatekeeperAgent (parent DO, own SQLite) ─────────────┐
  │                                                                   │
  │  LLM ──▶ Tools ──▶ Approval Queue (action_queue table)           │
  │                         │                                         │
  │  ┌──────────────────────┼──────────────────────────────────────┐  │
  │  │  CustomerDatabase    ▼    (FACET — own isolated SQLite)     │  │
  │  │                query() / execute()                          │  │
  │  │  ┌──────────────────────────────────────────────────────┐   │  │
  │  │  │  customers table (parent CANNOT access this)         │   │  │
  │  │  └──────────────────────────────────────────────────────┘   │  │
  │  └─────────────────────────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────────────────────┘
```

The CustomerDatabase is created via `ctx.facets.get("database", factory)` — the experimental Durable Object Facets API. The parent gets back an RPC stub. It cannot access the facet's `ctx.storage.sql` directly.

## Interesting Files

### `src/server.ts`

- **`CustomerDatabase`** — plain `DurableObject` subclass with its own SQLite. Exposes `query()`, `execute()`, `getAllCustomers()`. NOT in wrangler.jsonc bindings or migrations — it's a facet.
- **`_getDb()`** — calls `this.ctx.facets.get("database", ...)` with `this.ctx.exports.CustomerDatabase` as the class. Returns a typed facet stub. Uses `@ts-expect-error` for the experimental APIs.
- **`approveAction()`** — calls `db.execute(sql)` on the facet. This is the only path to mutate customer data.
- **Tool definitions** — `queryDatabase` reads via `db.query()`, `mutateDatabase` submits to the queue.

### `wrangler.jsonc`

Uses `"experimental"` compat flag for `ctx.facets` and `ctx.exports`. Only `GatekeeperAgent` is in DO bindings — `CustomerDatabase` is not independently addressable.

## Quick Start

```bash
npm start
```

## Try It

1. "Show me all customers" → reads via `db.query()`, logged as observation
2. "Upgrade all East customers to Gold" → queued for approval
3. Click **Approve** → executes via `db.execute()`, table updates
4. Click **Revert** → undone via `db.execute(revertSql)`
5. Click **Reject** → nothing happens

## Origin

Pattern from the [Gadgets architecture](../gadgets.md) — maps to the Gatekeeper/ApprovalQueue interfaces. See the design doc for the full analysis.
