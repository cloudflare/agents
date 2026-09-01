import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { setLifecycleEventSink } from "../../lifecycle/durable-object-lifecycle";
import { Sessions } from "../../sessions";

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
      maxEvictionRowsPerPass: 2
    },
    reservedMetadataKeys: ["channel", "turnMetadata"]
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  onAttachmentStored: (() => void) | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setLifecycleEventSink(this.lifecycle, (event) => {
      if (event.type === "session:attachment:stored") {
        this.onAttachmentStored?.();
      }
    });
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

  /** Legacy conversation-directory rows remain available in the tombstone. */
  readLegacySessionTombstone(): Array<{ id: string; name: string }> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string }>(
        "SELECT id, name FROM assistant_sessions__lifted_v1 ORDER BY id"
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
}

/**
 * Storage-ops benchmark harness: measures SQLite rows written (via
 * `total_changes()`) for the append hot path. The assertions pin the
 * storage-op model. A text append with search off writes exactly one row.
 * An attachment append also writes one whole-file row, one 1.5 MiB chunk row,
 * and one derived message reference.
 */
export class SessionBenchObject extends DurableObject<Cloudflare.Env> {
  readonly sessions = new Sessions({
    attachments: { inlineThresholdBytes: 1024 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);

  #totalChanges(): number {
    const cursor = this.ctx.storage.sql.exec(
      "SELECT total_changes() AS changes"
    );
    return Number([...cursor][0].changes);
  }

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
    const before = this.#totalChanges();
    for (let i = 0; i < count; i++) {
      await session.appendMessage({
        id: `bench-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `${i}:${filler}` }]
      });
    }
    return { rowsWritten: this.#totalChanges() - before };
  }

  async benchUpdate(): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    const before = this.#totalChanges();
    await session.updateMessage({
      id: "bench-0",
      role: "user",
      parts: [{ type: "text", text: "rewritten" }]
    });
    return { rowsWritten: this.#totalChanges() - before };
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
    const before = this.#totalChanges();
    await session.deleteMessages(ids.slice(0, -1));
    return { rowsWritten: this.#totalChanges() - before };
  }

  async benchAttachmentAppend(
    payloadBytes: number
  ): Promise<{ rowsWritten: number }> {
    await this.lifecycle.start();
    const session = this.sessions.session();
    await session.stats();
    const payload = btoa("y".repeat(payloadBytes));
    const before = this.#totalChanges();
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
    return { rowsWritten: this.#totalChanges() - before };
  }
}
