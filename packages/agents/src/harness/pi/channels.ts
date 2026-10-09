import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
  SubmissionId,
  SubmissionRecord
} from "@earendil-works/pi-durable";
import type {
  AgentHarness,
  HarnessInput,
  HarnessInputFrom,
  HarnessSession,
  HarnessSessions,
  OperationResult,
  OperationStatus,
  SessionEvent,
  SessionInfo,
  SessionState,
  SessionWatch,
  SubmitOptions,
  ToolAnswer
} from "../../experimental/channels/harness";
import {
  PiChunkProjection,
  toToolOutputChunk,
  toTranscriptMessages,
  toUserInput
} from "../../experimental/channels/projections/pi";
import type {
  ResponseChunk,
  TranscriptMessage
} from "../../experimental/channels/protocol";
import { BACKGROUND_CONTEXT } from "./context";
import type { PiHarness, PiSession } from "./harness";
import type { PiOperationResult } from "./types";

const BG = BACKGROUND_CONTEXT;

/**
 * `PiHarness` behind the shared harness interface (`AgentHarness`), so
 * `Channels.forHarness` can serve it. pi events become session events, and
 * pi's submission ids become the caller's operation ids (pi's `requestId`).
 * Messages keep pi's entry ids; `placed` and `done` report the entry an
 * operation placed. Message formats are the pi projection's. It knows nothing about how
 * sessions reach clients.
 *
 * Opt-in: `PiHarness` keeps pi's own shape.
 *
 * @experimental The shared harness interface may change between releases.
 */
export function piChannelsHarness(pi: PiHarness): AgentHarness {
  const session = (id?: string): HarnessSession =>
    new PiChannelsSession(pi, pi.session(id));
  const sessions: HarnessSessions = {
    create: async () => session((await pi.sessions.create()).id),
    fork: async (from) => session((await pi.sessions.fork(from)).id),
    list: (): Promise<SessionInfo[]> => pi.sessions.list()
  };
  return { sessions, session };
}

/** Lookups in pi's own storage that its events leave out. */
class Submissions {
  constructor(
    private readonly pi: PiHarness,
    private readonly session: string
  ) {}

  /** pi's submission id as the caller's operation id. */
  async operation(id: SubmissionId): Promise<string | undefined> {
    const storage = await this.pi.storage();
    return (await storage.submission(id, BG))?.requestId;
  }

  /** The entry the caller's operation placed, if pi placed it. */
  async entry(operationId: string): Promise<string | undefined> {
    const storage = await this.pi.storage();
    let cursor: Parameters<typeof storage.scanSubmissions>[2];
    for (;;) {
      const page = await storage.scanSubmissions(
        // SAFETY: pi session ids are pi conversation ids as strings.
        {
          conversationId: Number(
            this.session
          ) as SubmissionRecord["conversationId"]
        },
        100,
        cursor,
        BG
      );
      const record = page.items.find((r) => r.requestId === operationId);
      if (record) return entryId(record);
      if (page.next === undefined) return undefined;
      cursor = page.next;
    }
  }
}

class PiChannelsSession implements HarnessSession {
  readonly id: string;
  readonly #submissions: Submissions;

  constructor(
    private readonly pi: PiHarness,
    private readonly session: PiSession
  ) {
    this.id = session.id;
    this.#submissions = new Submissions(pi, session.id);
  }

  async submit(
    input: (HarnessInput | ToolAnswer) & HarnessInputFrom,
    options: SubmitOptions = {}
  ) {
    // pi's tools run on the server, and it has no approvals.
    if (!("parts" in input)) throw new Error("pi takes no tool answers");
    // pi has no participants, so `from` is dropped, and its entries have
    // their own ids, so `messageId` is too: `placed` reports the entry.
    const operationId = options.operationId ?? crypto.randomUUID();
    return this.session.submit(toUserInput(input.parts), {
      operationId,
      ...(options.whenBusy && { whenBusy: options.whenBusy })
    });
  }

  abort(operationId?: string): Promise<boolean> {
    return this.session.abort(operationId);
  }

  async wait(operationId: string, signal?: AbortSignal) {
    const result = toResult(await this.session.wait(operationId, signal));
    if (result.status !== "done") return result;
    // For a caller that missed `placed`.
    const messageId = await this.#submissions.entry(operationId);
    return { ...result, ...(messageId !== undefined && { messageId }) };
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
          if (out.length) await listener(placedFirst(out));
        }),
      stop: async () => void (await stream.stop()),
      closed: stream.closed.then(() => undefined)
    };
  }

  /** The active transcript, under pi's entry ids. */
  async transcript(): Promise<TranscriptMessage[]> {
    return toTranscriptMessages(await this.session.messages());
  }

  /** pi submission ids as operation ids, read from pi's storage. */
  async operations(inputs: readonly SubmissionId[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of inputs) {
      const operation = await this.#submissions.operation(id);
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
  #run: PiChunkProjection | undefined;

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
    this.#run = new PiChunkProjection();
    return this.#run.startMessage(partial);
  }

  async translate(event: AgentEvent): Promise<SessionEvent[]> {
    switch (event.type) {
      case "submission":
        return this.#submission(event.record);
      case "run_start": {
        this.#run = new PiChunkProjection();
        const operations = await this.session.operations(event.inputs);
        return [{ type: "run-start", operations }];
      }
      case "message_start":
        if (event.message.role !== "assistant") return [];
        // The partial may already hold text that no update will repeat.
        return this.#chunks(this.#run?.startMessage(event.message) ?? []);
      case "message_update":
        return this.#chunks(this.#run?.changes(event.changes) ?? []);
      case "message_end": {
        const chunks = this.#run?.endMessage(event.entry.model?.[0]) ?? [];
        return [...this.#chunks(chunks), ...(await this.#saved(event.entry))];
      }
      case "tool_execution_end": {
        const chunk = toToolOutputChunk(
          event.toolCallId,
          event.entry?.model?.[0]
        );
        return [
          ...this.#chunks(chunk ? [chunk] : []),
          ...(event.entry ? await this.#saved(event.entry) : [])
        ];
      }
      case "entry_appended":
        return this.#saved(event.entry);
      case "run_end": {
        const chunks = this.#run?.end() ?? [];
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
      case "done": {
        const messageId = entryId(record);
        return [
          {
            type: "operation",
            status: {
              operationId,
              status: record.status,
              ...(messageId !== undefined && { messageId })
            }
          }
        ];
      }
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
      const messages = await this.session.transcript();
      this.#messages = digest(messages);
      return [{ type: "transcript", messages }];
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

function entryId(record: SubmissionRecord): string | undefined {
  return record.entry === undefined ? undefined : String(record.entry);
}

/**
 * pi publishes a commit's submission records after its entries, so the user
 * entry an input placed comes before the `placed` that names it. Callers
 * map that id before the message arrives, so each `placed` moves to just
 * before its message; everything else keeps pi's order.
 */
function placedFirst(events: readonly SessionEvent[]): SessionEvent[] {
  const placed = new Map<string, SessionEvent>();
  for (const event of events) {
    if (
      event.type === "operation" &&
      event.status.status === "placed" &&
      event.status.messageId !== undefined
    ) {
      placed.set(event.status.messageId, event);
    }
  }
  const sent = new Set<SessionEvent>();
  const out: SessionEvent[] = [];
  const send = (event: SessionEvent) => {
    if (sent.has(event)) return;
    sent.add(event);
    out.push(event);
  };
  for (const event of events) {
    const early =
      event.type === "message" ? placed.get(event.message.id) : undefined;
    if (early) send(early);
    send(event);
  }
  return out;
}
