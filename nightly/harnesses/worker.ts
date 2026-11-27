/**
 * The harness suite's Worker: the Pi harness (`agents/harness/pi`) and the
 * OpenCode harness (`agents/harness/opencode`), each in a Durable Object, on
 * a scripted model for the fault cases (so a red is never the model) or on
 * Workers AI for the real conversation.
 *
 * Pi's tools: `gate` and `gate_unsafe` count their runs and wait until the
 * suite releases them (one replay-safe, one not); `multiply` multiplies by
 * three. OpenCode's scripted model holds a `hold` prompt's call until
 * released (counting the calls) and offers a `shout` tool.
 *
 * `/ctl/<pi|opencode>/<room>/<method>` (POST, a JSON array of arguments)
 * calls the object's `probe*` method. A room whose name starts with `real-`
 * talks to Workers AI; any other room to the scripted model.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { num, obj } from "@earendil-works/pi-schema";
import {
  createRegistry,
  Harness,
  type Extension,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import type { Plugin } from "@opencode/plugin";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { OpenCodeHarness } from "agents/harness/opencode";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { Browser, browserRun } from "agents/browser";
import { browserTool } from "agents/browser/pi";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI as createOpenCodeAI } from "agents/models/opencode";
import { createAI } from "agents/models/pi-ai";

type Env = {
  PROBE_KEY: string;
  BUILD: string;
  AI: Ai;
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  Witness: DurableObjectNamespace<Witness>;
  PiProbe: DurableObjectNamespace<PiProbe>;
  OpenCodeProbe: DurableObjectNamespace<OpenCodeProbe>;
};

const REAL_MODEL = "@cf/zai-org/glm-4.7-flash";
const RELEASE_KEY = "probe:release";

const NoParameters = obj({});
const MultiplyParameters = obj({ value: num() });

/** Model code for the browser tool: reads the active tab's title. */
const TITLE_CODE = `async () => {
  const r = await browser.cdp({ method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true }, sessionId: "active" });
  return { title: r.result.value };
}`;

/**
 * A codemode script: one multiply (journaled), then the gate. A reset while
 * it waits on the gate replays the script: the multiply's result comes from
 * the journal, the replay-safe gate runs again.
 */
const CODEMODE_SCRIPT = `const n = await tools.multiply({ value: 7 });
await tools.gate({});
return { n };`;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[])
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

/** The faux model: a tool call for a prompt that names one, else an echo. */
function script(context: TranscriptContext): AssistantMessage {
  const messages = context.messages.filter((m) => m.role !== "system");
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        `${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`
      )
    ]);
  }
  const prompt = last?.role === "user" ? textOf(last.content) : "";
  const call = (name: string, args: Record<string, string> = {}) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  if (["gate", "gate_unsafe", "deadline"].includes(prompt)) return call(prompt);
  if (prompt === "codemode") return call("codemode", { code: CODEMODE_SCRIPT });
  if (prompt === "browser") return call("browser", { code: TITLE_CODE });
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

/**
 * Records what the probes' tools and objects did, outside them: a suite can
 * read it without waking a probe, so a probe that comes back after a reset
 * shows it was its own wake job that brought it back.
 */
export class Witness extends DurableObject<Env> {
  async bump(key: string): Promise<number> {
    const n = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
    await this.ctx.storage.put(key, n);
    return n;
  }
  async read(key: string): Promise<number> {
    return (await this.ctx.storage.get<number>(key)) ?? 0;
  }
}

export class PiProbe extends DurableObject<Env> {
  readonly #real = this.ctx.id.name?.startsWith("real-") ?? false;
  readonly #ai = createAI({ binding: this.env.AI });
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly browser = new Browser({ provider: browserRun(this.env.BROWSER) });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.registry.install(this.#tools());
      this.registry.install({
        name: "browser",
        tools: [browserTool({ browser: this.browser, loader: this.env.LOADER })]
      });
      this.registry.install(
        createCodemodeExtension({
          models: false,
          sandbox: createInlineCodemodeSandbox()
        })
      );
      const models = createModels();
      models.setProvider(this.#real ? this.#ai.provider : this.#faux.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          onReport: (report) =>
            console.warn("pi report", report.kind, String(report.error))
        },
        context
      );
    },
    defaults: {
      model: this.#real ? this.#ai(REAL_MODEL) : this.#faux.getModel()
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.browser)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 500 }, () => script));
    void this.#witness("start");
  }

  #witness(key: string) {
    return this.env.Witness.getByName(this.ctx.id.name ?? "").bump(key);
  }

  #tools(): Extension {
    const storage = this.ctx.storage;
    const witness = (key: string) => this.#witness(key);
    const gate = (
      name: string,
      replay: "safe" | "unsafe"
    ): ToolRegistration<typeof NoParameters> => ({
      name,
      description: "Wait until the operator releases it.",
      parameters: NoParameters,
      replay,
      async execute(_args, _api, context) {
        const runs = await witness(name);
        while (!(await storage.get<boolean>(RELEASE_KEY))) {
          context.abortSignal?.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return {
          output: [{ type: "text", text: `released after ${runs} runs` }]
        };
      }
    });
    const multiply: ToolRegistration<typeof MultiplyParameters> = {
      name: "multiply",
      description: "Multiply a number by three.",
      parameters: MultiplyParameters,
      replay: "safe",
      async execute({ value }) {
        await witness("multiply");
        return { output: [{ type: "text", text: String(value * 3) }] };
      }
    };
    // Parks the call with a deadline 40 s out, holding nothing: the object
    // may go idle, and pi's alarm brings it back to finish the call.
    const deadline: ToolRegistration<typeof NoParameters> = {
      name: "deadline",
      description: "Wait 40 seconds, then report.",
      parameters: NoParameters,
      replay: "safe",
      async execute(_args, api) {
        if (api.wake !== undefined) {
          await witness("deadline-woke");
          return {
            output: [{ type: "text", text: `woke ${api.wake.reason}` }]
          };
        }
        await witness("deadline-parked");
        return { kind: "sleep", until: api.now() + 40_000, signals: [] };
      }
    };
    return {
      name: "probe-tools",
      tools: [
        gate("gate", "safe"),
        gate("gate_unsafe", "unsafe"),
        multiply,
        deadline
      ]
    };
  }

  async probeSubmit(text: string) {
    return this.harness.submit(text);
  }
  async probeWait(operationId: string) {
    return this.harness.wait(operationId);
  }
  async probeRelease() {
    await this.ctx.storage.put(RELEASE_KEY, true);
  }
  async probeState() {
    return {
      pending: (await this.harness.pending()).length,
      alarm: await this.ctx.storage.getAlarm(),
      entries: (await this.harness.messages()).length
    };
  }
  async probeAlarm() {
    return this.ctx.storage.getAlarm();
  }
  async probeReset() {
    this.ctx.abort("probe: reset");
  }
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

