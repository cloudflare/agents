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

  async record(id: SubmissionId): Promise<SubmissionRecord | undefined> {
    const storage = await this.pi.storage();
    return (await storage.submission(id, BG)) ?? undefined;
  }

  /** pi's submission id as the caller's operation id. */
  async operation(id: SubmissionId): Promise<string | undefined> {
    return (await this.record(id))?.requestId;
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
    pi: PiHarness,
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
    // Everything comes from pi's snapshot, which pi takes atomically with
    // the registration for later commits, so no change falls between them.
    const { snapshot } = stream;
    const translator = new EventTranslator(
      this.#submissions,
      snapshot.entries,
      () => this.session.messages()
    );
    const pending: OperationStatus[] = [];
    for (const item of snapshot.inbox) {
      const record = await this.#submissions.record(item.id);
      if (record?.requestId === undefined) continue;
      pending.push({ operationId: record.requestId, status: "queued" });
    }
    const operations: string[] = [];
    for (const id of snapshot.run?.inputs ?? []) {
      const record = await this.#submissions.record(id);
      if (record?.requestId === undefined) continue;
      operations.push(record.requestId);
      const messageId = entryId(record);
      pending.push({
        operationId: record.requestId,
        status: "placed",
        ...(messageId !== undefined && { messageId })
      });
    }
    const partial = snapshot.run
      ? translator.attachToRun(operations, snapshot.generation?.message)
      : [];
    const state: SessionState = {
      messages: translator.transcript(),
      pending,
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
          out.push(...(await translator.changed()));
          if (out.length) await listener(placedFirst(out));
        }),
      stop: async () => void (await stream.stop()),
      closed: stream.closed.then(() => undefined)
    };
  }
}

/**
 * pi's agent events as session events. The live message streams as chunks.
 * The active transcript is kept from the snapshot and the entries that
 * follow; after each commit, the messages it changed are republished, since
 * a tool result changes the assistant message holding its call.
 */
class EventTranslator {
  #entries: EntryRecord[];
  /** What was last published, per message id. */
  #published: Map<string, string>;
  #run: { operations: string[]; chunks: PiChunkProjection } | undefined;
  /** The context was replaced, as by a reset or a snapshot. */
  #replaced = false;
  /** The context changed in a way only a re-read shows. */
  #stale = false;

  constructor(
    private readonly submissions: Submissions,
    entries: readonly EntryRecord[],
    private readonly read: () => Promise<EntryRecord[]>
  ) {
    this.#entries = [...entries];
    this.#published = digest(this.transcript());
  }

  transcript(): TranscriptMessage[] {
    return toTranscriptMessages(this.#entries);
  }

  /**
   * Join a run already in progress: the in-flight message so far as chunks,
   * with its text and reasoning parts left open so the deltas that follow
   * continue them.
   */
  attachToRun(
    operations: string[],
    partial: AssistantMessage | undefined
  ): ResponseChunk[] {
    const chunks = new PiChunkProjection();
    this.#run = { operations, chunks };
    return chunks.startMessage(partial);
  }

  async translate(event: AgentEvent): Promise<SessionEvent[]> {
    const run = this.#run?.chunks;
    switch (event.type) {
      case "snapshot":
        // pi replaces undelivered batches with a snapshot when a watcher
        // falls behind.
        return this.#caughtUp(event);
      case "submission":
        return this.#submission(event.record);
      case "run_start": {
        const operations = await this.#operations(event.inputs);
        this.#run = { operations, chunks: new PiChunkProjection() };
        return [{ type: "run-start", operations }];
      }
      case "message_start":
        if (event.message.role !== "assistant") return [];
        // The partial may already hold text that no update will repeat.
        return this.#chunks(run?.startMessage(event.message) ?? []);
      case "message_update":
        return this.#chunks(run?.changes(event.changes) ?? []);
      case "message_end":
        this.#saved(event.entry);
        return this.#chunks(run?.endMessage(event.entry.model?.[0]) ?? []);
      case "tool_execution_end": {
        if (event.entry) this.#saved(event.entry);
        const chunk = toToolOutputChunk(
          event.toolCallId,
          event.entry?.model?.[0]
        );
        return this.#chunks(chunk ? [chunk] : []);
      }
      case "entry_appended":
        this.#saved(event.entry);
        return [];
      case "run_end": {
        const chunks = run?.end() ?? [];
        this.#run = undefined;
        const operations = await this.#operations(event.inputs);
        return [
          ...this.#chunks(chunks),
          ...(await this.changed()),
          { type: "run-end", operations }
        ];
      }
      default:
        return [];
    }
  }

  /**
   * The messages the entries so far changed: those new or different since
   * last published, or the whole transcript when published messages are
   * gone from it.
   */
  async changed(): Promise<SessionEvent[]> {
    if (this.#stale) {
      this.#stale = false;
      this.#entries = await this.read();
    }
    const transcript = this.transcript();
    const next = digest(transcript);
    const previous = this.#published;
    this.#published = next;
    const replaced = this.#replaced;
    this.#replaced = false;
    // A replacement that only added or changed messages needs no restart.
    if (replaced && [...previous.keys()].some((id) => !next.has(id))) {
      return [{ type: "transcript", messages: transcript }];
    }
    return transcript
      .filter((message) => previous.get(message.id) !== next.get(message.id))
      .map((message) => ({ type: "message", message }));
  }

  /** Track one saved entry in the active transcript. */
  #saved(entry: EntryRecord): void {
    if (entry.kind === "pi.reset") {
      // The context starts over at the reset.
      this.#entries = [entry];
      this.#replaced = true;
      return;
    }
    // Another entry that moves the context's start, or edits earlier
    // entries, such as a compaction: re-read the context once this commit
    // is translated.
    if (entry.head !== undefined || entry.edits !== undefined) {
      this.#stale = true;
    }
    const index = this.#entries.findIndex((e) => e.id === entry.id);
    if (index === -1) this.#entries.push(entry);
    else this.#entries[index] = entry;
  }

  /**
   * After an overflow, the snapshot is all that is known: replace the
   * transcript, and end or start the run where it differs.
   */
  async #caughtUp(
    snapshot: Extract<AgentEvent, { type: "snapshot" }>
  ): Promise<SessionEvent[]> {
    this.#entries = [...snapshot.entries];
    this.#replaced = true;
    const out: SessionEvent[] = [];
    const operations = await this.#operations(snapshot.run?.inputs ?? []);
    const same =
      this.#run !== undefined &&
      snapshot.run !== undefined &&
      this.#run.operations[0] === operations[0];
    if (this.#run && !same) {
      out.push(...this.#chunks(this.#run.chunks.end()));
      out.push({ type: "run-end", operations: this.#run.operations });
      this.#run = undefined;
    }
    if (snapshot.run && !same) {
      out.push({ type: "run-start", operations });
      out.push(
        ...this.#chunks(
          this.attachToRun(operations, snapshot.generation?.message)
        )
      );
    }
    return out;
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

  /** pi submission ids as operation ids, read from pi's storage. */
  async #operations(inputs: readonly SubmissionId[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of inputs) {
      const operation = await this.submissions.operation(id);
      if (operation !== undefined) out.push(operation);
    }
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
