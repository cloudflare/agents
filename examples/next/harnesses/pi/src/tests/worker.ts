import type { JsonValue } from "@earendil-works/chord";
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
import {
  createRegistry,
  Harness,
  type AgentEvent,
  type Registry,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { PiHarness } from "../harness/pi-harness";
import { PiSessionSockets } from "../sockets";
import type {
  PiMessage,
  PiOperationResult,
  PiReceipt,
  PiWhenBusy
} from "../harness/types";
import { EMPTY_VIEW, reduceEvents } from "../view";
import { createModels } from "../providers/models";

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

function messageText(message: PiMessage): string {
  return message.parts
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "tool-result"
          ? part.content.map((c) => (c.type === "text" ? c.text : "")).join("")
          : ""
    )
    .join("");
}

/** Real Durable Object fixture: the example's composition with pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly registry = this.#registry();
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: createModels({ providers: [this.#faux.provider] }),
          registry: this.registry,
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
    // Short enough that a suite does not sit on the real 30s heartbeat.
    timing: { heartbeatMs: 1_000, sleepThresholdMs: 5_000 }
  });
  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
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

  async prompt(text: string, session?: string) {
    const response = await this.harness.prompt(
      text,
      session ? { session } : {}
    );
    return { ...response, messages: response.messages.map(messageText) };
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

  async messages(session?: string): Promise<string[]> {
    return (await this.harness.messages(session ? { session } : {})).map(
      messageText
    );
  }

  async pending() {
    return this.harness.pending();
  }

  async abort(): Promise<boolean> {
    return this.harness.abort();
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }

  async listSessions() {
    return this.harness.sessions.list();
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

  async gateRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
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

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  #registry(): Registry {
    const registry = createRegistry();
    registry.batch(() => {
      registry.systemPrompt.section(
        "preamble",
        () => "Use the supplied test tools.",
        { tag: false }
      );
      for (const tool of this.#tools()) registry.tools.add(tool);
    });
    return registry;
  }

  #tools(): ToolRegistration[] {
    const storage = this.ctx.storage;
    const gate = (
      name: string,
      replay: "safe" | "unsafe"
    ): ToolRegistration => ({
      name,
      description: "Wait until the test releases it.",
      parameters: Type.Object({}),
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
    return [
      multiplyTool(),
      gate("gate", "safe"),
      gate("gate_unsafe", "unsafe")
    ];
  }
}

/** The one tool the factory fixture needs: no gating, no storage. */
function multiplyTool(): ToolRegistration {
  return {
    name: "multiply",
    description: "Multiply by three.",
    parameters: Type.Object({ value: Type.Number() }),
    replay: "safe",
    async execute(args: JsonValue) {
      const { value } = args as { value: number };
      return {
        content: [{ type: "text", text: String(value * 3) }],
        details: { result: value * 3 }
      };
    }
  };
}

/**
 * A harness given only its factory: no `defaults`, so new sessions start
 * without a model until one is set.
 */
export class PiNoDefaultsTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: createModels({ providers: [this.#faux.provider] }),
          registry: createRegistry()
        },
        context
      ),
    timing: { heartbeatMs: 1_000, sleepThresholdMs: 5_000 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 200 }, () => script));
  }

  async prompt(text: string) {
    const response = await this.harness.prompt(text);
    return { ...response, messages: response.messages.map(messageText) };
  }

  async setFauxModel(): Promise<void> {
    const model = this.#faux.getModel();
    await this.harness
      .session()
      .setModel({ provider: model.provider, modelId: model.id });
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

/** A bare object whose SQLite database the storage conformance suite uses. */
export class PiStoreTestObject extends DurableObject<Env> {}

export default { fetch: () => new Response("Not found", { status: 404 }) };
