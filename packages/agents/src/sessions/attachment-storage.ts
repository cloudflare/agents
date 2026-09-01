import { createHash } from "node:crypto";
import {
  SessionAttachmentMissingError,
  SessionAttachmentStoreError,
  SessionAttachmentTooLargeError
} from "./errors";
import type {
  SessionAttachmentBucket,
  SessionsAttachmentOptions
} from "./types";

/**
 * Fixed SQLite window used for attachment reads and writes. Attachments are
 * immutable, so larger rows save billed writes without Computer's need for
 * 512 KiB partial-file edits. Keep enough headroom below 2 MiB for row keys
 * and SQLite record overhead.
 */
export const SESSION_ATTACHMENT_CHUNK_BYTES = 1536 * 1024;

const DEFAULT_R2_THRESHOLD_BYTES = 1_500_000;
const DEFAULT_R2_PREFIX = "cf-agents/sessions/attachments";

/** @internal SQLite binding accepted by attachment storage. */
export type AttachmentSqlParam = ArrayBuffer | string | number | null;

type AttachmentBlobRow = {
  hash: string;
  backend: "sqlite" | "r2";
  storage_id: string;
  r2_key: string | null;
  bytes: number;
  media_type: string;
  filename: string | null;
};

/** @internal One SQLite attachment chunk row. */
export type AttachmentChunkRow = {
  bytes: ArrayBuffer;
};

/** @internal SQLite and telemetry operations supplied by Sessions. */
export interface SessionAttachmentStorageIo {
  sql<T>(query: string, params: AttachmentSqlParam[]): T[];
  sqlWrite(query: string, params: AttachmentSqlParam[]): number;
  rawSql(query: string): void;
  transaction<T>(fn: () => T): T;
  chunk(storageId: string, index: number): AttachmentChunkRow | null;
  emit(type: string, payload: Record<string, unknown>): void;
}

/** @internal Replayable byte input used by data URLs, strings, and buffers. */
export type ReplayableAttachmentSource = {
  readonly kind: "replayable";
  readonly open: () => ReadableStream<Uint8Array>;
};

/** @internal One-shot byte input used by request and RPC streams. */
export type StreamingAttachmentSource = {
  readonly kind: "stream";
  readonly stream: ReadableStream<Uint8Array>;
  /** Exact stream length, when the caller knows it. */
  readonly bytes?: number;
};

/** @internal Input accepted by the Sessions-owned attachment byte store. */
export type AttachmentByteSource =
  | ReplayableAttachmentSource
  | StreamingAttachmentSource;

/** @internal Result of storing one immutable attachment payload. */
export type StoredAttachmentBlob = {
  readonly hash: string;
  readonly bytes: number;
  readonly backend: "sqlite" | "r2";
  readonly mediaType: string;
  readonly filename?: string;
  /** True only when this call created the whole-file blob. */
  readonly created: boolean;
};

type MeasuredSource = {
  readonly hash: string;
  readonly bytes: number;
};

type ResolvedStorageOptions = {
  readonly bucket: SessionAttachmentBucket | undefined;
  readonly r2ThresholdBytes: number;
  readonly r2Prefix: string;
  readonly maxAttachmentBytes: number;
};

/**
 * Sessions-owned immutable attachment byte storage.
 *
 * Small payloads are split into fixed 1.5 MiB SQLite rows. Large payloads use
 * one private R2 object when a bucket is configured. The public identity is
 * always the raw-file SHA-256; random storage IDs and R2 keys stay internal.
 *
 * This store performs no age-based sweep. A successful `put` creates a valid
 * durable resource even before a message references it. Normal failed writes
 * clean up their own staged bytes. A process failure at the exact network or
 * SQLite commit boundary can leave unreachable storage overhead, which is
 * preferable to recurring scans and speculative deletion of valid resources.
 */
export class SessionAttachmentStorage {
  readonly #options:
    | SessionsAttachmentOptions
    | (() => SessionsAttachmentOptions | undefined)
    | undefined;
  readonly #io: SessionAttachmentStorageIo;
  readonly #knownRows = new Map<string, AttachmentBlobRow>();
  #tablesEnsured = false;

