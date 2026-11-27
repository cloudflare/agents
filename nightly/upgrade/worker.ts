/**
 * The upgrade suite's Worker. The suite deploys it twice under one name:
 * built on the latest release of agents, @cloudflare/ai-chat and
 * @cloudflare/think, then built on this repository over it. So it uses
 * only API both have.
 *
 * Its agents run on a fake model that streams `w1 w2 …` at a pace the room
 * sets, and calls `deleteFile` (which needs approval) when the user asks
 * with "[approve]". Server tool runs and fiber steps are counted in the
 * probe's own table, so a run that happens twice shows.
 *
 * `/ctl/<chat|think|agent>/<room>/<method>` (POST, a JSON array of
 * arguments) calls the object's `probe*` method.
 */
import { AIChatAgent } from "@cloudflare/ai-chat";
import { Think } from "@cloudflare/think";
import { Agent, getAgentByName, routeAgentRequest } from "agents";
import type { FiberRecoveryContext } from "agents";
import { convertToModelMessages, isStepCount, streamText, tool } from "ai";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { z } from "zod";

type Env = {
  PROBE_KEY: string;
  BUILD: string;
  ProbeChat: DurableObjectNamespace<ProbeChat>;
  ProbeThink: DurableObjectNamespace<ProbeThink>;
  ProbeAgent: DurableObjectNamespace<ProbeAgent>;
};

type Pace = { tokens: number; delayMs: number };
const DEFAULT_PACE: Pace = { tokens: 6, delayMs: 20 };

