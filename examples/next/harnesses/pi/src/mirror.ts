import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type ConversationView,
  type EntryId,
  type EntryQuery,
  type TranscriptView
} from "@earendil-works/pi-durable";
import type {
  PiClientMessage,
  PiEntriesPage,
  PiServerMessage
} from "./protocol";
import { EMPTY_VIEW, projectView, type PiSessionView } from "./view";

/** Entries one "load earlier" or "load missing" asks the server for. */
const PAGE_SIZE = 50;

type PendingPage = {
  readonly resolve: (page: PiEntriesPage) => void;
  readonly reject: (error: Error) => void;
};

/** Send a message on the socket. */
export type PiSend = (message: PiClientMessage) => void;

/**
 * The client's copy of one session, over this app's socket protocol: pi's
 * conversation view, kept current from the server's `view` and `ops`
 * frames, merged into a `ConversationTranscript` that keeps every entry
 * the client has seen, beyond the view's window. Earlier entries, and
 * entries a stall or reconnect skipped, load on demand with `entries`
 * requests. Pure state, no React, so the browser hook and the tests run
 * the same code.
 */
export class PiSessionMirror {
  readonly #onChange: (view: PiSessionView) => void;
  /** The open socket's send, between `open()` and `close()`. */
  #send: PiSend | undefined;
  readonly #transcript: ConversationTranscript;
  readonly #pages = new Map<string, PendingPage>();
  /** pi's view as the server last sent it; the operations apply to it. */
  #view: ConversationView | null = null;
  #projected: PiSessionView = EMPTY_VIEW;

  /** `onChange`: the projected view changed. */
  constructor(onChange: (view: PiSessionView) => void) {
    this.#onChange = onChange;
    this.#transcript = new ConversationTranscript(
      (query) => this.#loadPage(query),
      { pageSize: PAGE_SIZE }
    );
  }

  get view(): PiSessionView {
    return this.#projected;
  }

  /**
   * A socket opened: ask to watch the session, after the newest entry the
   * transcript has, so a reconnect gets only what it missed.
   */
  open(send: PiSend): void {
    this.#send = send;
    const from = this.#transcript.resume?.from;
    send({ type: "watch", ...(from === undefined ? {} : { from }) });
  }

  /** The socket closed: pages it was loading will not arrive. */
  close(): void {
    this.#send = undefined;
    const pages = [...this.#pages.values()];
    this.#pages.clear();
    for (const page of pages) page.reject(new Error("Disconnected"));
  }

  /** Take one server message. */
  receive(message: PiServerMessage): void {
    switch (message.type) {
      case "view":
        this.#view = message.view;
        this.#show(this.#transcript.merge(this.#view));
        return;
      case "ops":
        // Operations without a view to apply to: wait for the next view.
        if (this.#view === null) return;
        this.#view = applyImmutable(this.#view, message.ops);
        this.#show(this.#transcript.merge(this.#view));
        return;
      case "result":
      case "error":
        this.#settlePage(message);
        return;
      default:
        return;
    }
  }

  /** Load the page before the oldest message shown. */
  async loadEarlier(): Promise<void> {
    if (!this.#projected.earlier) return;
    this.#show(await this.#transcript.loadEarlier(BACKGROUND_CONTEXT));
  }

  /** Load the next page of a gap, a `gap` message of the view. */
  async fillGap(gap: { after: EntryId; upTo: EntryId }): Promise<void> {
    this.#show(
      await this.#transcript.fillGap(
        { kind: "gap", after: gap.after, upTo: gap.upTo },
        BACKGROUND_CONTEXT
      )
    );
  }

  #show(view: TranscriptView): void {
    const projected = projectView(view);
    this.#projected = projected;
    this.#onChange(projected);
  }

  #loadPage(query: Omit<EntryQuery, "conversationId">): Promise<PiEntriesPage> {
    const id = crypto.randomUUID();
    const send = this.#send;
    if (send === undefined) return Promise.reject(new Error("Disconnected"));
    return new Promise((resolve, reject) => {
      this.#pages.set(id, { resolve, reject });
      send({ type: "entries", id, query, limit: PAGE_SIZE });
    });
  }

  #settlePage(
    message: Extract<PiServerMessage, { type: "result" | "error" }>
  ): void {
    if (message.id === undefined) return;
    const page = this.#pages.get(message.id);
    if (page === undefined) return;
    this.#pages.delete(message.id);
    if (message.type === "error") page.reject(new Error(message.message));
    else page.resolve(message.result as PiEntriesPage);
  }
}
