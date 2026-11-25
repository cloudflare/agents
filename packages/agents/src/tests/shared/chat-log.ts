import { ReplyStreams, type SqlTaggedTemplate } from "../../chat";
import type { Streams } from "../../streams/streams";

/**
 * A chat stream log opened on `streams`, as a chat host opens its own, with
 * no host around it: `origins` stands in for the request's user message ids.
 */
export function openChatLog(
  streams: Streams,
  sql: SqlTaggedTemplate,
  isFacet: () => boolean = () => false,
  origins: Record<string, string[]> = {}
): ReplyStreams {
  const log = new ReplyStreams({
    streamStarted() {},
    streamEnded() {},
    originMessageIds: (requestId) => origins[requestId],
    transaction: (fn) => fn()
  });
  log.open(streams, sql, isFacet);
  return log;
}
