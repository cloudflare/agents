/**
 * The soak suite's Worker: a Think agent on a real Workers AI model, with a
 * server tool, a tool that needs the user's approval, whatever client tools
 * the tab declares, a tool from an extension loaded from source (run in a
 * Dynamic Worker), and a helper Think agent it asks as a sub-agent (a
 * facet). It records what the faults suite's checks read (chat events,
 * responses, starts) and counts every server tool run by its call id, so a
 * call run twice shows.
 *
 * `/ctl/think/<room>/<method>` (POST, a JSON array of arguments) calls the
 * object's `probe*` method.
 */
import { Think } from "@cloudflare/think";
import type { ChatResponseResult } from "@cloudflare/think";
import { getAgentByName, routeAgentRequest } from "agents";
import { agentTool } from "agents/agent-tools";
import { createAI } from "agents/models/ai-sdk";
import { genericObservability } from "agents/observability";
import type { Observability } from "agents/observability";
import { tool } from "ai";
import type { ToolSet, UIMessage } from "ai";
import { z } from "zod";

type Env = {
  PROBE_KEY: string;
  BUILD: string;
  AI: Ai;
  LOADER: WorkerLoader;
  ProbeThink: DurableObjectNamespace<ProbeThink>;
};

const MODEL = "@cf/zai-org/glm-4.7-flash";

type Sql = (
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => Record<string, unknown>[];

function tables(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS probe_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, type TEXT, json TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS probe_responses (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, json TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS probe_runs (kind TEXT, id TEXT, n INTEGER, PRIMARY KEY (kind, id))`;
}

function countRun(sql: Sql, kind: string, id: string) {
  tables(sql);
  sql`INSERT INTO probe_runs (kind, id, n) VALUES (${kind}, ${id}, 1)
      ON CONFLICT (kind, id) DO UPDATE SET n = n + 1`;
}

function recording(sql: Sql): Observability {
  return {
    emit(event) {
      try {
        const p =
          (event as { payload?: Record<string, unknown> }).payload ?? {};
        tables(sql);
        sql`INSERT INTO probe_events (at, type, json) VALUES (${Date.now()}, ${event.type}, ${JSON.stringify(
          {
            incidentId: p.incidentId,
            status: p.status,
            reason: p.reason,
            // For reading a turn that went wrong: which request, tool and error.
            requestId: p.requestId,
            toolName: p.toolName,
            error:
              p.error === undefined ? undefined : String(p.error).slice(0, 300)
          }
        )})`;
      } catch {
        // storage may be gone during a reset
      }
      genericObservability.emit(event);
    }
  };
}

/** An extension's source: one tool, run in its own Dynamic Worker. */
const DICE_EXTENSION = `{
  tools: {
    rollDie: {
      description: "Roll a die with the given number of sides and return the result.",
      parameters: { sides: { type: "number" } },
      required: ["sides"],
      execute: async (args) => String(Math.min(4, args.sides))
    }
  },
  hooks: {}
}`;

/** The helper the agent asks as a sub-agent; it runs as a facet of the room. */
export class HelperThink extends Think<Env> {
  readonly #ai = createAI({ binding: this.env.AI });
  override getModel() {
    return this.#ai(MODEL);
  }
  override getSystemPrompt() {
    return "You are a helper. Answer the question in one short sentence.";
  }
}

export class ProbeThink extends Think<Env> {
  extensionLoader = this.env.LOADER;
  override getExtensions() {
    return [
      {
        manifest: {
          name: "dice",
          version: "1.0.0",
          description: "Rolls dice",
          permissions: {}
        },
        source: DICE_EXTENSION
      }
    ];
  }
  override observability = recording(this.sql.bind(this) as Sql);
  readonly #ai = createAI({ binding: this.env.AI });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    countRun(this.s, "start", "start");
  }
  private get s(): Sql {
    return this.sql.bind(this) as Sql;
  }

  override getModel() {
    return this.#ai(MODEL);
  }
  override getSystemPrompt() {
    return "You are a terse assistant. Use the tools when the user asks for what they do. Answer in one short sentence.";
  }
  override getTools(): ToolSet {
    const sql = this.s;
    return {
      getWeather: tool({
        description: "Get the current weather for a city.",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }, { toolCallId }) => {
          countRun(sql, "getWeather", toolCallId);
          return { city, condition: "sunny", temperatureC: 21 };
        }
      }),
      askHelper: agentTool(HelperThink, {
        description: "Ask the helper agent a question and get its answer.",
        inputSchema: z.object({ question: z.string() })
      }),
      deleteFile: tool({
        description: "Delete a file by its path. Needs the user's approval.",
        inputSchema: z.object({ path: z.string() }),
        needsApproval: true,
        execute: async ({ path }, { toolCallId }) => {
          countRun(sql, "deleteFile", toolCallId);
          return { deleted: path };
        }
      })
    };
  }
  override onChatResponse(result: ChatResponseResult) {
    tables(this.s);
    this
      .sql`INSERT INTO probe_responses (at, json) VALUES (${Date.now()}, ${JSON.stringify(
      {
        status: result.status,
        continuation: result.continuation,
        requestId: result.requestId,
        error: (result as { error?: unknown }).error
          ? String((result as { error?: unknown }).error).slice(0, 300)
          : undefined
      }
    )})`;
  }

  async probeSubmit(text: string) {
    const message: UIMessage = {
      id: `sub-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    return this.submitMessages([message]);
  }
  /** The object's own runs (turns, submissions), newest first, for a failure. */
  async probeRuns() {
    return (await this.tasks.list()).slice(0, 60).map((r) => ({
      id: r.runId,
      definition: r.definition,
      status: r.status,
      attempt: (r as { attempt?: number }).attempt,
      // A settled run's snapshot keeps no attempt count; its error is an object.
      error: (r as { error?: unknown }).error
        ? JSON.stringify((r as { error?: unknown }).error).slice(0, 300)
        : undefined
    }));
  }
  async probeState() {
    tables(this.s);
    const parse = (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({
        at: r.at,
        type: r.type,
        ...JSON.parse(String(r.json))
      }));
    const runs = this.sql`SELECT kind, id, n FROM probe_runs ORDER BY kind, id`;
    return {
      messages: await this.getMessages(),
      starts: Number(runs.find((r) => r.kind === "start")?.n ?? 0),
      runs: runs.filter((r) => r.kind !== "start"),
      submissions: (await this.listSubmissions()).map((s) => s.status),
      schedules: 0,
      events: parse(
        this.sql`SELECT at, type, json FROM probe_events ORDER BY seq`
      ),
      responses: parse(
        this.sql`SELECT at, json FROM probe_responses ORDER BY seq`
      ),
      calls: [],
      notes: []
    };
  }
  async probeAbort() {
    this.ctx.abort("probe: reset");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key =
      request.headers.get("x-probe-key") ?? url.searchParams.get("key");
    if (!env.PROBE_KEY || key !== env.PROBE_KEY)
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/ready") return new Response(`ready:${env.BUILD}`);
    const m = url.pathname.match(/^\/ctl\/think\/([^/]+)\/(probe\w+)$/);
    if (m) {
      const [, room, method] = m;
      const args = (await request.json()) as unknown[];
      try {
        const stub = (await getAgentByName(
          env.ProbeThink,
          room
        )) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return Response.json({
          ok: true,
          value: (await stub[method](...args)) ?? null
        });
      } catch (e) {
        return Response.json({ ok: false, error: String(e).slice(0, 300) });
      }
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
