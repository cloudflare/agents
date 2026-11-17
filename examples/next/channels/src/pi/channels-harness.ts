import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  EntryRecord,
  InboxState,
  LiveState,
  SubmissionId,
  SubmissionRecord,
  UserInput
} from "@earendil-works/pi-durable";
import type {
  AgentHarness,
  HarnessInput,
  HarnessInputFrom,
  HarnessSession,
  HarnessSessions,
  Json,
  MessagePart,
  OperationResult,
  OperationStatus,
  ResponseChunk,
  SessionEvent,
  SessionInfo,
  SessionState,
  SessionWatch,
  SubmitOptions,
  ToolAnswer,
  ToolPart,
  TranscriptMessage
} from "agents/experimental/channels";
import type {
  PiHarness,
  PiOperationResult,
  PiSession
} from "agents/harness/pi";
import {
  projectEntries,
  type PiMessage
} from "../../../harnesses/pi/src/transcript";

const BG = BACKGROUND_CONTEXT;

export type PiChannelsHarnessOptions = {
  /**
   * Where the adapter keeps the caller's message id per operation. pi has
   * no field for it.
   */
  kv: SyncKvStorage;
};

/**
 * `PiHarness` behind the shared harness interface (`AgentHarness`). Only a
 * shape translation: pi entries become transcript messages, changes of pi's
 * conversation view become session events, and pi's submission ids become
 * the caller's operation ids
 * (pi's `requestId`). It knows nothing about how sessions reach clients.
 *
 * Opt-in and permanent: `PiHarness` keeps pi's own shape, and this adapter
 * would ship next to it (for example as `agents/harness/pi/channels`).
 */
export function piChannelsHarness(
  pi: PiHarness,
  options: PiChannelsHarnessOptions
): AgentHarness {
  const ids = new MessageIds(pi, options.kv);
  const session = (id?: string): HarnessSession =>
    new PiChannelsSession(pi, pi.session(id), ids);
  const sessions: HarnessSessions = {
    create: async () => session((await pi.sessions.create()).id),
    fork: async (from) => session((await pi.sessions.fork(from)).id),
    list: (): Promise<SessionInfo[]> => pi.sessions.list()
  };
  return { sessions, session };
}

/**
 * The caller's id for each user message.
 *
 * At submit, before pi sees the input, the caller's message id is recorded
 * under the operation id. Recording first means there is no crash window
 * where pi has the input but not the id: a crash between the two leaves an
 * orphaned record, which is harmless. The record is written outside pi's
 * transaction, so a repeated submit keeps the first id.
 *
 * On the way out, a user entry is matched to the submission that placed it
 * (from pi's storage, by `entry`) and so to its operation. That match is
 * cached once known.
 */
class MessageIds {
  constructor(
    private readonly pi: PiHarness,
    private readonly kv: SyncKvStorage
  ) {}

  record(session: string, operationId: string, messageId: string): void {
    const key = `pi-channels:op:${session}:${operationId}`;
    if (this.kv.get(key) === undefined) this.kv.put(key, messageId);
  }

  /** The caller's message id for a placed submission. */
  placed(session: string, record: SubmissionRecord): string | undefined {
    if (record.type !== "input" || record.requestId === undefined) return;
    if (record.entry === undefined) return;
    const messageId =
      this.kv.get<string>(`pi-channels:op:${session}:${record.requestId}`) ??
      record.requestId;
    this.kv.put(`pi-channels:entry:${session}:${record.entry}`, messageId);
    return messageId;
  }

