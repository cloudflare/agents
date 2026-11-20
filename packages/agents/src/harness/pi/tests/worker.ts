import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext,
  type Usage
} from "@earendil-works/pi-ai";
import { num, obj, str } from "@earendil-works/pi-schema";
import {
  AssistantEntry,
  createRegistry,
  defineSignal,
  defineTask,
  hook,
  SubmissionSettled,
  ToolTask,
  ConversationBusy,
  ConversationIdle,
  Harness,
  ROOT_CONVERSATION_ID,
  ToolResultEntry,
  UserEntry,
  type ConversationInit,
  type EntryRecord,
  type Extension,
  type InputEntry,
  type LiveState,
  type SubmissionNotify,
  type TaskId,
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
  type PiOnAbort,
  type PiOperationResult,
  type PiReceipt,
  type PiWhenBusy,
  type PiWhenIdle
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
 * - `park:` ends a task cut off once (pi's `restartLimit` of 1).
 * - `turns:` starts sessions with `maxTurns: 1`.
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
 * - `approval` calls `await_approval`, `approval-gate` calls
 *   `approval_then_gate`, `deadline` calls `await_deadline`, and
 *   `subagent:<task>` calls `subagent` with the task.
 * - After a tool result it answers `tool said: <result>`.
 */
/** The answer the `await_approval` tool parks on, delivered by the test. */
const Approval = defineSignal({
  name: "test.approval",
  version: 1,
  schema: obj({ text: str() })
});

/** Where `await_approval` records the task id of its parked call. */
const PARKED_TASK_KEY = "pi-test-parked-task";
/** How many times a parked call's `cancel()` ran. */
const CANCELS_KEY = "pi-test-cancels";
/** How many times the `beforeTool` gate on `multiply 77` ran. */
const GATE_HOOK_RUNS_KEY = "pi-test-gate-hook-runs";

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
  if (prompt === "approval") {
    return fauxAssistantMessage([fauxToolCall("await_approval", {})], {
      stopReason: "toolUse"
    });
  }
  if (prompt === "approval-gate") {
    return fauxAssistantMessage([fauxToolCall("approval_then_gate", {})], {
      stopReason: "toolUse"
    });
  }
  if (prompt === "deadline") {
    return fauxAssistantMessage([fauxToolCall("await_deadline", {})], {
      stopReason: "toolUse"
    });
  }
  if (prompt.startsWith("subagent:")) {
    return fauxAssistantMessage(
      [fauxToolCall("subagent", { task: prompt.slice("subagent:".length) })],
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
  // `big:` inputs are too long to echo at the faux provider's pace.
  if (prompt.startsWith("big:")) {
    return fauxAssistantMessage([fauxText(`got ${prompt.length}`)]);
  }
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

/** Usage for an imported assistant message, which has none: pi sums it. */
const NO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

/**
 * Seed a session's transcript with a history, one entry per message, as a
 * host importing an existing chat does: the user's message, the model's
 * tool call, the tool's result, and the model's answer. Pass it as `init`.
 */
function seedHistory(
  model: Pick<Model<string>, "api" | "provider" | "id">,
  value: number
): ConversationInit {
  const assistant = (
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"]
  ): AssistantMessage => ({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: NO_USAGE,
    stopReason,
    timestamp: Date.now()
  });
  const callId = `imported-${value}`;
  return async (tx, conversationId) => {
    await tx.appendEntry(UserEntry, conversationId, {
      model: [
        { role: "user", content: `multiply ${value}`, timestamp: Date.now() }
      ]
    });
    await tx.appendEntry(AssistantEntry, conversationId, {
      model: [
        assistant(
          [
            {
              type: "toolCall",
              id: callId,
              name: "multiply",
              arguments: { value }
            }
          ],
          "toolUse"
        )
      ]
    });
    await tx.appendEntry(ToolResultEntry, conversationId, {
      model: [
        {
          role: "toolResult",
          toolCallId: callId,
          toolName: "multiply",
          content: [{ type: "text", text: String(value * 3) }],
          isError: false,
          timestamp: Date.now()
        }
      ],
      data: { diagnostics: [] }
    });
    await tx.appendEntry(AssistantEntry, conversationId, {
      model: [
        assistant([{ type: "text", text: `tool said: ${value * 3}` }], "stop")
      ]
    });
  };
}

/** A model request as tests compare it: each message as `role: text`. */
function requestTexts(context: TranscriptContext): string[] {
  return context.messages.map((message) => {
    if (message.role === "system") {
      return `system: ${textOf(message.content)}${JSON.stringify(message.sections ?? {})}`;
    }
    if (message.role === "assistant") {
      return `assistant: ${message.content
        .map((part) =>
          part.type === "toolCall"
            ? `${part.name}(${JSON.stringify(part.arguments)})`
            : part.type === "text"
              ? part.text
              : ""
        )
        .join("")}`;
    }
    return `${message.role}: ${textOf(message.content)}`;
  });
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
            onReport: (report) => console.warn("pi report", report)
          },
          context
        )
      );
    },
    defaults: {
      model: this.#faux.getModel(),
      ...(this.ctx.id.name?.startsWith("turns:") ? { maxTurns: 1 } : {})
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    this.#faux.setResponses(
      Array.from({ length: 200 }, () => (context: TranscriptContext) => {
        this.#requests.push(requestTexts(context));
        return script(context, ctx.storage);
      })
    );
    piHarnessInstances.track(ctx.id.name ?? "", this.harness);
  }

  /** What this instance sent the model, one request at a time. */
  readonly #requests: string[][] = [];

  /** The last model request this instance sent, each message as `role: text`. */
  lastRequest(): string[] {
    return this.#requests.at(-1) ?? [];
  }

  /**
   * `harness.root()` with `seedHistory(value)` as `init`, or with an `init`
   * that appends an entry and then throws. Reports whether `init` ran,
   * since its function cannot cross RPC.
   */
  async seedRoot(
    options: { value?: number; instructions?: string; fail?: boolean } = {}
  ): Promise<
    | { session: string; created: boolean; initRan: boolean }
    | { error: string; initRan: boolean }
  > {
    let initRan = false;
    const seed = seedHistory(this.#faux.getModel(), options.value ?? 4);
    try {
      const { session, created } = await this.harness.root({
        ...(options.instructions
          ? { agent: { instructions: options.instructions } }
          : {}),
        init: async (tx, id) => {
          initRan = true;
          await seed(tx, id);
          if (options.fail) throw new Error("import failed");
        }
      });
      return { session: session.id, created, initRan };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        initRan
      };
    }
  }

  /** `sessions.create()`, seeded with `seedHistory(value)`. */
  async createSeededSession(
    value: number,
    instructions?: string
  ): Promise<string> {
    const session = await this.harness.sessions.create({
      ...(instructions ? { agent: { instructions } } : {}),
      init: seedHistory(this.#faux.getModel(), value)
    });
    return session.id;
  }

  /** `sessions.fork(from)`, with `seedHistory(value)` appended after the fork. */
  async forkSeeded(from: string, value: number): Promise<string> {
    const session = await this.harness.sessions.fork(from, {
      init: seedHistory(this.#faux.getModel(), value)
    });
    return session.id;
  }

  /**
   * Whether pi has the root conversation, read through `harness.pi()`, which
   * does not create it.
   */
  async rootExists(): Promise<boolean> {
    const pi = await this.harness.pi();
    return (await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))
      ? true
      : false;
  }

  async busy(session?: string): Promise<boolean> {
    return this.harness.session(session).busy();
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
    const root = await this.harness.conversation("1");
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
      onAbort?: PiOnAbort;
      session?: string;
      operationId?: string;
      entry?: InputEntry;
      notify?: { taskId: number; key: string };
    } = {}
  ): Promise<PiReceipt> {
    const { notify, ...rest } = options;
    return this.harness.submit(text, {
      ...rest,
      ...(notify
        ? {
            notify: {
              key: notify.key,
              taskId: notify.taskId as SubmissionNotify["taskId"]
            }
          }
        : {})
    });
  }

  /** The `notify` pi stored with the root session's submission. */
  async storedNotify(operationId: string) {
    const storage = await this.harness.storage();
    const conversation = await this.harness.conversation("1");
    const record = await storage.submissionByRequest(
      conversation.id,
      operationId,
      BACKGROUND_CONTEXT
    );
    return record?.notify ?? null;
  }

  continueSession(
    operationId?: string,
    notify?: { taskId: number; key: string }
  ): Promise<PiReceipt> {
    return this.harness.continue({
      ...(operationId ? { operationId } : {}),
      ...(notify
        ? {
            notify: {
              key: notify.key,
              taskId: notify.taskId as SubmissionNotify["taskId"]
            }
          }
        : {})
    });
  }

  /**
   * `submit()`, with how it settled: a receipt, or the error's name and
   * whether it is pi's `ConversationBusy` or `ConversationIdle`. Error
   * classes do not survive RPC.
   */
  async trySubmit(
    text: string,
    options: {
      whenBusy?: PiWhenBusy;
      whenIdle?: PiWhenIdle;
      operationId?: string;
    } = {}
  ): Promise<
    | { receipt: PiReceipt }
    | {
        error: string;
        conversationBusy: boolean;
        conversationIdle: boolean;
        message: string;
      }
  > {
    try {
      return { receipt: await this.harness.submit(text, options) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.name : String(error),
        conversationBusy: error instanceof ConversationBusy,
        conversationIdle: error instanceof ConversationIdle,
        message: error instanceof Error ? error.message : String(error)
      };
    }
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

  /**
   * Watch the root session through one run: what the view showed on the way,
   * and the transcript in its last value.
   */
  async watch(): Promise<{ sawRun: boolean; texts: string[] }> {
    const watch = await this.harness.session().watch();
    let sawRun = false;
    let texts: string[] = [];
    await new Promise<void>((resolve) => {
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        const { value } = call;
        const live = value.docs["pi.live"] as LiveState | undefined;
        if (live?.run !== undefined) sawRun = true;
        if (sawRun && live?.run === undefined) {
          texts = entryTexts(value.entries);
          resolve();
        }
      });
    });
    await watch.stop();
    return { sawRun, texts };
  }

  /** The transcript in a new watch's first value, as a client joining now sees it. */
  async watchTexts(): Promise<string[]> {
    const watch = await this.harness.session().watch();
    await watch.stop();
    return entryTexts(watch.value.entries);
  }

  /** The root session's transcript, oldest first, paged `size` entries at a time. */
  async pagedTexts(size: number): Promise<string[]> {
    const session = this.harness.session();
    const entries: EntryRecord[] = [];
    let page = await session.entries({ order: "ascending" }, size);
    entries.push(...page.items);
    while (page.items.length === size) {
      const last = page.items[page.items.length - 1];
      page = await session.entries(
        { order: "ascending", minEntryId: (last.id + 1) as EntryRecord["id"] },
        size
      );
      entries.push(...page.items);
    }
    return entryTexts(entries);
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** The task id of the parked `await_approval` call, once it parked. */
  async parkedTask(): Promise<number | null> {
    return (await this.ctx.storage.get<number>(PARKED_TASK_KEY)) ?? null;
  }

  /**
   * Deliver the approval the parked call waits for, as a host would, under
   * `key`: `approval` for the tools, `gate` for the `beforeTool` gate.
   */
  async approve(text: string, key = "approval"): Promise<string> {
    const taskId = (await this.parkedTask()) as TaskId | null;
    if (taskId === null) throw new Error("no parked call");
    return this.harness.signal(taskId, Approval, key, { text });
  }

  async cancels(): Promise<number> {
    return (await this.ctx.storage.get<number>(CANCELS_KEY)) ?? 0;
  }

  async gateHookRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>(GATE_HOOK_RUNS_KEY)) ?? 0;
  }

  /** A session's transcript, as text, by session id. */
  async sessionTexts(session: string): Promise<string[]> {
    return entryTexts(await this.harness.session(session).messages());
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
    // Parks on the Approval signal instead of returning, holding no
    // invocation, and runs again with the answer once it is delivered.
    const awaitApproval: ToolRegistration<typeof NoParameters> = {
      name: "await_approval",
      description: "Wait for a person's approval.",
      parameters: NoParameters,
      replay: "safe",
      async execute(_args, api, context) {
        const answer = await api.readSignal(Approval, "approval", context);
        if (answer !== undefined && "value" in answer) {
          return { output: [{ type: "text", text: answer.value.text }] };
        }
        await storage.put(PARKED_TASK_KEY, api.taskId);
        return { sleep: { signals: [Approval.key("approval")] } };
      }
    };
    // Waits for approval, then for the gate: a call woken by a signal that
    // is still running when the object dies. Counts its cancels.
    const approvalThenGate: ToolRegistration<typeof NoParameters> = {
      name: "approval_then_gate",
      description: "Wait for approval, then until the test releases it.",
      parameters: NoParameters,
      replay: "safe",
      async execute(_args, api, context) {
        const answer = await api.readSignal(Approval, "approval", context);
        if (answer === undefined || !("value" in answer)) {
          await storage.put(PARKED_TASK_KEY, api.taskId);
          return { sleep: { signals: [Approval.key("approval")] } };
        }
        const runs = ((await storage.get<number>(GATE_RUNS_KEY)) ?? 0) + 1;
        await storage.put(GATE_RUNS_KEY, runs);
        while (!(await storage.get<boolean>(RELEASE_KEY))) {
          context.abortSignal?.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return {
          output: [
            { type: "text", text: `${answer.value.text} after ${runs} runs` }
          ]
        };
      },
      async cancel() {
        await storage.put(
          CANCELS_KEY,
          ((await storage.get<number>(CANCELS_KEY)) ?? 0) + 1
        );
      }
    };
    // Waits for approval for at most 1.5 s.
    const awaitDeadline: ToolRegistration<typeof NoParameters> = {
      name: "await_deadline",
      description: "Wait for approval, at most 1.5 s.",
      parameters: NoParameters,
      replay: "safe",
      async execute(_args, api) {
        if (api.wake !== undefined) {
          return {
            output: [{ type: "text", text: `woke ${api.wake.reason}` }]
          };
        }
        await storage.put(PARKED_TASK_KEY, api.taskId);
        return {
          sleep: {
            until: api.now() + 1_500,
            signals: [Approval.key("approval")]
          }
        };
      }
    };
    // Pi's subagent pattern, as the docs show it: a child owned by the
    // call, a submission that notifies the call when it settles, and the
    // child's answer as the result.
    const subagent: ToolRegistration<typeof SubagentParameters> = {
      name: "subagent",
      description: "Delegate a task to a subagent and get its answer back.",
      parameters: SubagentParameters,
      replay: "safe",
      async execute({ task }, api, context) {
        const state = await api.readSignal(
          SubmissionSettled,
          "answered",
          context
        );
        if (state !== undefined && "value" in state) {
          const settled = state.value;
          if (settled.status !== "done" || settled.type === "write") {
            return {
              output: [{ type: "text", text: `Subagent ${settled.status}` }],
              isError: true
            };
          }
          const answer = await api.commit(
            (tx) => tx.entry(settled.answer),
            context
          );
          return {
            output: [
              { type: "text", text: textOf(answer?.model?.[0]?.content) }
            ]
          };
        }
        const child = await api.commit(async (tx) => {
          const existing = (
            await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
          ).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId }
          });
          return created.id;
        }, context);
        const handle = await api.conversation(child, context);
        await handle?.submit(
          {
            type: "input",
            content: task,
            requestId: `subagent:${api.taskId}`,
            notify: { taskId: api.taskId, key: "answered" }
          },
          context
        );
        await storage.put(PARKED_TASK_KEY, api.taskId);
        return { sleep: { signals: [SubmissionSettled.key("answered")] } };
      }
    };
    // Holds `multiply 77` until the test delivers the `gate` signal.
    const multiplyGate = hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        if (call.name !== "multiply" || call.arguments.value !== 77) {
          return undefined;
        }
        await storage.put(
          GATE_HOOK_RUNS_KEY,
          ((await storage.get<number>(GATE_HOOK_RUNS_KEY)) ?? 0) + 1
        );
        if ((await api.readSignal(Approval, "gate", context)) !== undefined) {
          return undefined;
        }
        await storage.put(PARKED_TASK_KEY, api.taskId);
        return { sleep: { signals: [Approval.key("gate")] } };
      }
    });
    return {
      name: "test-tools",
      hooks: [multiplyGate],
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
        gate("gate_unsafe", "unsafe"),
        awaitApproval,
        approvalThenGate,
        awaitDeadline,
        subagent
      ]
    };
  }
}

const NoParameters = obj({});
const MultiplyParameters = obj({ value: num() });
const SubagentParameters = obj({ task: str() });

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
export { PiWebTestObject } from "./web-fixture";
export { CodemodeRuntime } from "@cloudflare/codemode";
export {
  PiFactoryTestObject,
  PiFlakyFactoryTestObject
} from "./factory-fixture";
export { PiWireTestObject } from "./wire-fixture";

export default { fetch: () => new Response("Not found", { status: 404 }) };