/** A tool for the model: it upper-cases its input. */
const shoutPlugin: Plugin.Plugin = {
  id: "probe.shout",
  async setup(context) {
    await context.tool.transform((editor) => {
      editor.add({
        name: "shout",
        description: "Upper-case some text.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        },
        options: { codemode: false },
        execute: async (input) => ({
          content: (input as { text: string }).text.toUpperCase()
        })
      });
    });
  }
};

function sse(text: string): Response {
  const events = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
  ];
  return new Response(
    [...events.map((e) => JSON.stringify(e)), "[DONE]"]
      .map((d) => `data: ${d}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

/** The last user text, skipping OpenCode's note after a restart. */
function lastUserText(input: Record<string, unknown>): string {
  const messages = Array.isArray(input.messages)
    ? (input.messages as { role?: string; content?: unknown }[])
    : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = textOf(messages[i].content ?? "");
    if (!text.startsWith("The server restarted")) return text;
  }
  return "";
}

/**
 * A Workers AI binding that answers from the transcript alone: `hold` waits
 * for the release first; anything else is echoed. OpenCode's title requests
 * (no tools) answer `title`.
 */
function scriptedAI(
  hold: (signal: AbortSignal | undefined) => Promise<void>
): Ai {
  return {
    aiGatewayLogId: null,
    async run(
      _model: string,
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ) {
      if (input.stream !== true || !Array.isArray(input.tools)) {
        if (input.stream === true) return sse("title");
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "title" }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }
      const prompt = lastUserText(input);
      if (prompt === "hold") await hold(options?.signal);
      return sse(`echo: ${prompt}`);
    }
  } as unknown as Ai;
}

export class OpenCodeProbe extends DurableObject<Env> {
  readonly #real = this.ctx.id.name?.startsWith("real-") ?? false;
  readonly ai = createOpenCodeAI({
    binding: this.#real
      ? this.env.AI
      : scriptedAI((signal) => this.#hold(signal))
  });
  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({
        storage,
        models: { fetch: false },
        plugins: [this.ai.plugin, shoutPlugin]
      }),
    defaults: { model: this.ai(REAL_MODEL) }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.env.Witness.getByName(ctx.id.name ?? "").bump("start");
  }

  async #hold(signal: AbortSignal | undefined): Promise<void> {
    await this.env.Witness.getByName(this.ctx.id.name ?? "").bump("hold");
    while (!(await this.ctx.storage.get<boolean>(RELEASE_KEY))) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async probeSubmit(text: string) {
    return this.harness.submit(text);
  }
  async probeWait(operationId: string) {
    return this.harness.wait(operationId);
  }
  async probeRelease() {
    await this.ctx.storage.put(RELEASE_KEY, true);
  }
  async probeState() {
    return {
      pending: (await this.harness.pending()).length,
      alarm: await this.ctx.storage.getAlarm(),
      entries: (await this.harness.messages()).length
    };
  }
  /** Where the session stood: storage first, then what reading the harness shows. */
  async probeDiag() {
    const alarm = await this.ctx.storage.getAlarm();
    const jobs = this.lifecycle
      .sql`SELECT id, capability, fn, time, running FROM cf_agents_jobs`;
    return {
      alarm,
      jobs,
      pending: await this.harness.pending(),
      sessions: await this.harness.sessions.list()
    };
  }
  async probeAlarm() {
    return this.ctx.storage.getAlarm();
  }
  async probeReset() {
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
    const w = url.pathname.match(/^\/witness\/([^/]+)\/(\w[\w-]*)$/);
    if (w)
      return Response.json({
        ok: true,
        value: await env.Witness.getByName(w[1]).read(w[2])
      });
    const m = url.pathname.match(/^\/ctl\/(pi|opencode)\/([^/]+)\/(probe\w+)$/);
    if (!m) return new Response("Not found", { status: 404 });
    const [, harness, room, method] = m;
    const args = (await request.json()) as unknown[];
    try {
      const stub = (harness === "pi"
        ? env.PiProbe
        : env.OpenCodeProbe
      ).getByName(room) as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      return Response.json({
        ok: true,
        value: (await stub[method](...args)) ?? null
      });
    } catch (e) {
      return Response.json({ ok: false, error: String(e).slice(0, 300) });
    }
  }
};

// The browser tool runs model code in a codemode runtime facet of this class.
export { CodemodeRuntime } from "agents/browser";
