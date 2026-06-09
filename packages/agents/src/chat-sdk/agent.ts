import { Agent } from "../index";

interface StoredLock {
  threadId: string;
  token: string;
  expiresAt: number;
}

interface StoredQueueEntry {
  enqueuedAt: number;
  expiresAt: number;
}

const NEXT_CLEANUP_AT_KEY = "next_cleanup_at";
const CLEANUP_SCHEDULE_ID_KEY = "cleanup_schedule_id";

export class ChatSdkStateAgent extends Agent {
  async onStart(): Promise<void> {
    this.migrate();
    await this.scheduleNextCleanup();
  }

  subscribe(threadId: string): void {
    this.sql`
      INSERT OR IGNORE INTO chat_sdk_state_subscriptions (thread_id)
      VALUES (${threadId})
    `;
  }

  unsubscribe(threadId: string): void {
    this.sql`
      DELETE FROM chat_sdk_state_subscriptions
      WHERE thread_id = ${threadId}
    `;
  }

  isSubscribed(threadId: string): boolean {
    const rows = this.sql<{ found: number }>`
      SELECT 1 as found
      FROM chat_sdk_state_subscriptions
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async acquireLock(
    threadId: string,
    ttlMs: number
  ): Promise<StoredLock | null> {
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();

      this.ctx.storage.sql.exec(
        "DELETE FROM chat_sdk_state_locks WHERE thread_id = ? AND expires_at <= ?",
        threadId,
        now
      );

      const existing = this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM chat_sdk_state_locks WHERE thread_id = ? LIMIT 1",
          threadId
        )
        .toArray();
      if (existing.length > 0) {
        return null;
      }

      const token = crypto.randomUUID();
      const expiresAt = now + ttlMs;

      this.ctx.storage.sql.exec(
        "INSERT INTO chat_sdk_state_locks (thread_id, token, expires_at) VALUES (?, ?, ?)",
        threadId,
        token,
        expiresAt
      );

      return { threadId, token, expiresAt };
    });

    await this.scheduleCleanupForExpiry(result?.expiresAt ?? null);
    return result;
  }

  releaseLock(threadId: string, token: string): void {
    this.sql`
      DELETE FROM chat_sdk_state_locks
      WHERE thread_id = ${threadId} AND token = ${token}
    `;
  }

  async extendLock(
    threadId: string,
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const rows = this.ctx.storage.sql
        .exec<{ thread_id: string }>(
          `UPDATE chat_sdk_state_locks SET expires_at = ?
           WHERE thread_id = ? AND token = ? AND expires_at > ?
           RETURNING thread_id`,
          now + ttlMs,
          threadId,
          token,
          now
        )
        .toArray();
      return rows.length > 0;
    });
    if (result) {
      await this.scheduleCleanupForExpiry(Date.now() + ttlMs);
    }
    return result;
  }

  forceReleaseLock(threadId: string): void {
    this.sql`
      DELETE FROM chat_sdk_state_locks
      WHERE thread_id = ${threadId}
    `;
  }

  async enqueue(
    threadId: string,
    value: string,
    maxSize: number
  ): Promise<number> {
    const parsed = parseQueueEntry(value);

    const count = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO chat_sdk_state_queue (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)",
        threadId,
        value,
        parsed.enqueuedAt,
        parsed.expiresAt
      );

      this.ctx.storage.sql.exec(
        `DELETE FROM chat_sdk_state_queue WHERE thread_id = ? AND id NOT IN (
          SELECT id FROM chat_sdk_state_queue
          WHERE thread_id = ?
          ORDER BY id DESC
          LIMIT ?
        )`,
        threadId,
        threadId,
        maxSize
      );

      const row = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM chat_sdk_state_queue WHERE thread_id = ?",
          threadId
        )
        .one();
      return row.count;
    });
    await this.scheduleCleanupForExpiry(parsed.expiresAt);
    return count;
  }

  popQueue(threadId: string): string | null {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();

      this.ctx.storage.sql.exec(
        "DELETE FROM chat_sdk_state_queue WHERE thread_id = ? AND expires_at <= ?",
        threadId,
        now
      );

      const rows = this.ctx.storage.sql
        .exec<{ id: number; value: string }>(
          "SELECT id, value FROM chat_sdk_state_queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1",
          threadId
        )
        .toArray();
      const row = rows[0];
      if (!row) {
        return null;
      }

      this.ctx.storage.sql.exec(
        "DELETE FROM chat_sdk_state_queue WHERE id = ?",
        row.id
      );
      return row.value;
    });
  }

  queueDepth(threadId: string): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count
      FROM chat_sdk_state_queue
      WHERE thread_id = ${threadId} AND expires_at > ${Date.now()}
    `;
    return rows[0]?.count ?? 0;
  }

