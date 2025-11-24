import { DurableObject } from "cloudflare:workers";
import type {
  AgentBlueprint,
  ThreadMetadata,
  ThreadRequestContext
} from "../types";
import { getAgentByName } from "../..";
import type { AgentEnv } from "./index";

function validateBlueprint(bp: AgentBlueprint): string | null {
  if (!bp.name || !/^[a-zA-Z0-9_-]+$/.test(bp.name)) {
    return "Blueprint name must be alphanumeric with - or _";
  }
  if (!bp.prompt || typeof bp.prompt !== "string") {
    return "Blueprint must have a prompt";
  }
  return null;
}

export class Agency extends DurableObject<AgentEnv> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Initialize tables
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS blueprints (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL, -- JSON
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT -- JSON
      );
    `);
  }

  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname; // e.g. /agents, /blueprints

    // --------------------------------------------------
    // Blueprints Management
    // --------------------------------------------------

    // GET /blueprints -> List available types (DB overrides only)
    if (req.method === "GET" && path === "/blueprints") {
      const dbBlueprints = this.listDbBlueprints();
      // Note: worker will merge these with static defaults
      return Response.json({ blueprints: dbBlueprints });
    }

    // POST /blueprints -> Create/Update a custom blueprint for this Agency
    if (req.method === "POST" && path === "/blueprints") {
      const bp = (await req.json()) as AgentBlueprint;
      if (!bp.name) return new Response("Missing name", { status: 400 });

      const now = new Date().toISOString();
      const existing = this.sql
        .exec("SELECT data FROM blueprints WHERE name = ?", bp.name)
        .one();

      let merged = { ...bp };
      if (existing) {
        const prev = JSON.parse(existing.data as string);
        merged = {
          ...prev,
          ...bp,
          createdAt: prev.createdAt ?? now,
          updatedAt: now
        };
      } else {
        merged = {
          ...bp,
          status: bp.status ?? "active",
          createdAt: now,
          updatedAt: now
        };
      }

      const err = validateBlueprint(merged);
      if (err) return new Response(err, { status: 400 });

      this.sql.exec(
        `INSERT OR REPLACE INTO blueprints (name, data, updated_at)
   VALUES (?, ?, ?)`,
        merged.name,
        JSON.stringify(merged),
        Date.now()
      );

      return Response.json({ ok: true, name: merged.name });
    }

    // --------------------------------------------------
    // Agent Management
    // --------------------------------------------------

    // GET /agents -> List all threads in this Agency
    if (req.method === "GET" && path === "/agents") {
      const rows = this.sql.exec(
        "SELECT * FROM agents ORDER BY created_at DESC"
      );

      const agents = [];
      for (const r of rows) {
        agents.push({
          id: r.id,
          agentType: r.type,
          createdAt: new Date(r.created_at as number).toISOString(),
          ...JSON.parse((r.metadata as string) || "{}")
        });
      }

      return Response.json({ agents });
    }

    // POST /agents -> Create a new Agent instance
    if (req.method === "POST" && path === "/agents") {
      const body = (await req.json()) as {
        agentType: string;
        requestContext?: unknown;
      };

      const id = crypto.randomUUID();
      const createdAt = Date.now();

      // 1. Record in Agency DB
      const meta = {
        request: body.requestContext,
        agencyId: this.ctx.id.toString()
      };

      this.sql.exec(
        `INSERT INTO agents (id, type, created_at, metadata)
         VALUES (?, ?, ?, ?)`,
        id,
        body.agentType,
        createdAt,
        JSON.stringify(meta)
      );

      // 2. Initialize the actual SystemAgent DO
      const stub = await getAgentByName(this.env.SYSTEM_AGENT, id);

      const initPayload: ThreadMetadata = {
        id,
        createdAt: new Date(createdAt).toISOString(),
        agentType: body.agentType,
        request: body.requestContext as ThreadRequestContext,
        parent: undefined, // Top-level agent
        agencyId: this.ctx.id.toString()
      };

      const res = await stub.fetch(
        new Request("http://do/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(initPayload)
        })
      );

      if (!res.ok) {
        // Roll back DB if spawn failed
        this.sql.exec("DELETE FROM agents WHERE id = ?", id);
        return res;
      }

      return Response.json(initPayload, { status: 201 });
    }

    // --------------------------------------------------
    // Internal: Blueprint lookup for child agents
    // --------------------------------------------------

    // GET /internal/blueprint/:name -> specific lookup
    const matchBp = path.match(/^\/internal\/blueprint\/([^/]+)$/);
    if (req.method === "GET" && matchBp) {
      const name = matchBp[1];
      const row = this.sql
        .exec("SELECT data FROM blueprints WHERE name = ?", name)
        .one();

      if (row) {
        return Response.json(JSON.parse(row.data as string));
      }

      return new Response(null, { status: 404 });
    }

    return new Response("Agency endpoint not found", { status: 404 });
  }

  listDbBlueprints() {
    const rows = this.sql.exec("SELECT data FROM blueprints").toArray();
    return rows.map((r) => JSON.parse(r.data as string));
  }
}
