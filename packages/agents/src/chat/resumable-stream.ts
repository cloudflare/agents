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

/**
 * @deprecated Kept for `@cloudflare/ai-chat` 0.12.x and `@cloudflare/think`
 * 0.24.x, which construct it. Upgrade them together with `agents`.
 */
export class ResumableStream extends ReplyStreams {
  /**
   * @param options Released hosts pass `{ onProgress }` here, which nothing
   *   reads any more; a function is the facet check.
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
      typeof options === "function" ? options : () => false
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
}
