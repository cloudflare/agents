import { DurableObject } from "cloudflare:workers";
import { tool, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type {
  HarnessSession,
  SessionEvent,
  ToolAnswer
} from "../../../experimental/channels/harness";
import { Lifecycle } from "../../../lifecycle";
import { openHarnessStore } from "../../store/store";
import { Streams } from "../../../streams/streams";
import type { Session } from "../../../sessions/handle";
import { WebSockets } from "../../../websockets/websockets";
import { ThinkChat } from "../chat";
import {
  classifyContextOverflow,
  setWakeTimingForTests,
  SteerNotSupportedError,
  ThinkHarness
} from "../harness";
import type {
  ThinkOperationResult,
  ThinkReceipt,
  ThinkSubmitOptions
} from "../types";

const GATE_RUNS_KEY = "test:gate:runs";
const RELEASE_KEY = "test:gate:release";
const DANGEROUS_RUNS_KEY = "test:dangerous:runs";
const SYSTEM_KEY = "test:system";
const BLOCK_KEY = "test:block";
const ENDED_KEY = "test:ended";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1
  },
  outputTokens: { reasoning: undefined, text: 1, total: 1 }
};

type StreamPart =
  | { type: "stream-start"; warnings: [] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "finish";
      finishReason: { raw: string; unified: "stop" | "tool-calls" };
      logprobs: undefined;
      usage: typeof usage;
    }
  | { type: "error"; error: unknown };

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { raw: reason, unified: reason },
  logprobs: undefined,
  usage
});

function textReply(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop")
  ];
}

function callReply(
  calls: readonly { name: string; input?: unknown; id?: string }[]
): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.map(
      (call): StreamPart => ({
        type: "tool-call",
        toolCallId: call.id ?? `call-${crypto.randomUUID()}`,
        toolName: call.name,
        input: JSON.stringify(call.input ?? {})
      })
    ),
    finish("tool-calls")
  ];
}

type PromptMessage = { role: string; content: unknown };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" ? (part.text ?? "") : ""
    )
    .join("");
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const result = content.at(-1) as
    | { output?: { type: string; value?: unknown; reason?: string } }
    | undefined;
  const output = result?.output;
  if (!output) return "";
  switch (output.type) {
    case "error-text":
    case "error-json":
      return `error: ${String(output.value)}`;
    case "execution-denied":
      return "denied";
    case "text":
      return String(output.value);
    default:
      return JSON.stringify(output.value);
  }
}

