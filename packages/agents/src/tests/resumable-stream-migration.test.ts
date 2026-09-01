import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { getAgentByName } from "..";

/**
 * ResumableStream legacy-table migration.
 *
 * Pre-replatform releases stored chat stream buffers in their own
 * `cf_ai_chat_stream_*` tables (in two on-disk generations: with and without
 * the #1691/#1733 metadata columns). Constructing a Streams-backed
 * `ResumableStream` over a database holding those tables must migrate every
 * row into the Streams capability's tables — preserving the in-flight active
 * stream, both stored chunk formats (plain body and packed segment), and
 * last-activity semantics — then drop the legacy tables. Only a real workerd
 * SQLite can verify the DDL/pragma interplay end to end.
 */

interface LegacyMigrationStub {
  setupLegacyStreamTableForTest(): Promise<void>;
  resumableLegacyMigrationForTest(): Promise<{
    columnsBefore: string[];
    remainingLegacyTables: string[];
    migratedStatus: { status: string; request_id: string } | null;
    migratedChunkBodies: string[];
    migratedLiveCursor: number | null;
    migratedCompletedCursor: number | null;
    legacyMessageId: string | null;
    restoredActiveStreamId: string | null;
    startThrew: boolean;
    newStreamMessageId: string | null;
  }>;
}

async function getAgent(name: string): Promise<LegacyMigrationStub> {
  return getAgentByName(
    env.TestSessionAgent,
    name
  ) as unknown as Promise<LegacyMigrationStub>;
}

describe("ResumableStream — legacy table migration", () => {
  let name: string;
  beforeEach(() => {
    name = `rs-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("migrates legacy tables into the Streams capability on construction", async () => {
    const agent = await getAgent(name);
    await agent.setupLegacyStreamTableForTest();

    const result = await agent.resumableLegacyMigrationForTest();

    // Precondition: the seeded table really is the oldest schema (no
    // message_id / is_continuation columns).
    expect(result.columnsBefore).not.toContain("message_id");
    expect(result.columnsBefore).not.toContain("is_continuation");

    // Construction migrated and dropped the legacy tables.
    expect(result.remainingLegacyTables).toEqual([]);

    // The in-flight row survived with its status, request id, and chunks —
    // the packed segment row unpacked into its individual bodies.
    expect(result.migratedStatus).toEqual({
      status: "streaming",
      request_id: "legacy-req"
    });
    expect(result.migratedChunkBodies).toEqual([
      '{"type":"text-delta","delta":"a"}',
      '{"type":"text-delta","delta":"b"}',
      '{"type":"text-delta","delta":"c"}'
    ]);

    // Both migrated cursors are exact in stored segments (not unpacked
    // bodies): the live row's derived from the imported chunk log, the
    // completed row's stamped at import — nothing settle-stamps it later.
    expect(result.migratedLiveCursor).toBe(2);
    expect(result.migratedCompletedCursor).toBe(1);

    // Reading the post-#1691 field off a pre-#1691 row: guarded → null.
    expect(result.legacyMessageId).toBeNull();

    // restore() adopted the migrated in-flight stream.
    expect(result.restoredActiveStreamId).toBe("legacy-stream");

    // New writes work immediately on the migrated storage.
    expect(result.startThrew).toBe(false);
    expect(result.newStreamMessageId).toBe("msg-1");
  });

  it("chat tag lookups ignore newer non-chat streams sharing the tag", async () => {
    const agent = await getAgentByName(
      env.TestSessionAgent,
      crypto.randomUUID()
    );
    const result = await (
      agent as unknown as {
        chatTagCollisionForTest(): Promise<{
          latest: { id: string; status: string } | null;
          activeId: string | null;
        }>;
      }
    ).chatTagCollisionForTest();

    // The stream table is shared and tags are non-unique: newer application
    // streams with the same tag must not mask chat's recovery evidence.
    expect(result.latest).toEqual({ id: "chat-owned", status: "completed" });
    // The unrelated live stream must not read as a recoverable chat turn.
    expect(result.activeId).toBeNull();
  });
});
