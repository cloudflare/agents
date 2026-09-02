/**
 * Sessions-owned immutable attachment byte storage.
 *
 * Payloads are content-addressed by their raw SHA-256. Small payloads are
 * split into fixed 1.5 MiB SQLite rows; payloads at or above the R2
 * threshold become one private R2 object when a bucket is configured.
 * Random storage ids and R2 keys stay internal.
 *
 * A successful `put` is a valid durable resource before any message points
 * at it. Failed writes clean up their own bytes. There is no age-based sweep:
 * a crash at the exact commit boundary can leave unreachable bytes, which is
 * cheaper than recurring scans or speculative deletes of valid resources.
 */

import { createHash } from "node:crypto";
import {
  SessionAttachmentMissingError,
  SessionAttachmentStoreError,
  SessionAttachmentTooLargeError
} from "./errors";
import type { SessionsIo } from "./io";
import type { SessionAttachmentBucket } from "./types";

/**
 * Fixed SQLite window for attachment rows. Attachments are immutable, so
 * larger rows save billed writes; the headroom below 2 MiB covers row keys
 * and SQLite record overhead.
 */
export const SESSION_ATTACHMENT_CHUNK_BYTES = 1536 * 1024;

/** @internal One `cf_agents_session_attachment_blobs` row. */
export type AttachmentBlobRow = {
  hash: string;
  backend: "sqlite" | "r2";
  storage_id: string;
  r2_key: string | null;
  bytes: number;
  media_type: string;
  filename: string | null;
};

/** @internal Replayable byte input (data URLs, strings, buffers). */
export type ReplayableSource = {
  readonly kind: "replayable";
  readonly open: () => ReadableStream<Uint8Array>;
};

/** @internal One-shot byte input (request and RPC streams). */
export type StreamSource = {
  readonly kind: "stream";
  readonly stream: ReadableStream<Uint8Array>;
  /** Exact stream length, when the caller knows it. */
  readonly bytes?: number;
};

export type AttachmentByteSource = ReplayableSource | StreamSource;

/** @internal Storage-tier policy with defaults applied. */
export type BlobStoreOptions = {
  readonly bucket: SessionAttachmentBucket | undefined;
  readonly r2ThresholdBytes: number;
  readonly r2Prefix: string;
  readonly maxAttachmentBytes: number;
};

type BlobMetadata = { mediaType: string; filename?: string };
type Measured = { readonly hash: string; readonly bytes: number };
type Expected = { readonly hash?: string; readonly bytes?: number };
type PutResult = { row: AttachmentBlobRow; created: boolean };

export class AttachmentBlobStore {
  readonly #io: SessionsIo;
  readonly #options: () => BlobStoreOptions;
  readonly #rows = new Map<string, AttachmentBlobRow>();

  constructor(io: SessionsIo, options: () => BlobStoreOptions) {
    this.#io = io;
    this.#options = options;
  }

