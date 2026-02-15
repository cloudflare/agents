/**
 * Gatekeeper Example — with Durable Object Facets
 *
 * The CustomerDatabase is a FACET — a child Durable Object created by the
 * GatekeeperAgent via ctx.facets.get(). It has its own isolated SQLite
 * that the parent cannot access directly. The parent can only call the
 * facet's RPC methods: query(), execute(), getAllCustomers().
 *
 * This makes the approval queue structurally enforceable: the agent
 * literally cannot bypass it because it has no path to the customer data
 * except through the facet stub.
 *
 * Requires the "experimental" compatibility flag for ctx.facets and
 * ctx.exports.
 */

import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { DurableObject } from "cloudflare:workers";
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Types shared between server and client
// ─────────────────────────────────────────────────────────────────────────────

export type ActionEntry = {
  id: number;
  type: "action" | "observation";
  title: string;
  description: string;
  sql: string;
  state: "pending" | "approved" | "rejected" | "reverted";
  canRevert: boolean;
  revertSql: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type GatekeeperState = {
  actions: ActionEntry[];
  customers: CustomerRecord[];
};

export type CustomerRecord = {
  id: number;
  name: string;
  email: string;
  tier: string;
  region: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// CustomerDatabase — Facet (plain DurableObject, isolated storage)
//
// NOT listed in wrangler.jsonc bindings or migrations. Instantiated by the
// parent GatekeeperAgent via ctx.facets.get("database", factory).
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

/**
 * Typed interface for the facet stub returned by ctx.facets.get().
 * Facet calls are RPC — all methods become async.
 */
interface DatabaseFacet {
  query(sql: string): Promise<Record<string, unknown>[]>;
  execute(sql: string): Promise<{ success: boolean }>;
  getAllCustomers(): Promise<CustomerRecord[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Gatekeeper Agent
// ─────────────────────────────────────────────────────────────────────────────

export class GatekeeperAgent extends AIChatAgent<Env, GatekeeperState> {
  initialState: GatekeeperState = {
    actions: [],
    customers: []
  };

  async onStart() {
    this._initQueue();
    await this._syncState();
  }

  // ─── Facet access ────────────────────────────────────────────────────

  /**
   * Get (or create) the CustomerDatabase facet.
   *
   * ctx.facets.get() returns a stub to a child DO with its own isolated
   * SQLite. The factory tells the runtime which class to instantiate,
   * using ctx.exports to reference the exported CustomerDatabase class.
   *
   * The returned stub is an RPC proxy — calls execute in the facet's
   * context, not the parent's.
   */
  private _getDb(): DatabaseFacet {
    // @ts-expect-error — ctx.facets is experimental (requires "experimental" compat flag)
    return this.ctx.facets.get("database", () => ({
      // @ts-expect-error — ctx.exports is experimental
      class: this.ctx.exports.CustomerDatabase
    })) as DatabaseFacet;
  }

  // ─── Queue table ─────────────────────────────────────────────────────

  private _initQueue() {
    this.sql`
      CREATE TABLE IF NOT EXISTS action_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL DEFAULT 'action',
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        sql_statement TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        can_revert INTEGER NOT NULL DEFAULT 0,
        revert_sql TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )
    `;
  }

  // ─── State sync ──────────────────────────────────────────────────────

  private async _syncState() {
    const actions = this.sql<ActionEntry>`
      SELECT id, type, title, description,
             sql_statement as sql, state,
             can_revert as canRevert, revert_sql as revertSql,
             created_at as createdAt, resolved_at as resolvedAt
      FROM action_queue ORDER BY id DESC
    `;

    const customers = await this._getDb().getAllCustomers();

    this.setState({
      actions: actions.map((a) => ({ ...a, canRevert: Boolean(a.canRevert) })),
      customers
    });
  }

  // ─── Gatekeeper API ──────────────────────────────────────────────────

  private async _logObservation(title: string, desc: string, sql: string) {
    this.sql`
      INSERT INTO action_queue (type, title, description, sql_statement, state, can_revert)
      VALUES ('observation', ${title}, ${desc}, ${sql}, 'approved', 0)
    `;
    await this._syncState();
  }

  private async _submitAction(
    title: string,
    desc: string,
    sql: string,
    revertSql: string | null
  ): Promise<number> {
    this.sql`
      INSERT INTO action_queue (type, title, description, sql_statement, state, can_revert, revert_sql)
      VALUES ('action', ${title}, ${desc}, ${sql}, 'pending', ${revertSql ? 1 : 0}, ${revertSql})
    `;
    const result = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`;
    await this._syncState();
    return result[0].id;
  }

  @callable()
  async approveAction(actionId: number) {
    const rows = this.sql<{ sql_statement: string; state: string }>`
      SELECT sql_statement, state FROM action_queue WHERE id = ${actionId}
    `;
    if (rows.length === 0) throw new Error(`Action ${actionId} not found`);
    if (rows[0].state !== "pending") throw new Error(`Not pending`);

    await this._getDb().execute(rows[0].sql_statement);

    this.sql`
      UPDATE action_queue SET state = 'approved', resolved_at = datetime('now')
      WHERE id = ${actionId}
    `;
    await this._syncState();
  }

  @callable()
  async rejectAction(actionId: number) {
    const rows = this.sql<{ state: string }>`
      SELECT state FROM action_queue WHERE id = ${actionId}
    `;
    if (rows.length === 0) throw new Error(`Action ${actionId} not found`);
    if (rows[0].state !== "pending") throw new Error(`Not pending`);

    this.sql`
      UPDATE action_queue SET state = 'rejected', resolved_at = datetime('now')
      WHERE id = ${actionId}
    `;
    await this._syncState();
  }

  @callable()
  async revertAction(actionId: number) {
    const rows = this.sql<{
      state: string;
      revert_sql: string | null;
      can_revert: number;
    }>`
      SELECT state, revert_sql, can_revert FROM action_queue WHERE id = ${actionId}
    `;
    if (rows.length === 0) throw new Error(`Action ${actionId} not found`);
    if (rows[0].state !== "approved") throw new Error(`Not approved`);
    if (!rows[0].can_revert || !rows[0].revert_sql)
      throw new Error(`Not revertable`);

    await this._getDb().execute(rows[0].revert_sql);

    this.sql`
      UPDATE action_queue SET state = 'reverted', resolved_at = datetime('now')
      WHERE id = ${actionId}
    `;
    await this._syncState();
  }

  // ─── Chat ────────────────────────────────────────────────────────────

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const agent = this;

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are a helpful database administrator assistant. You manage a customer database.

You can query the database freely — reads are always allowed. But any changes to the data
(INSERT, UPDATE, DELETE) will be submitted for human approval before they execute. This is
the "Gatekeeper" pattern: you propose changes, a human reviews them.

The database has a "customers" table with columns: id, name, email, tier (Bronze/Silver/Gold), region (West/East/Central).

When proposing changes:
- Be specific about what will change and why
- Generate correct SQL — the human will see the exact query
- For UPDATEs, mention how many rows will be affected
- For DELETEs, warn about data loss

Important: After submitting an action for approval, tell the user it's been queued and they
can approve or reject it in the action panel. Don't say it's been done — it hasn't happened yet.`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        queryDatabase: tool({
          description:
            "Query the customer database with a SELECT statement. " +
            "Reads are always allowed and auto-logged.",
          inputSchema: z.object({
            sql: z.string().describe("A SELECT query"),
            description: z.string().describe("What this query looks for")
          }),
          execute: async ({ sql, description }) => {
            const trimmed = sql.trim().toUpperCase();
            if (!trimmed.startsWith("SELECT")) {
              return {
                error: "Only SELECT allowed. Use mutateDatabase for writes."
              };
            }
            await agent._logObservation(
              `Query: ${description}`,
              description,
              sql
            );
            try {
              const results = await agent._getDb().query(sql);
              return { sql, rowCount: results.length, rows: results };
            } catch (err) {
              return { error: `SQL error: ${err}` };
            }
          }
        }),

        mutateDatabase: tool({
          description:
            "Propose a change (INSERT, UPDATE, DELETE). " +
            "Queued for human approval — will NOT execute immediately.",
          inputSchema: z.object({
            title: z.string().describe("Short title for the action"),
            description: z.string().describe("What this change does"),
            sql: z.string().describe("The SQL mutation"),
            revertSql: z
              .string()
              .nullable()
              .describe("SQL to undo this action, or null if not revertable")
          }),
          execute: async ({ title, description, sql, revertSql }) => {
            const trimmed = sql.trim().toUpperCase();
            if (trimmed.startsWith("SELECT")) {
              return { error: "Use queryDatabase for SELECTs." };
            }
            const actionId = await agent._submitAction(
              title,
              description,
              sql,
              revertSql
            );
            return {
              actionId,
              status: "pending",
              message: `Action #${actionId} queued for approval.`
            };
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
