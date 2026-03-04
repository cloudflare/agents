# Gatekeeper — Approval Queue with Sub-Agent Isolation

An AI agent that manages a customer database, where **reads are free but writes require human approval**. The database lives in a **sub-agent** with its own isolated SQLite, so the agent structurally cannot bypass the approval queue.

## How It Works

```
GatekeeperAgent (extends withSubAgents(AIChatAgent))
  │
  │  LLM ──▶ Tools ──▶ Approval Queue (action_queue table, parent SQLite)
  │                         │
  │  ┌──────────────────────▼──────────────────────────────────────┐
  │  │  CustomerDatabase (SubAgent — own isolated SQLite)          │
  │  │  query() / execute() / getAllCustomers()                    │
  │  │  ┌──────────────────────────────────────────────────────┐   │
  │  │  │  customers table (parent CANNOT access directly)     │   │
  │  │  └──────────────────────────────────────────────────────┘   │
  │  └─────────────────────────────────────────────────────────────┘
```

The parent has no path to customer data except through the sub-agent's typed RPC methods. This makes the approval queue structurally enforceable — not just a convention.

## Key Pattern

```typescript
import { SubAgent, withSubAgents } from "agents/experimental/subagent";

export class CustomerDatabase extends SubAgent<Env> {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS customers (...)`;
  }

  query(sql: string): Record<string, unknown>[] {
    /* ... */
  }
  execute(sql: string): { success: boolean } {
    /* ... */
  }
  getAllCustomers(): CustomerRecord[] {
    /* ... */
  }
}

const SubAgentChat = withSubAgents(AIChatAgent);

export class GatekeeperAgent extends SubAgentChat<Env, GatekeeperState> {
  private _getDb() {
    return this.subAgent(CustomerDatabase, "database");
  }

  // The ONLY path to mutate customer data
  async approveAction(id: number) {
    const db = await this._getDb();
    db.execute(action.sql);
  }
}
```

The LLM's `mutateDatabase` tool queues actions for approval. The `queryDatabase` tool reads freely via `db.query()`. Only `approveAction()` calls `db.execute()`.

## Quick Start

```bash
npm start
```

## Try It

1. "Show me all customers" — reads via `db.query()`, logged as observation
2. "Upgrade all East customers to Gold" — queued for approval
3. Click **Approve** — executes via `db.execute()`, table updates
4. Click **Revert** — undone via `db.execute(revertSql)`
5. Click **Reject** — nothing happens

## Related

- [gadgets-subagents](../gadgets-subagents) — fan-out/fan-in with parallel sub-agents
- [gadgets-chat](../gadgets-chat) — multi-room chat via sub-agents
- [gadgets-sandbox](../gadgets-sandbox) — isolated database sub-agent with dynamic Worker isolates
- [design/rfc-sub-agents.md](../../design/rfc-sub-agents.md) — RFC for the sub-agent API
