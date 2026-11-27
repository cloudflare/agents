/**
 * perf probe: a Think agent, an AIChatAgent and a plain Agent, each with its
 * storage metered from construction. The driver (scripts/run.mjs) calls
 * `/run/<cls>/<room>/<scenario>`; the object runs the scenario, waits for
 * its alarm work to settle, and returns counts, time and what is left at rest.
 */
import { AIChatAgent, createToolsFromClientSchemas } from "@cloudflare/ai-chat";
import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import { Think } from "@cloudflare/think";
import { Agent, getAgentByName, routeAgentRequest } from "agents";
import type { TaskHandlers, TaskStep } from "agents/tasks";
import { convertToModelMessages, isStepCount, streamText, tool } from "ai";
import type { ToolSet, UIMessage } from "ai";
import { z } from "zod";
import { Meter, tableStats } from "./meter";
import { fakeModel } from "./model";

type Env = {
  PerfThink: DurableObjectNamespace<PerfThink>;
  PerfChat: DurableObjectNamespace<PerfChat>;
  PerfAgent: DurableObjectNamespace<PerfAgent>;
  PerfParent: DurableObjectNamespace<PerfParent>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tools(): ToolSet {
  return {
    getWeather: tool({
      description: "Weather for a city.",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, condition: "sunny" })
    }),
    deleteFile: tool({
      description: "Delete a file. Needs approval.",
      inputSchema: z.object({ path: z.string() }),
      needsApproval: true,
      execute: async ({ path }) => ({ deleted: path })
    })
  };
}