  ensureTables(): void {
    this.#io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_attachment_blobs (
        hash TEXT PRIMARY KEY,
        backend TEXT NOT NULL CHECK(backend IN ('sqlite', 'r2')),
        storage_id TEXT NOT NULL,
        r2_key TEXT,
        bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        filename TEXT
      ) WITHOUT ROWID`,
      []
    );
    this.#io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_attachment_chunks (
        storage_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (storage_id, idx)
      ) WITHOUT ROWID`,
      []
    );
  }

  /** Store one immutable payload without materializing the stream. */
  async put(
    source: AttachmentByteSource,
    metadata: BlobMetadata
  ): Promise<PutResult> {
    const options = this.#options();
    const max = options.maxAttachmentBytes;
    let stream: ReadableStream<Uint8Array>;
    let expected: Expected;
    if (source.kind === "replayable") {
      const measured = await measureSource(source.open(), max);
      const existing = this.get(measured.hash);
      if (existing) return { row: existing, created: false };
      stream = source.open();
      expected = measured;
    } else {
      if (source.bytes !== undefined && source.bytes > max) {
        await source.stream.cancel().catch(() => undefined);
        throw new SessionAttachmentTooLargeError(source.bytes, max);
      }
      stream = source.stream;
      expected = { bytes: source.bytes };
    }

    const storageId = crypto.randomUUID();
    if (
      options.bucket &&
      expected.bytes !== undefined &&
      expected.bytes >= options.r2ThresholdBytes
    ) {
      return this.#commitR2(
        options.bucket,
        stream,
        { bytes: expected.bytes, hash: expected.hash },
        storageId,
        metadata,
        options
      );
    }
    return this.#commitSqlite(stream, expected, storageId, metadata, options);
  }

  get(hash: string): AttachmentBlobRow | null {
    return this.getMany([hash]).get(hash) ?? null;
  }

  /** Resolve several whole-file rows with one SQLite read for cache misses. */
  getMany(hashes: readonly string[]): Map<string, AttachmentBlobRow> {
    const result = new Map<string, AttachmentBlobRow>();
    const missing: string[] = [];
    for (const hash of new Set(hashes)) {
      const known = this.#rows.get(hash);
      if (known) result.set(hash, known);
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
      this.#remember(row);
      result.set(row.hash, row);
    }
    return result;
  }

  /** Open one payload as a backpressure-aware stream. */
  async open(hash: string): Promise<ReadableStream<Uint8Array>> {
    const row = this.get(hash);
    if (!row) throw new SessionAttachmentMissingError(hash);
    if (row.backend === "sqlite") {
      return this.#sqliteStream(row.storage_id, hash, row.bytes);
    }
    const bucket = this.#options().bucket;
    if (!bucket || !row.r2_key) throw new SessionAttachmentMissingError(hash);
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
   * Delete one whole-file blob. R2 is deleted before its metadata row so a
   * failed R2 call leaves the resource addressable for a retry.
   */
  async delete(hash: string): Promise<boolean> {
    const row = this.get(hash);
    if (!row) return false;
    if (row.backend === "r2" && row.r2_key) {
      const bucket = this.#options().bucket;
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
    this.#rows.delete(hash);
    return true;
  }

  async #commitSqlite(
    stream: ReadableStream<Uint8Array>,
    expected: Expected,
    storageId: string,
    metadata: BlobMetadata,
    options: BlobStoreOptions
  ): Promise<PutResult> {
    let keep = false;
    try {
      const measured = await writeChunks(
        stream,
        options.maxAttachmentBytes,
        (index, bytes) => this.#insertChunk(storageId, index, bytes)
      );
      assertExpected(measured, expected);
      const existing = this.get(measured.hash);
      if (existing) return { row: existing, created: false };
      if (options.bucket && measured.bytes >= options.r2ThresholdBytes) {
        return await this.#commitR2(
          options.bucket,
          this.#sqliteStream(storageId, measured.hash, measured.bytes),
          measured,
          storageId,
          metadata,
          options
        );
      }
      const result = this.#commitBlob(
        { ...measured, backend: "sqlite", storageId, r2Key: null },
        metadata
      );
      keep = result.created;
      return result;
    } catch (cause) {
      throw storeError(cause, storageId, "SQLite write");
    } finally {
      if (!keep) this.#deleteChunks(storageId);
    }
  }

  async #commitR2(
    bucket: SessionAttachmentBucket,
    stream: ReadableStream<Uint8Array>,
    expected: { bytes: number; hash?: string },
    storageId: string,
    metadata: BlobMetadata,
    options: BlobStoreOptions
  ): Promise<PutResult> {
    const r2Key = `${options.r2Prefix.replace(/\/+$/, "")}/${storageId}`;
    let keep = false;
    try {
      const measured = await uploadFixedLength(
        bucket,
        r2Key,
        stream,
        expected.bytes,
        metadata.mediaType,
        options.maxAttachmentBytes
      );
      if (expected.hash !== undefined && measured.hash !== expected.hash) {
        throw new Error("Replayable attachment changed between reads");
      }
      const result = this.#commitBlob(
        { ...measured, backend: "r2", storageId, r2Key },
        metadata
      );
      keep = result.created;
      return result;
    } catch (cause) {
      throw storeError(cause, r2Key, "R2 put");
    } finally {
      if (!keep) {
        try {
          await bucket.delete(r2Key);
        } catch (cause) {
          this.#io.emit("session:attachment:r2-orphaned", {
            key: r2Key,
            error: cause instanceof Error ? cause.message : String(cause)
          });
        }
      }
    }
  }

  /** The one place that inserts a whole-file row and resolves insert races. */
  #commitBlob(
    input: {
      hash: string;
      bytes: number;
      backend: "sqlite" | "r2";
      storageId: string;
      r2Key: string | null;
    },
    metadata: BlobMetadata
  ): PutResult {
    const row: AttachmentBlobRow = {
      hash: input.hash,
      backend: input.backend,
      storage_id: input.storageId,
      r2_key: input.r2Key,
      bytes: input.bytes,
      media_type: metadata.mediaType,
      filename: metadata.filename ?? null
    };
    const inserted =
      this.#io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_attachment_blobs
           (hash, backend, storage_id, r2_key, bytes, media_type, filename)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          row.hash,
          row.backend,
          row.storage_id,
          row.r2_key,
          row.bytes,
          row.media_type,
          row.filename
        ]
      ) > 0;
    if (inserted) {
      this.#remember(row);
      return { row, created: true };
    }
    const raced = this.get(row.hash);
    if (!raced) {
      throw new Error("Attachment insert lost a race without a stored row");
    }
    return { row: raced, created: false };
  }

  #remember(row: AttachmentBlobRow): void {
    this.#rows.set(row.hash, row);
    if (this.#rows.size <= 256) return;
    const oldest = this.#rows.keys().next().value;
    if (oldest !== undefined) this.#rows.delete(oldest);
  }

  #insertChunk(storageId: string, index: number, bytes: Uint8Array): void {
    this.#io.sqlWrite(
      `INSERT INTO cf_agents_session_attachment_chunks (storage_id, idx, bytes)
       VALUES (?, ?, ?)`,
      [
        storageId,
        index,
        (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            )) as ArrayBuffer
      ]
    );
  }

  #deleteChunks(storageId: string): void {
    this.#io.sqlWrite(
      "DELETE FROM cf_agents_session_attachment_chunks WHERE storage_id = ?",
      [storageId]
    );
  }

  /** One primary-key row per pull; never a cursor over every chunk. */
  #sqliteStream(
    storageId: string,
    hash: string,
    totalBytes: number
  ): ReadableStream<Uint8Array> {
    let index = 0;
    let readBytes = 0;
    const io = this.#io;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readBytes === totalBytes) {
          controller.close();
          return;
        }
        const chunk = io.sql<{ bytes: ArrayBuffer }>(
          `SELECT bytes FROM cf_agents_session_attachment_chunks
           WHERE storage_id = ? AND idx = ?`,
          [storageId, index++]
        )[0];
        const expectedBytes = Math.min(
          SESSION_ATTACHMENT_CHUNK_BYTES,
          totalBytes - readBytes
        );
        if (!chunk || chunk.bytes.byteLength !== expectedBytes) {
          controller.error(new SessionAttachmentMissingError(hash));
          return;
        }
        readBytes += expectedBytes;
        controller.enqueue(new Uint8Array(chunk.bytes));
      }
    });
  }
}

