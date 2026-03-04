# Sandbox — Dynamic Code Execution with Worker Loader

An AI agent that writes JavaScript code and runs it in a **sandboxed dynamic Worker isolate**. The isolate has no internet access — its only connection to the outside world is a database binding that proxies through a sub-agent.

## How It Works

```
SandboxAgent (extends withSubAgents(AIChatAgent))
  │
  ├── executeCode tool ──▶ env.LOADER.get(id, {
  │     mainModule: "harness.js",
  │     modules: { "harness.js": ..., "user-code.js": agentCode },
  │     env: { db: DatabaseLoopback },    ← only binding
  │     globalOutbound: null,              ← no fetch()
  │     tails: [TailLoopback]              ← capture console.log
  │   })
  │
  ├── DatabaseLoopback (WorkerEntrypoint)
  │     └── proxies env.db calls back to the parent
  │
  ├── TailLoopback (WorkerEntrypoint)
  │     └── captures console output, delivers to parent
  │
  └── CustomerDatabase (SubAgent — own isolated SQLite)
        └── query() / execute() / getAllCustomers()
```

Three layers of isolation:

1. **Dynamic isolate** — code runs in a Worker with `globalOutbound: null`. No `fetch()`, no `connect()`.
2. **Restricted env** — the only binding is `env.db`, a `DatabaseLoopback` that proxies to the parent.
3. **Sub-agent storage** — the database is a child DO whose SQLite the parent can't access directly.

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
}

const SubAgentSandbox = withSubAgents(AIChatAgent);

export class SandboxAgent extends SubAgentSandbox<Env, SandboxState> {
  private _db() {
    return this.subAgent(CustomerDatabase, "database");
  }

  // DatabaseLoopback calls these — they forward to the sub-agent
  async proxyDbQuery(sql: string) {
    const db = await this._db();
    return db.query(sql);
  }
}
```

The **Loopback pattern**: dynamic Worker isolates can't hold sub-agent stubs directly — they can only have `ServiceStub` bindings. So `DatabaseLoopback` (a `WorkerEntrypoint`) proxies calls back to the parent, which delegates to the sub-agent.

Chain: `dynamic isolate → DatabaseLoopback → SandboxAgent → CustomerDatabase sub-agent`

## Quick Start

```bash
npm start
```

## Try It

1. "Count customers by tier" — agent writes code, runs in sandbox, shows output
2. "Find customers with emails containing 'example'" — agent queries via `env.db`
3. "Add a new customer named Zara" — agent calls `env.db.execute()` from sandbox
4. Check the **Executions** tab to see code + captured output
5. Check the **Customers** tab to see the database state

## Related

- [gadgets-subagents](../gadgets-subagents) — fan-out/fan-in with parallel sub-agents
- [gadgets-chat](../gadgets-chat) — multi-room chat via sub-agents
- [gadgets-gatekeeper](../gadgets-gatekeeper) — gated database access via sub-agent boundary
- [design/rfc-sub-agents.md](../../design/rfc-sub-agents.md) — RFC for the sub-agent API
