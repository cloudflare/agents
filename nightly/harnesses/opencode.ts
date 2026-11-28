/**
 * The OpenCode harness suite's Worker: the OpenCode harness
 * (`agents/harness/opencode`, inside the Durable Object, no container), on a
 * scripted model for the fault cases or on Workers AI for the real
 * conversation. The scripted model holds a `hold` prompt's call until
 * released (counting the calls) and offers a `shout` tool.
 */
import { DurableObject } from "cloudflare:workers";
import type { Plugin } from "@opencode/plugin";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { OpenCodeHarness } from "agents/harness/opencode";
import { Lifecycle } from "agents/lifecycle";
import { createAI as createOpenCodeAI } from "agents/models/opencode";
import {
  probeWorker,
  REAL_MODEL,
  RELEASE_KEY,
  textOf,
  type BaseEnv
} from "./shared";

type Env = BaseEnv & {
  OpenCodeProbe: DurableObjectNamespace<OpenCodeProbe>;
};

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

export default probeWorker<Env>("opencode", (env) => env.OpenCodeProbe);

export { Witness } from "./shared";
