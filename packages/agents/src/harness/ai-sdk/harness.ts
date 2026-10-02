import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type StopCondition,
  type ToolSet,
  type UIMessage
} from "ai";
// Imported from their modules, not "../../lifecycle", which loads
// cloudflare:workers.
import { LifecycleCapability } from "../../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../../lifecycle/job-queue";
import {
  answerToolCall,
  toResponseChunks,
  toTranscriptMessage,
  type ToolCallAnswer
} from "./turns";
import type {
  AgentHarness,
  HarnessInput,
  HarnessInputFrom,
  HarnessSession,
  HarnessSessions,
  InputPart,
  OperationResult,
  OperationStatus,
  Receipt,
  SessionEvent,
  SessionId,
  SessionInfo,
  SessionState,
  SessionWatch,
  SubmitOptions,
  ToolAnswer
} from "../../experimental/channels/harness";
import type {
  ResponseChunk,
  TranscriptMessage
} from "../../experimental/channels/protocol";

export type AiSdkHarnessOptions<TOOLS extends ToolSet> = {
  model: LanguageModel;
  /**
   * Tools without `execute` run on the client of the participant whose
   * message started the turn; tools with `needsApproval` wait for an
   * approval from anyone.
   */
  tools?: TOOLS;
  system?: string;
  /** Default: `stepCountIs(5)`. */
  stopWhen?: StopCondition<NoInfer<TOOLS>>;
  /** How often a running session's wake job checks in. Default: 30 s. */
  heartbeatMs?: number;
};

/** Saved messages remember whose client runs their client tool calls. */
type Message = UIMessage<{ owner?: string }>;

type Input = (HarnessInput | ToolAnswer) & HarnessInputFrom;

type StoredOperation = {
  operationId: string;
  seq: number;
  input: Input;
  status: OperationStatus["status"];
  text?: string;
  reason?: string;
};

type StoredSession = { id: SessionId; parent?: SessionId };

/** The run in progress in one session, in memory only. */
type Run = {
  operations: string[];
  /** The in-flight message so far. */
  partial: ResponseChunk[];
  abort: AbortController;
};

const PREFIX = "ai-sdk-harness:";
const WAKE_FN = "wake";
const DEFAULT_SESSION = "main";
const HEARTBEAT_MS = 30_000;

/**
 * An agent harness around the AI SDK's `streamText`, hosted in a Durable
 * Object: sessions, their transcripts, and a queue of operations, all in the
 * object's storage. One operation runs at a time per session; a run is one
 * `streamText` call over the session's transcript.
 *
 * The AI SDK keeps no state of its own, so a run that an eviction cuts short
 * starts again from the saved transcript, and its unsaved output is lost.
 * Steering is not supported: `whenBusy: "steer"` queues like a follow-up.
 *
 * @experimental The API may change between releases.
 */
