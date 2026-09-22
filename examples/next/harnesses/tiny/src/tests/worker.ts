/**
 * Test-local Durable Objects.
 *
 * Structurally the same composition as `src/server.ts`, with the model
 * replaced by a scripted adapter and the script supplied per test over RPC.
 * Keeping this separate from the production entrypoint means the tests never
 * need a production seam that exists only for them.
 *
 * The harness is built lazily, on the first `configure()` or turn, because
 * options like `maxRounds` and `approval` are read once in its constructor
 * and each test wants different ones. `Lifecycle.install()` still happens in
 * the DO constructor, which is what the real server does.
 */
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { TinyHarness } from "../harness";
import type { ApprovalMode } from "../harness";
import type { HarnessRole, TurnEvent, TurnSnapshot } from "../protocol";

import { TURN_DEFINITION } from "../turn";
import type { TurnResult } from "../turn";
import { scriptedModel, scriptedModels } from "./scripted-model";
import type {
  ScriptedCall,
  ScriptedModel,
  ScriptedRound
} from "./scripted-model";

const ROOT = "/workspace";

/** Default canned summary the compaction summarizer returns. */
const SUMMARY_TEXT = "SUMMARY: the earlier turns were about fizzbuzz.";

type AgentTasks = Tasks<{
  [TURN_DEFINITION]: (input: never, step: TaskStep) => Promise<TurnResult>;
}>;

/** Config a test sends before driving a turn. */
export type TestConfig = {
  readonly rounds: readonly ScriptedRound[];
  readonly role?: HarnessRole;
  readonly approval?: "auto" | "interactive";
  readonly approvalTimeoutMs?: number;
  readonly maxRounds?: number;
  /**
   * Compaction policy. Off by default, because a summarizer call would
   * consume scripted rounds and most tests are about the loop.
   * `compaction.test.ts` turns it on.
   */
  readonly compaction?:
    | false
    | { readonly afterTokens?: number; readonly keepRecentTokens?: number };
  /** Canned summary the compaction summarizer returns. */
  readonly summary?: string;
};


/** The base fixture, shared by the lead and subagent objects. */
abstract class TestAgentBase extends DurableObject<Env> {
  readonly tasks: AgentTasks;
  readonly streams = new Streams();
  readonly sessions = new Sessions();
  readonly lifecycle: Lifecycle;

  #model: ScriptedModel;
  /**
   * A second scripted model, used only by the compaction summarizer.
   *
   * Replies with one text round, for ever, because `chat()` may be called
   * any number of times by the compaction algorithm and a test should not
   * have to predict how many.
   */
  #summarizer: ScriptedModel;
  #harness: TinyHarness | undefined;
  #config: TestConfig;

