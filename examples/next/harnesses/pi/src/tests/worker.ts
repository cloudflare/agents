import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { Harness, type AgentEvent } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import {
  PiHarness,
  type PiExtension,
  type PiOperationResult,
  type PiTool,
  type PiReceipt,
  type PiWhenBusy
} from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { PiSessionSockets } from "../sockets";
import { EMPTY_VIEW, reduceEvents } from "../view";

/** A pi-ai model registry holding only the faux provider. */
function fauxModels(provider: Parameters<MutableModels["setProvider"]>[0]) {
  const models = createModels();
  models.setProvider(provider);
  return models;
}

const RELEASE_KEY = "test:gate:release";
const GATE_RUNS_KEY = "test:gate:runs";

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
}

/**
 * The faux model's script, derived from the transcript alone so it gives
 * the same answer after an eviction as before it:
 *
 * - `multiply N` calls `multiply`, `gate` calls `gate`, `gate-unsafe` calls
 *   `gate_unsafe`; anything else is echoed back.
 * - After a tool result it answers `tool said: <result>`.
 */
function script(context: TranscriptContext): AssistantMessage {
  // pi places system-prompt changes positionally, so a system message can
  // follow the user's input.
  const last = context.messages.filter((m) => m.role !== "system").at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        `${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`
      )
    ]);
  }
  const prompt = last?.role === "user" ? textOf(last.content) : "";
  const multiply = /^multiply (\d+)$/.exec(prompt);
  if (multiply) {
    return fauxAssistantMessage(
      [fauxToolCall("multiply", { value: Number(multiply[1]) })],
      { stopReason: "toolUse" }
    );
  }
  if (prompt === "gate" || prompt === "gate-unsafe") {
    return fauxAssistantMessage(
      [fauxToolCall(prompt === "gate" ? "gate" : "gate_unsafe", {})],
      { stopReason: "toolUse" }
    );
  }
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

/** Real Durable Object fixture: the example's composition with pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly harness = new PiHarness({
    harness: ({ storage, context, registry, settings }) =>
      Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry,
          settings,
          onReport: (error) => console.warn("pi report", error)
        },
        context
      ),
    defaults: {
      model: {
        provider: this.#faux.getModel().provider,
        modelId: this.#faux.getModel().id
      },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }
    },
    extensions: { "test-tools": this.#testTools() },
    // Short enough that a suite does not sit on the real 30s heartbeat.
    timing: { heartbeatMs: 1_000, sleepThresholdMs: 5_000 }
  });
  readonly sockets = new PiSessionSockets(this.harness, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 200 }, () => script));
  }

  /** Prompt the root session; the result without its transcript. */
  async prompt(text: string): Promise<PiOperationResult> {
    const { messages: _messages, ...result } = await this.harness.prompt(text);
    return result;
  }

  submit(
    text: string,
    options: {
      whenBusy?: PiWhenBusy;
      session?: string;
      operationId?: string;
    } = {}
  ): Promise<PiReceipt> {
    return this.harness.submit(text, options);
  }

  wait(operationId: string, session?: string): Promise<PiOperationResult> {
    return this.harness.wait(operationId, session ? { session } : {});
  }

  /** Resolve once the gate tool has started `runs` times. */
  async gateStarted(runs: number): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const count = (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
      if (count >= runs) return count;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The gate tool never started");
  }

  async release(): Promise<void> {
    await this.ctx.storage.put(RELEASE_KEY, true);
  }

  /** Watch the root session's events until a run ends. */
  async watch(): Promise<{ view: string; types: string[] }> {
    const stream = await this.harness.session().events();
    let view = reduceEvents(EMPTY_VIEW, [stream.snapshot]);
    const types: string[] = ["snapshot"];
    await new Promise<void>((resolve) => {
      stream.start(async (events: readonly AgentEvent[]) => {
        types.push(...events.map((event) => event.type));
        view = reduceEvents(view, events);
        if (events.some((event) => event.type === "run_end")) resolve();
      });
    });
    await stream.stop();
    // JSON, so the RPC type stays shallow for the test's type checker.
    return { view: JSON.stringify(view), types };
  }

  /** The view folded from a fresh snapshot, as a client joining now sees it. */
  async snapshotView(): Promise<string> {
    const stream = await this.harness.session().events();
    await stream.stop();
    return JSON.stringify(reduceEvents(EMPTY_VIEW, [stream.snapshot]));
  }

  #testTools(): PiExtension {
    const storage = this.ctx.storage;
    const gate = (replay: "safe" | "unsafe"): PiTool<typeof NoParameters> => ({
      description: "Wait until the test releases it.",
      parameters: NoParameters,
      replay,
      async execute(_args, api, context) {
        const runs = ((await storage.get<number>(GATE_RUNS_KEY)) ?? 0) + 1;
        await storage.put(GATE_RUNS_KEY, runs);
        api.output(`run ${runs}\n`);
        while (!(await storage.get<boolean>(RELEASE_KEY))) {
          context.abortSignal?.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return {
          content: [{ type: "text", text: `released after ${runs} runs` }]
        };
      }
    });
    return (ctx) => {
      ctx.prompt.transform((prompt) =>
        prompt.set("preamble", {
          render: () => "Use the supplied test tools.",
          tag: false
        })
      );
      ctx.tools.transform((tools) => {
        tools.set("multiply", multiplyTool());
        tools.set("gate", gate("safe"));
        tools.set("gate_unsafe", gate("unsafe"));
      });
    };
  }
}

const NoParameters = Type.Object({});
const MultiplyParameters = Type.Object({ value: Type.Number() });

/** Multiplies by three. */
function multiplyTool(): PiTool<typeof MultiplyParameters> {
  return {
    description: "Multiply by three.",
    parameters: MultiplyParameters,
    replay: "safe",
    async execute({ value }) {
      return {
        content: [{ type: "text", text: String(value * 3) }],
        details: { result: value * 3 }
      };
    }
  };
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