/** Real Durable Object fixture: a ThinkHarness over a scripted model. */
export class ThinkHarnessTestObject extends DurableObject<Cloudflare.Env> {
  /** Every model call's prompt, in order, for this isolate. */
  readonly prompts: PromptMessage[][] = [];
  #releaseSlow: () => void = () => {};
  #slowHeld = new Promise<void>((resolve) => {
    this.#releaseSlow = resolve;
  });
  #overflowed = false;
  /** Sessions handles, as configureSession hands them over. */
  readonly #handles = new Map<string, Session>();

  readonly harness = new ThinkHarness({
    system: "You are a test.",
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        // SAFETY: the mock's prompt is the provider's message list.
        const messages = prompt as unknown as PromptMessage[];
        this.prompts.push(messages);
        return { stream: this.#reply(messages) };
      }
    }),
    tools: {
      multiply: tool({
        description: "Multiply by three",
        inputSchema: z.object({ value: z.number() }),
        execute: async ({ value }) => value * 3
      }),
      gate: tool({
        description: "Wait until released",
        inputSchema: z.object({}),
        execute: () => this.#gate()
      }),
      gate_safe: {
        ...tool({
          description: "Wait until released; safe to rerun",
          inputSchema: z.object({}),
          execute: () => this.#gate()
        }),
        recovery: "rerun"
      },
      dangerous: tool({
        description: "Needs approval",
        inputSchema: z.object({}),
        needsApproval: true,
        execute: async () => {
          const runs =
            (this.ctx.storage.kv.get<number>(DANGEROUS_RUNS_KEY) ?? 0) + 1;
          this.ctx.storage.kv.put(DANGEROUS_RUNS_KEY, runs);
          return "did the dangerous thing";
        }
      }),
      ask: tool({
        description: "Runs on the client",
        inputSchema: z.object({ question: z.string() })
      })
    },
    recovery: { backoffMs: 10 },
    hooks: {
      classifyError: classifyContextOverflow,
      beforeTurn: () => {
        const system = this.ctx.storage.kv.get<string>(SYSTEM_KEY);
        return system ? { system } : undefined;
      },
      beforeToolCall: ({ toolName }) => {
        const blocked = this.ctx.storage.kv.get<string>(BLOCK_KEY);
        if (blocked === toolName) {
          return { action: "block", reason: "blocked by policy" };
        }
        if (blocked === `substitute:${toolName}`) {
          return { action: "substitute", output: 1000 };
        }
        return undefined;
      },
      onTurnEnd: ({ status }) => {
        const ended = this.ctx.storage.kv.get<string[]>(ENDED_KEY) ?? [];
        this.ctx.storage.kv.put(ENDED_KEY, [...ended, status]);
      }
    },
    configureSession: (session, id) => {
      this.#handles.set(id, session);
      session.onCompaction(async (history) => {
        // Everything but the newest message.
        const last = history.at(-2);
        const first = history[0];
        if (!first || !last) return null;
        return {
          summary: "[compacted]",
          fromMessageId: first.id,
          toMessageId: last.id
        };
      });
    }
  });
  readonly webSockets = new WebSockets();
  readonly chat = new ThinkChat({
    harness: this.harness,
    webSockets: this.webSockets
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.webSockets)
    .use(this.chat);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, { heartbeatMs: 1_000 });
  }

  #reply(prompt: PromptMessage[]): ReadableStream<StreamPart> {
    const last = prompt.filter((m) => m.role !== "system").at(-1);
    let parts: StreamPart[];
    if (last?.role === "tool") {
      parts = textReply(`tool said: ${toolResultText(last.content)}`);
    } else if (last?.role === "assistant") {
      parts = textReply("continued");
    } else {
      const text = contentText(last?.content);
      const multiply = /^multiply (\d+)$/.exec(text);
      if (multiply) {
        parts = callReply([
          { name: "multiply", input: { value: Number(multiply[1]) } }
        ]);
      } else if (text === "prototype id") {
        // A tool-call id that names an Object.prototype property.
        parts = callReply([
          { name: "multiply", input: { value: 5 }, id: "constructor" }
        ]);
      } else if (text === "two tools") {
        parts = callReply([
          { name: "multiply", input: { value: 2 } },
          { name: "multiply", input: { value: 3 } }
        ]);
      } else if (text === "gate" || text === "gate-safe") {
        parts = callReply([{ name: text === "gate" ? "gate" : "gate_safe" }]);
      } else if (text === "approve") {
        parts = callReply([{ name: "dangerous" }]);
      } else if (text === "client") {
        parts = callReply([{ name: "ask", input: { question: "why?" } }]);
      } else if (text === "slow") {
        return this.#slow(12);
      } else if (text === "slow-short") {
        return this.#slow(2);
      } else if (text === "fail") {
        parts = [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("model exploded") }
        ];
      } else if (text === "overflow" && !this.#overflowed) {
        this.#overflowed = true;
        parts = [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("context_length_exceeded") }
        ];
      } else {
        parts = textReply(`echo: ${text}`);
      }
    }
    return new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      }
    });
  }

  /** Streams `deltas` deltas, then holds until `releaseSlow()`. */
  #slow(deltas: number): ReadableStream<StreamPart> {
    const held = this.#slowHeld;
    return new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        for (let i = 0; i < deltas; i++) {
          controller.enqueue({ type: "text-delta", id: "t", delta: "x" });
        }
        await held;
        controller.enqueue({ type: "text-delta", id: "t", delta: " end" });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue(finish("stop"));
        controller.close();
      }
    });
  }

  async #gate(): Promise<string> {
    const runs = (this.ctx.storage.kv.get<number>(GATE_RUNS_KEY) ?? 0) + 1;
    this.ctx.storage.kv.put(GATE_RUNS_KEY, runs);
    while (!this.ctx.storage.kv.get(RELEASE_KEY)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `released after ${runs} runs`;
  }

  // ── RPC for the tests ────────────────────────────────────────────────────

  submit(
    text: string,
    options: ThinkSubmitOptions & { session?: string } = {}
  ): Promise<ThinkReceipt> {
    const { session, ...rest } = options;
    return this.harness.session(session).submit(text, rest);
  }

  /** Submit through the shared harness interface, asking to steer. */
  async steer(text: string): Promise<string> {
    const session: HarnessSession = this.harness.session();
    try {
      await session.submit(
        { parts: [{ type: "text", text }] },
        { whenBusy: "steer" }
      );
      return "accepted";
    } catch (error) {
      return error instanceof SteerNotSupportedError ? error._tag : "other";
    }
  }

  /** Submit untrusted input as a chat client would. */
  submitAsClient(
    messages: {
      id: string;
      role: "user" | "assistant" | "system";
      text: string;
    }[],
    clientTools?: { name: string; description?: string }[]
  ): Promise<ThinkReceipt> {
    return this.harness.session().submit(
      messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: [{ type: "text" as const, text: m.text }]
      })),
      { source: "client", ...(clientTools && { clientTools }) }
    );
  }

  answer(answer: ToolAnswer, session?: string): Promise<ThinkReceipt> {
    return this.harness.session(session).submit(answer);
  }

  async prompt(text: string, session?: string) {
    const response = await this.harness.session(session).prompt(text);
    return { ...response, messages: summarize(response.messages) };
  }

  wait(operationId: string, session?: string): Promise<ThinkOperationResult> {
    return this.harness.session(session).wait(operationId);
  }

  async messages(session?: string): Promise<string[]> {
    return summarize(await this.harness.session(session).messages());
  }

  /** Ids of each message, in order. */
  async messageIds(session?: string): Promise<string[]> {
    return (await this.harness.session(session).messages()).map((m) => m.id);
  }

  /** The latest message's tool calls, with their approval ids. */
  async lastToolCalls(): Promise<
    { toolCallId: string; approvalId: string | undefined }[]
  > {
    const last = (await this.harness.session().messages()).at(-1);
    return (last?.parts ?? []).flatMap((part) =>
      "toolCallId" in part
        ? [
            {
              toolCallId: part.toolCallId,
              approvalId:
                "approval" in part && part.approval
                  ? part.approval.id
                  : undefined
            }
          ]
        : []
    );
  }

  pending() {
    return this.harness.pending();
  }

  abort(operationId?: string, session?: string): Promise<boolean> {
    return this.harness.session(session).abort(operationId);
  }

  reset(session?: string): Promise<void> {
    return this.harness.session(session).reset();
  }

  regenerate(): Promise<ThinkReceipt> {
    return this.harness.session().regenerate();
  }

  /** Write on the Sessions handle directly; the event types a listener saw. */
  async writeDirectly(text: string): Promise<string[]> {
    const seen: string[] = [];
    const stop = this.harness.session().subscribe((event) => {
      seen.push(
        event.type === "message" ? `message:${event.message.id}` : event.type
      );
    });
    await this.#handles.get("")?.appendMessage({
      id: "direct",
      role: "user",
      parts: [{ type: "text", text }]
    });
    stop();
    return seen;
  }

  /** Delete a message, then compact, on the Sessions handle; the events seen. */
  async deleteAndCompact(messageId: string): Promise<string[]> {
    const seen: string[] = [];
    const session = this.harness.session();
    const stop = session.subscribe((event) => seen.push(event.type));
    await this.#handles.get("")?.deleteMessages([messageId]);
    await session.compact();
    stop();
    return seen;
  }

  /** Create the operations table as it was before `abandon_reason`. */
  createOldOperationsTable(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE cf_think_harness_operations (
      session_id TEXT NOT NULL, operation_id TEXT NOT NULL, seq INTEGER NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
      parent_id TEXT, message_id TEXT, stream_id TEXT,
      pending_model INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
      interruptions INTEGER NOT NULL DEFAULT 0,
      overflow_retries INTEGER NOT NULL DEFAULT 0,
      reason TEXT, text TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, operation_id))`);
  }

  /**
   * Write the harness's records as a version before the shared store kept
   * them: its own three tables, holding three sessions, a settled operation
   * and a queued one.
   */
  seedLegacyRecords(): void {
    const sql = this.ctx.storage.sql;
    createLegacyTables(sql);
    sql.exec(
      `INSERT INTO cf_think_harness_sessions (id, parent, client_tools, created_at)
       VALUES ('', NULL, NULL, 1000),
         ('zeta', '', '[{"name":"lookup"}]', 2000), ('alpha', NULL, NULL, 3000)`
    );
    const messages = (id: string, text: string) =>
      JSON.stringify({
        kind: "messages",
        messages: [{ id, role: "user", parts: [{ type: "text", text }] }]
      });
    sql.exec(
      `INSERT INTO cf_think_harness_operations
         (session_id, operation_id, seq, input, status, source, message_id,
          text, created_at, updated_at)
       VALUES ('', 'op-done', 1, ?, 'done', 'server', 'answer-old',
          'old answer', 1000, 1000)`,
      messages("user-old", "before the upgrade")
    );
    sql.exec(
      `INSERT INTO cf_think_harness_operations
         (session_id, operation_id, seq, input, status, source, created_at,
          updated_at)
       VALUES ('', 'op-queued', 2, ?, 'queued', 'server', 1000, 1000)`,
      messages("user-new", "after the upgrade")
    );
  }

  /**
   * Write a queued operation the way a rolled-back earlier version would:
   * into its own tables, reusing an id the shared store already holds.
   */
  seedRollbackRecords(operationId: string): void {
    const sql = this.ctx.storage.sql;
    createLegacyTables(sql);
    sql.exec(
      `INSERT INTO cf_think_harness_sessions (id, parent, client_tools, created_at)
       VALUES ('', NULL, NULL, 1000)`
    );
    sql.exec(
      `INSERT INTO cf_think_harness_operations
         (session_id, operation_id, seq, input, status, source, created_at,
          updated_at)
       VALUES ('', ?, 1, ?, 'queued', 'server', 1000, 1000)`,
      operationId,
      JSON.stringify({
        kind: "messages",
        messages: [
          {
            id: "user-rollback",
            role: "user",
            parts: [{ type: "text", text: "after the rollback" }]
          }
        ]
      })
    );
  }

  /**
   * Move the harness's records out of the shared store into the tables an
   * earlier version kept, as if that version had written them. The
   * transcript and streams are untouched: their format did not change.
   */
  downgradeRecords(): void {
    const sql = this.ctx.storage.sql;
    const store = openHarnessStore(this.ctx.storage, {
      prefix: SHARED_STORE_PREFIX
    });
    createLegacyTables(sql);
    for (const session of store.sessions()) {
      // SAFETY: the harness writes its session state as this shape.
      const state = session.state as unknown as LegacySessionState;
      sql.exec(
        `INSERT INTO cf_think_harness_sessions (id, parent, client_tools, created_at)
         VALUES (?, ?, ?, ?)`,
        session.id,
        session.parent ?? null,
        JSON.stringify(state.clientTools),
        session.createdAt
      );
      for (const [toolCallId, call] of Object.entries(state.toolCalls)) {
        sql.exec(
          `INSERT INTO cf_think_harness_tool_calls
             (session_id, tool_call_id, operation_id, attempts)
           VALUES (?, ?, ?, ?)`,
          session.id,
          toolCallId,
          call.operationId,
          call.attempts
        );
      }
    }
    for (const op of store.operations()) {
      // SAFETY: the harness writes its operation meta as this shape.
      const meta = op.meta as unknown as LegacyOperationMeta;
      const result =
        op.result !== null && typeof op.result === "object"
          ? // SAFETY: a done operation's result is `{ text }`.
            (op.result as { text?: string })
          : {};
      sql.exec(
        `INSERT INTO cf_think_harness_operations
           (session_id, operation_id, seq, input, status, source, parent_id,
            message_id, stream_id, pending_model, steps, interruptions,
            overflow_retries, reason, text, abandon_reason, created_at,
            updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        op.session,
        op.id,
        op.seq,
        JSON.stringify(op.input),
        op.status,
        meta.source,
        meta.parentId,
        meta.messageId,
        meta.streamId,
        meta.pendingModel ? 1 : 0,
        meta.steps,
        meta.interruptions,
        meta.overflowRetries,
        op.reason ?? null,
        result.text ?? null,
        meta.abandonReason,
        op.createdAt,
        op.createdAt
      );
    }
    for (const table of ["sessions", "operations", "log"]) {
      sql.exec(`DROP TABLE ${SHARED_STORE_PREFIX}${table}`);
    }
  }

  /** The harness's tables that are left, by name. */
  harnessTables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'cf_think_harness%' ORDER BY name`
      )
      .toArray()
      .map((row) => row.name);
  }

  /** An operation as the shared harness store holds it. */
  storedOperation(session: string, operationId: string) {
    const op = openHarnessStore(this.ctx.storage, {
      prefix: SHARED_STORE_PREFIX
    }).operation(session, operationId);
    if (!op) return undefined;
    // Flattened for RPC: a JSON value's type is too deep to serialize.
    const result: { readonly status: string; readonly result: string } = {
      status: op.status,
      result: JSON.stringify(op.result)
    };
    return result;
  }

  /** What the alarm memory-limit breaker does when it seals. */
  sealMemoryLimit(): void {
    this.harness.onMemoryLimit({ sealed: true });
  }

  answerAsClient(
    answer: ToolAnswer,
    autoContinue = true
  ): Promise<ThinkReceipt> {
    return this.harness
      .session()
      .submit(answer, { source: "client", autoContinue });
  }

  async search(query: string): Promise<number> {
    return (await this.harness.session().search(query)).length;
  }

  async branches(messageId: string): Promise<number> {
    return (await this.harness.session().branches(messageId)).length;
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }

  async fork(from: string): Promise<string> {
    return (await this.harness.sessions.fork(from)).id;
  }

  listSessions() {
    return this.harness.sessions.list();
  }

  /** Resolve once the gate tool has started `runs` times. */
  async gateStarted(runs: number): Promise<number> {
    for (let i = 0; i < 300; i++) {
      const count = this.ctx.storage.kv.get<number>(GATE_RUNS_KEY) ?? 0;
      if (count >= runs) return count;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The gate tool never started");
  }

  release(): void {
    this.ctx.storage.kv.put(RELEASE_KEY, true);
  }

  gateRuns(): number {
    return this.ctx.storage.kv.get<number>(GATE_RUNS_KEY) ?? 0;
  }

  dangerousRuns(): number {
    return this.ctx.storage.kv.get<number>(DANGEROUS_RUNS_KEY) ?? 0;
  }

  releaseSlow(): void {
    this.#releaseSlow();
  }

  /** Resolve once a model call's chunks are durable in its stream. */
  async streamed(): Promise<void> {
    for (let i = 0; i < 300; i++) {
      const rows = this.ctx.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM cf_agents_stream_blocks"
        )
        .one();
      if (rows.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Nothing was streamed");
  }

  streamRows(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM cf_agents_streams")
      .one().n;
  }

  /** Think's chat(): the chunk types the callback saw, and how it ended. */
  async chatCallback(text: string): Promise<{ types: string[]; end: string }> {
    const types: string[] = [];
    let end = "";
    await this.harness.session().chat(text, {
      onEvent: (json) => {
        types.push((JSON.parse(json) as { type: string }).type);
      },
      onDone: () => {
        end = "done";
      },
      onError: (error) => {
        end = `error: ${error}`;
      }
    });
    return { types, end };
  }

  inspect(operationId: string) {
    return this.harness.session().inspect(operationId);
  }

  setSystem(system: string): void {
    this.ctx.storage.kv.put(SYSTEM_KEY, system);
  }

  setBlock(rule: string): void {
    this.ctx.storage.kv.put(BLOCK_KEY, rule);
  }

  ended(): string[] {
    return this.ctx.storage.kv.get<string[]>(ENDED_KEY) ?? [];
  }

  modelCalls(): number {
    return this.prompts.length;
  }

  lastPromptText(): string {
    const prompt = this.prompts.at(-1) ?? [];
    return prompt.map((m) => `${m.role}:${contentText(m.content)}`).join("|");
  }

  /** Watch a session until an operation settles; the event types seen. */
  async watchUntilSettled(session?: string): Promise<{
    initial: number;
    types: string[];
  }> {
    const watch = await this.harness.session(session).watch();
    const types: string[] = [];
    await new Promise<void>((resolve) => {
      watch.start(async (events: readonly SessionEvent[]) => {
        for (const event of events) {
          types.push(
            event.type === "operation"
              ? `operation:${event.status.status}`
              : event.type
          );
          if (
            event.type === "operation" &&
            (event.status.status === "done" ||
              event.status.status === "unanswered")
          ) {
            resolve();
          }
        }
      });
    });
    await watch.stop();
    return { initial: watch.state.messages.length, types };
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

/**
 * A host with its own Streams capability beside the harness's, on one
 * object: the two share the stream tables, including a v1 legacy table.
 */
export class ThinkWithStreamsObject extends DurableObject<Cloudflare.Env> {
  readonly streams = new Streams();
  readonly harness = new ThinkHarness({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of textReply("hi")) controller.enqueue(part);
            controller.close();
          }
        })
      })
    })
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness);

  /** Seed a v1 stream whose rows are the last in the legacy table. */
  async seedLegacy(): Promise<void> {
    const sql = this.ctx.storage.sql;
    await this.ctx.storage.put("cf_agents:streams_schema_version", 1);
    sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_streams (
      stream_id TEXT PRIMARY KEY, state TEXT NOT NULL, tag TEXT, metadata TEXT,
      error_message TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_stream_chunks (
      stream_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (stream_id, seq)) WITHOUT ROWID`);
    sql.exec(
      `INSERT INTO cf_agents_streams (stream_id, state, chunk_count, created_at, updated_at, closed_at)
       VALUES ('old', 'completed', 1, 1, 1, 2)`
    );
    sql.exec(
      `INSERT INTO cf_agents_stream_chunks (stream_id, seq, chunk, created_at) VALUES ('old', 0, '"a"', 1)`
    );
  }

  /** Read the v1 stream through the host's Streams, which folds it and drops the table. */
  async foldThroughHost(): Promise<boolean> {
    for await (const _chunk of this.streams.read("old")) {
      // Reading is what folds.
    }
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name = 'cf_agents_stream_chunks'"
        )
        .toArray().length === 0
    );
  }

  async prompt(text: string) {
    const result = await this.harness.prompt(text);
    return result.status;
  }
}

