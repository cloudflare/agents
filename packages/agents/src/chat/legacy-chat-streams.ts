import type { StreamsSyncInternal } from "../streams/streams";
import type { StreamJson, StreamState } from "../streams/types";
import type { ChatStreamMetadata, SqlTaggedTemplate } from "./resumable-stream";

/** Whether the read succeeds: a `LIMIT 0` read of a missing table throws. */
function exists(read: () => unknown): boolean {
  try {
    read();
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time migration of the pre-capability `cf_ai_chat_stream_*` tables
 * into the Streams tables, preserving in-flight resumability across the
 * upgrade (an active stream keeps its id, chunks, and last-activity), then
 * dropping the legacy tables. Tolerates the pre-#1691/#1733 metadata
 * schema (no `message_id` / `is_continuation` columns). The host `sql`
 * handle touches only these chat-owned legacy tables. The tables are probed
 * with a `LIMIT 0` read, not `sqlite_master` (RUNTIME-FACTS: a missing
 * table throws, an existing one reads no row).
 */
export function importLegacyChatStreams(
  sql: SqlTaggedTemplate,
  ops: StreamsSyncInternal
): void {
  const hasMetadata = exists(
    () => sql`SELECT 1 FROM cf_ai_chat_stream_metadata LIMIT 0`
  );
  const hasChunks = exists(
    () => sql`SELECT 1 FROM cf_ai_chat_stream_chunks LIMIT 0`
  );
  if (!hasMetadata && !hasChunks) return;

  if (hasMetadata) {
    const columns = sql<{ name: string }>`
      SELECT name FROM pragma_table_info('cf_ai_chat_stream_metadata')
    `.map((row) => row.name);
    const hasMessageId = columns.includes("message_id");
    const hasContinuation = columns.includes("is_continuation");

    const rows = sql<{
      id: string;
      request_id: string;
      status: string;
      created_at: number;
      completed_at: number | null;
      message_id?: string | null;
      is_continuation?: number | null;
    }>`SELECT * FROM cf_ai_chat_stream_metadata`;
    for (const row of rows) {
      const streamId = String(row.id);
      if (ops.getStream(streamId)) continue;

      const metadata: ChatStreamMetadata = { cfChat: 1 };
      if (hasMessageId && row.message_id != null) {
        metadata.messageId = String(row.message_id);
      }
      if (hasContinuation && row.is_continuation === 1) {
        metadata.isContinuation = 1;
      }

      const chunkRows = hasChunks
        ? sql<{ body: string; created_at: number }>`
            SELECT body, created_at FROM cf_ai_chat_stream_chunks
            WHERE stream_id = ${streamId} ORDER BY chunk_index ASC
          `
        : [];

      const status = String(row.status);
      const state: StreamState =
        status === "error"
          ? "errored"
          : status === "completed"
            ? "completed"
            : "streaming";
      const createdAt = Number(row.created_at);
      const closedAt =
        row.completed_at != null ? Number(row.completed_at) : null;
      // Preserve last-activity semantics: the legacy sweep keyed off the
      // newest chunk write, falling back to the stream's start time.
      const lastChunkAt = chunkRows.reduce(
        (max, chunk) => Math.max(max, Number(chunk.created_at)),
        createdAt
      );

      // The row is imported complete: final chunk count and last-activity
      // timestamp up front, because importChunk is a bare log INSERT that
      // never touches the stream row. A terminal row must carry its exact
      // cursor at rest (nothing stamps it later), and a live row's
      // updated_at seeds the sweep's coarse cutoff until real appends
      // resume.
      ops.importStream({
        streamId,
        state,
        tag: String(row.request_id),
        metadata,
        chunkCount: chunkRows.length,
        createdAt,
        updatedAt: closedAt ?? lastChunkAt,
        closedAt
      });
      for (const chunk of chunkRows) {
        const body = String(chunk.body);
        // A legacy row body is either a packed JSON array of chunk bodies
        // (imported verbatim as that array) or a single opaque body string.
        let value: StreamJson = body;
        try {
          const parsed = JSON.parse(body) as StreamJson;
          if (Array.isArray(parsed)) value = parsed;
        } catch {
          // Opaque body string.
        }
        ops.importChunk(streamId, value, Number(chunk.created_at));
      }
    }
  }

  sql`DROP TABLE IF EXISTS cf_ai_chat_stream_chunks`;
  sql`DROP TABLE IF EXISTS cf_ai_chat_stream_metadata`;
}
