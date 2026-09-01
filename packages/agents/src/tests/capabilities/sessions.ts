import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { Sessions, type SessionAttachmentStore } from "../../sessions";

/**
 * In-memory attachment store fake with operation counters. The structural
 * seam is the point under test — a `@cloudflare/shell` Workspace satisfies
 * the same interface in production.
 */
export class MemoryAttachmentStore implements SessionAttachmentStore {
  readonly files = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  writes = 0;
  deletes = 0;
  stats = 0;
  onWrite: (() => void | Promise<void>) | undefined;

  async writeFileBytes(
    path: string,
    data: Uint8Array | ArrayBuffer,
    mimeType = "application/octet-stream"
  ): Promise<void> {
    this.writes++;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.files.set(path, { bytes: new Uint8Array(bytes), mimeType });
    await this.onWrite?.();
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    const entry = this.files.get(path);
    return entry ? new Uint8Array(entry.bytes) : null;
  }

  async readFileStream(
    path: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    const entry = this.files.get(path);
    if (!entry) return null;
    const bytes = new Uint8Array(entry.bytes);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
  }

  async deleteFile(path: string): Promise<boolean> {
    this.deletes++;
    return this.files.delete(path);
  }

  async stat(path: string): Promise<{ size: number } | null> {
    this.stats++;
    const entry = this.files.get(path);
    return entry ? { size: entry.bytes.byteLength } : null;
  }
}

/**
 * Minimal real host for capability-level Sessions tests: a Durable Object
 * whose ONLY capability is Sessions, installed through a real Lifecycle over
 * real SQLite — proving the capability stands alone (it needs no alarm at
 * all, so it also works on facets). Attachments ride an in-memory store
 * satisfying the structural seam; search indexing stays at its default
 * (off) — `SessionSearchHarnessObject` covers the opt-in.
 */
export class SessionHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly attachmentStore = new MemoryAttachmentStore();
  readonly sessions = new Sessions({
    attachments: {
      store: () => this.attachmentStore,
      inlineThresholdBytes: 1024,
      keepRecentMessages: 2,
      maxEvictionRowsPerPass: 2
    },
    reservedMetadataKeys: ["channel", "turnMetadata"]
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);

  /** Seed legacy `assistant_*` tables BEFORE the Lifecycle starts. */
  seedLegacy(statements: string[]): void {
    for (const statement of statements) {
      this.ctx.storage.sql.exec(statement);
    }
  }

  async kvGet<T>(key: string): Promise<T | undefined> {
    return this.ctx.storage.get<T>(key);
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
 * storage-op model — a text append with search off writes exactly ONE row
 * (the legacy module wrote three: the row plus two secondary index rows,
 * with more for FTS), and an attachment-bearing append writes two.
 */
export class SessionBenchObject extends DurableObject<Cloudflare.Env> {
  readonly attachmentStore = new MemoryAttachmentStore();
  readonly sessions = new Sessions({
    attachments: {
      store: () => this.attachmentStore,
      inlineThresholdBytes: 1024
    }
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
