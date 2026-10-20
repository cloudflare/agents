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
  type EntryRecord,
  type Extension,
  type InputEntry,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { setWakeTimingForTests } from "../harness";
import { TEST_TIMING } from "./timing";
import { fauxModels, TEST_SETTINGS } from "./faux";
import {
  PiHarness,
  type PiOperationResult,
  type PiReceipt,
  type PiWhenBusy
} from "../index";

const RELEASE_KEY = "test:gate:release";
const GATE_RUNS_KEY = "test:gate:runs";
const HOLD_RUNS_KEY = "test:hold:runs";
const FLAKY_KEY = "test:flaky:failed";

/**
 * Variants of `PiHarnessTestObject`, by the prefix of the object's name, so
 * a variant survives a restart:
 *
 * - `nowake:` opens pi without `onWake`.
 * - `retry:` retries a failed generation once, after two seconds.
 * - `park:` parks a task after its first restart.
 */
function variantSettings(name: string) {
  const plain = name.replace(/^nowake:/, "");
  if (plain.startsWith("retry:")) {
    return { retry: { enabled: true, maxRetries: 1, baseDelayMs: 2_000 } };
  }
  if (plain.startsWith("park:")) return { ...TEST_SETTINGS, restartLimit: 1 };
  return TEST_SETTINGS;
}

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
 *   `gate_unsafe`, `hold` calls `hold`; `flaky` fails once with a retryable
 *   error; anything else is echoed back.
 * - After a tool result it answers `tool said: <result>`.
 */
function script(
  context: TranscriptContext,
  storage: DurableObjectStorage
): AssistantMessage {
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
  // `flaky` fails once with a retryable error, then is echoed.
  if (prompt === "flaky" && storage.kv.get(FLAKY_KEY) === undefined) {
    storage.kv.put(FLAKY_KEY, true);
    return fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "overloaded"
    });
  }
  const multiply = /^multiply (\d+)$/.exec(prompt);
  if (multiply) {
    return fauxAssistantMessage(
      [fauxToolCall("multiply", { value: Number(multiply[1]) })],
      { stopReason: "toolUse" }
    );
  }
  if (prompt === "hold") {
    return fauxAssistantMessage([fauxToolCall("hold", {})], {
      stopReason: "toolUse"
    });
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
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.registry.install(this.#testTools());
      const name = this.ctx.id.name ?? "";
      return this.#observe(
        await Harness.open(
          storage,
          {
            models: fauxModels(this.#faux.provider),
            registry: this.registry,
            settings: variantSettings(name),
            ...(name.startsWith("nowake:") ? {} : { onWake }),
            onReport: (error) => console.warn("pi report", error)
          },
          context
        )
      );
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    this.#faux.setResponses(
      Array.from(
        { length: 200 },
        () => (context: TranscriptContext) => script(context, ctx.storage)
      )
    );
  }

  /** The harness's pending Lifecycle jobs: its wake, while it has one. */
  wakeJobs(): string[] {
    return this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM cf_agents_jobs WHERE capability = 'pi-harness'"
      )
      .toArray()
      .map((row) => row.id);
  }

  /**
   * Leave a per-session wake job as a version before Pi 1.4 did, due now,
   * with the alarm set for it.
   */
  async addLegacyWakeJob(): Promise<void> {
    // A first prompt creates the jobs table.
    await this.harness.prompt("hello");
    this.ctx.storage.sql.exec(
      `INSERT INTO cf_agents_jobs (id, capability, fn, time, payload, singleflight, recovery_loop)
       VALUES ('pi-wake:1', 'pi-harness', 'wake', ?, '{"session":"1"}', 1, 1)`,
      Date.now()
    );
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** When pi next needs to run, as `pi.wake()` says. */
  async piWake() {
    return (await this.harness.pi()).wake();
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
      entry?: InputEntry;
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

  /**
   * Each transcript entry that carries a model message: its kind, its data
   * as JSON, the message's role and text.
   */
  async entries(): Promise<
    { kind: string; data: string; role: string; text: string }[]
  > {
    return (await this.harness.messages()).flatMap((entry) => {
      const message = entry.model?.[0];
      if (entry.kind === "pi.system" || message === undefined) return [];
      return [
        {
          kind: entry.kind,
          data: JSON.stringify(entry.data ?? null),
          role: message.role,
          text: textOf(message.content)
        }
      ];
    });
  }

  async abort(): Promise<boolean> {
    return this.harness.abort();
  }

  async retry(): Promise<boolean> {
    return this.harness.retry();
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }

  async listSessions() {
    return this.harness.sessions.list();
  }

  /** Resolve once the gate tool has started `runs` times. */
  async gateStarted(runs: number): Promise<number> {
    return this.#toolStarted("gate", GATE_RUNS_KEY, runs);
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

  /** Random per instance, so a test can tell the object was evicted. */
  readonly #instance = crypto.randomUUID();
  #releaseHold: (() => void) | undefined;
  #wakeSteps = 0;

  instance(): string {
    return this.#instance;
  }

  async holdRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>(HOLD_RUNS_KEY)) ?? 0;
  }

  /** Resolve once the hold tool has started `runs` times. */
  async holdStarted(runs: number): Promise<number> {
    return this.#toolStarted("hold", HOLD_RUNS_KEY, runs);
  }

  /** Poll a tool's stored run count until it reaches `runs`. */
  async #toolStarted(
    tool: string,
    runsKey: string,
    runs: number
  ): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const count = (await this.ctx.storage.get<number>(runsKey)) ?? 0;
      if (count >= runs) return count;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`The ${tool} tool never started`);
  }

  /** Release this instance's hold tool, if it is running here. */
  releaseHold(): boolean {
    const release = this.#releaseHold;
    release?.();
    return release !== undefined;
  }

  /**
   * How many times the wake job has stepped past a running wait, in this
   * instance. While pi is active, each such step starts a new wait.
   */
  wakeSteps(): number {
    return this.#wakeSteps;
  }

  setWaitBudget(waitBudgetMs: number): void {
    setWakeTimingForTests(this.harness, { waitBudgetMs });
  }

  /**
   * pi, with the wake's steps counted. A wake step that finds no wait
   * running calls `pi.resume()` before it reads `pi.wake()`; a heartbeat
   * during a wait returns first. The method is replaced on the instance:
   * pi checks its own objects' brands, so a proxy would not pass for it.
   */
  #observe(pi: Harness): Harness {
    const resume = pi.resume.bind(pi);
    pi.resume = (...args) => {
      this.#wakeSteps++;
      return resume(...args);
    };
    return pi;
  }

  /** The fixture's tools and preamble, as one pi extension. */
  #testTools(): Extension {
    const storage = this.ctx.storage;
    // Waits on an in-memory promise and does no I/O, like a tool waiting
    // for an approval. Only something else in flight keeps the object
    // alive while it waits.
    const holdTool = (): ToolRegistration<typeof NoParameters> => ({
      name: "hold",
      description: "Wait in memory until the test releases it.",
      parameters: NoParameters,
      replay: "safe",
      execute: async () => {
        const runs = ((await storage.get<number>(HOLD_RUNS_KEY)) ?? 0) + 1;
        await storage.put(HOLD_RUNS_KEY, runs);
        await new Promise<void>((resolve) => {
          this.#releaseHold = resolve;
        });
        return { output: [{ type: "text", text: `held after ${runs} runs` }] };
      }
    });
    const gate = (
      name: string,
      replay: "safe" | "unsafe"
    ): ToolRegistration<typeof NoParameters> => ({
      name,
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
          output: [{ type: "text", text: `released after ${runs} runs` }]
        };
      }
    });
    return {
      name: "test-tools",
      sections: [
        {
          key: "preamble",
          render: () => "Use the supplied test tools.",
          tag: false
        }
      ],
      tools: [
        holdTool(),
        multiplyTool(),
        gate("gate", "safe"),
        gate("gate_unsafe", "unsafe")
      ]
    };
  }
}

