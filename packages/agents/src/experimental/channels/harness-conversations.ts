import type {
  AgentHarness,
  HarnessSession,
  InputPart,
  OperationStatus,
  SessionEvent,
  SessionWatch
} from "./harness";
import type {
  ConversationInfo,
  ConversationOperation,
  ConversationSnapshot,
  EventOrigin,
  InboundEvent,
  ResponseChunk,
  TranscriptMessage,
  TurnStatus
} from "./protocol";
import type { ResponseWriter } from "./response";

/** An inbound event acting in a conversation, rather than on it. */
export type TurnEvent = Exclude<InboundEvent, { type: ConversationOperation }>;

export function isTurnEvent(event: InboundEvent): event is TurnEvent {
  return (
    event.type !== "conversation-create" &&
    event.type !== "conversation-fork" &&
    event.type !== "conversation-reset"
  );
}

/** What harness conversations need from Channels. */
export type HarnessConversationsHost = {
  /** Read once installed; Channels has no storage when constructed. */
  kv(): SyncKvStorage;
  openResponse(conversationId: string, turnId: string): Promise<ResponseWriter>;
  publishTurn(conversationId: string, turn: TurnStatus): Promise<void>;
  publishMessages(
    conversationId: string,
    messages: TranscriptMessage[]
  ): Promise<void>;
  reset(conversationId: string): Promise<void>;
};

/**
 * A turn record: its status, the user message it answers, and the operation
 * driving it now. A turn starts with its own operation (same id); each tool
 * answer that continues it is a new operation, aliased to the turn.
 */
type Turn = TurnStatus & { messageId: string; operation?: string };

const PREFIX = "channels:harness:";

/**
 * Serves harness sessions as Channels conversations: the conversation id is
 * the session id, a turn is one operation (its id is the inbound message's
 * event id), and a run is one response. Operations that join a running run
 * (steers) share its response.
 *
 * The harness owns the transcript. Turn records live in storage; each
 * watched session's transcript is held in memory, from the watch's state
 * and the messages that follow it.
 */
export class HarnessConversations {
  readonly #harness: AgentHarness;
  readonly #host: HarnessConversationsHost;
  readonly #links = new Map<string, Promise<SessionLink>>();

  constructor(harness: AgentHarness, host: HarnessConversationsHost) {
    this.#harness = harness;
    this.#host = host;
  }

  /** The conversation a surface joins when it names none. */
  defaultConversation(): string {
    return this.#harness.session().id;
  }