  /** Map user entry ids to caller ids, reading pi's submissions for misses. */
  async resolve(
    session: string,
    entryIds: readonly string[]
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const missing = new Set<string>();
    for (const id of entryIds) {
      const known = this.kv.get<string>(`pi-channels:entry:${session}:${id}`);
      if (known === undefined) missing.add(id);
      else out.set(id, known);
    }
    if (missing.size === 0) return out;
    const storage = await this.pi.storage();
    let cursor: Parameters<typeof storage.scanSubmissions>[2];
    for (;;) {
      const page = await storage.scanSubmissions(
        // SAFETY: pi session ids are pi conversation ids as strings.
        {
          conversationId: Number(session) as SubmissionRecord["conversationId"]
        },
        100,
        cursor,
        BG
      );
      for (const record of page.items) {
        if (record.entry === undefined) continue;
        if (!missing.has(String(record.entry))) continue;
        const messageId = this.placed(session, record);
        if (messageId !== undefined) out.set(String(record.entry), messageId);
      }
      if (page.next === undefined) return out;
      cursor = page.next;
    }
  }

  /** pi's submission id as the caller's operation id. */
  async operation(id: SubmissionId): Promise<string | undefined> {
    const storage = await this.pi.storage();
    return (await storage.submission(id, BG))?.requestId;
  }
}

class PiChannelsSession implements HarnessSession {
  readonly id: string;
  /**
   * Operations submitted here that no view has shown yet. The watch takes
   * them off once it reports them, or settles them if they came and went
   * between two views.
   */
  readonly unseen = new Set<string>();

  constructor(
    private readonly pi: PiHarness,
    private readonly session: PiSession,
    private readonly ids: MessageIds
  ) {
    this.id = session.id;
  }

  async submit(
    input: (HarnessInput | ToolAnswer) & HarnessInputFrom,
    options: SubmitOptions = {}
  ) {
    // pi's tools run on the server, and it has no approvals.
    if (!("parts" in input)) throw new Error("pi takes no tool answers");
    // pi has no participants, so `from` is dropped.
    const operationId = options.operationId ?? crypto.randomUUID();
    this.ids.record(this.id, operationId, input.messageId ?? operationId);
    const receipt = await this.session.submit(toUserInput(input), {
      operationId,
      ...(options.whenBusy && { whenBusy: options.whenBusy })
    });
    // Only once pi has it, so pending() lists it until it settles.
    this.unseen.add(operationId);
    return receipt;
  }

  /** Operation ids queued or running in pi. */
  async pending(): Promise<Set<string>> {
    const pending = await this.pi.pending({ session: this.id });
    return new Set(pending.map((p) => p.operationId));
  }

  abort(operationId?: string): Promise<boolean> {
    return this.session.abort(operationId);
  }

  async wait(operationId: string, signal?: AbortSignal) {
    return toResult(await this.session.wait(operationId, signal));
  }

  reset(handoff?: string): Promise<void> {
    return this.session.reset(handoff);
  }

  async watch(): Promise<SessionWatch> {
    const watch = await this.session.watch();
    const transcript = await this.transcript();
    const pending = await this.pi.pending({ session: this.id });
    const view = watch.value;
    const live = liveOf(view);
    const operations = await this.operations(live.run?.inputs ?? []);
    const translator = new ViewTranslator(this, transcript, view);
    const partial = translator.attach(view);
    const state: SessionState = {
      messages: transcript,
      pending: pending.map((p): OperationStatus => ({
        operationId: p.operationId,
        status: p.status === "queued" ? "queued" : "placed"
      })),
      ...(live.run && {
        run: { operations, ...(partial.length && { partial }) }
      })
    };
    return {
      state,
      start: (listener) =>
        watch.start(async (call) => {
          if (call.kind !== "value") return;
          let out: SessionEvent[] = [];
          try {
            out = await translator.advance(call.value);
          } catch (error) {
            console.warn("pi view → session events", error);
          }
          if (out.length) await listener(out);
        }),
      stop: async () => void (await watch.stop()),
      closed: watch.closed.then(() => undefined)
    };
  }

  /** The active transcript, with user messages under the caller's ids. */
  async transcript(): Promise<TranscriptMessage[]> {
    const messages = projectEntries(await this.session.messages());
    const users = messages.filter((m) => m.role === "user").map((m) => m.id);
    const ids = await this.ids.resolve(this.id, users);
    return toTranscript(messages, (entryId) => ids.get(entryId));
  }

