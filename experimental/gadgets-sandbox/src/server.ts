/**
 * Sandbox Example — Dynamic Code Execution with Worker Loader
 *
 * The AI agent writes JavaScript code, which runs in a dynamically loaded
 * Worker isolate. The isolate has NO access to the internet (globalOutbound
 * is null) — its only connection to the outside world is an `env.db` binding
 * that proxies back to the CustomerDatabase facet.
 *
 * This is the full Gadgets stack:
 *
 *   ┌─────────── SandboxAgent (parent DO) ──────────────────────────┐
 *   │                                                                │
 *   │  LLM ──▶ executeCode tool ──▶ env.LOADER                     │
 *   │                                   │                            │
 *   │         ┌─────────────────────────┼─────────────────────┐     │
 *   │         │  Dynamic Isolate        │                     │     │
 *   │         │  (agent-written code)   │                     │     │
 *   │         │  - no fetch()           │                     │     │
 *   │         │  - no connect()         │                     │     │
 *   │         │  - env.db is the        │                     │     │
 *   │         │    ONLY binding         │                     │     │
 *   │         └─────────────────────────┼─────────────────────┘     │
 *   │                                   │                            │
 *   │         DatabaseLoopback ◀────────┘                            │
 *   │              │ (WorkerEntrypoint that proxies to facet)        │
 *   │              ▼                                                 │
 *   │  ┌─────────────────────────────────────────────────────┐      │
 *   │  │  CustomerDatabase (facet — own isolated SQLite)     │      │
 *   │  │  query() / execute() / getAllCustomers()            │      │
 *   │  └─────────────────────────────────────────────────────┘      │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Three layers of isolation:
 * 1. The dynamic isolate can't reach the internet (globalOutbound: null)
 * 2. The only binding is env.db, which goes through DatabaseLoopback
 * 3. The DatabaseLoopback proxies to the CustomerDatabase facet, which
 *    has its own SQLite the parent can't access directly
 *
 * Console output from the isolate is captured via Tail events and
 * delivered back to the parent through TailLoopback.
 */

import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SandboxState = {
  customers: CustomerRecord[];
  executions: ExecutionRecord[];
};

export type CustomerRecord = {
  id: number;
  name: string;
  email: string;
  tier: string;
  region: string;
};

export type ExecutionRecord = {
  id: string;
  code: string;
  output: string;
  error: string | null;
  timestamp: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// CustomerDatabase — facet with isolated SQLite
// ─────────────────────────────────────────────────────────────────────────────

export class CustomerDatabase extends DurableObject<Env> {
  private db: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this._init();
  }

  private _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'Bronze',
        region TEXT NOT NULL DEFAULT 'Unknown'
      )
    `);
    const row = this.db.exec("SELECT COUNT(*) as cnt FROM customers").one() as {
      cnt: number;
    };
    if (row.cnt === 0) {
      this.db.exec(`INSERT INTO customers (name, email, tier, region) VALUES
        ('Alice Chen', 'alice@example.com', 'Gold', 'West'),
        ('Bob Martinez', 'bob@example.com', 'Silver', 'East'),
        ('Carol Johnson', 'carol@example.com', 'Bronze', 'West'),
        ('Dave Kim', 'dave@example.com', 'Gold', 'Central'),
        ('Eve Williams', 'eve@example.com', 'Silver', 'East'),
        ('Frank Brown', 'frank@example.com', 'Bronze', 'West'),
        ('Grace Lee', 'grace@example.com', 'Gold', 'Central'),
        ('Hank Davis', 'hank@example.com', 'Silver', 'East')
      `);
    }
  }

  query(sqlText: string): Record<string, unknown>[] {
    return [...this.db.exec(sqlText).toArray()] as Record<string, unknown>[];
  }

  execute(sqlText: string): { success: boolean } {
    this.db.exec(sqlText);
    return { success: true };
  }

  getAllCustomers(): CustomerRecord[] {
    return [
      ...this.db
        .exec("SELECT id, name, email, tier, region FROM customers ORDER BY id")
        .toArray()
    ] as CustomerRecord[];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DatabaseLoopback — WorkerEntrypoint that proxies to the facet
//
// Dynamic isolates (from env.LOADER) can have ServiceStubs in their env
// but not direct facet stubs. So we create a WorkerEntrypoint whose methods
// proxy to the CustomerDatabase facet.
//
// The dynamic isolate sees `env.db` as a service binding. When the code
// calls `env.db.query(sql)`, it goes:
//   dynamic isolate → DatabaseLoopback → SandboxAgent.proxyDbQuery() → facet
//
// This is the Gatekeeper Loopback pattern — see gadgets.md.
// ─────────────────────────────────────────────────────────────────────────────

type LoopbackProps = {
  agentId: string;
};

export class DatabaseLoopback extends WorkerEntrypoint<Env, LoopbackProps> {
  private _agentId: string = this.ctx.props.agentId;

  private _getAgent(): DurableObjectStub<SandboxAgent> {
    // @ts-expect-error — experimental: ctx.exports
    const ns = this.ctx.exports
      .SandboxAgent as DurableObjectNamespace<SandboxAgent>;
    return ns.get(ns.idFromString(this._agentId));
  }

  /** Called by code in the dynamic isolate: env.db.query(sql) */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    return this._getAgent().proxyDbQuery(sql);
  }

  /** Called by code in the dynamic isolate: env.db.execute(sql) */
  async execute(sql: string): Promise<{ success: boolean }> {
    return this._getAgent().proxyDbExecute(sql);
  }

  /** Called by code in the dynamic isolate: env.db.getAllCustomers() */
  async getAllCustomers(): Promise<CustomerRecord[]> {
    return this._getAgent().proxyDbGetAll();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TailLoopback — captures console output from dynamic isolates
//
// When code in the dynamic isolate calls console.log(), the output is
// captured as a Tail event. This WorkerEntrypoint receives those events
// and delivers them back to the SandboxAgent.
// ─────────────────────────────────────────────────────────────────────────────

type TailLoopbackProps = {
  executionId: string;
  agentId: string;
};

export class TailLoopback extends WorkerEntrypoint<Env, TailLoopbackProps> {
  async tail(events: TraceItem[]) {
    if (events.length === 0) return;

    const event = events[0];
    // Skip the verify() call trace
    if (
      event.event &&
      "rpcMethod" in event.event &&
      event.event.rpcMethod === "verify"
    ) {
      return;
    }

    // Round-trip through JSON to make traces serializable
    const serializable = JSON.parse(JSON.stringify(event));

    // ctx.exports is available on WorkerEntrypoints in the experimental runtime,
    // but the types only declare it on DurableObjectState.
    // @ts-expect-error — experimental: ctx.exports on WorkerEntrypoint
    const ns = this.ctx.exports
      .SandboxAgent as DurableObjectNamespace<SandboxAgent>;
    const stub = ns.get(ns.idFromString(this.ctx.props.agentId));
    await stub.deliverTrace(this.ctx.props.executionId, serializable);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness code — wraps agent-written code in a WorkerEntrypoint
// ─────────────────────────────────────────────────────────────────────────────

const CODE_HARNESS = `
import { WorkerEntrypoint } from "cloudflare:workers";
import run from "user-code.js";

