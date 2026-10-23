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
  defineTask,
  Harness,
  type AgentEvent,
  type EntryRecord,
  type Extension,
  type InputEntry,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { LiveInstances } from "../../../tests/shared/live-instances";
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
/** Where Lifecycle's alarm breaker counts memory-limit strikes. */
const STRIKES_KEY = "cf_agents:oom_alarm_strikes";

/**
 * A background task that sleeps until `until` with pi's `sleepUntil`, as a
 * reminder due days out would, then completes.
 */
const Reminder = defineTask<
  { until: number },
  { phase: "sleep" } | { phase: "due" },
  null
>({
  name: "test.reminder",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (task, runtime, context) => {
      await runtime.sleepUntil(task.input.until, { phase: "due" }, context);
    },
    due: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null }
        }),
        context
      );
    }
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context
    );
  }
});

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
 * - `gate-fail` calls `gate`, then fails with a model error.
 * - After a tool result it answers `tool said: <result>`.
 */
function script(
  context: TranscriptContext,
  storage: DurableObjectStorage
): AssistantMessage {
  // pi places system-prompt changes positionally, so a system message can
  // follow the user's input.
  const messages = context.messages.filter((m) => m.role !== "system");
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    const asked = messages.filter((m) => m.role === "user").at(-1);
    if (asked && textOf(asked.content) === "gate-fail") {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "model failed after the gate"
      });
    }
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
  if (prompt === "gate" || prompt === "gate-fail" || prompt === "gate-unsafe") {
    return fauxAssistantMessage(
      [fauxToolCall(prompt === "gate-unsafe" ? "gate_unsafe" : "gate", {})],
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

/**
 * pi's storage, failing the next commit with `faults.commit` when one is
 * set, as a lost disk would. Any error a Storage commit throws fails pi's
 * Session for good.
 */
function withCommitFault(
  storage: SqliteStorage,
  faults: { commit?: Error }
): SqliteStorage {
  return new Proxy(storage, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "commit") return value.bind(target);
      return (...args: Parameters<SqliteStorage["commit"]>) => {
        const error = faults.commit;
        faults.commit = undefined;
        return error ? Promise.reject(error) : target.commit(...args);
      };
    }
  });
}

/** Every {@link PiHarnessTestObject} harness, by object name. */
const piHarnessInstances = new LiveInstances();

/** Real Durable Object fixture: a harness over pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly #faults: { commit?: Error } = {};
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.registry.install(this.#testTools());
      const name = this.ctx.id.name ?? "";
      return this.#observe(
        await Harness.open(
          withCommitFault(storage, this.#faults),
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
    piHarnessInstances.track(ctx.id.name ?? "", this.harness);
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

  /** When the harness's wake job is due, while it has one. */
  wakeJobTime(): number | null {
    return (
      this.ctx.storage.sql
        .exec<{ time: number }>(
          "SELECT time FROM cf_agents_jobs WHERE id = 'pi-wake'"
        )
        .toArray()[0]?.time ?? null
    );
  }

  /**
   * Make the wake job due now, creating it if it is gone, with the alarm
   * set for it.
   */
  async wakeJobDueNow(): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO cf_agents_jobs (id, capability, fn, time, singleflight, recovery_loop)
       VALUES ('pi-wake', 'pi-harness', 'wake', ?, 1, 1)
       ON CONFLICT(id) DO UPDATE SET time = excluded.time, running = 0`,
      Date.now()
    );
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Make every wake step fail, or stop, as a broken pi would. */
  failWakeSteps(fail: boolean): void {
    this.#failWakeSteps = fail;
  }

  /** The alarm memory-limit breaker's strike count. */
  async memoryLimitStrikes(): Promise<number> {
    return (await this.ctx.storage.get<number>(STRIKES_KEY)) ?? 0;
  }

  /**
   * Start a background reminder in the root session that sleeps until
   * `until`, as pi's own retries and polls sleep.
   */
  async remindAt(until: number): Promise<void> {
    const pi = await this.harness.pi();
    const root = await pi.root(BACKGROUND_CONTEXT);
    await root.commit(
      (tx) =>
        tx.createTask(
          Reminder,
          { until },
          { ownership: { kind: "conversation" }, background: true }
        ),
      BACKGROUND_CONTEXT
    );
    pi.resume();
  }

  /** How many reminder tasks are still live, not yet completed. */
  async liveReminders(): Promise<number> {
    const pi = await this.harness.pi();
    const inspection = await pi.inspect(BACKGROUND_CONTEXT);
    return inspection.tasks.filter(
      ({ record }) => record.kind === Reminder.definition.name
    ).length;
  }

  /** When pi next needs to run, as `pi.wake()` says. */
  async piWake() {
    return (await this.harness.pi()).wake();
  }

  /** Count this object's harnesses still alive after a forced GC. */
  countLiveHarnesses(): Promise<number> {
    return piHarnessInstances.countAfterGC(this.ctx.id.name ?? "");
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

  /** `wait()`, given up after `ms`: `"waiting"` if it had not settled. */
  async waitWithin(
    operationId: string,
    ms: number,
    session?: string
  ): Promise<PiOperationResult | "waiting"> {
    const signal = AbortSignal.timeout(ms);
    try {
      return await this.harness.wait(operationId, {
        signal,
        ...(session ? { session } : {})
      });
    } catch (error) {
      if (signal.aborted) return "waiting";
      throw error;
    }
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

  /**
   * Submit with pi's next storage commit failing with `message`, which fails
   * pi's Session. Returns the error the submit rejected with.
   */
  async submitThroughStorageError(
    text: string,
    message = "disk gone"
  ): Promise<string> {
    this.#faults.commit = new Error(message);
    try {
      await this.harness.submit(text);
      return "submitted";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      this.#faults.commit = undefined;
    }
  }

  /** Close pi's in-memory resources, as the host does on shutdown. */
  async dispose(): Promise<void> {
    await this.harness.dispose();
  }

  async abort(operationId?: string): Promise<boolean> {
    return this.harness.abort({ operationId });
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
  #failWakeSteps = false;

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
   * How many times `pi.resume()` has been called in this instance: each wake
   * step past a running wait, which starts a new wait while pi is active,
   * and each sleep a running wait resumes when it is due.
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
   * during a wait returns first. A wait calls it too when a sleep beside the
   * running work is due. The method is replaced on the instance:
   * pi checks its own objects' brands, so a proxy would not pass for it.
   */
  #observe(pi: Harness): Harness {
    const resume = pi.resume.bind(pi);
    pi.resume = (...args) => {
      if (this.#failWakeSteps) throw new Error("pi is unavailable");
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
      tasks: [Reminder],
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