  /** Cache the caller's message id once pi places the input. */
  placed(record: SubmissionRecord): void {
    this.ids.placed(this.id, record);
  }

  /** pi's record of a submission, read from its storage. */
  async submission(id: SubmissionId): Promise<SubmissionRecord | undefined> {
    return (await this.pi.storage()).submission(id, BG);
  }

  /** pi submission ids as operation ids, read from pi's storage. */
  async operations(inputs: readonly SubmissionId[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of inputs) {
      const operation = await this.ids.operation(id);
      if (operation !== undefined) out.push(operation);
    }
    return out;
  }
}

function liveOf(view: ConversationView): LiveState {
  return (view.docs["pi.live"] ?? {}) as LiveState;
}

/** What identifies a run across changes: its first input, or its task. */
function runKey(live: LiveState): string | undefined {
  if (live.run === undefined) return undefined;
  return String(live.run.inputs[0] ?? `task:${live.run.taskId}`);
}

/** What identifies the message being streamed: its generation and attempt. */
function generationKey(live: LiveState): string | undefined {
  if (live.generation?.message === undefined) return undefined;
  return `${live.run?.taskId}:${live.generation.attempt}`;
}

/**
 * Changes of pi's conversation view as session events. pi's watch hands
 * over the newest view, with what changed since the last one folded in, so
 * this compares each view with the last: inputs that joined the inbox or the
 * run, a run starting or ending, new transcript entries, and the text the
 * streamed message gained. Every saved entry republishes the messages it
 * changed, since a tool result changes the assistant message holding its
 * call.
 */
class ViewTranslator {
  #messages: Map<string, string>;
  #run: RunChunks | undefined;
  #runKey: string | undefined;
  #runInputs: SubmissionId[] = [];
  /** The streamed message the run's chunks belong to. */
  #streaming: string | undefined;
  /** The newest entry seen. */
  #newest: number;
  /** Inputs reported queued or placed and not yet settled. */
  readonly #open = new Set<SubmissionId>();

  constructor(
    private readonly session: PiChannelsSession,
    transcript: readonly TranscriptMessage[],
    view: ConversationView
  ) {
    this.#messages = digest(transcript);
    this.#newest = view.entries.at(-1)?.id ?? view.before ?? 0;
    const live = liveOf(view);
    for (const item of inboxOf(view)) this.#open.add(item.id);
    for (const id of live.run?.inputs ?? []) this.#open.add(id);
  }

  /**
   * Join a run already in progress: the in-flight message so far as chunks,
   * with its text and reasoning parts left open so the text that follows
   * continues them.
   */
  attach(view: ConversationView): ResponseChunk[] {
    const live = liveOf(view);
    if (live.run === undefined) return [];
    this.#startRun(live, live.run.inputs);
    const partial = live.generation?.message as AssistantMessage | undefined;
    if (partial === undefined) return [];
    this.#streaming = generationKey(live);
    return this.#run?.seed(partial) ?? [];
  }