  /** Follow every session a surface has joined. Call from `onStart`. */
  async attachAll(): Promise<void> {
    const sessions = this.#host
      .kv()
      .list<true>({ prefix: `${PREFIX}session:` });
    await Promise.all(
      [...sessions].map(([key]) =>
        this.#link(key.slice(`${PREFIX}session:`.length)).catch((error) =>
          console.error("Failed to follow a harness session", error)
        )
      )
    );
  }

  async snapshot(conversationId: string): Promise<ConversationSnapshot> {
    const link = await this.#link(conversationId);
    return {
      messages: [...link.messages],
      turns: this.#turns(conversationId).filter(isOpen)
    };
  }

  async onEvent(event: TurnEvent, origin: EventOrigin): Promise<void> {
    const conversationId = origin.conversationId;
    const link = await this.#link(conversationId);
    switch (event.type) {
      case "message": {
        if (!this.#turnRecord(conversationId, event.eventId)) {
          await this.#save(conversationId, {
            turnId: event.eventId,
            startedBy: event.eventId,
            messageId: event.message.id,
            status: "queued"
          });
        }
        // The harness deduplicates by operation id, so redelivery is harmless.
        await link.session.submit(
          {
            parts: inputParts(event.message),
            messageId: event.message.id,
            from: { participantId: origin.participant.id }
          },
          { operationId: event.eventId }
        );
        return;
      }
      case "tool-result":
      case "approval-response": {
        // The harness decides whether the answer is wanted and whose it is.
        const turn = this.#turnRecord(conversationId, event.turnId);
        if (!turn) return;
        const operationId = event.eventId;
        this.#host.kv().put(aliasKey(conversationId, operationId), turn.turnId);
        await link.session.submit(
          {
            ...(event.type === "tool-result"
              ? {
                  type: "tool-result" as const,
                  toolCallId: event.toolCallId,
                  result: event.result
                }
              : {
                  type: "approval" as const,
                  approvalId: event.approvalId,
                  approved: event.approved,
                  ...(event.reason !== undefined && { reason: event.reason })
                }),
            from: { participantId: origin.participant.id }
          },
          { operationId }
        );
        return;
      }
      case "cancel": {
        const turn = this.#turnRecord(conversationId, event.turnId);
        await link.session.abort(turn?.operation ?? event.turnId);
        return;
      }
    }
  }

  /** Every session, as conversations. */
  async list(): Promise<ConversationInfo[]> {
    const sessions = await this.#harness.sessions.list();
    return sessions.map(({ id, parent, busy }) => ({
      id,
      busy,
      ...(parent !== undefined && { parent })
    }));
  }

  /** Create a session; a conversation operation. */
  async create(): Promise<string> {
    const session = await this.#harness.sessions.create();
    await this.#link(session.id);
    return session.id;
  }

  /** Fork a session; a conversation operation. */
  async fork(from: string): Promise<string> {
    const session = await this.#harness.sessions.fork(from);
    await this.#link(session.id);
    return session.id;
  }

  /** Reset a session's context; the watch reports it as a `reset` event. */
  async reset(conversationId: string, handoff?: string): Promise<void> {
    const link = await this.#link(conversationId);
    await link.session.reset(handoff);
  }

  // ── Following a session ────────────────────────────────────────────────

  #link(conversationId: string): Promise<SessionLink> {
    let link = this.#links.get(conversationId);
    if (!link) {
      const attached: Promise<SessionLink> = this.#attach(conversationId).then(
        (linked) => {
          // A closed watch is followed again on next use.
          void linked.watch.closed.then(() => {
            if (this.#links.get(conversationId) === attached) {
              this.#links.delete(conversationId);
            }
          });
          return linked;
        },
        (error: unknown) => {
          this.#links.delete(conversationId);
          throw error;
        }
      );
      link = attached;
      this.#links.set(conversationId, link);
    }
    return link;
  }

  async #attach(conversationId: string): Promise<SessionLink> {
    const session = this.#harness.session(conversationId);
    const watch = await session.watch();
    this.#host.kv().put(`${PREFIX}session:${conversationId}`, true);
    const link = new SessionLink(session, watch);
    await this.#resume(conversationId, link);
    watch.start((events) => this.#onEvents(conversationId, link, events));
    return link;
  }

  /** Catch up from the watch's state, after an attach or a restart. */
  async #resume(conversationId: string, link: SessionLink): Promise<void> {
    const { state } = link.watch;
    const live = new Set(state.pending.map((p) => p.operationId));
    for (const status of state.pending) {
      await this.#operation(conversationId, link, status);
    }
    if (state.run) {
      for (const id of state.run.operations) live.add(id);
      await this.#runStart(conversationId, link, state.run.operations);
      // The output so far; the watch's chunks continue its open parts.
      for (const chunk of state.run.partial ?? []) link.append(chunk);
    }
    // Turns that settled while nothing was watching.
    for (const turn of this.#turns(conversationId)) {
      const operationId = turn.operation ?? turn.turnId;
      if (turn.status === "settled" || live.has(operationId)) continue;
      void link.session.wait(operationId).then(
        (result) =>
          this.#operation(conversationId, link, result).catch((error) =>
            console.error("Failed to settle a turn", error)
          ),
        (error) => console.error("Failed to settle a turn", error)
      );
    }
  }

  async #onEvents(
    conversationId: string,
    link: SessionLink,
    events: readonly SessionEvent[]
  ): Promise<void> {
    for (const event of events) {
      try {
        await this.#onEvent(conversationId, link, event);
      } catch (error) {
        console.error("Harness event failed", event.type, error);
      }
    }
  }

  async #onEvent(
    conversationId: string,
    link: SessionLink,
    event: SessionEvent
  ): Promise<void> {
    switch (event.type) {
      case "operation":
        return this.#operation(conversationId, link, event.status);
      case "run-start":
        return this.#runStart(conversationId, link, event.operations);
      case "chunk":
        link.append(event.chunk);
        return;
      case "message":
        link.upsert(event.message);
        await this.#host.publishMessages(conversationId, [event.message]);
        return;
      case "run-end":
        link.endResponse();
        return;
      case "reset":
        link.endResponse();
        link.messages = [];
        await this.#host.reset(conversationId);
        return;
    }
  }

  async #runStart(
    conversationId: string,
    link: SessionLink,
    operations: readonly string[]
  ): Promise<void> {
    link.endResponse();
    const queued = this.#turns(conversationId).find(
      (t) => t.status === "queued"
    );
    const first = operations[0] ?? queued?.operation ?? queued?.turnId;
    if (first === undefined) return;
    const turn = this.#turn(conversationId, first);
    if (!turn) return;
    link.response = await this.#host.openResponse(conversationId, turn.turnId);
    // A run that answers a tool call continues the message that made it.
    const last = link.messages.at(-1);
    link.extends =
      turn.turnId !== first && last?.role === "assistant" ? last.id : undefined;
    for (const id of operations.length ? operations : [first]) {
      await this.#join(conversationId, link, id);
    }
  }

  async #operation(
    conversationId: string,
    link: SessionLink,
    status: OperationStatus
  ): Promise<void> {
    const { operationId } = status;
    const turn = this.#turn(conversationId, operationId);
    switch (status.status) {
      case "queued":
        // An operation a client of the harness itself submitted.
        if (!turn) {
          await this.#save(conversationId, {
            turnId: operationId,
            startedBy: operationId,
            messageId: operationId,
            status: "queued"
          });
        } else if (turn.turnId !== operationId && turn.status === "settled") {
          // A tool answer reopens the turn it answers.
          await this.#save(conversationId, {
            turnId: turn.turnId,
            startedBy: turn.startedBy,
            messageId: turn.messageId,
            operation: operationId,
            status: "queued"
          });
        }
        return;
      case "placed":
        // A steer joins the running run.
        return this.#join(conversationId, link, operationId);
      case "done":
        return this.#settle(conversationId, link, operationId, {
          outcome: "completed"
        });
      case "unanswered": {
        const stopped =
          status.reason === "aborted" || status.reason === "withdrawn";
        // A refused tool answer (not the owner's, or not wanted) leaves the
        // turn as it was: still waiting, if its calls are.
        const refusedAnswer =
          turn !== undefined && turn.turnId !== operationId && !stopped;
        return this.#settle(
          conversationId,
          link,
          operationId,
          stopped
            ? { outcome: "aborted" }
            : refusedAnswer
              ? { outcome: "completed" }
              : {
                  outcome: "failed",
                  error: `Not answered${status.reason ? `: ${status.reason}` : ""}`
                }
        );
      }
    }
  }

  async #join(
    conversationId: string,
    link: SessionLink,
    operationId: string
  ): Promise<void> {
    const turn = this.#turn(conversationId, operationId);
    if (!turn || !link.response) return;
    const answer = turn.turnId !== operationId;
    // A settled turn runs again only for a tool answer.
    if (turn.status === "settled" && !answer) return;
    if (turn.status === "running" && turn.responseId === link.response.id) {
      return;
    }
    await this.#save(conversationId, {
      turnId: turn.turnId,
      startedBy: turn.startedBy,
      messageId: turn.messageId,
      ...(answer && { operation: operationId }),
      status: "running",
      responseId: link.response.id,
      ...(link.extends !== undefined && { extends: link.extends })
    });
  }

  async #settle(
    conversationId: string,
    link: SessionLink,
    operationId: string,
    end:
      | { outcome: "completed" | "aborted" }
      | { outcome: "failed"; error: string }
  ): Promise<void> {
    const turn = this.#turn(conversationId, operationId);
    if (!turn || turn.status === "settled") return;
    // Only the operation driving the turn settles it.
    if ((turn.operation ?? turn.turnId) !== operationId) return;
    // The turn's messages are what follows its user message.
    const start = link.messages.findIndex((m) => m.id === turn.messageId);
    const messageIds: string[] = [];
    for (const message of start === -1 ? [] : link.messages.slice(start + 1)) {
      if (message.role === "user") break;
      messageIds.push(message.id);
    }
    // Completed with a tool call still unanswered: the turn waits for it.
    const waiting =
      end.outcome === "completed" &&
      link.messages.some(
        (message) => messageIds.includes(message.id) && awaitsInput(message)
      );
    await this.#save(conversationId, {
      turnId: turn.turnId,
      startedBy: turn.startedBy,
      messageId: turn.messageId,
      ...(turn.operation !== undefined && { operation: turn.operation }),
      status: "settled",
      messageIds,
      ...(waiting ? { outcome: "awaiting-input" as const } : end)
    });
  }

  // ── Turn records ───────────────────────────────────────────────────────

  async #save(conversationId: string, turn: Turn): Promise<void> {
    this.#host.kv().put(turnKey(conversationId, turn.turnId), turn);
    await this.#host.publishTurn(conversationId, turn);
  }

  #turnRecord(conversationId: string, turnId: string): Turn | undefined {
    return this.#host.kv().get<Turn>(turnKey(conversationId, turnId));
  }

  /** The turn an operation belongs to: its own, or the one it answers. */
  #turn(conversationId: string, operationId: string): Turn | undefined {
    const turnId =
      this.#host.kv().get<string>(aliasKey(conversationId, operationId)) ??
      operationId;
    return this.#turnRecord(conversationId, turnId);
  }

  #turns(conversationId: string): Turn[] {
    const prefix = turnKey(conversationId, "");
    return [...this.#host.kv().list<Turn>({ prefix })].map(([, turn]) => turn);
  }
}