export default class extends WorkerEntrypoint {
  verify() {}
  async run() {
    await run(this.env);
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// SandboxAgent
// ─────────────────────────────────────────────────────────────────────────────

export class SandboxAgent extends AIChatAgent<Env, SandboxState> {
  initialState: SandboxState = {
    customers: [],
    executions: []
  };

  async onStart() {
    this._initTables();
    await this._syncState();
  }

  // ─── Database facet ──────────────────────────────────────────────────

  private _dbFacet(): Pick<
    CustomerDatabase,
    "query" | "execute" | "getAllCustomers"
  > {
    // @ts-expect-error — experimental: ctx.facets, ctx.exports
    return this.ctx.facets.get("database", () => ({
      // @ts-expect-error — experimental: ctx.exports
      class: this.ctx.exports.CustomerDatabase
    }));
  }

  // These proxy methods are called by DatabaseLoopback, which is called
  // by code running in the dynamic isolate. The chain is:
  //   isolate code → env.db (DatabaseLoopback) → these methods → facet

  async proxyDbQuery(sql: string): Promise<Record<string, unknown>[]> {
    return this._dbFacet().query(sql);
  }

  async proxyDbExecute(sql: string): Promise<{ success: boolean }> {
    return this._dbFacet().execute(sql);
  }

  async proxyDbGetAll(): Promise<CustomerRecord[]> {
    return this._dbFacet().getAllCustomers();
  }

  // ─── Tables ──────────────────────────────────────────────────────────

  private _initTables() {
    this.sql`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
  }

  // ─── State sync ──────────────────────────────────────────────────────

  private async _syncState() {
    const customers = await this._dbFacet().getAllCustomers();
    const executions = this.sql<ExecutionRecord>`
      SELECT id, code, output, error, timestamp
      FROM executions ORDER BY timestamp DESC LIMIT 20
    `;
    this.setState({ customers, executions });
  }

  // ─── Trace delivery (from TailLoopback) ──────────────────────────────

  #traceResolvers = new Map<string, (trace: TraceItem) => void>();

  async deliverTrace(executionId: string, trace: TraceItem) {
    const resolver = this.#traceResolvers.get(executionId);
    if (resolver) {
      resolver(trace);
      this.#traceResolvers.delete(executionId);
    }
  }

  // ─── Code execution via LOADER ───────────────────────────────────────

  /**
   * Execute user/agent-written code in a sandboxed dynamic Worker isolate.
   *
   * The isolate gets:
   *   - env.db: a DatabaseLoopback binding (the ONLY way to reach data)
   *   - globalOutbound: null (no fetch, no connect — fully sandboxed)
   *   - tails: [TailLoopback] to capture console.log output
   *
   * This follows the Gadgets code execution pattern — see gadgets.md.
   */
  private async _executeCode(code: string): Promise<{
    output: string;
    error: string | null;
  }> {
    const executionId = crypto.randomUUID();

    // Set up a promise that resolves when the tail event arrives
    const tracePromise = new Promise<TraceItem>((resolve) => {
      this.#traceResolvers.set(executionId, resolve);
    });

    // Build the loopback bindings. The dynamic isolate will see env.db
    // as a service binding pointing at DatabaseLoopback, which proxies
    // back to our facet.
    const loopbackProps: LoopbackProps = {
      agentId: this.ctx.id.toString()
    };
    const tailProps: TailLoopbackProps = {
      executionId,
      agentId: this.ctx.id.toString()
    };

    // @ts-expect-error — experimental: ctx.exports
    const dbBinding = this.ctx.exports.DatabaseLoopback({
      props: loopbackProps
    });
    // @ts-expect-error — experimental: ctx.exports
    const tailBinding = this.ctx.exports.TailLoopback({ props: tailProps });

    // Create the dynamic isolate via the Worker Loader.
    // Each execution gets a unique ID so isolates don't collide.
    const worker = this.env.LOADER.get(executionId, () => ({
      compatibilityDate: "2026-01-28",
      mainModule: "harness.js",
      modules: {
        "harness.js": CODE_HARNESS,
        "user-code.js": code
      },
      // The ONLY binding the code gets — everything else is blocked
      env: { db: dbBinding },
      // Capture console.log output
      tails: [tailBinding],
      // No internet access
      globalOutbound: null
    }));

    // Verify the code compiles and the isolate starts.
    // We cast because getEntrypoint's type expects a WorkerEntrypoint brand,
    // but our harness is dynamically loaded.
    const entrypoint = worker.getEntrypoint() as unknown as {
      verify(): Promise<void>;
      run(): Promise<void>;
    };
    await entrypoint.verify();

    // Run the code
    let error: string | null = null;
    try {
      await entrypoint.run();
    } catch (err) {
      error = err instanceof Error && err.stack ? err.stack : String(err);
    }

    // Wait for the tail event (with timeout)
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 5000)
    );
    const trace = await Promise.race([tracePromise, timeout]);

    let output = "";
    if (trace) {
      output = (trace.logs || [])
        .map((log: { message: unknown[] }) =>
          (log.message as unknown[])
            .map((part) =>
              typeof part === "string" ? part : JSON.stringify(part)
            )
            .join(" ")
        )
        .join("\n");
    }

    if (error) {
      output += (output ? "\n\n" : "") + `Error: ${error}`;
    }

    return { output: output || "(no output)", error };
  }

  // ─── Chat ────────────────────────────────────────────────────────────

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const agent = this;

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are a helpful assistant that can write and execute JavaScript code to work with a customer database.

You have access to an executeCode tool. The code you write runs in a SANDBOX — a completely
isolated environment with no internet access. The only thing the code can do is interact with
a customer database through the \`env.db\` binding.

Available methods on env.db:
- env.db.query(sql) — run a SELECT query, returns an array of row objects
- env.db.execute(sql) — run INSERT/UPDATE/DELETE, returns { success: true }
- env.db.getAllCustomers() — returns all customers as an array

The database has a "customers" table with columns: id, name, email, tier (Bronze/Silver/Gold), region (West/East/Central).

Your code must export a default async function that receives env:

\`\`\`js
export default async function(env) {
  const rows = await env.db.query("SELECT * FROM customers WHERE tier = 'Gold'");
  console.log("Gold customers:", rows.length);
  for (const row of rows) {
    console.log(\`  - \${row.name} (\${row.region})\`);
  }
}
\`\`\`

console.log() output is captured and returned. Use it to show results.
Write clean, readable code. Handle errors gracefully.`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        executeCode: tool({
          description:
            "Execute JavaScript code in a sandboxed Worker isolate. " +
            "The code has no internet access — only env.db for database operations. " +
            "Console output is captured and returned.",
          inputSchema: z.object({
            code: z
              .string()
              .describe(
                "JavaScript module exporting a default async function(env). " +
                  "Use env.db.query(sql), env.db.execute(sql), or env.db.getAllCustomers(). " +
                  "Use console.log() to produce output."
              )
          }),
          execute: async ({ code }) => {
            try {
              const { output, error } = await agent._executeCode(code);

              // Persist the execution
              const id = crypto.randomUUID();
              agent.sql`
                INSERT INTO executions (id, code, output, error)
                VALUES (${id}, ${code}, ${output}, ${error})
              `;
              await agent._syncState();

              return { output, error };
            } catch (err) {
              return { output: "", error: String(err) };
            }
          }
        }),

        queryDatabase: tool({
          description:
            "Directly query the database with a SELECT. " +
            "Use this for simple queries; use executeCode for complex logic.",
          inputSchema: z.object({
            sql: z.string().describe("A SELECT query")
          }),
          execute: async ({ sql }) => {
            try {
              const results = await agent._dbFacet().query(sql);
              return { rowCount: results.length, rows: results };
            } catch (err) {
              return { error: String(err) };
            }
          }
        })
      },
      stopWhen: stepCountIs(5)
    });

    return result.toUIMessageStreamResponse();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