  async advance(view: ConversationView): Promise<SessionEvent[]> {
    const live = liveOf(view);
    const inbox = inboxOf(view);
    const out: SessionEvent[] = [];
    // A run ended, or the next one already started.
    const key = runKey(live);
    if (this.#runKey !== undefined && key !== this.#runKey) {
      out.push(...(await this.#entries(view)));
      out.push(...(await this.#settled(live, inbox)));
      out.push(...(await this.#endRun()));
    }
    for (const item of inbox) {
      if (this.#open.has(item.id)) continue;
      this.#open.add(item.id);
      const operations = await this.session.operations([item.id]);
      for (const operationId of operations) {
        this.session.unseen.delete(operationId);
        out.push({
          type: "operation",
          status: { operationId, status: "queued" }
        });
      }
    }
    if (live.run !== undefined && this.#runKey === undefined) {
      this.#startRun(live);
      const operations = await this.session.operations(live.run.inputs);
      for (const id of operations) this.session.unseen.delete(id);
      out.push({ type: "run-start", operations });
    }
    // Inputs the run took, at its start or as steers.
    for (const id of live.run?.inputs ?? []) {
      if (this.#runInputs.includes(id)) continue;
      this.#runInputs.push(id);
      this.#open.add(id);
      const record = await this.session.submission(id);
      if (record?.type !== "input" || record.requestId === undefined) continue;
      this.session.unseen.delete(record.requestId);
      this.session.placed(record);
      out.push({
        type: "operation",
        status: { operationId: record.requestId, status: "placed" }
      });
    }
    out.push(...(await this.#entries(view)));
    out.push(...this.#partial(live));
    out.push(...(await this.#settled(live, inbox)));
    out.push(...(await this.#missed()));
    return out;
  }

  /** A new run; `inputs` are the ones already reported as placed. */
  #startRun(live: LiveState, inputs: readonly SubmissionId[] = []): void {
    this.#run = new RunChunks();
    this.#runKey = runKey(live);
    this.#runInputs = [...inputs];
    this.#streaming = undefined;
  }

  async #endRun(): Promise<SessionEvent[]> {
    const chunks = this.#run?.closeParts() ?? [];
    const operations = await this.session.operations(this.#runInputs);
    this.#run = undefined;
    this.#runKey = undefined;
    this.#runInputs = [];
    this.#streaming = undefined;
    return [
      ...this.#chunks(chunks),
      ...(await this.#changed()),
      { type: "run-end", operations }
    ];
  }

  /** The text the streamed message gained since the last view. */
  #partial(live: LiveState): SessionEvent[] {
    const message = live.generation?.message as AssistantMessage | undefined;
    const key = generationKey(live);
    if (message === undefined || key === undefined || !this.#run) return [];
    if (key !== this.#streaming) {
      this.#run.nextMessage();
      this.#streaming = key;
    }
    // Tool calls are shown once their message is saved.
    return this.#chunks(this.#run.complete(message));
  }

  /** Entries added since the last view. */
  async #entries(view: ConversationView): Promise<SessionEvent[]> {
    const added = view.entries.filter((entry) => entry.id > this.#newest);
    if (added.length === 0) return [];
    this.#newest = added[added.length - 1].id;
    const out: SessionEvent[] = [];
    for (const entry of added) out.push(...this.#entry(entry));
    return [...out, ...(await this.#changed())];
  }

  #entry(entry: EntryRecord): SessionEvent[] {
    if (entry.kind === "pi.reset") {
      this.#messages = new Map();
      return [{ type: "reset" }];
    }
    const message = entry.model?.[0];
    const run = this.#run;
    if (!run) return [];
    if (message?.role === "assistant") {
      // pi saves the message with text the last view may not have shown.
      if (this.#streaming === undefined) run.nextMessage();
      this.#streaming = undefined;
      const chunks = [...run.complete(message), ...run.closeParts()];
      for (const part of message.content) {
        if (part.type === "toolCall") {
          chunks.push(
            ...run.toolCall(part.id, part.name, part.arguments as Json)
          );
        }
      }
      return this.#chunks(chunks);
    }
    if (message?.role === "toolResult") {
      const text = toolText(message.content);
      return this.#chunks([
        message.isError
          ? {
              type: "tool-output-error",
              toolCallId: message.toolCallId,
              errorText: text
            }
          : {
              type: "tool-output-available",
              toolCallId: message.toolCallId,
              output: toolOutput(message.content, message.details)
            }
      ]);
    }
    return [];
  }

  /** Inputs that left the inbox and the run: how pi settled each. */
  async #settled(
    live: LiveState,
    inbox: readonly { id: SubmissionId }[]
  ): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    const current = new Set([
      ...inbox.map((item) => item.id),
      ...(live.run?.inputs ?? [])
    ]);
    for (const id of [...this.#open]) {
      if (current.has(id)) continue;
      const record = await this.session.submission(id);
      if (record?.status !== "done" && record?.status !== "unanswered") {
        continue;
      }
      this.#open.delete(id);
      if (record.type !== "input" || record.requestId === undefined) continue;
      const operationId = record.requestId;
      this.session.unseen.delete(operationId);
      out.push({
        type: "operation",
        status:
          record.status === "done"
            ? { operationId, status: "done" }
            : { operationId, status: "unanswered", reason: record.reason }
      });
    }
    return out;
  }

  /**
   * Operations submitted here that settled before any view showed them: a
   * run that started and ended while the listener was busy is folded into
   * the next view, which shows neither it nor its inputs.
   */
  async #missed(): Promise<SessionEvent[]> {
    const unseen = this.session.unseen;
    if (unseen.size === 0) return [];
    // Copy first: one submitted while pending() runs is missing from its
    // answer though still running, so it waits for a later view.
    const submitted = [...unseen];
    const pending = await this.session.pending();
    const out: SessionEvent[] = [];
    for (const operationId of submitted) {
      // Still queued or running: a later view shows it.
      if (pending.has(operationId)) continue;
      unseen.delete(operationId);
      // Settled, so this resolves at once.
      const { session: _session, ...status } =
        await this.session.wait(operationId);
      out.push({ type: "operation", status });
    }
    return out;
  }

  /** Messages that are new or differ from what was last published. */
  async #changed(): Promise<SessionEvent[]> {
    const transcript = await this.session.transcript();
    const next = digest(transcript);
    const out: SessionEvent[] = [];
    for (const message of transcript) {
      if (this.#messages.get(message.id) !== next.get(message.id)) {
        out.push({ type: "message", message });
      }
    }
    this.#messages = next;
    return out;
  }

  #chunks(chunks: readonly ResponseChunk[]): SessionEvent[] {
    return chunks.map((chunk) => ({ type: "chunk", chunk }));
  }
}

function inboxOf(view: ConversationView): readonly { id: SubmissionId }[] {
  return (view.docs["pi.inbox"] as InboxState | undefined)?.items ?? [];
}

/** Part ids for one run: unique across the run's assistant messages. */
class RunChunks {
  #open = new Map<number, { kind: "text" | "reasoning"; id: string }>();
  /** Characters emitted per content index of the current message. */
  #emitted = new Map<number, number>();
  #message = 0;
  readonly #calls = new Set<string>();

  nextMessage(): void {
    this.#message += 1;
    this.#open.clear();
    this.#emitted.clear();
  }

  /**
   * The message so far. Text and reasoning stay open under the ids later
   * deltas use. Tool calls wait for their block or the message end, as
   * when streaming.
   */
  seed(message: AssistantMessage): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    message.content.forEach((block, index) => {
      if (block.type === "toolCall") return;
      const kind = block.type === "thinking" ? "reasoning" : "text";
      const part = this.#start(index, kind, out);
      this.#delta(index, part.id, kind, blockText(block), out);
    });
    return out;
  }

  /** A tool call, once. pi may complete it in a block or only at message end. */
  toolCall(toolCallId: string, toolName: string, input: Json): ResponseChunk[] {
    if (this.#calls.has(toolCallId)) return [];
    this.#calls.add(toolCallId);
    return [
      { type: "tool-input-start", toolCallId, toolName },
      { type: "tool-input-available", toolCallId, toolName, input }
    ];
  }

  /** Emit whatever text of `message` has not been streamed yet. */
  complete(message: AssistantMessage): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    message.content.forEach((block, index) => this.#rest(index, block, out));
    return out;
  }

  #rest(
    index: number,
    block: AssistantMessage["content"][number],
    out: ResponseChunk[]
  ): void {
    if (block.type !== "text" && block.type !== "thinking") return;
    const text = blockText(block);
    const done = this.#emitted.get(index) ?? 0;
    if (text.length <= done) return;
    const kind = block.type === "thinking" ? "reasoning" : "text";
    const part = this.#start(index, kind, out);
    this.#delta(index, part.id, kind, text.slice(done), out);
  }

  #delta(
    index: number,
    id: string,
    kind: "text" | "reasoning",
    delta: string,
    out: ResponseChunk[]
  ): void {
    if (!delta) return;
    this.#emitted.set(index, (this.#emitted.get(index) ?? 0) + delta.length);
    out.push({ type: `${kind}-delta`, id, delta });
  }

  closeParts(): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    for (const index of [...this.#open.keys()]) this.#close(index, out);
    return out;
  }

  #start(index: number, kind: "text" | "reasoning", out: ResponseChunk[]) {
    const open = this.#open.get(index);
    if (open) return open;
    const part = { kind, id: `${this.#message}:${index}` };
    this.#open.set(index, part);
    out.push({ type: `${kind}-start`, id: part.id });
    return part;
  }

  #close(index: number, out: ResponseChunk[]): void {
    const part = this.#open.get(index);
    if (!part) return;
    this.#open.delete(index);
    out.push({ type: `${part.kind}-end`, id: part.id });
  }
}

function toUserInput(input: HarnessInput): UserInput {
  const parts = input.parts.flatMap(
    (part): Exclude<UserInput, string>[number][] => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      const data = /^data:([^;,]+);base64,(.*)$/.exec(part.url);
      return data && part.mediaType.startsWith("image/")
        ? [{ type: "image", mimeType: data[1], data: data[2] }]
        : [];
    }
  );
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

function toResult(result: PiOperationResult): OperationResult {
  return result.status === "done"
    ? {
        operationId: result.operationId,
        session: result.session,
        status: "done",
        ...(result.text !== undefined && { text: result.text })
      }
    : {
        operationId: result.operationId,
        session: result.session,
        status: "unanswered",
        ...(result.reason !== undefined && { reason: result.reason })
      };
}

function digest(messages: readonly TranscriptMessage[]): Map<string, string> {
  return new Map(messages.map((m) => [m.id, JSON.stringify(m)]));
}

function blockText(block: AssistantMessage["content"][number]): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  return "";
}

/** pi's projected messages as a transcript. Tool results fold into their call. */
function toTranscript(
  messages: readonly PiMessage[],
  userId: (entryId: string) => string | undefined
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const calls = new Map<string, ToolPart>();
  for (const message of messages) {
    // Gaps come only from a client's paged transcript, never from entries.
    if (message.role === "gap") continue;
    if (message.role === "tool") {
      for (const part of message.parts) {
        const call = part.type === "tool-result" && calls.get(part.id);
        if (!call || part.type !== "tool-result") continue;
        if (part.error) {
          call.state = "output-error";
          call.errorText = toolText(part.content);
        } else {
          call.state = "output-available";
          call.output = toolOutput(part.content, part.details);
        }
      }
      continue;
    }
    const parts: MessagePart[] = [];
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          parts.push({ type: "text", text: part.text });
          break;
        case "thinking":
          parts.push({ type: "reasoning", text: part.text });
          break;
        case "image":
          parts.push({
            type: "file",
            mediaType: part.mimeType,
            url: `data:${part.mimeType};base64,${part.data}`
          });
          break;
        case "tool-call": {
          const call: ToolPart = {
            type: "tool",
            toolCallId: part.id,
            toolName: part.name,
            state: "input-available",
            input: part.arguments as Json
          };
          calls.set(part.id, call);
          parts.push(call);
          break;
        }
      }
    }
    if (message.error) {
      parts.push({ type: "text", text: `Error: ${message.error}` });
    }
    // A reset notice, or a compaction summary.
    if (message.role === "notice" || message.role === "summary") {
      if (parts.length) out.push({ id: message.id, role: "system", parts });
      continue;
    }
    out.push({
      id:
        message.role === "user"
          ? (userId(message.id) ?? message.id)
          : message.id,
      role: message.role,
      parts
    });
  }
  return out;
}

function toolText(content: readonly { type: string; text?: string }[]): string {
  return content.map((part) => part.text ?? "").join("");
}

function toolOutput(
  content: readonly { type: string; text?: string }[],
  details: unknown
): Json {
  return (details ?? toolText(content)) as Json;
}
