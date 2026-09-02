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
    attachments: {
      inlineThresholdBytes: 1024,
      keepRecentMessages: 2,
      maxMaintenanceRowsPerPass: 2
    },
    reservedMetadataKeys: ["channel", "turnMetadata"]
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly events: RecordedEvent[] = [];
  onAttachmentStored: (() => void) | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setLifecycleEventSink(this.lifecycle, (event) => {
      this.events.push({
        type: event.type,
        payload: (event.payload ?? {}) as Record<string, unknown>
      });
      if (event.type === "session:attachment:stored") {
        this.onAttachmentStored?.();
      }
    });
  }

  /** Telemetry events of one type, in dispatch order. */
  eventsOfType(type: string): RecordedEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  /** Number of immutable whole-file blobs owned by Sessions. */
  attachmentBlobCount(): number {
    if (!this.#tableExists("cf_agents_session_attachment_blobs")) return 0;
    return Number(
      this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_blobs"
        )
        .one().count
    );
  }

  /** Number of fixed-window SQLite rows backing attachment blobs. */
  attachmentChunkCount(): number {
    if (!this.#tableExists("cf_agents_session_attachment_chunks")) return 0;
    return Number(
      this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_chunks"
        )
        .one().count
    );
  }

  /** Whole-file hashes currently present in Sessions storage. */
  attachmentHashes(): string[] {
    if (!this.#tableExists("cf_agents_session_attachment_blobs")) return [];
    return this.ctx.storage.sql
      .exec<{ hash: string }>(
        "SELECT hash FROM cf_agents_session_attachment_blobs ORDER BY hash"
      )
      .toArray()
      .map((row) => row.hash);
  }

  /** Reference rows of one message: `(session_id, message_id, hash)` only. */
  attachmentReferences(
    sessionId: string,
    messageId: string
  ): Array<{ hash: string }> {
    return this.ctx.storage.sql
      .exec<{ hash: string }>(
        `SELECT hash FROM cf_agents_session_attachments
         WHERE session_id = ? AND message_id = ? ORDER BY hash`,
        sessionId,
        messageId
      )
      .toArray();
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

  #tableExists(name: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          name
        )
        .toArray().length > 0
    );
  }

  /** Simulate loss of SQLite payload rows while preserving blob metadata. */
  deleteAttachmentChunks(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_session_attachment_chunks"
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

/** Opt-in FTS search coverage. */
export class SessionSearchHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly sessions = new Sessions({ searchIndexing: true });
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
   * Billed rows for one text append and one text-changing update with the
   * FTS index maintained.
   */
  async benchIndexedWrites(): Promise<{ append: number; update: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    await session.stats();

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
 * of `rowsWritten` over every cursor a measured window produced. Search
 * indexing is off, which is the default and the shape most hosts run.
 */
export class SessionBenchObject extends DurableObject<Cloudflare.Env> {
  readonly sessions = new Sessions({
    attachments: { inlineThresholdBytes: 1024 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly #billed = new BilledRows(this.ctx.storage.sql);

  /** One message row per append: no index, no counter, no FTS row. */
  async benchLinearAppends(
    count: number,
    textBytes: number
  ): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    // Warm the leaf/stats caches outside the measured window, as a live host
    // would be after its first turn.
    await session.stats();
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

  attachmentBlobCount(): number {
    return Number(
      this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_blobs"
        )
        .one().count
    );
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

  /** Message row + reference row + whole-file row + one payload chunk. */
  async benchAttachmentAppend(
    payloadBytes: number
  ): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    await session.stats();
    const payload = btoa("y".repeat(payloadBytes));
    this.#billed.start();
    await session.appendMessage({
      id: "bench-attachment",
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