export class AiSdkHarness<TOOLS extends ToolSet = ToolSet>
  extends LifecycleCapability
  implements AgentHarness
{
  readonly sessions: HarnessSessions;
  readonly #options: AiSdkHarnessOptions<TOOLS>;
  readonly #heartbeatMs: number;
  readonly #runs = new Map<SessionId, Run>();
  /** The loop running a session's queue, while it runs. */
  readonly #driving = new Map<SessionId, Promise<void>>();
  readonly #watchers = new Map<SessionId, Set<Watcher>>();
  readonly #waiters = new Map<string, Set<(op: StoredOperation) => void>>();

  constructor(options: AiSdkHarnessOptions<TOOLS>) {
    super("ai-sdk-harness");
    this.#options = options;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.sessions = {
      create: async () => this.#create({ id: crypto.randomUUID() }),
      fork: async (from) => {
        this.#ensure(from);
        const session = this.#create({ id: crypto.randomUUID(), parent: from });
        for (const message of this.#messages(from)) {
          this.#putMessage(session.id, message);
        }
        return session;
      },
      list: async (): Promise<SessionInfo[]> => {
        this.#ensure(DEFAULT_SESSION);
        return [...this.#kv.list<StoredSession>({ prefix: `${PREFIX}s:` })].map(
          ([, { id, parent }]) => ({
            id,
            ...(parent !== undefined && { parent }),
            busy: this.#pending(id).length > 0
          })
        );
      }
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  override async onStart(): Promise<void> {
    // Sessions with unsettled operations: an earlier instance was running
    // them, or was about to. Read them all first: storage allows one open
    // kv.list() at a time, and #pending() lists too.
    const sessions = [
      ...this.#kv.list<StoredSession>({ prefix: `${PREFIX}s:` })
    ];
    for (const [, session] of sessions) {
      if (this.#pending(session.id).length > 0) await this.#wake(session.id);
    }
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== WAKE_FN) return;
    const payload = context.job.payload as { session?: unknown } | null;
    const session = payload?.session;
    if (typeof session !== "string") return;
    if (!this.#driving.has(session) && this.#pending(session).length === 0) {
      return;
    }
    // The job keeps the object alive while the queue runs; a heartbeat
    // after an eviction finds no loop and starts one.
    this.lifecycle.trackAlarmWork(this.#drive(session));
    return { rescheduleAt: Date.now() + this.#heartbeatMs };
  }

  // ── The harness interface ──────────────────────────────────────────────

  session(id: SessionId = DEFAULT_SESSION): HarnessSession {
    return {
      id,
      submit: (input, options) => this.#submit(id, input, options),
      abort: (operationId) => this.#abort(id, operationId),
      wait: (operationId, signal) => this.#wait(id, operationId, signal),
      reset: (handoff) => this.#reset(id, handoff),
      watch: async () => this.#watch(id)
    };
  }

  async #submit(
    session: SessionId,
    input: Input,
    options: SubmitOptions = {}
  ): Promise<Receipt> {
    this.#ensure(session);
    const operationId = options.operationId ?? crypto.randomUUID();
    if (this.#operation(session, operationId)) {
      return { operationId, session, accepted: false };
    }
    const op: StoredOperation = {
      operationId,
      seq: this.#nextSeq(session),
      input,
      status: "queued"
    };
    this.#saveOperation(session, op);
    this.#emit(session, [
      { type: "operation", status: { operationId, status: "queued" } }
    ]);
    await this.#wake(session);
    void this.#drive(session);
    return { operationId, session, accepted: true };
  }

  async #abort(session: SessionId, operationId?: string): Promise<boolean> {
    const run = this.#runs.get(session);
    const targets = operationId
      ? [this.#operation(session, operationId)].filter(
          (op): op is StoredOperation => op !== undefined && isPending(op)
        )
      : this.#pending(session);
    for (const op of targets) {
      if (run?.operations.includes(op.operationId)) run.abort.abort();
      else {
        this.#settle(session, op, {
          status: "unanswered",
          reason: "withdrawn"
        });
      }
    }
    return targets.length > 0;
  }

  async #wait(
    session: SessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    const op = this.#operation(session, operationId);
    if (!op) {
      return {
        operationId,
        session,
        status: "unanswered",
        reason: "not_found"
      };
    }
    const settled = isPending(op)
      ? await new Promise<StoredOperation>((resolve, reject) => {
          const key = waiterKey(session, operationId);
          const waiters = this.#waiters.get(key) ?? new Set();
          this.#waiters.set(key, waiters);
          const done = (result: StoredOperation) => {
            signal?.removeEventListener("abort", aborted);
            resolve(result);
          };
          const aborted = () => {
            waiters.delete(done);
            reject(signal?.reason);
          };
          waiters.add(done);
          signal?.addEventListener("abort", aborted, { once: true });
        })
      : op;
    return settled.status === "done"
      ? {
          operationId,
          session,
          status: "done",
          ...(settled.text !== undefined && { text: settled.text })
        }
      : {
          operationId,
          session,
          status: "unanswered",
          ...(settled.reason !== undefined && { reason: settled.reason })
        };
  }

  async #reset(session: SessionId, handoff?: string): Promise<void> {
    this.#ensure(session);
    await this.#abort(session);
    await this.#driving.get(session);
    for (const [key] of this.#kv.list({ prefix: messagePrefix(session) })) {
      this.#kv.delete(key);
    }
    const events: SessionEvent[] = [{ type: "reset" }];
    if (handoff) {
      const note: Message = {
        id: crypto.randomUUID(),
        role: "system",
        parts: [{ type: "text", text: handoff }]
      };
      this.#putMessage(session, note);
      events.push({ type: "message", message: this.#transcript(note) });
    }
    this.#emit(session, events);
  }

  #watch(session: SessionId): SessionWatch {
    this.#ensure(session);
    const run = this.#runs.get(session);
    const state: SessionState = {
      messages: this.#messages(session).map((m) => this.#transcript(m)),
      pending: this.#pending(session).map((op) => ({
        operationId: op.operationId,
        status: op.status === "placed" ? "placed" : "queued"
      })),
      ...(run && {
        run: {
          operations: [...run.operations],
          ...(run.partial.length > 0 && { partial: [...run.partial] })
        }
      })
    };
    const watchers = this.#watchers.get(session) ?? new Set();
    this.#watchers.set(session, watchers);
    const watcher = new Watcher(state, () => watchers.delete(watcher));
    watchers.add(watcher);
    return watcher;
  }

  // ── Running the queue ──────────────────────────────────────────────────

  /** Run the session's operations in order until none are left. */
  #drive(session: SessionId): Promise<void> {
    let driving = this.#driving.get(session);
    if (!driving) {
      driving = (async () => {
        try {
          for (;;) {
            const next = this.#pending(session)[0];
            if (!next) return;
            await this.#run(session, next);
          }
        } finally {
          this.#driving.delete(session);
        }
      })();
      this.#driving.set(session, driving);
    }
    return driving;
  }

  async #run(session: SessionId, op: StoredOperation): Promise<void> {
    const { operationId } = op;
    let owner = "parts" in op.input ? op.input.from?.participantId : undefined;
    // Place the input, unless an earlier instance already did.
    if (op.status === "queued") {
      let placed: Message;
      if ("parts" in op.input) {
        placed = {
          id: op.input.messageId ?? operationId,
          role: "user",
          parts: op.input.parts.map(toUIPart)
        };
      } else {
        const answered = this.#answer(session, op.input);
        if (typeof answered === "string") {
          this.#settle(session, op, { status: "unanswered", reason: answered });
          return;
        }
        placed = answered;
      }
      this.#putMessage(session, placed);
      op = { ...op, status: "placed" };
      this.#saveOperation(session, op);
      this.#emit(session, [
        { type: "message", message: this.#transcript(placed) },
        { type: "operation", status: { operationId, status: "placed" } }
      ]);
    }

    const messages = this.#messages(session);
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      // An answer continues the message that made the call, for whoever
      // started it; with calls still unanswered, it waits for them.
      owner = last.metadata?.owner;
      if (awaitsInput(last)) {
        this.#settle(session, op, { status: "done" });
        return;
      }
    }

    const run: Run = {
      operations: [operationId],
      partial: [],
      abort: new AbortController()
    };
    this.#runs.set(session, run);
    this.#emit(session, [{ type: "run-start", operations: [operationId] }]);
    const { model, tools, system } = this.#options;
    let message: Message | undefined;
    let error: unknown;
    try {
      const result = streamText({
        model,
        ...(system !== undefined && { system }),
        ...(tools && { tools }),
        stopWhen: this.#options.stopWhen ?? stepCountIs(5),
        messages: await convertToModelMessages(messages),
        abortSignal: run.abort.signal
      });
      const stream = toUIMessageStream<TOOLS, Message>({
        stream: result.stream,
        ...(tools && { tools }),
        originalMessages: messages,
        generateMessageId: () => crypto.randomUUID(),
        onEnd: ({ responseMessage }) => {
          message = {
            ...responseMessage,
            metadata: {
              ...responseMessage.metadata,
              ...(owner !== undefined && { owner })
            }
          };
        }
      });
      for await (const chunk of toResponseChunks(stream, {
        ...(tools && { tools }),
        ...(owner !== undefined && { owner })
      })) {
        run.partial.push(chunk);
        this.#emit(session, [{ type: "chunk", chunk }]);
      }
    } catch (caught) {
      error = caught;
    }
    if (message) {
      this.#putMessage(session, message);
      this.#emit(session, [
        { type: "message", message: this.#transcript(message) }
      ]);
    }
    this.#runs.delete(session);
    if (run.abort.signal.aborted) {
      this.#settle(session, op, { status: "unanswered", reason: "aborted" });
    } else if (error !== undefined) {
      console.error(`AI SDK run for "${operationId}" failed`, error);
      this.#settle(session, op, {
        status: "unanswered",
        reason: error instanceof Error ? error.message : "failed"
      });
    } else {
      this.#settle(session, op, {
        status: "done",
        text: message ? textOf(message) : ""
      });
    }
    this.#emit(session, [{ type: "run-end", operations: [operationId] }]);
  }

  /** The message an answer updates, or why it is not wanted. */
  #answer(session: SessionId, answer: Input & ToolAnswer): Message | string {
    const messages = this.#messages(session);
    const event: ToolCallAnswer =
      answer.type === "approval"
        ? {
            type: "approval-response",
            approvalId: answer.approvalId,
            approved: answer.approved,
            ...(answer.reason !== undefined && { reason: answer.reason })
          }
        : {
            type: "tool-result",
            toolCallId: answer.toolCallId,
            result: answer.result
          };
    if (answer.type === "tool-result") {
      // Only the client of the participant who started the turn runs a
      // client tool.
      const holder = messages.find((m) =>
        m.parts.some(
          (p) => "toolCallId" in p && p.toolCallId === answer.toolCallId
        )
      );
      const owner = holder?.metadata?.owner;
      const from = answer.from?.participantId;
      if (owner !== undefined && from !== undefined && owner !== from) {
        return "not_owner";
      }
    }
    // SAFETY: the answered message keeps the metadata it was saved with.
    const answered = answerToolCall(messages, event) as Message | undefined;
    // The first answer wins.
    return answered ?? "not_waiting";
  }

  #settle(
    session: SessionId,
    op: StoredOperation,
    result:
      | { status: "done"; text?: string }
      | { status: "unanswered"; reason: string }
  ): void {
    const settled: StoredOperation = { ...op, ...result };
    this.#saveOperation(session, settled);
    const { operationId } = op;
    this.#emit(session, [
      {
        type: "operation",
        status:
          result.status === "done"
            ? {
                operationId,
                status: "done",
                ...(result.text !== undefined && { text: result.text })
              }
            : { operationId, status: "unanswered", reason: result.reason }
      }
    ]);
    const key = waiterKey(session, operationId);
    for (const waiter of this.#waiters.get(key) ?? []) waiter(settled);
    this.#waiters.delete(key);
  }

  #wake(session: SessionId): Promise<unknown> {
    return this.lifecycle.jobs.push({
      id: `${PREFIX}wake:${session}`,
      fn: WAKE_FN,
      time: Date.now(),
      payload: { session },
      singleflight: true
    });
  }

  #emit(session: SessionId, events: SessionEvent[]): void {
    for (const watcher of this.#watchers.get(session) ?? []) {
      watcher.push(events);
    }
  }

  // ── Storage ────────────────────────────────────────────────────────────

  get #kv(): SyncKvStorage {
    return this.lifecycle.storage.kv;
  }

  #create(session: StoredSession): HarnessSession {
    this.#kv.put(`${PREFIX}s:${session.id}`, session);
    return this.session(session.id);
  }

  /** Sessions are created on first use, so any id names one. */
  #ensure(session: SessionId): void {
    if (this.#kv.get(`${PREFIX}s:${session}`) === undefined) {
      this.#create({ id: session });
    }
  }

  #nextSeq(session: SessionId): number {
    const key = `${PREFIX}seq:${session}`;
    const seq = (this.#kv.get<number>(key) ?? 0) + 1;
    this.#kv.put(key, seq);
    return seq;
  }

  #messages(session: SessionId): Message[] {
    return [...this.#kv.list<Message>({ prefix: messagePrefix(session) })].map(
      ([, message]) => message
    );
  }

  /** Save a message, in place of any with its id. */
  #putMessage(session: SessionId, message: Message): void {
    const indexKey = `${PREFIX}mi:${JSON.stringify(session)}:${message.id}`;
    let key = this.#kv.get<string>(indexKey);
    if (key === undefined || this.#kv.get(key) === undefined) {
      key = messagePrefix(session) + pad(this.#nextSeq(session));
      this.#kv.put(indexKey, key);
    }
    this.#kv.put(key, message);
  }

  #operation(
    session: SessionId,
    operationId: string
  ): StoredOperation | undefined {
    return this.#kv.get(operationKey(session, operationId));
  }

  #saveOperation(session: SessionId, op: StoredOperation): void {
    this.#kv.put(operationKey(session, op.operationId), op);
    const pendingKey = `${pendingPrefix(session)}${pad(op.seq)}`;
    if (isPending(op)) this.#kv.put(pendingKey, op.operationId);
    else this.#kv.delete(pendingKey);
  }

  /** Unsettled operations, oldest first. */
  #pending(session: SessionId): StoredOperation[] {
    return [...this.#kv.list<string>({ prefix: pendingPrefix(session) })]
      .map(([, id]) => this.#operation(session, id))
      .filter((op): op is StoredOperation => op !== undefined);
  }

  #transcript(message: Message): TranscriptMessage {
    const owner = message.metadata?.owner;
    return toTranscriptMessage(message, {
      ...(this.#options.tools && { tools: this.#options.tools }),
      ...(owner !== undefined && { owner })
    });
  }
}

