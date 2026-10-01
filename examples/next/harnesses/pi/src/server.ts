import { DurableObject } from "cloudflare:workers";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  ToolTask,
  type Registry,
  type ToolExecutionResult,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { PiHarness } from "./harness/pi-harness";
import { PiSessionSockets } from "./sockets";

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/** Longest `sleep` the model may ask for. */
const MAX_SLEEP_SECONDS = 3600;

function text(content: string, details?: JsonValue): ToolExecutionResult {
  return {
    content: [{ type: "text", text: content }],
    ...(details === undefined ? {} : { details })
  };
}

/** pi validates arguments against `parameters` before `execute` runs. */
function argsOf<T>(args: JsonValue): T {
  return args as T;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/**
 * The playground's tools.
 *
 * `sleep` is the interesting one. It waits in memory with `setTimeout`, like
 * pi's own retry and poll sleeps, but memoizes its deadline in pi so it is
 * replay-safe: after an eviction pi reruns it and it only waits out what is
 * left. A timer does not keep the object alive by itself; the harness's wake
 * job does, through its alarm. See NOTES.md, "pi's timers are in
 * memory".
 */
function createTools(): ToolRegistration[] {
  return [
    {
      name: "sleep",
      description: `Wait for a number of seconds (at most ${MAX_SLEEP_SECONDS}) before continuing.`,
      parameters: Type.Object({
        seconds: Type.Number({ minimum: 0, maximum: MAX_SLEEP_SECONDS })
      }),
      replay: "safe",
      async execute(args, api, context) {
        const { seconds } = argsOf<{ seconds: number }>(args);
        const startedAt = await api.memo("startedAt", Date.now(), context);
        const until = startedAt + seconds * 1000;
        api.output(`Sleeping until ${new Date(until).toISOString()}\n`);
        const remaining = until - Date.now();
        if (remaining > 0) await pause(remaining, context.abortSignal);
        const slept = (Date.now() - startedAt) / 1000;
        return text(`Slept ${slept.toFixed(1)}s.`, {
          seconds,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString()
        });
      }
    },
    {
      name: "current_time",
      description: "Return the current UTC time.",
      parameters: Type.Object({}),
      replay: "safe",
      async execute() {
        const iso = new Date().toISOString();
        return text(iso, { iso });
      }
    }
  ];
}

/** pi's registry for this app: the prompt, the tools, and a sleep cap. */
function createAppRegistry(): Registry {
  const registry = createRegistry();
  registry.batch(() => {
    registry.systemPrompt.section(
      "preamble",
      () =>
        "You are a concise playground assistant. You can read the current UTC time with current_time and wait with sleep. Use tools whenever they can answer the request, and explain their results plainly.",
      { tag: false }
    );
    for (const tool of createTools()) registry.tools.add(tool);
    registry.hooks.add(ToolTask, {
      beforeTool: (call) =>
        call.name === "sleep" &&
        typeof call.arguments.seconds === "number" &&
        call.arguments.seconds > MAX_SLEEP_SECONDS
          ? { block: `sleep is capped at ${MAX_SLEEP_SECONDS} seconds.` }
          : undefined
    });
  });
  return registry;
}

/** Playable pi session backed by one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  // Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
  readonly ai = createAI({ binding: this.env.AI });
  readonly registry = createAppRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: this.#models(),
          registry: this.registry,
          onReport: (error) => console.warn("pi report", error)
        },
        context
      ),
    defaults: {
      model: { provider: CLOUDFLARE_PROVIDER_ID, modelId: MODEL_ID },
      thinkingLevel: "low",
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 }
    }
  });
  #models() {
    const models = createModels();
    models.setProvider(this.ai.provider);
    return models;
  }

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pi playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
