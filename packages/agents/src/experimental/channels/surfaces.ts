import type {
  ChannelChunkSource,
  ChannelStreamOptions,
  DeliveryResult
} from "./channel";
import type {
  ChannelsHost,
  ConversationChannel,
  ConversationUpdate
} from "./conversations";
import type {
  EventOrigin,
  Json,
  ResponseChunk,
  ToolPart,
  TranscriptMessage,
  TurnStatus
} from "./protocol";
import { messageChunks } from "./stream";
import type { ChannelMessageSurface } from "./surface";

/** A tool call waiting for approval, as a surface shows it. */
export type SurfaceApproval = {
  approvalId: string;
  toolName: string;
  input: Json;
  title?: string;
};

/** How a chat platform shows a conversation. Each Channel supplies these. */
export type SurfaceRenderer = {
  /**
   * Show one response, streamed where the platform can. Call `onStarted`
   * with a reference once a platform message exists, so a response cut
   * short by an eviction can be closed off later.
   */
  stream(
    surface: ChannelMessageSurface,
    chunks: ChannelChunkSource,
    options: ChannelStreamOptions & { onStarted?(reference: string): void }
  ): Promise<DeliveryResult>;
  /** Close off a response an earlier instance left streaming. */
  interrupt?(surface: ChannelMessageSurface, reference: string): Promise<void>;
  /** Ask for an approval. The delivered reference marks it answered later. */
  requestApproval?(
    surface: ChannelMessageSurface,
    approval: SurfaceApproval
  ): Promise<DeliveryResult>;
  /** Show that an approval was answered. */
  answerApproval?(
    surface: ChannelMessageSurface,
    reference: string,
    approval: SurfaceApproval & { approved: boolean }
  ): Promise<void>;
  /** Quote a message from another surface above a response. */
  quote?(name: string, text: string): string;
};

type Placed = { surface: ChannelMessageSurface; reference: string };
type Quote = { name: string; text: string; surface: ChannelMessageSurface };

/**
 * Shows every turn of a conversation on each of a chat platform's surfaces
 * that joined it: each response as its own message, a message from another
 * surface quoted above its response, and approvals that are marked once
 * answered.
 */
export class ConversationSurfaces implements ConversationChannel {
  readonly #renderer: SurfaceRenderer;
  #host: ChannelsHost | undefined;
  /** Responses this instance is showing. */
  readonly #showing = new Set<string>();
  /** Inbound messages by event id, to quote above their turn's response. */
  readonly #quotes = new Map<string, Quote>();
  readonly #approving = new Set<string>();

  constructor(renderer: SurfaceRenderer) {
    this.#renderer = renderer;
  }

