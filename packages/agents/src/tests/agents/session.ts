import { Agent } from "../../index";
import { ResumableStream, createChatStreams } from "../../chat";

/** Test Agent retained for ResumableStream legacy migration coverage. */
export class TestSessionAgent extends Agent {
  readonly streams = createChatStreams();

  constructor(...args: ConstructorParameters<typeof Agent>) {
    super(...args);
    this.lifecycle.use(this.streams);
  }

  // ── ResumableStream legacy migration helpers ────────────────────

  /**
   * Recreate `cf_ai_chat_stream_metadata` with the pre-#1691/#1733 schema
   * (no `message_id` / `is_continuation`) and seed one in-flight row, so a
   * fresh `ResumableStream` exercises the legacy lazy-migration path on a
   * real workerd SQLite (validates the runtime's actual error strings).
   */
  async setupLegacyStreamTableForTest(): Promise<void> {
    this.sql`drop table if exists cf_ai_chat_stream_metadata`;
    this.sql`drop table if exists cf_ai_chat_stream_chunks`;
    this.sql`create table cf_ai_chat_stream_metadata (
      id text primary key,
      request_id text not null,
      status text not null,
      created_at integer not null,
      completed_at integer
    )`;
    this
      .sql`insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values ('legacy-stream', 'legacy-req', 'streaming', ${Date.now()})`;
    this.sql`create table cf_ai_chat_stream_chunks (
      id text primary key,
      stream_id text not null,
      body text not null,
      chunk_index integer not null,
      created_at integer not null
    )`;
    // One plain body row and one packed segment row, so the migration must
    // preserve both stored formats.
    this
      .sql`insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
      values ('c0', 'legacy-stream', ${'{"type":"text-delta","delta":"a"}'}, 0, ${Date.now()})`;
    this
      .sql`insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
      values ('c1', 'legacy-stream', ${JSON.stringify(['{"type":"text-delta","delta":"b"}', '{"type":"text-delta","delta":"c"}'])}, 1, ${Date.now()})`;
  }

  /**
   * Prove chat tag lookups ignore non-chat streams sharing a tag: seed one
   * chat-owned completed stream for a request, then NEWER application
   * streams with the same tag (one streaming, one completed), and report
   * what the chat lookups observe.
   */
  async chatTagCollisionForTest(): Promise<{
    latest: { id: string; status: string } | null;
    activeId: string | null;
  }> {
    const requestId = "collide-req";
    const chat = await this.streams.open("chat-owned", {
      tag: requestId,
      metadata: { cfChat: 1 }
    });
    chat.append(JSON.stringify({ type: "text-delta", delta: "hi" }));
    chat.close();
    // Newer unrelated application streams sharing the tag, in the states
    // that could mask each chat lookup.
    const appLive = await this.streams.open("app-live", { tag: requestId });
    appLive.append({ x: 1 });
    const appDone = await this.streams.open("app-done", { tag: requestId });
    appDone.append({ x: 2 });
    appDone.close();

    const stream = new ResumableStream(
      this.streams,
      <T = Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ): T[] => this.sql<T>(strings, ...values)
    );
    const latest = stream.latestStreamInfoForRequest(requestId);
    return {
      latest: latest ? { id: latest.id, status: latest.status } : null,
      activeId: stream.latestActiveStreamInfoForRequest(requestId)?.id ?? null
    };
  }

  private streamMetadataColumnsForTest(): string[] {
    return this.sql<{ name: string }>`
      select name from pragma_table_info('cf_ai_chat_stream_metadata')
    `.map((c) => c.name);
  }

  /**
   * Drive a `ResumableStream` over seeded legacy `cf_ai_chat_stream_*` tables
   * and report what happened, so the test can assert construction migrated
   * the rows into the Streams capability's tables (preserving both stored
   * chunk formats and the in-flight active stream) and dropped the legacy
   * tables.
   */
  async resumableLegacyMigrationForTest(): Promise<{
    columnsBefore: string[];
    remainingLegacyTables: string[];
    migratedStatus: { status: string; request_id: string } | null;
    migratedChunkBodies: string[];
    legacyMessageId: string | null;
    restoredActiveStreamId: string | null;
    startThrew: boolean;
    newStreamMessageId: string | null;
  }> {
    const columnsBefore = this.streamMetadataColumnsForTest();

    const stream = new ResumableStream(
      this.streams,
      <T = Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ): T[] => this.sql<T>(strings, ...values)
    );

    const remainingLegacyTables = this.sql<{ name: string }>`
      select name from sqlite_master where type = 'table'
      and name in ('cf_ai_chat_stream_metadata', 'cf_ai_chat_stream_chunks')
    `.map((row) => row.name);

    const migratedStatus = stream.getStreamMetadata("legacy-stream");
    const migratedChunkBodies = stream
      .getStreamChunks("legacy-stream")
      .map((chunk) => chunk.body);
    // The legacy schema predates message-id tracking: guarded → null.
    const legacyMessageId = stream.getStreamMessageId("legacy-stream");
    // Construction ran restore(), which must adopt the migrated in-flight row.
    const restoredActiveStreamId = stream.activeStreamId;

    let startThrew = false;
    let newStreamId = "";
    try {
      newStreamId = stream.start("req-x", {
        messageId: "msg-1",
        continuation: true
      });
    } catch {
      startThrew = true;
    }

    const newStreamMessageId = newStreamId
      ? stream.getStreamMessageId(newStreamId)
      : null;

    return {
      columnsBefore,
      remainingLegacyTables,
      migratedStatus,
      migratedChunkBodies,
      legacyMessageId,
      restoredActiveStreamId,
      startThrew,
      newStreamMessageId
    };
  }
}