const NoParameters = Type.Object({});
const MultiplyParameters = Type.Object({ value: Type.Number() });

/** Multiplies by three: no gating, no storage. */
function multiplyTool(): ToolRegistration<typeof MultiplyParameters> {
  return {
    name: "multiply",
    description: "Multiply by three.",
    parameters: MultiplyParameters,
    replay: "safe",
    async execute({ value }) {
      return {
        output: [{ type: "text", text: String(value * 3) }],
        details: { result: value * 3 }
      };
    }
  };
}

/**
 * A harness given only its providers: no `defaults`, so new sessions start
 * without a model until one is set. Its factory does not pass `onWake`
 * either, so it runs on the polling fallback.
 */
export class PiNoDefaultsTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry: createRegistry(),
          settings: TEST_SETTINGS
        },
        context
      )
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    this.#faux.setResponses(
      Array.from(
        { length: 200 },
        () => (context: TranscriptContext) => script(context, ctx.storage)
      )
    );
  }

  async prompt(text: string) {
    const response = await this.harness.prompt(text);
    return { ...response, messages: entryTexts(response.messages) };
  }

  async setFauxModel(): Promise<void> {
    await this.harness.session().setModel(this.#faux.getModel());
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

/** A bare object whose SQLite database the storage conformance suite uses. */
export class PiStoreTestObject extends DurableObject<Cloudflare.Env> {}

export { PiBrowserTestObject } from "./browser-fixture";
export { CodemodeRuntime } from "@cloudflare/codemode";
export {
  PiFactoryTestObject,
  PiFlakyFactoryTestObject
} from "./factory-fixture";

export default { fetch: () => new Response("Not found", { status: 404 }) };