  constructor(ctx: DurableObjectState, env: Env, defaults: TestConfig) {
    super(ctx, env);

    // The script has to outlive the isolate. A durability test evicts the
    // object mid-turn and the run then resumes in a fresh one, which rebuilds
    // this fixture from its constructor — with the default script, not the
    // test's, so the replayed rounds would come from the wrong script.
    // Persisting it is what makes "evict and let it replay" testable at all.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS test_config (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         json TEXT NOT NULL,
         cursor INTEGER NOT NULL DEFAULT 0
       );`
    );
    const saved = [
      ...ctx.storage.sql.exec<{ json: string; cursor: number }>(
        "SELECT json, cursor FROM test_config WHERE id = 1"
      )
    ][0];
    this.#config = saved ? (JSON.parse(saved.json) as TestConfig) : defaults;
    this.#model = this.#createModel(this.#config.rounds, saved?.cursor ?? 0);
    this.#summarizer = scriptedModel({
      rounds: [{ kind: "text", text: this.#config.summary ?? SUMMARY_TEXT }],
      repeatLast: true
    });

    this.tasks = new Tasks({
      definitions: {
        [TURN_DEFINITION]: (input: never, step: TaskStep) =>
          this.harness.taskDefinitions[TURN_DEFINITION](input, step)
      }
    });

    // Lifecycle is installed once, in the constructor, exactly as the real
    // server does. The harness is added on first use.
    this.lifecycle = Lifecycle.install(this)
      .use(this.tasks)
      .use(this.streams)
      .use(this.sessions);
  }

  /** Build the harness on demand, so per-test options take effect. */
  protected get harness(): TinyHarness {
    if (!this.#harness) {
      const config = this.#config;
      this.#harness = new TinyHarness({
        tasks: this.tasks,
        streams: this.streams,
        sessions: this.sessions,
        workspace: this.workspace,
        // A proxy, so `configure()` can swap the script and the harness
        // still resolves the current adapter on every round.
        //
        // `compact` gets its own adapter. The summarizer calls `chat()` on
        // it, and `stream: false` still runs through `chatStream`, so sharing
        // the turn's script would silently consume a round the test had
        // budgeted for a model turn.
        models: new Proxy(
          {},
          {
            get: (_target, role: string) =>
              role === "compact"
                ? this.#summarizer.adapter
                : scriptedModels(this.#model)[
                    role as keyof ReturnType<typeof scriptedModels>
                  ]
          }
        ) as never,
        role: config.role ?? "lead",
        root: ROOT,
        approval: this.approvalMode(config),
        maxRounds: config.maxRounds ?? 8,
        // Off unless a test asks: a summarizer call would otherwise consume
        // scripted rounds, and most tests are about the loop.
        compaction: config.compaction ?? false,
        logging: false,
        ...this.extraOptions()
      });
      this.lifecycle.use(this.#harness);
    }
    return this.#harness;
  }

  protected approvalMode(config: TestConfig): ApprovalMode {
    if ((config.approval ?? "auto") === "auto") return { kind: "auto" };
    return {
      kind: "interactive",
      ...(config.approvalTimeoutMs !== undefined
        ? { timeoutMs: config.approvalTimeoutMs }
        : {})
    };
  }

  protected extraOptions(): Record<string, unknown> {
    return {};
  }

  /**
   * Set the script and options for a test.
   *
   * The harness is built on first use, because `maxRounds` and `approval`
   * are read in its constructor and each test wants different ones. It can
   * only be built once, though: `Lifecycle.use()` refuses a second
   * registration. So a second `configure()` on the same object replaces only
   * the script — which is what a multi-turn test needs anyway. Use
   * `rescript()` to say that explicitly.
   */
  configure(config: TestConfig): void {
    this.#persist(config);
    if (this.#harness) {
      this.rescript(config.rounds);
      return;
    }
    this.#config = config;
    this.#model = this.#createModel(config.rounds);
    this.#summarizer = scriptedModel({
      rounds: [{ kind: "text", text: config.summary ?? SUMMARY_TEXT }],
      repeatLast: true
    });
    // Touch the getter before the first submit, matching production startup.
    void this.harness;
  }

  /**
   * Replace just the script, keeping the harness and its recorded calls.
   *
   * A multi-turn test uses this for the second turn: the model's `calls` log
   * resets, so assertions read the new turn's rounds from index 0.
   */
  rescript(rounds: readonly ScriptedRound[]): void {
    this.#persist({ ...this.#config, rounds });
    this.#config = { ...this.#config, rounds };
    this.#model = this.#createModel(rounds);
  }

  #createModel(rounds: readonly ScriptedRound[], initialCursor = 0) {
    return scriptedModel({
      rounds,
      initialCursor,
      onCursor: (cursor) => {
        this.ctx.storage.sql.exec(
          "UPDATE test_config SET cursor = ? WHERE id = 1",
          cursor
        );
      }
    });
  }

  #persist(config: TestConfig): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO test_config (id, json, cursor) VALUES (1, ?, 0)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, cursor = 0`,
      JSON.stringify(config)
    );
  }

  /** What the model was asked, per round. */
  modelCalls(): ScriptedCall[] {
    return this.#model.calls;
  }

  /** What the compaction summarizer was asked. One entry per chat() call. */
  summarizerCalls(): ScriptedCall[] {
    return this.#summarizer.calls;
  }

  /**
   * The system prompt the model actually received, per round.
   *
   * Asserted through the scripted adapter's own record rather than by
   * reaching into the harness: the prompt the model saw is the only
   * definition that matters, and it is what the prompt-cache tests are about.
   */
  systemPrompts(): string[] {
    return this.modelCalls().map((call) => call.systemPrompts.join("\n"));
  }

  /** Tool names offered to the model, per round. */
  offeredTools(): string[][] {
    return this.modelCalls().map((call) => [...call.toolNames]);
  }

  // ── Turn driving ────────────────────────────────────────────────────────

  submit(prompt: string, turnId?: string) {
    return this.harness.submit({
      prompt,
      ...(turnId ? { turnId } : {})
    });
  }

  async trySubmit(
    prompt: string
  ): Promise<{ accepted: boolean; error?: string }> {
    try {
      const receipt = await this.submit(prompt);
      return { accepted: receipt.accepted };
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  turn(turnId: string): Promise<TurnSnapshot | null> {
    return this.harness.turn(turnId);
  }

  turns(): Promise<TurnSnapshot[]> {
    return this.harness.turns();
  }

  /** Submit and wait for the turn to reach a terminal state. */
  async runToSettled(
    prompt: string,
    options: { timeoutMs?: number } = {}
  ): Promise<TurnSnapshot> {
    const receipt = await this.submit(prompt);
    return this.waitForSettled(receipt.turnId, options);
  }

  /** Poll the Task-backed turn projection until it is terminal. */
  async waitForSettled(
    turnId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<TurnSnapshot> {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    for (;;) {
      const snapshot = await this.harness.turn(turnId);
      if (
        snapshot &&
        snapshot.status !== "queued" &&
        snapshot.status !== "running" &&
        snapshot.status !== "awaiting-approval"
      ) {
        return snapshot;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `turn ${turnId} did not settle: status=${snapshot?.status ?? "missing"}`
        );
      }
      await scheduler.wait(25);
    }
  }

  /**
   * Wait until a turn is parked on a human.
   *
   * `notApprovalId` skips an already-answered request, which polling alone
   * cannot distinguish from the next one.
   */
  async waitForApproval(
    turnId: string,
    options: { timeoutMs?: number; notApprovalId?: string } = {}
  ): Promise<NonNullable<TurnSnapshot["pendingApproval"]>> {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    for (;;) {
      const snapshot = await this.harness.turn(turnId);
      if (
        snapshot?.pendingApproval &&
        snapshot.pendingApproval.approvalId !== options.notApprovalId
      ) {
        return snapshot.pendingApproval;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `turn ${turnId} never requested approval: status=${
            snapshot?.status ?? "missing"
          }`
        );
      }
      await scheduler.wait(25);
    }
  }

  resolveApproval(approvalId: string, approved: boolean, note?: string) {
    return this.harness.resolveApproval(approvalId, {
      approved,
      ...(note ? { note } : {})
    });
  }

  cancel(turnId: string, reason?: string) {
    return this.harness.cancel(turnId, reason);
  }

  // ── Durable state probes ────────────────────────────────────────────────

  /** The durable event log for a turn, in order. */
  streamStatus(turnId: string) {
    return this.streams.status(`turn:${turnId}`);
  }

  async events(turnId: string): Promise<TurnEvent[]> {
    const out: TurnEvent[] = [];
    const status = await this.streams.status(`turn:${turnId}`);
    if (!status) return out;
    for await (const chunk of this.streams.read(`turn:${turnId}`)) {
      const events = Array.isArray(chunk.chunk) ? chunk.chunk : [chunk.chunk];
      out.push(...(events as unknown as TurnEvent[]));
    }
    return out;
  }

  /**
   * Tail a turn's stream and resolve on a matching CUSTOM event.
   *
   * Unlike `events()`, which reads after the turn settles, this reads
   * concurrently — the only way to tell a live event from one that is
   * merely readable on reload.
   */
  async waitForCustomEvent(
    turnId: string,
    name: string,
    options: { timeoutMs?: number } = {}
  ): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    const seen = new Set<number>();
    for (;;) {
      const status = await this.streams.status(`turn:${turnId}`);
      if (status) {
        for await (const chunk of this.streams.read(`turn:${turnId}`)) {
          if (seen.has(chunk.seq)) continue;
          seen.add(chunk.seq);
          const events = Array.isArray(chunk.chunk)
            ? chunk.chunk
            : [chunk.chunk];
          for (const event of events as Array<Record<string, unknown>>) {
            if (event?.type === "CUSTOM" && event?.name === name) return event;
          }
        }
      }
      if (Date.now() > deadline) return null;
      await scheduler.wait(25);
    }
  }

  /** Whether the turn's stream still exists (the cutover discards it). */
  async streamExists(turnId: string): Promise<boolean> {
    return (await this.streams.status(`turn:${turnId}`)) !== null;
  }

  // ── Compaction probes ───────────────────────────────────────────────────

  /**
   * Run the registered compaction function now.
   *
   * Returns the overlay's range and summary, or null when the harness was
   * built with `compaction: false` (no function registered) or there was
   * nothing to compact.
   */
  async compact(): Promise<{
    fromMessageId: string;
    toMessageId: string;
    summary: string;
  } | null> {
    await this.harness.turns();
    if (
      this.#config.compaction === false ||
      this.#config.compaction === undefined
    ) {
      return null;
    }
    return this.sessions.session().compact();
  }

  /** Stored compaction overlays, oldest first. */
  async compactions(): Promise<
    { summary: string; fromMessageId: string; toMessageId: string }[]
  > {
    await this.harness.turns();
    const stored = await this.sessions.session().getCompactions();
    return (stored as unknown[]).map((raw) => {
      const row = raw as {
        summary?: string;
        fromMessageId?: string;
        toMessageId?: string;
      };
      return {
        summary: row.summary ?? "",
        fromMessageId: row.fromMessageId ?? "",
        toMessageId: row.toMessageId ?? ""
      };
    });
  }

  /** Append plain messages, to build a transcript without running turns. */
  async seedMessages(count: number, bytesEach = 200): Promise<void> {
    await this.harness.turns();
    const session = this.sessions.session();
    for (let i = 0; i < count; i++) {
      await session.appendMessage({
        id: `seed:${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [
          { type: "text", text: `message ${i}: ${"x".repeat(bytesEach)}` }
        ]
      });
    }
  }

  /** The text the model would be given, after compaction overlays apply. */
  async windowText(bytes = 1024 * 1024): Promise<string> {
    await this.harness.turns();
    const history = await this.sessions.session().getRecentHistory(bytes);
    return (history.messages as unknown[])
      .map((raw) => {
        const message = raw as { parts?: { text?: string }[] };
        return (message.parts ?? []).map((part) => part.text ?? "").join("");
      })
      .join("\n");
  }

  /** The transcript, flattened to something a test can assert on. */
  async transcript(): Promise<
    {
      id: string;
      role: string;
      parts: { type: string; state?: string }[];
    }[]
  > {
    const history = await this.sessions.session().getRecentHistory(1024 * 1024);
    return (history.messages as unknown[]).map((raw) => {
      const message = raw as {
        id?: string;
        role?: string;
        parts?: { type?: string; state?: string }[];
      };
      return {
        id: message.id ?? "",
        role: message.role ?? "",
        parts: (message.parts ?? []).map((part) => ({
          type: part.type ?? "",
          ...(part.state ? { state: part.state } : {})
        }))
      };
    });
  }

  /** Write a file into the durable workspace. */
  async writeFile(path: string, contents: string): Promise<void> {
    await this.workspace.fs.mkdir(ROOT, { recursive: true }).catch(() => {});
    await this.workspace.fs.writeFile(path, contents);
  }

  async readFile(path: string): Promise<string | null> {
    return this.workspace.fs
      .readFile(path, "utf8")
      .then((value: unknown) => (typeof value === "string" ? value : null))
      .catch(() => null);
  }

  harnessTables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'harness_%'"
      )
      .toArray()
      .map((row) => row.name);
  }
}

/** The lead agent fixture. */
export class TestAgent extends TestAgentBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { rounds: [{ kind: "text", text: "default" }] });
  }

  protected override extraOptions(): Record<string, unknown> {
    return {
      delegation: {
        namespace: (this.env as unknown as Record<string, unknown>)
          .TINY_TEST_SUBAGENT,
        maxDepth: 1
      }
    };
  }
}

/** The subagent fixture, mirroring `Subagent`. */
export class TestSubagent extends TestAgentBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      rounds: [{ kind: "text", text: "subagent done" }],
      role: "explorer"
    });
  }

  runToCompletion(input: {
    role: "explorer";
    goal: string;
    parentName?: string;
  }) {
    return this.harness.runToCompletion(input);
  }
}

export default {
  fetch(): Response {
    return new Response("test worker", { status: 200 });
  }
} satisfies ExportedHandler<Env>;
