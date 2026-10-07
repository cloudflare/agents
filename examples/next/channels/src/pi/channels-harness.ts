import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
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
 * shape translation: pi entries become transcript messages, pi events become
 * session events, and pi's submission ids become the caller's operation ids
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
    return this.session.submit(toUserInput(input), {
      operationId,
      ...(options.whenBusy && { whenBusy: options.whenBusy })
    });
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
    const stream = await this.session.events();
    const transcript = await this.transcript();
    const pending = await this.pi.pending({ session: this.id });
    const snapshot = stream.snapshot;
    const operations = await this.operations(snapshot.run?.inputs ?? []);
    const translator = new EventTranslator(this, transcript);
    const partial = snapshot.run
      ? translator.attachToRun(snapshot.generation?.message)
      : [];
    const state: SessionState = {
      messages: transcript,
      pending: pending.map(
        (p): OperationStatus => ({
          operationId: p.operationId,
          status: p.status === "queued" ? "queued" : "placed"
        })
      ),
      ...(snapshot.run && {
        run: { operations, ...(partial.length && { partial }) }
      })
    };
    return {
      state,
      start: (listener) =>
        stream.start(async (events) => {
          const out: SessionEvent[] = [];
          for (const event of events) {
            try {
              out.push(...(await translator.translate(event)));
            } catch (error) {
              console.warn("pi → session event", event.type, error);
            }
          }
          if (out.length) await listener(out);
        }),
      stop: async () => void (await stream.stop()),
      closed: stream.closed.then(() => undefined)
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

/**
 * pi's agent events as session events. The live message streams as chunks;
 * every saved entry republishes the messages it changed, since a tool
 * result changes the assistant message holding its call.
 */
class EventTranslator {
  #messages: Map<string, string>;
  #run: RunChunks | undefined;

  constructor(
    private readonly session: PiChannelsSession,
    transcript: readonly TranscriptMessage[]
  ) {
    this.#messages = digest(transcript);
  }

  /**
   * Join a run already in progress: the in-flight message so far as chunks,
   * with its text and reasoning parts left open so the deltas that follow
   * continue them.
   */
  attachToRun(partial: AssistantMessage | undefined): ResponseChunk[] {
    this.#run = new RunChunks();
    this.#run.nextMessage();
    return partial ? this.#run.seed(partial) : [];
  }

  async translate(event: AgentEvent): Promise<SessionEvent[]> {
    switch (event.type) {
      case "submission":
        return this.#submission(event.record);
      case "run_start": {
        this.#run = new RunChunks();
        const operations = await this.session.operations(event.inputs);
        return [{ type: "run-start", operations }];
      }
      case "message_start":
        if (event.message.role !== "assistant") return [];
        this.#run?.nextMessage();
        // The partial may already hold text that no update will repeat.
        return this.#chunks(this.#run?.seed(event.message) ?? []);
      case "message_update":
        return this.#chunks(this.#run?.apply(event.changes) ?? []);
      case "message_end": {
        const message = event.entry.model?.[0];
        // pi coalesces live updates; a message can finish with text that no
        // update carried. Complete it from the saved entry before closing.
        const chunks = [
          ...(message?.role === "assistant"
            ? (this.#run?.complete(message) ?? [])
            : []),
          ...(this.#run?.closeParts() ?? [])
        ];
        if (message?.role === "assistant") {
          for (const part of message.content) {
            if (part.type === "toolCall") {
              chunks.push(
                ...(this.#run?.toolCall(
                  part.id,
                  part.name,
                  part.arguments as Json
                ) ?? [])
              );
            }
          }
        }
        return [...this.#chunks(chunks), ...(await this.#saved(event.entry))];
      }
      case "tool_execution_end": {
        const chunks: ResponseChunk[] = [];
        const result = event.entry?.model?.[0];
        if (result?.role === "toolResult") {
          const text = toolText(result.content);
          chunks.push(
            result.isError
              ? {
                  type: "tool-output-error",
                  toolCallId: event.toolCallId,
                  errorText: text
                }
              : {
                  type: "tool-output-available",
                  toolCallId: event.toolCallId,
                  output: toolOutput(result.content, result.details)
                }
          );
        }
        return [
          ...this.#chunks(chunks),
          ...(event.entry ? await this.#saved(event.entry) : [])
        ];
      }
      case "entry_appended":
        return this.#saved(event.entry);
      case "run_end": {
        const chunks = this.#run?.closeParts() ?? [];
        this.#run = undefined;
        const operations = await this.session.operations(event.inputs);
        return [
          ...this.#chunks(chunks),
          ...(await this.#changed()),
          { type: "run-end", operations }
        ];
      }
      default:
        return [];
    }
  }

  #submission(record: SubmissionRecord): SessionEvent[] {
    if (record.type !== "input" || record.requestId === undefined) return [];
    const operationId = record.requestId;
    switch (record.status) {
      case "queued":
        return [
          { type: "operation", status: { operationId, status: "queued" } }
        ];
      case "placed":
        this.session.placed(record);
        return [
          { type: "operation", status: { operationId, status: "placed" } }
        ];
      case "done":
        return [{ type: "operation", status: { operationId, status: "done" } }];
      case "unanswered":
        return [
          {
            type: "operation",
            status: { operationId, status: "unanswered", reason: record.reason }
          }
        ];
    }
  }

  async #saved(entry: EntryRecord): Promise<SessionEvent[]> {
    if (entry.kind === "pi.reset") {
      this.#messages = new Map();
      return [{ type: "reset" }, ...(await this.#changed())];
    }
    return this.#changed();
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

  apply(changes: readonly MessageChange[]): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    for (const change of changes) {
      switch (change.type) {
        case "text_start":
        case "thinking_start": {
          const kind = change.block.type === "thinking" ? "reasoning" : "text";
          const part = this.#start(change.contentIndex, kind, out);
          this.#delta(
            change.contentIndex,
            part.id,
            kind,
            blockText(change.block),
            out
          );
          break;
        }
        case "text_delta":
        case "thinking_delta": {
          const kind = change.type === "text_delta" ? "text" : "reasoning";
          const part = this.#start(change.contentIndex, kind, out);
          this.#delta(change.contentIndex, part.id, kind, change.delta, out);
          break;
        }
        case "block":
          if (change.block.type === "toolCall") {
            const { id, name, arguments: input } = change.block;
            out.push(...this.toolCall(id, name, input as Json));
          } else {
            this.#rest(change.contentIndex, change.block, out);
            this.#close(change.contentIndex, out);
          }
          break;
        case "message":
          out.push(...this.complete(change.message));
          break;
        default:
          // Tool call deltas: the call is shown once its block completes.
          break;
      }
    }
    return out;
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
    if (message.role === "notice") {
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