type Sql = (
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => Record<string, unknown>[];

function tables(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS probe_kv (k TEXT PRIMARY KEY, v TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS probe_runs (kind TEXT, id TEXT, n INTEGER, PRIMARY KEY (kind, id))`;
}
function getPace(sql: Sql): Pace {
  tables(sql);
  const row = sql`SELECT v FROM probe_kv WHERE k = 'pace'`[0];
  return row ? (JSON.parse(String(row.v)) as Pace) : DEFAULT_PACE;
}
function setPace(sql: Sql, pace: Pace) {
  tables(sql);
  sql`INSERT OR REPLACE INTO probe_kv (k, v) VALUES ('pace', ${JSON.stringify(pace)})`;
}
/** Count one run of `kind`/`id`; the count shows anything that ran twice. */
function countRun(sql: Sql, kind: string, id: string) {
  tables(sql);
  sql`INSERT INTO probe_runs (kind, id, n) VALUES (${kind}, ${id}, 1)
      ON CONFLICT (kind, id) DO UPDATE SET n = n + 1`;
}
function runs(sql: Sql) {
  tables(sql);
  return sql`SELECT kind, id, n FROM probe_runs ORDER BY kind, id`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Prompt = { role: string; content: unknown }[];

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "user") continue;
    return Array.isArray(m.content)
      ? m.content.map((c) => (c as { text?: string }).text ?? "").join("")
      : String(m.content);
  }
  return "";
}

/** A model that streams `w1 … wN`, or asks to delete a file when told "[approve]". */
function fakeModel(sql: Sql, build: string): LanguageModel {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  };
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("fake: doGenerate is not supported");
    },
    async doStream(options: { prompt: Prompt; abortSignal?: AbortSignal }) {
      const pace = getPace(sql);
      const prompt = options.prompt;
      // Which build made each model call: work in flight at the deploy must
      // reach the new build.
      countRun(sql, "call", build);
      // And for which user message, so a turn that ran twice shows.
      countRun(sql, "turn", `${build}|${lastUserText(prompt)}`);
      const callTool =
        prompt.at(-1)?.role === "user" &&
        lastUserText(prompt).includes("[approve]");
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (callTool) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: `call_${crypto.randomUUID().slice(0, 8)}`,
              toolName: "deleteFile",
              input: JSON.stringify({ path: "/tmp/probe.txt" })
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage
            });
            controller.close();
            return;
          }
          controller.enqueue({ type: "text-start", id: "t" });
          for (let i = 1; i <= pace.tokens; i++) {
            await sleep(pace.delayMs);
            if (options.abortSignal?.aborted) {
              controller.error(new Error("aborted"));
              return;
            }
            controller.enqueue({
              type: "text-delta",
              id: "t",
              delta: `w${i} `
            });
          }
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage
          });
          controller.close();
        }
      });
      return { stream };
    }
  } as unknown as LanguageModel;
}

function tools(sql: Sql): ToolSet {
  return {
    deleteFile: tool({
      description: "Delete a file. Needs the user's approval.",
      inputSchema: z.object({ path: z.string() }),
      needsApproval: true,
      execute: async ({ path }, { toolCallId }) => {
        countRun(sql, "tool", toolCallId);
        return { deleted: path };
      }
    })
  };
}

export class ProbeChat extends AIChatAgent<Env> {
  private get s(): Sql {
    return this.sql.bind(this) as Sql;
  }
  async onChatMessage() {
    return streamText({
      model: fakeModel(this.s, this.env.BUILD),
      messages: await convertToModelMessages(this.messages),
      tools: tools(this.s),
      stopWhen: isStepCount(4)
    }).toUIMessageStreamResponse();
  }
  async probePace(pace: Pace) {
    setPace(this.s, pace);
  }
  async probeState() {
    return { messages: this.messages, runs: runs(this.s) };
  }
}

export class ProbeThink extends Think<Env> {
  private get s(): Sql {
    return this.sql.bind(this) as Sql;
  }
  override getModel() {
    return fakeModel(this.s, this.env.BUILD);
  }
  override getSystemPrompt() {
    return "fake";
  }
  override getTools(): ToolSet {
    return tools(this.s);
  }
  async probePace(pace: Pace) {
    setPace(this.s, pace);
  }
  async probeSubmit(text: string) {
    const message: UIMessage = {
      id: `sub-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    return this.submitMessages([message]);
  }
  async probeState() {
    const submissions = (await this.listSubmissions()) as unknown as {
      status?: string;
    }[];
    return {
      messages: await this.getMessages(),
      runs: runs(this.s),
      submissions: submissions.map((s) => s.status)
    };
  }
}

/** A fiber that counts its steps, and a schedule that counts its ticks. */
export class ProbeAgent extends Agent<Env> {
  private get s(): Sql {
    return this.sql.bind(this) as Sql;
  }
  async probeStartFiber(steps: number, stepMs: number) {
    void this.runFiber("count", async (ctx) => {
      for (let i = 1; i <= steps; i++) {
        await sleep(stepMs);
        countRun(this.s, "step", String(i));
        ctx.stash({ step: i });
      }
    });
  }
  override async onFiberRecovered(ctx: FiberRecoveryContext) {
    countRun(this.s, "recovered", JSON.stringify(ctx.snapshot));
  }
  async probeSchedule(seconds: number) {
    await this.schedule(seconds, "tick");
  }
  async tick() {
    countRun(this.s, "tick", this.env.BUILD);
  }
  async probeState() {
    return { runs: runs(this.s) };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key =
      request.headers.get("x-probe-key") ?? url.searchParams.get("key");
    if (!env.PROBE_KEY || key !== env.PROBE_KEY) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/ready") return new Response(`ready:${env.BUILD}`);
    const m = url.pathname.match(
      /^\/ctl\/(chat|think|agent)\/([^/]+)\/(probe\w+)$/
    );
    if (m) {
      const [, cls, room, method] = m;
      const args = (await request.json()) as unknown[];
      try {
        const stub =
          cls === "chat"
            ? await getAgentByName(env.ProbeChat, room)
            : cls === "think"
              ? await getAgentByName(env.ProbeThink, room)
              : await getAgentByName(env.ProbeAgent, room);
        const call = (
          stub as unknown as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >
        )[method];
        return Response.json({
          ok: true,
          value: (await call(...args)) ?? null
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