/** The table prefix ThinkHarness keeps its records under in the shared store. */
const SHARED_STORE_PREFIX = "cf_think_harness_store_";

type LegacySessionState = {
  readonly clientTools: unknown[];
  readonly toolCalls: Record<
    string,
    { readonly operationId: string; readonly attempts: number }
  >;
};

type LegacyOperationMeta = {
  readonly source: string;
  readonly parentId: string | null;
  readonly messageId: string | null;
  readonly streamId: string | null;
  readonly pendingModel: boolean;
  readonly steps: number;
  readonly interruptions: number;
  readonly overflowRetries: number;
  readonly abandonReason: string | null;
};

/** ThinkHarness's own tables, as the version before the shared store made them. */
function createLegacyTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE cf_think_harness_sessions (
    id TEXT PRIMARY KEY, parent TEXT, client_tools TEXT,
    created_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE cf_think_harness_operations (
    session_id TEXT NOT NULL, operation_id TEXT NOT NULL, seq INTEGER NOT NULL,
    input TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
    parent_id TEXT, message_id TEXT, stream_id TEXT,
    pending_model INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
    interruptions INTEGER NOT NULL DEFAULT 0,
    overflow_retries INTEGER NOT NULL DEFAULT 0,
    reason TEXT, text TEXT, abandon_reason TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, operation_id))`);
  sql.exec(`CREATE TABLE cf_think_harness_tool_calls (
    session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, attempts INTEGER NOT NULL,
    PRIMARY KEY (session_id, tool_call_id))`);
}

/** Each message as `role: text`, with its tool calls as `[name state]`. */
function summarize(messages: readonly UIMessage[]): string[] {
  return messages.map((message) => {
    const pieces = message.parts.flatMap((part) => {
      if (part.type === "text") return [part.text];
      if ("toolCallId" in part) {
        const name =
          part.type === "dynamic-tool"
            ? part.toolName
            : part.type.slice("tool-".length);
        return [`[${name} ${part.state}]`];
      }
      return [];
    });
    return `${message.role}: ${pieces.join(" ")}`;
  });
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
};