function storeError(cause: unknown, path: string, operation: string): Error {
  if (
    cause instanceof SessionAttachmentTooLargeError ||
    cause instanceof SessionAttachmentStoreError
  ) {
    return cause;
  }
  return new SessionAttachmentStoreError(path, operation, cause);
}

function assertExpected(measured: Measured, expected: Expected): void {
  if (expected.bytes !== undefined && expected.bytes !== measured.bytes) {
    throw new Error(
      `Attachment stream length ${measured.bytes} did not match declared length ${expected.bytes}`
    );
  }
  if (expected.hash !== undefined && expected.hash !== measured.hash) {
    throw new Error("Replayable attachment changed between reads");
  }
}

async function measureSource(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Measured> {
  return writeChunks(stream, maxBytes, () => undefined);
}

/**
 * Hash a stream while handing out fixed windows. At most one window plus the
 * source chunks needed to fill it are held in memory.
 */
async function writeChunks(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  write: (index: number, bytes: Uint8Array) => void | Promise<void>
): Promise<Measured> {
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
      else pending[0] = part.subarray(take);
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

/** Stream a known-length payload straight into R2 while hashing it. */
async function uploadFixedLength(
  bucket: SessionAttachmentBucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  mediaType: string,
  maxBytes: number
): Promise<Measured> {
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