/** One watch: events queue until `start`, then reach the listener in order. */
class Watcher implements SessionWatch {
  readonly closed: Promise<void>;
  #close!: () => void;
  #listener: ((events: readonly SessionEvent[]) => Promise<void>) | undefined;
  readonly #queue: SessionEvent[][] = [];
  #draining = false;
  #stopped = false;

  constructor(
    readonly state: SessionState,
    private readonly onStop: () => void
  ) {
    this.closed = new Promise((resolve) => {
      this.#close = resolve;
    });
  }

  start(listener: (events: readonly SessionEvent[]) => Promise<void>): void {
    this.#listener = listener;
    void this.#drain();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.onStop();
    this.#close();
  }

  push(events: SessionEvent[]): void {
    if (this.#stopped) return;
    this.#queue.push(events);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (!this.#listener || this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && !this.#stopped) {
        const events = this.#queue.shift() as SessionEvent[];
        try {
          await this.#listener(events);
        } catch (error) {
          console.error("A session watcher failed", error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}

function isPending(op: StoredOperation): boolean {
  return op.status === "queued" || op.status === "placed";
}

/** Whether the message has a tool call waiting for a result or approval. */
function awaitsInput(message: Message): boolean {
  return message.parts.some(
    (part) =>
      "toolCallId" in part &&
      (part.state === "input-available" || part.state === "approval-requested")
  );
}

function textOf(message: Message): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function toUIPart(part: InputPart): Message["parts"][number] {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : {
        type: "file",
        mediaType: part.mediaType,
        url: part.url,
        ...(part.filename !== undefined && { filename: part.filename })
      };
}

function pad(seq: number): string {
  return String(seq).padStart(12, "0");
}

function messagePrefix(session: SessionId): string {
  return `${PREFIX}m:${JSON.stringify(session)}:`;
}

function pendingPrefix(session: SessionId): string {
  return `${PREFIX}p:${JSON.stringify(session)}:`;
}

function operationKey(session: SessionId, operationId: string): string {
  return `${PREFIX}o:${JSON.stringify(session)}:${operationId}`;
}

function waiterKey(session: SessionId, operationId: string): string {
  return JSON.stringify([session, operationId]);
}