  async listAppend(
    key: string,
    value: string,
    maxLength?: number,
    ttlMs?: number
  ): Promise<void> {
    const expiresAt = ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null;

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO chat_sdk_state_lists (key, value, expires_at) VALUES (?, ?, ?)",
        key,
        value,
        expiresAt
      );

      if (expiresAt !== null) {
        // Chat SDK history lists use a list-level TTL: any append refreshes the
        // expiry for the whole logical list, not only the new row.
        this.ctx.storage.sql.exec(
          "UPDATE chat_sdk_state_lists SET expires_at = ? WHERE key = ?",
          expiresAt,
          key
        );
      }

      if (maxLength != null && maxLength > 0) {
        this.ctx.storage.sql.exec(
          `DELETE FROM chat_sdk_state_lists WHERE key = ? AND id NOT IN (
            SELECT id FROM chat_sdk_state_lists
            WHERE key = ?
            ORDER BY id DESC
            LIMIT ?
          )`,
          key,
          key,
          maxLength
        );
      }
    });
    await this.scheduleCleanupForExpiry(expiresAt);
  }

  listGet(key: string): string[] {
    const now = Date.now();

    this.sql`
      DELETE FROM chat_sdk_state_lists
      WHERE key = ${key}
        AND expires_at IS NOT NULL
        AND expires_at <= ${now}
    `;

    return this.sql<{ value: string }>`
      SELECT value
      FROM chat_sdk_state_lists
      WHERE key = ${key}
      ORDER BY id ASC
    `.map((row) => row.value);
  }

  cacheGet(key: string): string | null {
    return this.readCacheValue(key, Date.now());
  }

  async cacheSet(key: string, value: string, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null;
    this.upsertCacheValue(key, value, expiresAt);
    await this.scheduleCleanupForExpiry(expiresAt);
  }

  async cacheSetIfNotExists(
    key: string,
    value: string,
    ttlMs?: number
  ): Promise<boolean> {
    const now = Date.now();

    const inserted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM chat_sdk_state_cache WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?",
        key,
        now
      );

      if (this.readCacheValue(key, now) !== null) {
        return false;
      }

      const expiresAt = ttlMs && ttlMs > 0 ? now + ttlMs : null;
      this.upsertCacheValue(key, value, expiresAt);
      return true;
    });
    if (inserted) {
      const expiresAt = ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null;
      await this.scheduleCleanupForExpiry(expiresAt);
    }
    return inserted;
  }

  cacheDelete(key: string): void {
    this.sql`
      DELETE FROM chat_sdk_state_cache
      WHERE key = ${key}
    `;
  }

  async cleanupExpired(payload?: { expiresAt?: number }): Promise<void> {
    const current = this.readCleanupMetadata();
    if (
      payload?.expiresAt !== undefined &&
      current.nextCleanupAt !== null &&
      payload.expiresAt !== current.nextCleanupAt
    ) {
      return;
    }

    const now = Date.now();
    this.clearCleanupMetadata();

    this.sql`
      DELETE FROM chat_sdk_state_locks
      WHERE expires_at <= ${now}
    `;
    this.sql`
      DELETE FROM chat_sdk_state_cache
      WHERE expires_at IS NOT NULL AND expires_at <= ${now}
    `;
    this.sql`
      DELETE FROM chat_sdk_state_queue
      WHERE expires_at <= ${now}
    `;
    this.sql`
      DELETE FROM chat_sdk_state_lists
      WHERE expires_at IS NOT NULL AND expires_at <= ${now}
    `;
    await this.scheduleNextCleanup();
  }

  private migrate(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS chat_sdk_state_subscriptions (
        thread_id TEXT PRIMARY KEY
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS chat_sdk_state_locks (
        thread_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS chat_sdk_state_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS chat_sdk_state_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        value TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS chat_sdk_state_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS chat_sdk_state_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_sdk_state_locks_expires
      ON chat_sdk_state_locks(expires_at)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_sdk_state_cache_expires
      ON chat_sdk_state_cache(expires_at)
      WHERE expires_at IS NOT NULL
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_sdk_state_queue_thread
      ON chat_sdk_state_queue(thread_id, id)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_sdk_state_queue_expires
      ON chat_sdk_state_queue(expires_at)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_sdk_state_lists_key
      ON chat_sdk_state_lists(key, id)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_sdk_state_lists_expires
      ON chat_sdk_state_lists(expires_at)
      WHERE expires_at IS NOT NULL
    `;
  }

  private readCacheValue(key: string, now: number): string | null {
    const rows = this.sql<{ value: string }>`
      SELECT value
      FROM chat_sdk_state_cache
      WHERE key = ${key}
        AND (expires_at IS NULL OR expires_at > ${now})
    `;
    return rows[0]?.value ?? null;
  }

  private upsertCacheValue(
    key: string,
    value: string,
    expiresAt: number | null
  ): void {
    this.sql`
      INSERT OR REPLACE INTO chat_sdk_state_cache (key, value, expires_at)
      VALUES (${key}, ${value}, ${expiresAt})
    `;
  }

  private async scheduleCleanupForExpiry(
    expiresAt: number | null
  ): Promise<void> {
    if (expiresAt === null) {
      return;
    }

    await this.ensureCleanupScheduled(expiresAt);
  }

  private async scheduleNextCleanup(): Promise<void> {
    const next = this.nextExpiry();
    if (next === null) {
      const current = this.readCleanupMetadata();
      if (current.scheduleId) {
        await this.cancelSchedule(current.scheduleId).catch(() => false);
      }
      this.clearCleanupMetadata();
      return;
    }

    await this.ensureCleanupScheduled(next);
  }

  private async ensureCleanupScheduled(expiresAt: number): Promise<void> {
    const current = this.readCleanupMetadata();
    if (current.nextCleanupAt !== null && current.nextCleanupAt <= expiresAt) {
      return;
    }

    if (current.scheduleId) {
      await this.cancelSchedule(current.scheduleId).catch(() => false);
    }

    const delaySeconds = Math.max(
      0,
      Math.ceil((expiresAt - Date.now()) / 1000)
    );
    const schedule = await this.schedule(delaySeconds, "cleanupExpired", {
      expiresAt
    });
    this.writeCleanupMetadata(expiresAt, schedule.id);
  }

  private nextExpiry(): number | null {
    const rows = this.sql<{ expires_at: number | null }>`
      SELECT MIN(expires_at) as expires_at
      FROM (
        SELECT expires_at FROM chat_sdk_state_locks
        UNION ALL
        SELECT expires_at FROM chat_sdk_state_queue
        UNION ALL
        SELECT expires_at FROM chat_sdk_state_cache WHERE expires_at IS NOT NULL
        UNION ALL
        SELECT expires_at FROM chat_sdk_state_lists WHERE expires_at IS NOT NULL
      )
    `;
    return rows[0]?.expires_at ?? null;
  }

  private readCleanupMetadata(): {
    nextCleanupAt: number | null;
    scheduleId: string | null;
  } {
    const rows = this.sql<{ key: string; value: string }>`
      SELECT key, value
      FROM chat_sdk_state_metadata
      WHERE key IN (${NEXT_CLEANUP_AT_KEY}, ${CLEANUP_SCHEDULE_ID_KEY})
    `;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const nextCleanupAt = Number(values.get(NEXT_CLEANUP_AT_KEY));
    return {
      nextCleanupAt: Number.isFinite(nextCleanupAt) ? nextCleanupAt : null,
      scheduleId: values.get(CLEANUP_SCHEDULE_ID_KEY) ?? null
    };
  }

  private writeCleanupMetadata(expiresAt: number, scheduleId: string): void {
    this.sql`
      INSERT OR REPLACE INTO chat_sdk_state_metadata (key, value)
      VALUES (${NEXT_CLEANUP_AT_KEY}, ${String(expiresAt)})
    `;
    this.sql`
      INSERT OR REPLACE INTO chat_sdk_state_metadata (key, value)
      VALUES (${CLEANUP_SCHEDULE_ID_KEY}, ${scheduleId})
    `;
  }

  private clearCleanupMetadata(): void {
    this.sql`
      DELETE FROM chat_sdk_state_metadata
      WHERE key IN (${NEXT_CLEANUP_AT_KEY}, ${CLEANUP_SCHEDULE_ID_KEY})
    `;
  }
}

function parseQueueEntry(value: string): StoredQueueEntry {
  const raw = JSON.parse(value) as Record<string, unknown>;
  if (typeof raw.enqueuedAt !== "number" || typeof raw.expiresAt !== "number") {
    throw new Error(
      "ChatSdkStateAgent expected QueueEntry JSON with numeric TTLs"
    );
  }

  return {
    enqueuedAt: raw.enqueuedAt,
    expiresAt: raw.expiresAt
  };
}
