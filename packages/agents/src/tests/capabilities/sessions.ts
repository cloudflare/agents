import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { setLifecycleEventSink } from "../../lifecycle/durable-object-lifecycle";
import { Sessions } from "../../sessions";

/** One capability telemetry event recorded by a harness object. */
export type RecordedEvent = { type: string; payload: Record<string, unknown> };

/**
 * Sums BILLED row writes across a window of SQLite statements.
 *
 * `total_changes()` counts logical row mutations, which is not what a
 * Durable Object bills: the billed unit is the rows each statement writes,
 * including index and FTS shadow rows. Every cursor's `rowsWritten` is a
 * getter that only settles once the cursor has been consumed, so the sum is
 * taken at the end of the window, after every caller has drained its cursor.
 */
class BilledRows {
  #cursors: { readonly rowsWritten: number }[] = [];
  #active = false;

  constructor(sql: SqlStorage) {
    const exec = sql.exec.bind(sql);
    (sql as { exec: SqlStorage["exec"] }).exec = ((
      query: string,
      ...params: unknown[]
    ) => {
      const cursor = exec(query, ...(params as never[]));
      if (this.#active) this.#cursors.push(cursor);
      return cursor;
      // SAFETY: the wrapper forwards every argument and the cursor unchanged.
    }) as SqlStorage["exec"];
  }

  start(): void {
    this.#cursors = [];
    this.#active = true;
  }

  stop(): number {
    this.#active = false;
    let total = 0;
    for (const cursor of this.#cursors) total += cursor.rowsWritten;
    this.#cursors = [];
    return total;
  }
}

/**
 * Minimal real host for capability-level Sessions tests: a Durable Object
 * whose only capability is Sessions, installed through a real Lifecycle over
 * real SQLite. Search indexing stays at its default (off); the search harness
 * below covers the opt-in path.
 */
export class SessionHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly sessions = new Sessions({
    reservedMetadataKeys: ["channel", "turnMetadata"]
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly events: RecordedEvent[] = [];

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setLifecycleEventSink(this.lifecycle, (event) => {
      this.events.push({
        type: event.type,
        payload: (event.payload ?? {}) as Record<string, unknown>
      });
    });
  }

  /** Telemetry events of one type, in dispatch order. */
  eventsOfType(type: string): RecordedEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  /** Continuation rows a message was split across, in `idx` order. */
  continuationRows(
    sessionId: string,
    messageId: string
  ): Array<{ idx: number; bytes: number }> {
    return this.ctx.storage.sql
      .exec<{ idx: number; bytes: number }>(
        `SELECT idx, LENGTH(CAST(content AS BLOB)) AS bytes
         FROM cf_agents_session_message_chunks
         WHERE session_id = ? AND id = ? ORDER BY idx ASC`,
        sessionId,
        messageId
      )
      .toArray();
  }

  /** Every continuation row in the object, regardless of session. */
  continuationRowCount(): number {
    return Number(
      this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM cf_agents_session_message_chunks")
        .one().count
    );
  }

  /** The `content_chunks` stamped on one stored message row. */
  contentChunks(sessionId: string, messageId: string): number | null {
    const rows = this.ctx.storage.sql
      .exec<{ content_chunks: number }>(
        "SELECT content_chunks FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
        sessionId,
        messageId
      )
      .toArray();
    return rows.length > 0 ? Number(rows[0].content_chunks) : null;
  }

  /** Stored size of one message row, excluding anything it points at. */
  messageRowBytes(sessionId: string, messageId: string): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ bytes: number }>(
          `SELECT LENGTH(CAST(content AS BLOB)) AS bytes
           FROM cf_agents_session_messages WHERE session_id = ? AND id = ?`,
          sessionId,
          messageId
        )
        .one().bytes
    );
  }

  /** Every attachment payload held by the object, newest address order. */
  attachmentRecords(): Array<{
    hash: string;
    bytes: number;
    mediaType: string;
  }> {
    return this.ctx.storage.sql
      .exec<{ hash: string; bytes: number; media_type: string }>(
        "SELECT hash, bytes, media_type FROM cf_agents_session_attachment_meta ORDER BY hash"
      )
      .toArray()
      .map((row) => ({
        hash: row.hash,
        bytes: Number(row.bytes),
        mediaType: row.media_type
      }));
  }

  /** Attachment chunk rows in the object. */
  attachmentChunkCount(): number {
    return Number(
      this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_chunks"
        )
        .one().count
    );
  }

  /** Reference rows tying messages to payloads. */
  attachmentRefCount(): number {
    return Number(
      this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM cf_agents_session_attachment_refs")
        .one().count
    );
  }

  /** Column names of a Sessions table, for schema assertions. */
  columnNames(table: string): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((row) => row.name);
  }

  /** True when the table was created WITHOUT ROWID. */
  isWithoutRowid(table: string): boolean {
    const sql = String(
      this.ctx.storage.sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
          table
        )
        .one().sql
    );
    return sql.includes("WITHOUT ROWID");
  }

  /** Ordering columns of the stored rows for one session. */
  messageRows(sessionId: string): Array<{
    id: string;
    seq: number;
    type: string;
    parent_id: string | null;
  }> {
    return this.ctx.storage.sql
      .exec<{
        id: string;
        seq: number;
        type: string;
        parent_id: string | null;
      }>(
        `SELECT id, seq, type, parent_id FROM cf_agents_session_messages
         WHERE session_id = ? ORDER BY seq ASC`,
        sessionId
      )
      .toArray();
  }

  /** Rewrite one stored row behind the capability's back (race simulation). */
  overwriteMessageContent(
    sessionId: string,
    messageId: string,
    content: string
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE cf_agents_session_messages SET content = ?
       WHERE session_id = ? AND id = ?`,
      content,
      sessionId,
      messageId
    );
  }

  /** True when a table exists, for migration assertions. */
  tableExists(name: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          name
        )
        .toArray().length > 0
    );
  }

  /** Seed legacy `assistant_*` tables BEFORE the Lifecycle starts. */
  seedLegacy(statements: string[]): void {
    for (const statement of statements) {
      this.ctx.storage.sql.exec(statement);
    }
  }

  async kvGet<T>(key: string): Promise<T | undefined> {
    return this.ctx.storage.get<T>(key);
  }

  /** Legacy config rows, which Sessions leaves untouched for Think to lift. */
  readLegacyConfig(): Array<{ key: string; value: string }> {
    return this.ctx.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM assistant_config ORDER BY key"
      )
      .toArray();
  }

  tableNames(): string[] {
    return [
      ...this.ctx.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
    ].map((row) => String(row.name));
  }
}

/** FTS coverage: the index exists only once something has searched. */
export class SessionSearchHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly sessions = new Sessions();
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly #billed = new BilledRows(this.ctx.storage.sql);

  /** Seed legacy `assistant_*` tables before the Lifecycle starts. */
  seedLegacy(statements: string[]): void {
    for (const statement of statements) {
      this.ctx.storage.sql.exec(statement);
    }
  }

  /** Names of all SQLite tables after startup or migration. */
  tableNames(): string[] {
    return [
      ...this.ctx.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
    ].map((row) => String(row.name));
  }

  /**
   * Billed rows for one text append and one text-changing update once the
   * FTS index exists, which the first search brings about.
   */
  async benchIndexedWrites(): Promise<{ append: number; update: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    await session.search("warm");

    this.#billed.start();
    await session.appendMessage({
      id: "indexed",
      role: "user",
      parts: [{ type: "text", text: "indexed body" }]
    });
    const append = this.#billed.stop();

    this.#billed.start();
    await session.updateMessage({
      id: "indexed",
      role: "user",
      parts: [{ type: "text", text: "rewritten body" }]
    });
    const update = this.#billed.stop();
    return { append, update };
  }
}

/**
 * Storage-ops benchmark harness. Every number below is BILLED rows: the sum
 * of `rowsWritten` over every cursor a measured window produced. Nothing
 * here searches, so no FTS index exists: the shape every host runs until
 * something calls `search()`.
 */
export class SessionBenchObject extends DurableObject<Cloudflare.Env> {
  readonly sessions = new Sessions();
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly #billed = new BilledRows(this.ctx.storage.sql);

  /** Continuation rows written for one message. */
  continuationRowCount(messageId: string): number {
    return Number(
      this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_agents_session_message_chunks WHERE id = ?",
          messageId
        )
        .one().count
    );
  }

  /** One message row per append: no index, no counter, no FTS row. */
  async benchLinearAppends(
    count: number,
    textBytes: number
  ): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    // Warm the tail cache outside the measured window, as a live host would
    // be after its first turn.
    await session.getLatestLeaf();
    const filler = "x".repeat(textBytes);
    this.#billed.start();
    for (let i = 0; i < count; i++) {
      await session.appendMessage({
        id: `bench-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `${i}:${filler}` }]
      });
    }
    return { rowsWritten: this.#billed.stop() };
  }

  /** An update whose serialized row is byte-identical writes nothing. */
  async benchNoOpUpdate(
    id: string,
    text: string
  ): Promise<{
    rowsWritten: number;
  }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    this.#billed.start();
    await session.updateMessage({
      id,
      role: "user",
      parts: [{ type: "text", text }]
    });
    return { rowsWritten: this.#billed.stop() };
  }

  /** A changed update rewrites exactly the one message row. */
  async benchUpdate(): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    this.#billed.start();
    await session.updateMessage({
      id: "bench-0",
      role: "user",
      parts: [{ type: "text", text: "rewritten" }]
    });
    return { rowsWritten: this.#billed.stop() };
  }

  /** A prefix delete rewires one surviving boundary child, not one per row. */
  async benchDeleteLinearPrefix(
    messageCount: number
  ): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    const ids: string[] = [];
    for (let index = 0; index < messageCount; index++) {
      const id = `delete-${index}`;
      ids.push(id);
      await session.appendMessage({
        id,
        role: "user",
        parts: [{ type: "text", text: id }]
      });
    }
    this.#billed.start();
    await session.deleteMessages(ids.slice(0, -1));
    return { rowsWritten: this.#billed.stop() };
  }

  /** Billed rows for one append carrying a payload of `payloadBytes`. */
  async benchPayloadAppend(
    payloadBytes: number
  ): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    await session.getLatestLeaf();
    const payload = btoa("y".repeat(payloadBytes));
    this.#billed.start();
    await session.appendMessage({
      id: "bench-payload",
      role: "user",
      parts: [
        { type: "text", text: "see attached" },
        {
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,${payload}`
        }
      ]
    });
    return { rowsWritten: this.#billed.stop() };
  }
}
