/**
 * Reading chat's stream rows from the Streams capability: which rows are
 * chat's, their chunk bodies one page at a time, and the replays of a
 * request's settled stream to a reconnecting tab.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { Connection } from "agents";
import type { StreamsSyncInternal } from "../streams/streams";
import type { StreamJson, StreamRow } from "../streams/types";
import { sendReplayBodies, sendReplayControl } from "./replay-frames";
import type { ChatStreamMetadata } from "./reply-stream";

/**
 * Stored chunks per page when replaying a stream's chunk log. Bounds
 * replay memory to one page of chunk bodies rather than the whole turn.
 */
const REPLAY_PAGE_CHUNKS = 100;
/**
 * Characters of chunk JSON per replay page: a page stops at the first
 * chunk past it, so a turn of large chunks holds about this much (plus one
 * chunk) at a time, not a hundred of them.
 */
const REPLAY_PAGE_CHARS = 1_000_000;

/** Public status vocabulary predates the Streams state names. */
export type PublicStreamStatus = "streaming" | "completed" | "error";

export function toPublicStatus(state: StreamRow["state"]): PublicStreamStatus {
  return state === "errored" ? "error" : state;
}

export function parseChatMetadata(row: StreamRow): ChatStreamMetadata | null {
  if (row.metadata === null) return null;
  try {
    const parsed = JSON.parse(row.metadata) as Partial<ChatStreamMetadata>;
    if (parsed && parsed.cfChat === 1) return parsed as ChatStreamMetadata;
  } catch {
    // Not chat metadata.
  }
  return null;
}

/**
 * A stored chunk is one chunk body (a JSON string value), or, from a
 * version that packed them, a segment (a JSON array of chunk body
 * strings). Unpack to the individual chunk bodies in order.
 */
export function unpackSegment(rawChunkJson: string): string[] {
  const parsed = JSON.parse(rawChunkJson) as StreamJson;
  if (Array.isArray(parsed)) return parsed as string[];
  return [parsed as string];
}

/**
 * Stored chunk bodies for one stream, packed segments expanded, in order.
 * A generator over paged reads, so replaying a large turn holds one page
 * of segments in memory instead of the whole stored stream; iteration is
 * synchronous end to end (WebSocket sends don't await), so the pages see
 * a consistent log.
 */
export function* storedBodies(
  ops: StreamsSyncInternal,
  streamId: string
): Generator<string> {
  let next = 0;
  for (;;) {
    const rows = ops.readChunks(
      streamId,
      next,
      REPLAY_PAGE_CHUNKS,
      REPLAY_PAGE_CHARS
    );
    for (const row of rows) {
      next = row.seq + 1;
      yield* unpackSegment(row.chunk);
    }
    // A short page is the end, unless the character cap cut it short.
    let chars = 0;
    for (const row of rows) chars += row.chunk.length;
    if (rows.length < REPLAY_PAGE_CHUNKS && chars < REPLAY_PAGE_CHARS) {
      return;
    }
  }
}

/**
 * Latest CHAT-owned row carrying a request tag. The stream table is
 * shared with application producers and tags are non-unique, so the
 * newest row by tag alone could be an unrelated stream masking chat's
 * recovery evidence — ownership is the `cfChat` metadata marker.
 */
export function latestChatRowByTag(
  ops: StreamsSyncInternal,
  requestId: string,
  state?: StreamRow["state"]
): StreamRow | undefined {
  return ops
    .rowsByTag(requestId, state)
    .find((row) => parseChatMetadata(row) !== null);
}

export function replayCompletedChunks(
  ops: StreamsSyncInternal,
  connection: Connection,
  requestId: string
): boolean {
  const row = latestChatRowByTag(ops, requestId, "completed");
  if (!row) return false;
  // Only this stream's buffer: other producers' buffers are theirs.
  ops.flush(row.stream_id);

  const chat = parseChatMetadata(row);
  const continuation = chat?.isContinuation === 1;
  if (
    !sendReplayBodies(
      connection,
      requestId,
      storedBodies(ops, row.stream_id),
      continuation,
      chat?.seqBase,
      chat?.messageId
    )
  ) {
    return false;
  }
  return sendReplayControl(connection, requestId, {
    done: true,
    continuation,
    messageIds: chat?.originMessageIds,
    outcome: chat?.outcome
  });
}

/**
 * Replay the stored chunks of an errored stream for a request, WITHOUT a
 * terminal frame — the caller follows up with the `done: true, error: true`
 * frame carrying the durable terminal record's error text, mirroring what a
 * live client observed (content chunks, then the error). Without this, a
 * client that missed broadcast frames while disconnected has no other
 * channel to the pre-error partial content (#1575).
 *
 * Returns true when the caller should proceed to send its terminal frame:
 * either no errored stream existed (nothing to replay) or its chunks were
 * replayed successfully. Returns false only when a send failed mid-replay,
 * signalling the caller to skip the terminal frame — the connection is gone
 * and the next reconnect retries the whole sequence.
 */
export function replayErroredChunks(
  ops: StreamsSyncInternal,
  connection: Connection,
  requestId: string
): boolean {
  const row = latestChatRowByTag(ops, requestId, "errored");
  if (!row) return true;
  ops.flush(row.stream_id);
  const chat = parseChatMetadata(row);
  return sendReplayBodies(
    connection,
    requestId,
    storedBodies(ops, row.stream_id),
    chat?.isContinuation === 1,
    chat?.seqBase,
    chat?.messageId
  );
}