  mount(host: ChannelsHost): void {
    if (this.#host) throw new Error("A Channel can be mounted only once");
    this.#host = host;
  }

  async publish(
    conversationId: string,
    update: ConversationUpdate
  ): Promise<void> {
    switch (update.type) {
      case "messages":
        if (update.origin && update.eventId) {
          this.#remember(update.eventId, update.messages, update.origin);
        } else await this.#approvals(conversationId, update.messages);
        return;
      case "turn":
        return this.#turn(conversationId, update.turn);
      case "response-end":
        if (update.ending === "interrupted") {
          await this.#interrupt(update.responseId);
        }
        return;
      case "reset":
        return;
    }
  }

  #remember(
    eventId: string,
    messages: TranscriptMessage[],
    origin: EventOrigin
  ): void {
    const text = messages
      .flatMap((message) => message.parts)
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ");
    this.#quotes.set(eventId, {
      name: origin.participant.name ?? origin.participant.id,
      text,
      surface: origin.surface
    });
  }

  async #turn(conversationId: string, turn: TurnStatus): Promise<void> {
    if (turn.status === "settled") {
      this.#quotes.delete(turn.startedBy);
      if (turn.outcome === "failed") {
        const text = turn.error ?? "The turn failed.";
        for (const surface of await this.#mounted().surfaces(conversationId)) {
          void this.#renderer
            .stream(surface, messageChunks(text), {})
            .catch(logFailure);
        }
      }
      return;
    }
    if (turn.status !== "running" || this.#showing.has(turn.responseId)) {
      return;
    }
    const { responseId } = turn;
    this.#showing.add(responseId);
    // A continuation follows its own earlier message, so only the turn's
    // first response quotes the message that started it.
    const quote = turn.extends ? undefined : this.#quotes.get(turn.startedBy);
    const surfaces = await this.#mounted().surfaces(conversationId);
    const shown = surfaces.map((surface) =>
      this.#renderer
        .stream(
          surface,
          this.#response(conversationId, responseId, surface, quote),
          {
            onStarted: (reference) =>
              this.#placed(responseId, surface, reference)
          }
        )
        .catch(logFailure)
    );
    void Promise.all(shown).finally(() => {
      this.#showing.delete(responseId);
      this.#mounted().state.delete(`response:${responseId}`);
    });
  }

  /** A response's chunks, with a quote first when it came from elsewhere. */
  #response(
    conversationId: string,
    responseId: string,
    surface: ChannelMessageSurface,
    quote: Quote | undefined
  ): ChannelChunkSource {
    const host = this.#mounted();
    const abort = new AbortController();
    const quoted =
      quote && !sameSurface(quote.surface, surface)
        ? (this.#renderer.quote ?? defaultQuote)(quote.name, quote.text)
        : undefined;
    return new ReadableStream<ResponseChunk>({
      start(controller) {
        if (quoted) {
          const id = `quote:${responseId}`;
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, delta: quoted });
          controller.enqueue({ type: "text-end", id });
        }
        host
          .readResponse(conversationId, responseId, {
            signal: abort.signal,
            onChunks: (_from, chunks) => {
              for (const chunk of chunks) controller.enqueue(chunk);
            },
            onCaughtUp: () => {}
          })
          .then(
            (ending) => {
              if (ending === "ended") controller.close();
              else controller.error(new Error(`Response ${ending}`));
            },
            (error: unknown) => controller.error(error)
          );
      },
      cancel: () => abort.abort()
    });
  }

  #placed(
    responseId: string,
    surface: ChannelMessageSurface,
    reference: string
  ): void {
    const state = this.#mounted().state;
    const key = `response:${responseId}`;
    const placed = state.get<Placed[]>(key) ?? [];
    state.put(key, [...placed, { surface, reference }]);
  }

  /** Close off messages an earlier instance left streaming. */
  async #interrupt(responseId: string): Promise<void> {
    if (this.#showing.has(responseId)) return;
    const state = this.#mounted().state;
    const key = `response:${responseId}`;
    for (const { surface, reference } of state.get<Placed[]>(key) ?? []) {
      await this.#renderer.interrupt?.(surface, reference).catch(logFailure);
    }
    state.delete(key);
  }

  /** Ask for new approvals, and mark answered ones, on every surface. */
  async #approvals(
    conversationId: string,
    messages: TranscriptMessage[]
  ): Promise<void> {
    const { requestApproval, answerApproval } = this.#renderer;
    if (!requestApproval) return;
    const state = this.#mounted().state;
    for (const part of messages.flatMap((message) => message.parts)) {
      if (part.type !== "tool" || !part.approval) continue;
      const approval: SurfaceApproval = {
        approvalId: part.approval.id,
        toolName: part.toolName,
        input: part.input ?? null,
        ...(part.title !== undefined && { title: part.title })
      };
      const key = `approval:${approval.approvalId}`;
      if (this.#approving.has(key)) continue;
      const placed = state.get<Placed[]>(key);

      if (part.state === "approval-requested") {
        if (placed) continue;
        this.#approving.add(key);
        try {
          const asked: Placed[] = [];
          for (const surface of await this.#mounted().surfaces(
            conversationId
          )) {
            const result = await requestApproval(surface, approval);
            if (result.status === "delivered" && result.reference) {
              asked.push({ surface, reference: result.reference });
            }
          }
          state.put(key, asked);
        } finally {
          this.#approving.delete(key);
        }
      } else if (placed) {
        state.delete(key);
        for (const { surface, reference } of placed) {
          await answerApproval?.(surface, reference, {
            ...approval,
            approved: approvedIn(part)
          }).catch(logFailure);
        }
      }
    }
  }

  #mounted(): ChannelsHost {
    if (!this.#host) throw new Error("The Channel is not mounted");
    return this.#host;
  }
}

function approvedIn(part: ToolPart): boolean {
  return part.approval?.approved ?? part.state !== "output-denied";
}

function sameSurface(a: ChannelMessageSurface, b: ChannelMessageSurface) {
  return (
    a.channelKey === b.channelKey &&
    JSON.stringify(a.address) === JSON.stringify(b.address)
  );
}

function defaultQuote(name: string, text: string): string {
  const lines = `${name}: ${text}`.split("\n").map((line) => `> ${line}`);
  return `${lines.join("\n")}\n\n`;
}

function logFailure(error: unknown): void {
  console.error("Failed to show a conversation on a surface", error);
}