function user(text: string): UIMessage {
  return {
    id: `u-${crypto.randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text }]
  };
}

function history(n: number): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `h-${i}`,
      role: i % 2 ? "assistant" : "user",
      parts: [{ type: "text", text: `message ${i} `.repeat(20) }]
    });
  }
  return out;
}

/** Shared by the three classes. */
interface Host {
  meter: Meter;
  ctx: DurableObjectState;
}

/** Wait until no alarm is due in the next 2 s (bounded), so alarm work lands in the counts. */
async function settle(h: Host, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  await sleep(50);
  while (Date.now() < deadline) {
    const at = await h.meter.quiet(() => h.ctx.storage.getAlarm());
    if (at == null || at > Date.now() + 2000) return;
    await sleep(100);
  }
}

function rest(h: Host) {
  return h.meter.quiet(() => {
    const sql = h.ctx.storage.sql;
    const tables = tableStats(sql);
    let jobs: unknown[] = [];
    try {
      jobs = sql
        .exec("SELECT * FROM cf_agents_jobs")
        .toArray()
        .map((j) => {
          const r = j as Record<string, unknown>;
          return {
            owner: r.owner,
            kind: r.kind ?? r.type,
            run_at: r.run_at ?? r.due_at
          };
        });
    } catch {
      // no job table
    }
    return { databaseSize: sql.databaseSize, tables, jobs };
  });
}

async function measure(
  h: Host,
  run: () => Promise<unknown>,
  opts: { settle?: boolean; reset?: boolean } = {}
) {
  if (opts.reset !== false) h.meter.reset();
  const t0 = Date.now();
  let value: unknown;
  let error: string | undefined;
  try {
    value = await run();
  } catch (e) {
    error = String(e).slice(0, 200);
  }
  const runMs = Date.now() - t0;
  if (opts.settle !== false) await settle(h);
  const wallMs = Date.now() - t0;
  const alarm = await h.meter.quiet(() => h.ctx.storage.getAlarm());
  return {
    doId: h.ctx.id.toString(),
    counts: h.meter.snapshot(),
    runMs,
    wallMs,
    alarmInMs: alarm == null ? null : alarm - Date.now(),
    value: summarize(value),
    error,
    top: h.meter.topStatements(),
    ...(await rest(h))
  };
}

function summarize(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of [
    "status",
    "reason",
    "error",
    "submissionId",
    "runId",
    "state",
    "messages",
    "result",
    "first",
    "timeout"
  ]) {
    if (k in o) keep[k] = k === "messages" ? (o[k] as unknown[]).length : o[k];
  }
  return keep;
}

type Scenario = (arg?: unknown) => Promise<unknown>;

/**
 * Whether the host's reply stream is still open. It reads a private field,
 * named differently across versions (`_resumableStream` in the release,
 * `_replyStreams` after), because no public API says it: a recovery's cost
 * is only complete once the reply has finished streaming.
 */
function replyStreaming(host: object): boolean {
  const fields = host as Record<
    string,
    { hasActiveStream?: () => boolean } | undefined
  >;
  const rs = [fields._resumableStream, fields._replyStreams].find(
    (x) => typeof x?.hasActiveStream === "function"
  );
  return Boolean(rs?.hasActiveStream?.());
}

// ── Think ──────────────────────────────────────────────────────────────────

export class PerfThink extends Think<Env> {
  meter: Meter;
  constructor(ctx: DurableObjectState, env: Env) {
    const meter = new Meter();
    meter.install(ctx.storage);
    super(ctx, env);
    this.meter = meter;
  }
  host(): Host {
    return { meter: this.meter, ctx: this.ctx };
  }
  override getModel() {
    return fakeModel();
  }
  override getSystemPrompt() {
    return "perf";
  }
  /** The workflow event a workflow submission owes: accepted at once (outbox's scenario). */
  override async sendWorkflowEvent(): Promise<void> {}
  override getTools(): ToolSet {
    return tools();
  }
  /** Platform-transient failures still to throw before the model call (scenario "transient"). */
  transientLeft = 0;
  override beforeTurn() {
    if (this.transientLeft > 0) {
      this.transientLeft--;
      throw new Error("Network connection lost.");
    }
    return { activeTools: ["getWeather", "deleteFile", "getUserLocation"] };
  }

  scenarios(): Record<string, Scenario> {
    return {
      noop: async () => null,
      seed: async (n) => this.addMessages(history(Number(n ?? 500))),
      // one transient failure while the agent stays up, then the recovered reply
      transient: async (mode) => {
        // arg "throw": a platform transient thrown before the model call; default: the provider fails mid-stream
        if (mode === "throw") this.transientLeft = 1;
        const first = summarize(
          await this.saveMessages([
            user(mode === "throw" ? "hi" : `overloaded ${crypto.randomUUID()}`)
          ]).catch((e) => ({ error: String(e).slice(0, 80) }))
        );
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const msgs = await this.getMessages();
          if (
            msgs.at(-1)?.role === "assistant" &&
            !(await this.meter.quiet(() => this.isStreaming()))
          )
            return { first, messages: msgs };
          await sleep(100);
        }
        return { first, messages: await this.getMessages(), timeout: true };
      },
      short: async () => this.saveMessages([user("hi")]),
      long: async (n) => this.saveMessages([user(`long ${n ?? 2000}`)]),
      tool: async () => this.saveMessages([user("tool")]),
      approve: async () => this.saveMessages([user("approve")]),
      queued: async () => {
        const first = this.saveMessages([user("long 50 delay 20")]);
        await sleep(100);
        const rest = [1, 2, 3].map((i) =>
          this.saveMessages([user(`queued ${i}`)])
        );
        return {
          results: (await Promise.all([first, ...rest])).map((r) =>
            summarize(r)
          )
        };
      },
      submit: async () => {
        const s = await this.submitMessages([user("hi")]);
        const id =
          (s as { submissionId?: string }).submissionId ??
          (s as { submission?: { submissionId: string } }).submission
            ?.submissionId;
        if (id) return this.waitForSubmission(id);
        return s;
      },
      submitWorkflow: async () => {
        // A submission a ThinkWorkflow step started: its terminal status owes
        // the workflow one event (outbox, lane O).
        const s = await this.submitMessages([user("hi")], {
          metadata: {
            __thinkWorkflowPrompt: {
              workflow: {
                name: "PERF_WF",
                id: "wf-1",
                stepName: "s",
                eventType: "perf-done"
              }
            }
          }
        });
        const id =
          (s as { submissionId?: string }).submissionId ??
          (s as { submission?: { submissionId: string } }).submission
            ?.submissionId;
        if (id) return this.waitForSubmission(id);
        return s;
      },
      abortMidStream: async () => {
        void this.saveMessages([user("long 400 delay 10")]);
        await sleep(1000);
        await this.ctx.storage.sync();
        this.ctx.abort("perf: reset");
      },
      awaitIdle: async () => {
        // after a reset: wait until recovery has written the reply
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const msgs = await this.getMessages();
          const last = msgs.at(-1);
          if (
            last?.role === "assistant" &&
            !(await this.meter.quiet(() => this.isStreaming()))
          )
            return { messages: msgs };
          await sleep(200);
        }
        return { messages: await this.getMessages(), timeout: true };
      }
    };
  }
  isStreaming(): boolean {
    return replyStreaming(this);
  }

  async perf(scenario: string, arg?: unknown, opts?: { reset?: boolean }) {
    const fn = this.scenarios()[scenario];
    if (!fn) throw new Error(`unknown scenario ${scenario}`);
    return measure(this.host(), () => fn(arg), opts);
  }
  async perfAbort() {
    await this.ctx.storage.sync();
    this.ctx.abort("perf: reset");
  }
  async perfSinceStart() {
    return {
      doId: this.ctx.id.toString(),
      constructedAt: this.meter.constructedAt,
      counts: this.meter.snapshot(),
      top: this.meter.topStatements(),
      ...(await rest(this.host()))
    };
  }
}

// ── AIChatAgent ────────────────────────────────────────────────────────────

export class PerfChat extends AIChatAgent<Env> {
  meter: Meter;
  constructor(ctx: DurableObjectState, env: Env) {
    const meter = new Meter();
    meter.install(ctx.storage);
    super(ctx, env);
    this.meter = meter;
  }
  host(): Host {
    return { meter: this.meter, ctx: this.ctx };
  }
  transientLeft = 0;
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    if (this.transientLeft > 0) {
      this.transientLeft--;
      throw new Error("Network connection lost.");
    }
    const result = streamText({
      model: fakeModel(),
      messages: await convertToModelMessages(this.messages),
      tools: {
        ...tools(),
        ...createToolsFromClientSchemas(options?.clientTools)
      },
      abortSignal: options?.abortSignal,
      stopWhen: isStepCount(4)
    });
    return result.toUIMessageStreamResponse();
  }

  scenarios(): Record<string, Scenario> {
    return {
      noop: async () => null,
      seed: async (n) => this.persistMessages(history(Number(n ?? 500))),
      transient: async (mode) => {
        // arg "throw": a platform transient thrown before the model call; default: the provider fails mid-stream
        if (mode === "throw") this.transientLeft = 1;
        const first = summarize(
          await this.saveMessages([
            user(mode === "throw" ? "hi" : `overloaded ${crypto.randomUUID()}`)
          ]).catch((e) => ({ error: String(e).slice(0, 80) }))
        );
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if (
            this.messages.at(-1)?.role === "assistant" &&
            !replyStreaming(this)
          )
            return { first, messages: this.messages };
          await sleep(100);
        }
        return { first, messages: this.messages, timeout: true };
      },
      short: async () => this.saveMessages([user("hi")]),
      long: async (n) => this.saveMessages([user(`long ${n ?? 2000}`)]),
      tool: async () => this.saveMessages([user("tool")]),
      approve: async () => this.saveMessages([user("approve")]),
      queued: async () => {
        const first = this.saveMessages([user("long 50 delay 20")]);
        await sleep(100);
        const rest = [1, 2, 3].map((i) =>
          this.saveMessages([user(`queued ${i}`)])
        );
        return {
          results: (await Promise.all([first, ...rest])).map((r) =>
            summarize(r)
          )
        };
      },
      abortMidStream: async () => {
        void this.saveMessages([user("long 400 delay 10")]);
        await sleep(1000);
        await this.ctx.storage.sync();
        this.ctx.abort("perf: reset");
      },
      awaitIdle: async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const last = this.messages.at(-1);
          if (last?.role === "assistant" && !replyStreaming(this))
            return { messages: this.messages };
          await sleep(200);
        }
        return { messages: this.messages, timeout: true };
      }
    };
  }

  async perf(scenario: string, arg?: unknown, opts?: { reset?: boolean }) {
    const fn = this.scenarios()[scenario];
    if (!fn) throw new Error(`unknown scenario ${scenario}`);
    return measure(this.host(), () => fn(arg), opts);
  }
  async perfAbort() {
    await this.ctx.storage.sync();
    this.ctx.abort("perf: reset");
  }
  async perfSinceStart() {
    return {
      doId: this.ctx.id.toString(),
      constructedAt: this.meter.constructedAt,
      counts: this.meter.snapshot(),
      top: this.meter.topStatements(),
      ...(await rest(this.host()))
    };
  }
}

// ── Plain Agent: fibers, tasks ─────────────────────────────────────────────

export class PerfAgent extends Agent<Env> {
  meter: Meter;
  constructor(ctx: DurableObjectState, env: Env) {
    const meter = new Meter();
    meter.install(ctx.storage);
    super(ctx, env);
    this.meter = meter;
  }
  host(): Host {
    return { meter: this.meter, ctx: this.ctx };
  }
  override readonly taskDefinitions = {
    five: async (_input: undefined, step: TaskStep) => {
      let acc = 0;
      for (let i = 0; i < 5; i++) acc += await step.do(`s${i}`, () => i);
      return acc;
    }
  } satisfies TaskHandlers;

  scenarios(): Record<string, Scenario> {
    return {
      noop: async () => null,
      fiber: async () =>
        this.runFiber("perf", async (ctx) => {
          for (let i = 0; i < 3; i++) {
            ctx.stash({ i, note: "x".repeat(100) });
            await sleep(5);
          }
          return "done";
        }),
      task: async () => {
        const r = await this.tasks.run("five");
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const s = await this.tasks.get(r.runId);
          // release: `state` (completed | failed | cancelled); after T1: `status` (completed | error | aborted | skipped)
          const st =
            (s as { status?: string; state?: string } | null)?.status ??
            (s as { state?: string } | null)?.state;
          if (
            s &&
            st &&
            st !== "pending" &&
            st !== "running" &&
            st !== "waiting" &&
            st !== "queued"
          )
            return s;
          await sleep(20);
        }
        return { runId: r.runId, state: "timeout" };
      },
      schedule: async () => {
        await this.schedule(1, "perfTick");
        await sleep(2500);
        return this.ticks;
      }
    };
  }
  ticks = 0;
  async perfTick() {
    this.ticks++;
  }
  async perf(scenario: string, arg?: unknown, opts?: { reset?: boolean }) {
    const fn = this.scenarios()[scenario];
    if (!fn) throw new Error(`unknown scenario ${scenario}`);
    return measure(this.host(), () => fn(arg), opts);
  }
  async perfAbort() {
    await this.ctx.storage.sync();
    this.ctx.abort("perf: reset");
  }
  async perfSinceStart() {
    return {
      doId: this.ctx.id.toString(),
      constructedAt: this.meter.constructedAt,
      counts: this.meter.snapshot(),
      top: this.meter.topStatements(),
      ...(await rest(this.host()))
    };
  }
}

// ── Root that runs the three classes as facets ─────────────────────────────

// "parent" nests: arg "parent:think:short" runs think:short two levels down.
const FACET_CLASSES = {
  think: PerfThink,
  chat: PerfChat,
  agent: PerfAgent,
  get parent() {
    return PerfParent;
  }
} as const;

/**
 * Scenario "facet": arg = "<think|chat|agent>:<scenario>[:<arg>]". Runs the
 * scenario in a facet (subAgent) and returns the facet's counts plus what the
 * root wrote meanwhile (the root wakes facets, so its writes are part of the cost).
 */
export class PerfParent extends Agent<Env> {
  meter: Meter;
  constructor(ctx: DurableObjectState, env: Env) {
    const meter = new Meter();
    meter.install(ctx.storage);
    super(ctx, env);
    this.meter = meter;
  }
  host(): Host {
    return { meter: this.meter, ctx: this.ctx };
  }
  async perf(scenario: string, arg?: unknown, opts?: { reset?: boolean }) {
    if (scenario === "noop")
      return measure(this.host(), async () => null, opts);
    if (scenario !== "facet") throw new Error(`unknown scenario ${scenario}`);
    const [cls, sc, ...rest] = String(arg).split(":");
    const childArg =
      cls === "parent"
        ? [sc, ...rest].join(":")
        : rest.length
          ? rest.join(":")
          : undefined;
    const child = (await this.subAgent(
      FACET_CLASSES[cls as keyof typeof FACET_CLASSES] as typeof PerfAgent,
      `${cls}-child`
    )) as unknown as {
      perf(scenario: string, arg?: unknown): Promise<unknown>;
    };
    await child.perf("noop");
    let facet: unknown;
    const root = await measure(this.host(), async () => {
      facet =
        cls === "parent"
          ? await child.perf("facet", childArg)
          : await child.perf(sc, childArg);
    });
    return { ...root, facet };
  }
  async perfAbort() {
    await this.ctx.storage.sync();
    this.ctx.abort("perf: reset");
  }
  async perfSinceStart() {
    return {
      doId: this.ctx.id.toString(),
      constructedAt: this.meter.constructedAt,
      counts: this.meter.snapshot(),
      top: this.meter.topStatements(),
      ...(await rest(this.host()))
    };
  }
}

// ── Worker entry ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(
      /^\/(run|since|abort)\/(think|chat|agent|parent)\/([^/]+)(?:\/(\w+))?$/
    );
    if (m) {
      const [, verb, cls, room, scenario] = m;
      const ns =
        cls === "think"
          ? env.PerfThink
          : cls === "chat"
            ? env.PerfChat
            : cls === "parent"
              ? env.PerfParent
              : env.PerfAgent;
      // t0 before getAgentByName: a first call's rpcMs includes construction and onStart (cold start)
      const t0 = Date.now();
      const stub = (await getAgentByName(
        ns as DurableObjectNamespace<PerfAgent>,
        room
      )) as unknown as {
        perf(
          scenario: string,
          arg?: unknown,
          opts?: { reset?: boolean }
        ): Promise<Record<string, unknown>>;
        perfAbort(): Promise<Record<string, unknown>>;
        perfSinceStart(): Promise<Record<string, unknown>>;
      };
      const arg = url.searchParams.get("arg") ?? undefined;
      try {
        const value =
          verb === "abort"
            ? await stub.perfAbort().catch(() => ({ aborted: true }))
            : verb === "run"
              ? await stub.perf(scenario, arg, {
                  reset: url.searchParams.get("reset") !== "0"
                })
              : await stub.perfSinceStart();
        return Response.json({ ok: true, rpcMs: Date.now() - t0, ...value });
      } catch (e) {
        return Response.json({
          ok: false,
          rpcMs: Date.now() - t0,
          error: String(e).slice(0, 300)
        });
      }
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