/** One watched session: its transcript and the response of its run. */
class SessionLink {
  messages: TranscriptMessage[];
  response: ResponseWriter | undefined;
  /** The saved message the run's response continues, if any. */
  extends: string | undefined;

  constructor(
    readonly session: HarnessSession,
    readonly watch: SessionWatch
  ) {
    this.messages = [...watch.state.messages];
  }

  upsert(message: TranscriptMessage): void {
    const index = this.messages.findIndex((m) => m.id === message.id);
    if (index === -1) this.messages.push(message);
    else this.messages[index] = message;
  }

  append(chunk: ResponseChunk): void {
    try {
      this.response?.append(chunk);
    } catch (error) {
      console.warn("Dropped a harness chunk", chunk.type, error);
    }
  }

  endResponse(): void {
    this.response?.end();
    this.response = undefined;
    this.extends = undefined;
  }
}

function turnKey(conversationId: string, turnId: string): string {
  // The quoted id keeps one conversation's prefix from matching another's.
  return `${PREFIX}turn:${JSON.stringify(conversationId)}:${turnId}`;
}

function aliasKey(conversationId: string, operationId: string): string {
  return `${PREFIX}alias:${JSON.stringify(conversationId)}:${operationId}`;
}

/** Whether the message has a tool call waiting for a result or approval. */
function awaitsInput(message: TranscriptMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === "tool" &&
      (part.state === "input-available" || part.state === "approval-requested")
  );
}

function isOpen(turn: TurnStatus): boolean {
  return turn.status !== "settled" || turn.outcome === "awaiting-input";
}

function inputParts(message: TranscriptMessage): InputPart[] {
  return message.parts.flatMap((part): InputPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "file") {
      return [
        {
          type: "file",
          mediaType: part.mediaType,
          url: part.url,
          ...(part.filename !== undefined && { filename: part.filename })
        }
      ];
    }
    return [];
  });
}