  constructor(
    options:
      | SessionsAttachmentOptions
      | (() => SessionsAttachmentOptions | undefined)
      | undefined,
    io: SessionAttachmentStorageIo
  ) {
    this.#options = options;
    this.#io = io;
  }

  /** Create the Sessions-owned whole-file and chunk tables. */
  ensureTables(): void {
    if (this.#tablesEnsured) return;
    this.#io.rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_session_attachment_blobs (
        hash TEXT PRIMARY KEY,
        backend TEXT NOT NULL CHECK(backend IN ('sqlite', 'r2')),
        storage_id TEXT NOT NULL,
        r2_key TEXT,
        bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        filename TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.#io.rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_session_attachment_chunks (
        storage_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (storage_id, idx)
      ) WITHOUT ROWID
    `);
    this.#tablesEnsured = true;
  }

  /** Store one immutable payload without materializing a stream. */
  async put(
    source: AttachmentByteSource,
    metadata: { mediaType: string; filename?: string }
  ): Promise<StoredAttachmentBlob> {
    this.ensureTables();
    const options = this.#resolvedOptions();

    if (
      source.kind === "stream" &&
      source.bytes !== undefined &&
      source.bytes > options.maxAttachmentBytes
    ) {
      await source.stream.cancel().catch(() => undefined);
      throw new SessionAttachmentTooLargeError(
        source.bytes,
        options.maxAttachmentBytes
      );
    }

    if (source.kind === "replayable") {
      return this.#putReplayable(source, metadata, options);
    }

    if (
      source.bytes !== undefined &&
      source.bytes >= options.r2ThresholdBytes &&
      options.bucket
    ) {
      return this.#putKnownLargeStream(source, source.bytes, metadata, options);
    }

    return this.#putStagedStream(source, metadata, options);
  }

  /** Return durable whole-file metadata for one hash. */
  get(hash: string): StoredAttachmentBlob | null {
    return this.getMany([hash]).get(hash) ?? null;
  }

  /** Return whole-file metadata for several hashes with one SQLite read. */
  getMany(hashes: readonly string[]): Map<string, StoredAttachmentBlob> {
    const unique = [...new Set(hashes)];
    if (unique.length === 0 || !this.#tablesExist()) return new Map();
    const result = new Map<string, StoredAttachmentBlob>();
    const missing: string[] = [];
    for (const hash of unique) {
      const known = this.#knownRows.get(hash);
      if (known) result.set(hash, resultFromRow(known, false));
      else missing.push(hash);
    }
    if (missing.length === 0) return result;
    const rows = this.#io.sql<AttachmentBlobRow>(
      `SELECT hash, backend, storage_id, r2_key, bytes, media_type, filename
       FROM cf_agents_session_attachment_blobs
       WHERE hash IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(missing)]
    );
    for (const row of rows) {
      this.#rememberRow(row);
      result.set(row.hash, resultFromRow(row, false));
    }
    return result;
  }

  /** Open one payload as a backpressure-aware stream. */
  async open(hash: string): Promise<ReadableStream<Uint8Array>> {
    const row = this.#blob(hash);
    if (!row) throw new SessionAttachmentMissingError(hash);

    if (row.backend === "sqlite") return this.#sqliteStream(row);

    const bucket = this.#resolvedOptions().bucket;
    if (!bucket || !row.r2_key) {
      throw new SessionAttachmentMissingError(hash);
    }
    try {
      const object = await bucket.get(row.r2_key);
      if (!object) throw new SessionAttachmentMissingError(hash);
      return object.body;
    } catch (cause) {
      if (cause instanceof SessionAttachmentMissingError) throw cause;
      throw new SessionAttachmentStoreError(row.r2_key, "R2 get", cause);
    }
  }

  /**
   * Delete one whole-file blob. R2 is deleted before its metadata row. A
   * failed R2 call leaves the resource addressable so a caller can retry.
   */
  async delete(hash: string): Promise<boolean> {
    const row = this.#blob(hash);
    if (!row) return false;

    if (row.backend === "r2" && row.r2_key) {
      const bucket = this.#resolvedOptions().bucket;
      if (!bucket) {
        throw new SessionAttachmentStoreError(
          row.r2_key,
          "R2 delete",
          new Error("No R2 bucket is configured")
        );
      }
      try {
        await bucket.delete(row.r2_key);
      } catch (cause) {
        throw new SessionAttachmentStoreError(row.r2_key, "R2 delete", cause);
      }
    }

    this.#io.transaction(() => {
      if (row.backend === "sqlite") this.#deleteChunks(row.storage_id);
      this.#io.sqlWrite(
        "DELETE FROM cf_agents_session_attachment_blobs WHERE hash = ?",
        [hash]
      );
    });
    this.#knownRows.delete(hash);
    return true;
  }

  async #putReplayable(
    source: ReplayableAttachmentSource,
    metadata: { mediaType: string; filename?: string },
    options: ResolvedStorageOptions
  ): Promise<StoredAttachmentBlob> {
    const measured = await measureSource(
      source.open(),
      options.maxAttachmentBytes
    );
    const existing = this.#blob(measured.hash);
    if (existing) return resultFromRow(existing, false);

    if (
      measured.bytes >= options.r2ThresholdBytes &&
      options.bucket !== undefined
    ) {
      return this.#writeR2Replayable(source, measured, metadata, options);
    }
    return this.#writeSqliteReplayable(source, measured, metadata, options);
  }

  async #writeSqliteReplayable(
    source: ReplayableAttachmentSource,
    measured: MeasuredSource,
    metadata: { mediaType: string; filename?: string },
    options: ResolvedStorageOptions
  ): Promise<StoredAttachmentBlob> {
    const storageId = crypto.randomUUID();
    try {
      const written = await writeChunks(
        source.open(),
        options.maxAttachmentBytes,
        (index, bytes) => this.#insertChunk(storageId, index, bytes)
      );
      if (written.bytes !== measured.bytes || written.hash !== measured.hash) {
        throw new Error("Replayable attachment changed between reads");
      }

      const inserted = this.#insertBlob({
        hash: measured.hash,
        backend: "sqlite",
        storageId,
        r2Key: null,
        bytes: measured.bytes,
        ...metadata
      });
      if (!inserted) {
        this.#deleteChunks(storageId);
        const raced = this.#blob(measured.hash);
        if (raced) return resultFromRow(raced, false);
        throw new Error("Attachment insert lost a race without a stored row");
      }
      return storedResult(measured, "sqlite", metadata);
    } catch (cause) {
      this.#deleteChunks(storageId);
      if (
        cause instanceof SessionAttachmentTooLargeError ||
        cause instanceof SessionAttachmentStoreError
      ) {
        throw cause;
      }
      throw new SessionAttachmentStoreError(storageId, "SQLite write", cause);
    }
  }

  async #writeR2Replayable(
    source: ReplayableAttachmentSource,
    measured: MeasuredSource,
    metadata: { mediaType: string; filename?: string },
    options: ResolvedStorageOptions
  ): Promise<StoredAttachmentBlob> {
    const bucket = options.bucket;
    if (!bucket) {
      return this.#writeSqliteReplayable(source, measured, metadata, options);
    }
    const storageId = crypto.randomUUID();
    const r2Key = this.#r2Key(options.r2Prefix, storageId);
    let uploaded = false;
    try {
      const written = await uploadFixedLength(
        bucket,
        r2Key,
        source.open(),
        measured.bytes,
        metadata.mediaType,
        options.maxAttachmentBytes
      );
      uploaded = true;
      if (written.hash !== measured.hash) {
        throw new Error("Replayable attachment changed between reads");
      }

      const inserted = this.#insertBlob({
        hash: measured.hash,
        backend: "r2",
        storageId,
        r2Key,
        bytes: measured.bytes,
        ...metadata
      });
      if (!inserted) {
        await this.#deleteUploadedObject(bucket, r2Key);
        uploaded = false;
        const raced = this.#blob(measured.hash);
        if (raced) return resultFromRow(raced, false);
        throw new Error("Attachment insert lost a race without a stored row");
      }
      return storedResult(measured, "r2", metadata);
    } catch (cause) {
      if (uploaded) await this.#tryDeleteUploadedObject(bucket, r2Key);
      if (
        cause instanceof SessionAttachmentTooLargeError ||
        cause instanceof SessionAttachmentStoreError
      ) {
        throw cause;
      }
      throw new SessionAttachmentStoreError(r2Key, "R2 put", cause);
    }
  }

  async #putKnownLargeStream(
    source: StreamingAttachmentSource,
    expectedBytes: number,
    metadata: { mediaType: string; filename?: string },
    options: ResolvedStorageOptions
  ): Promise<StoredAttachmentBlob> {
    const bucket = options.bucket;
    if (!bucket) return this.#putStagedStream(source, metadata, options);
    const storageId = crypto.randomUUID();
    const r2Key = this.#r2Key(options.r2Prefix, storageId);
    let uploaded = false;
    try {
      const measured = await uploadFixedLength(
        bucket,
        r2Key,
        source.stream,
        expectedBytes,
        metadata.mediaType,
        options.maxAttachmentBytes
      );
      uploaded = true;
      const inserted = this.#insertBlob({
        hash: measured.hash,
        backend: "r2",
        storageId,
        r2Key,
        bytes: measured.bytes,
        ...metadata
      });
      if (!inserted) {
        await this.#deleteUploadedObject(bucket, r2Key);
        uploaded = false;
        const existing = this.#blob(measured.hash);
        if (existing) return resultFromRow(existing, false);
        throw new Error("Attachment insert lost a race without a stored row");
      }
      return storedResult(measured, "r2", metadata);
    } catch (cause) {
      if (uploaded) await this.#tryDeleteUploadedObject(bucket, r2Key);
      if (
        cause instanceof SessionAttachmentTooLargeError ||
        cause instanceof SessionAttachmentStoreError
      ) {
        throw cause;
      }
      throw new SessionAttachmentStoreError(r2Key, "R2 put", cause);
    }
  }

  async #putStagedStream(
    source: StreamingAttachmentSource,
    metadata: { mediaType: string; filename?: string },
    options: ResolvedStorageOptions
  ): Promise<StoredAttachmentBlob> {
    const storageId = crypto.randomUUID();
    try {
      const measured = await writeChunks(
        source.stream,
        options.maxAttachmentBytes,
        (index, bytes) => this.#insertChunk(storageId, index, bytes)
      );
      if (source.bytes !== undefined && source.bytes !== measured.bytes) {
        throw new Error(
          `Attachment stream length ${measured.bytes} did not match declared length ${source.bytes}`
        );
      }

      const existing = this.#blob(measured.hash);
      if (existing) {
        this.#deleteChunks(storageId);
        return resultFromRow(existing, false);
      }

      if (
        measured.bytes >= options.r2ThresholdBytes &&
        options.bucket !== undefined
      ) {
        return this.#moveStagedToR2(storageId, measured, metadata, options);
      }

      const inserted = this.#insertBlob({
        hash: measured.hash,
        backend: "sqlite",
        storageId,
        r2Key: null,
        bytes: measured.bytes,
        ...metadata
      });
      if (!inserted) {
        this.#deleteChunks(storageId);
        const raced = this.#blob(measured.hash);
        if (raced) return resultFromRow(raced, false);
        throw new Error("Attachment insert lost a race without a stored row");
      }
      return storedResult(measured, "sqlite", metadata);
    } catch (cause) {
      this.#deleteChunks(storageId);
      if (
        cause instanceof SessionAttachmentTooLargeError ||
        cause instanceof SessionAttachmentStoreError
      ) {
        throw cause;
      }
      throw new SessionAttachmentStoreError(storageId, "stream write", cause);
    }
  }

  async #moveStagedToR2(
    storageId: string,
    measured: MeasuredSource,
    metadata: { mediaType: string; filename?: string },
    options: ResolvedStorageOptions
  ): Promise<StoredAttachmentBlob> {
    const bucket = options.bucket;
    if (!bucket) throw new Error("R2 storage is not configured");
    const r2Key = this.#r2Key(options.r2Prefix, storageId);
    let uploaded = false;
    try {
      await uploadFixedLength(
        bucket,
        r2Key,
        this.#sqliteStream({
          hash: measured.hash,
          backend: "sqlite",
          storage_id: storageId,
          r2_key: null,
          bytes: measured.bytes,
          media_type: metadata.mediaType,
          filename: metadata.filename ?? null
        }),
        measured.bytes,
        metadata.mediaType,
        options.maxAttachmentBytes
      );
      uploaded = true;

      const inserted = this.#insertBlob({
        hash: measured.hash,
        backend: "r2",
        storageId,
        r2Key,
        bytes: measured.bytes,
        ...metadata
      });
      if (!inserted) {
        await this.#deleteUploadedObject(bucket, r2Key);
        uploaded = false;
        this.#deleteChunks(storageId);
        const raced = this.#blob(measured.hash);
        if (raced) return resultFromRow(raced, false);
        throw new Error("Attachment insert lost a race without a stored row");
      }
      this.#deleteChunks(storageId);
      return storedResult(measured, "r2", metadata);
    } catch (cause) {
      if (uploaded) await this.#tryDeleteUploadedObject(bucket, r2Key);
      throw cause;
    }
  }

  #blob(hash: string): AttachmentBlobRow | null {
    const known = this.#knownRows.get(hash);
    if (known) return known;
    if (!this.#tablesExist()) return null;
    const row =
      this.#io.sql<AttachmentBlobRow>(
        `SELECT hash, backend, storage_id, r2_key, bytes, media_type, filename
         FROM cf_agents_session_attachment_blobs WHERE hash = ?`,
        [hash]
      )[0] ?? null;
    if (row) this.#rememberRow(row);
    return row;
  }

  #tablesExist(): boolean {
    if (this.#tablesEnsured) return true;
    const exists =
      this.#io.sql<{ present: number }>(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table'
           AND name = 'cf_agents_session_attachment_blobs'
         LIMIT 1`,
        []
      ).length > 0;
    if (exists) this.#tablesEnsured = true;
    return exists;
  }

  #rememberRow(row: AttachmentBlobRow): void {
    this.#knownRows.set(row.hash, row);
    if (this.#knownRows.size <= 256) return;
    const oldest = this.#knownRows.keys().next().value;
    if (oldest !== undefined) this.#knownRows.delete(oldest);
  }

  #insertBlob(input: {
    hash: string;
    backend: "sqlite" | "r2";
    storageId: string;
    r2Key: string | null;
    bytes: number;
    mediaType: string;
    filename?: string;
  }): boolean {
    const inserted =
      this.#io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_attachment_blobs
           (hash, backend, storage_id, r2_key, bytes, media_type, filename, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.hash,
          input.backend,
          input.storageId,
          input.r2Key,
          input.bytes,
          input.mediaType,
          input.filename ?? null,
          Date.now()
        ]
      ) > 0;
    if (inserted) {
      this.#rememberRow({
        hash: input.hash,
        backend: input.backend,
        storage_id: input.storageId,
        r2_key: input.r2Key,
        bytes: input.bytes,
        media_type: input.mediaType,
        filename: input.filename ?? null
      });
    }
    return inserted;
  }

  #insertChunk(storageId: string, index: number, bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.#io.sqlWrite(
      `INSERT INTO cf_agents_session_attachment_chunks
         (storage_id, idx, bytes)
       VALUES (?, ?, ?)`,
      [storageId, index, copy.buffer]
    );
  }

  #deleteChunks(storageId: string): void {
    this.#io.sqlWrite(
      "DELETE FROM cf_agents_session_attachment_chunks WHERE storage_id = ?",
      [storageId]
    );
  }

  #sqliteStream(row: AttachmentBlobRow): ReadableStream<Uint8Array> {
    let index = 0;
    let readBytes = 0;
    const io = this.#io;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readBytes === row.bytes) {
          controller.close();
          return;
        }
        const chunk = io.chunk(row.storage_id, index++);
        if (!chunk) {
          controller.error(new SessionAttachmentMissingError(row.hash));
          return;
        }
        const bytes = new Uint8Array(chunk.bytes);
        const expectedBytes = Math.min(
          SESSION_ATTACHMENT_CHUNK_BYTES,
          row.bytes - readBytes
        );
        if (bytes.byteLength !== expectedBytes) {
          controller.error(new SessionAttachmentMissingError(row.hash));
          return;
        }
        readBytes += bytes.byteLength;
        controller.enqueue(bytes);
      }
    });
  }

  #r2Key(prefix: string, storageId: string): string {
    return `${prefix.replace(/\/+$/, "")}/${storageId}`;
  }

  async #deleteUploadedObject(
    bucket: SessionAttachmentBucket,
    key: string
  ): Promise<void> {
    try {
      await bucket.delete(key);
    } catch (cause) {
      this.#io.emit("session:attachment:r2-orphaned", {
        key,
        error: cause instanceof Error ? cause.message : String(cause)
      });
      throw new SessionAttachmentStoreError(key, "R2 cleanup", cause);
    }
  }

  async #tryDeleteUploadedObject(
    bucket: SessionAttachmentBucket,
    key: string
  ): Promise<void> {
    try {
      await bucket.delete(key);
    } catch (cause) {
      this.#io.emit("session:attachment:r2-orphaned", {
        key,
        error: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  #resolvedOptions(): ResolvedStorageOptions {
    const input =
      typeof this.#options === "function" ? this.#options() : this.#options;
    const bucketInput = input?.r2;
    const bucket =
      typeof bucketInput === "function" ? bucketInput() : bucketInput;
    const thresholdInput = input?.r2ThresholdBytes;
    const threshold =
      typeof thresholdInput === "function" ? thresholdInput() : thresholdInput;
    return {
      bucket,
      r2ThresholdBytes: Math.max(
        1,
        Math.floor(threshold ?? DEFAULT_R2_THRESHOLD_BYTES)
      ),
      r2Prefix: input?.r2Prefix ?? DEFAULT_R2_PREFIX,
      maxAttachmentBytes: Math.max(
        1,
        Math.floor(input?.maxAttachmentBytes ?? 8 * 1024 * 1024)
      )
    };
  }
}

function resultFromRow(
  row: AttachmentBlobRow,
  created: boolean
): StoredAttachmentBlob {
  return {
    hash: row.hash,
    bytes: row.bytes,
    backend: row.backend,
    mediaType: row.media_type,
    ...(row.filename !== null ? { filename: row.filename } : {}),
    created
  };
}

function storedResult(
  measured: MeasuredSource,
  backend: "sqlite" | "r2",
  metadata: { mediaType: string; filename?: string }
): StoredAttachmentBlob {
  return {
    ...measured,
    backend,
    ...metadata,
    created: true
  };
}

async function measureSource(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<MeasuredSource> {
  return writeChunks(stream, maxBytes, () => undefined);
}

async function writeChunks(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  write: (index: number, bytes: Uint8Array) => void | Promise<void>
): Promise<MeasuredSource> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;
  let chunkIndex = 0;

  const flush = async (length: number): Promise<void> => {
    const window = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const part = pending[0];
      if (!part) throw new Error("Attachment chunk buffer underflow");
      const take = Math.min(part.byteLength, length - offset);
      window.set(part.subarray(0, take), offset);
      offset += take;
      pendingBytes -= take;
      if (take === part.byteLength) pending.shift();
      else pending[0] = part.slice(take);
    }
    hash.update(window);
    await write(chunkIndex++, window);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const error = new SessionAttachmentTooLargeError(total, maxBytes);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= SESSION_ATTACHMENT_CHUNK_BYTES) {
        await flush(SESSION_ATTACHMENT_CHUNK_BYTES);
      }
    }
    if (pendingBytes > 0) await flush(pendingBytes);
  } finally {
    reader.releaseLock();
  }

  return { hash: hash.digest("hex"), bytes: total };
}

async function uploadFixedLength(
  bucket: SessionAttachmentBucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  mediaType: string,
  maxBytes: number
): Promise<MeasuredSource> {
  const hash = createHash("sha256");
  let total = 0;
  const checked = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new SessionAttachmentTooLargeError(total, maxBytes);
      }
      hash.update(chunk);
      controller.enqueue(chunk);
    }
  });
  const fixed = new FixedLengthStream(expectedBytes);
  const pipe = stream.pipeThrough(checked).pipeTo(fixed.writable);
  const put = bucket.put(key, fixed.readable, {
    httpMetadata: { contentType: mediaType }
  });
  await Promise.all([pipe, put]);
  if (total !== expectedBytes) {
    throw new Error(
      `Attachment stream length ${total} did not match expected length ${expectedBytes}`
    );
  }
  return { hash: hash.digest("hex"), bytes: total };
}
