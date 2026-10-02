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
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  type AgentEvent,
  type EntryRecord,
  type Registry,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import {
  PiHarness,
  type PiOperationResult,
  type PiReceipt,
  type PiWhenBusy
} from "../index";

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

/**
 * The text of each transcript entry that carries a model message, so tests
 * can compare transcripts as strings. A tool call with no text is "".
 */
function entryTexts(entries: readonly EntryRecord[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "pi.reset") return ["Context reset"];
    const message = entry.model?.[0];
    if (entry.kind === "pi.system" || message === undefined) return [];
    return [textOf(message.content)];
  });
}

/** Real Durable Object fixture: a harness over pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly registry = this.#registry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, settings }) =>
      Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry: this.registry,
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
    // Short enough that a suite does not sit on the real 30s heartbeat.
    timing: { heartbeatMs: 1_000, sleepThresholdMs: 5_000 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 200 }, () => script));
  }

  async prompt(text: string, session?: string) {
    const response = await this.harness.prompt(
      text,
      session ? { session } : {}
    );
    return { ...response, messages: entryTexts(response.messages) };
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
    return entryTexts(await this.harness.messages(session ? { session } : {}));
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
  async watch(): Promise<string[]> {
    const stream = await this.harness.session().events();
    const types: string[] = [stream.snapshot.type];
    await new Promise<void>((resolve) => {
      stream.start(async (events: readonly AgentEvent[]) => {
        types.push(...events.map((event) => event.type));
        if (events.some((event) => event.type === "run_end")) resolve();
      });
    });
    await stream.stop();
    return types;
  }

  /** The transcript in a fresh snapshot, as a client joining now sees it. */
  async snapshotTexts(): Promise<string[]> {
    const stream = await this.harness.session().events();
    await stream.stop();
    return entryTexts(stream.snapshot.entries);
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  #registry(): Registry {
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "test-tools",
        sections: [
          section("preamble", () => "Use the supplied test tools.", {
            tag: false
          })
        ],
        tools: this.#tools()
      })
    );
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

const MultiplyParameters = Type.Object({ value: Type.Number() });

/** The one tool the factory fixture needs: no gating, no storage. */
function multiplyTool(): ToolRegistration<typeof MultiplyParameters> {
  return {
    name: "multiply",
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

/**
 * A harness given only its factory: no `defaults`, so new sessions start
 * without a model until one is set.
 */
export class PiNoDefaultsTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly harness = new PiHarness({
    harness: ({ storage, context, settings }) =>
      Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry: createRegistry(),
          settings
        },
        context
      ),
    timing: { heartbeatMs: 1_000, sleepThresholdMs: 5_000 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 200 }, () => script));
  }

  async prompt(text: string) {
    const response = await this.harness.prompt(text);
    return { ...response, messages: entryTexts(response.messages) };
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
export class PiStoreTestObject extends DurableObject<Cloudflare.Env> {}

export default { fetch: () => new Response("Not found", { status: 404 }) };
