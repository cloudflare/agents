/**
 * `ResumableStream`, kept for released hosts only.
 *
 * `@cloudflare/ai-chat` 0.12.x and `@cloudflare/think` 0.24.x construct it
 * from `agents/chat`, and their `agents` ranges admit this version. Chat
 * itself writes through {@link ReplyStreams}; this class is a
 * {@link ReplyStreams} with no host around it, opened by its constructor as
 * those hosts expect. Deleted when support for those releases ends.
 */

import type { Streams } from "../streams/streams";
import {
  ReplyStreams,
  type ReplyStreamStart,
  type SqlTaggedTemplate
} from "./reply-stream";
import { parseChatMetadata } from "./stream-rows";
import type { ChatTurnOutcome } from "./wire-types";

/** Deleted streams whose end a released host's late resume can still read. */
const REMEMBERED_ENDS = 32;

/**
 * @deprecated Kept for `@cloudflare/ai-chat` 0.12.x and `@cloudflare/think`
 * 0.24.x, which construct it. Upgrade them together with `agents`.
 */
export class ResumableStream extends ReplyStreams {
  /**
   * The ids and outcome of recently deleted streams, by request. Released
   * hosts record no terminal frames, so as in their release a late resume
   * after the rows are gone reads them here.
   */
  readonly #ended = new Map<
    string,
    { messageIds?: string[]; outcome?: ChatTurnOutcome }
  >();

  /**
   * @param options Released hosts pass `{ onProgress }` here, which nothing
   *   reads any more. Without the facet check, the legacy tables are
   *   emptied rather than dropped, which is safe at the root and in a facet.
   */
  constructor(
    streams: Streams,
    sql: SqlTaggedTemplate,
    options?: (() => boolean) | { onProgress?: unknown }
  ) {
    super({
      streamStarted() {},
      streamEnded() {},
      originMessageIds: () => undefined,
      transaction: (fn) => fn()
    });
    this.open(
      streams,
      sql,
      typeof options === "function" ? options : () => true
    );
  }

  /** Released hosts pass the request's user message ids here. */
  override start(
    requestId: string,
    options: ReplyStreamStart & { originMessageIds?: string[] } = {}
  ): string {
    return super.start(requestId, options);
  }

  /** Mark a stream errored, as released hosts call it. */
  markError(streamId: string): void {
    this.error(streamId);
  }

  override cutover(
    streamId: string,
    persist: () => void,
    options: { discard?: boolean } = {}
  ): void {
    const row = this.streamOps.getStream(streamId);
    super.cutover(streamId, persist, options);
    if (row && !this.streamOps.getStream(streamId)) this.#remember([row]);
  }

  override reclaim(now?: number): number {
    const before = this.streamOps.listRows();
    const reclaimed = super.reclaim(now);
    if (reclaimed > 0) {
      this.#remember(
        before.filter((row) => !this.streamOps.getStream(row.stream_id))
      );
    }
    return reclaimed;
  }

  override clearAll(): void {
    super.clearAll();
    this.#ended.clear();
  }

  override getOriginMessageIds(requestId: string): string[] | undefined {
    return (
      super.getOriginMessageIds(requestId) ??
      this.#ended.get(requestId)?.messageIds
    );
  }

  override getOutcome(requestId: string): ChatTurnOutcome | undefined {
    return super.getOutcome(requestId) ?? this.#ended.get(requestId)?.outcome;
  }

  #remember(rows: ReturnType<typeof this.streamOps.listRows>): void {
    for (const row of rows) {
      const chat = parseChatMetadata(row);
      if (!row.tag || !chat || (!chat.originMessageIds && !chat.outcome)) {
        continue;
      }
      this.#ended.delete(row.tag);
      this.#ended.set(row.tag, {
        messageIds: chat.originMessageIds,
        outcome: chat.outcome
      });
      if (this.#ended.size > REMEMBERED_ENDS) {
        const oldest = this.#ended.keys().next().value;
        if (oldest !== undefined) this.#ended.delete(oldest);
      }
    }
  }
}
