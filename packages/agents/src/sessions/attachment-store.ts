/**
 * Content-addressed byte storage for session attachments.
 *
 * An attachment is a typed media payload that never belongs inside a message
 * row: an image, an audio clip, a PDF. The store holds the raw bytes under
 * their SHA-256 and hands back a content address; the message keeps only a
 * pointer part. Payloads larger than one SQLite row are split across numbered
 * chunk rows, the same way an oversized message is.
 *
 * Everything here is synchronous, so bytes and the message row that points at
 * them commit in ONE transaction. There is no window in which a stored pointer
 * has no bytes behind it, and no cleanup pass for half-written payloads.
 *
 * Content addressing buys idempotency — a replayed append re-derives the same
 * address and stores nothing new. It is not a space-saving claim: two messages
 * that happen to carry the same image share a record, but nothing in the design
 * depends on that being common.
 */

import { createHash } from "node:crypto";
import { MAX_INLINE_ROW_BYTES } from "./chunking";
import type { SessionsIo } from "./io";

/**
 * SQLite window for one attachment chunk. Attachments are immutable, so a
 * larger row means fewer billed writes; this leaves headroom below SQLite's
 * 2 MiB ceiling for the row key and record overhead.
 */
export const ATTACHMENT_CHUNK_BYTES = MAX_INLINE_ROW_BYTES;

/** Metadata for one stored payload. */
export interface AttachmentRecord {
  /** SHA-256 hex of the raw bytes — the content address. */
  hash: string;
  mediaType: string;
  bytes: number;
}

/** @internal Bytes plus the type they were declared with. */
export interface AttachmentBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** The content address of a payload. Pure: no storage access. */
export function hashPayload(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A standalone copy of a slice, since `SqlParam` accepts only `ArrayBuffer`. */
function chunkBuffer(
  bytes: Uint8Array,
  start: number,
  end: number
): ArrayBuffer {
  return bytes.slice(start, end).buffer as ArrayBuffer;
}

export class AttachmentStore {
  readonly #io: SessionsIo;

  constructor(io: SessionsIo) {
    this.#io = io;
  }

  ensureTables(): void {
    this.#io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_attachment_meta (
        hash TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        chunks INTEGER NOT NULL
      ) WITHOUT ROWID`,
      []
    );
    this.#io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_attachment_chunks (
        hash TEXT NOT NULL,
        idx INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (hash, idx)
      ) WITHOUT ROWID`,
      []
    );
    // Reference rows give an attachment its lifetime. There is deliberately no
    // index on `hash`: this table takes a write on every attachment append, and
    // the reachability check that reads it is a scan of a small table, which is
    // far cheaper than maintaining an index on the write path.
    this.#io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_attachment_refs (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id, hash)
      ) WITHOUT ROWID`,
      []
    );
  }

  /**
   * Store one payload under its precomputed address. Idempotent: bytes that
   * are already present cost a single read and no writes.
   *
   * Call inside the caller's transaction so the payload and the message that
   * references it commit together. The address is passed in rather than
   * derived so hashing stays outside the transaction.
   */
  put(payload: AttachmentBytes, hash: string): void {
    const { bytes, mediaType } = payload;
    const existing = this.#io.sql<{ hash: string }>(
      "SELECT hash FROM cf_agents_session_attachment_meta WHERE hash = ?",
      [hash]
    );
    if (existing.length > 0) return;

    let chunks = 0;
    for (let start = 0; start < bytes.length; start += ATTACHMENT_CHUNK_BYTES) {
      const end = Math.min(start + ATTACHMENT_CHUNK_BYTES, bytes.length);
      this.#io.sqlWrite(
        "INSERT INTO cf_agents_session_attachment_chunks (hash, idx, data) VALUES (?, ?, ?)",
        [hash, chunks, chunkBuffer(bytes, start, end)]
      );
      chunks++;
    }
    this.#io.sqlWrite(
      `INSERT INTO cf_agents_session_attachment_meta (hash, bytes, media_type, chunks)
       VALUES (?, ?, ?, ?)`,
      [hash, bytes.length, mediaType, chunks]
    );
  }

  /** Read one payload back, or `undefined` when the address is unknown. */
  get(hash: string): AttachmentBytes | undefined {
    const [meta] = this.#io.sql<{
      bytes: number;
      media_type: string;
      chunks: number;
    }>(
      "SELECT bytes, media_type, chunks FROM cf_agents_session_attachment_meta WHERE hash = ?",
      [hash]
    );
    if (!meta) return undefined;

    const out = new Uint8Array(meta.bytes);
    if (meta.chunks > 0) {
      const rows = this.#io.sql<{ idx: number; data: ArrayBuffer }>(
        "SELECT idx, data FROM cf_agents_session_attachment_chunks WHERE hash = ? ORDER BY idx",
        [hash]
      );
      let offset = 0;
      for (const row of rows) {
        const slice = new Uint8Array(row.data);
        out.set(slice, offset);
        offset += slice.length;
      }
    }
    return { mediaType: meta.media_type, bytes: out };
  }

  /** Metadata without the bytes — enough to size a payload or label a pointer. */
  describe(hash: string): AttachmentRecord | undefined {
    const [meta] = this.#io.sql<{ bytes: number; media_type: string }>(
      "SELECT bytes, media_type FROM cf_agents_session_attachment_meta WHERE hash = ?",
      [hash]
    );
    if (!meta) return undefined;
    return { hash, mediaType: meta.media_type, bytes: meta.bytes };
  }

  /** Record that one message references these payloads. */
  addRefs(
    sessionId: string,
    messageId: string,
    hashes: readonly string[]
  ): void {
    for (const hash of hashes) {
      this.#io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_attachment_refs
           (session_id, message_id, hash) VALUES (?, ?, ?)`,
        [sessionId, messageId, hash]
      );
    }
  }

  /**
   * Point one message at exactly `hashes`, adding and dropping references to
   * match, and collect whatever that orphaned. Call after the new payloads are
   * stored, so a hash the message still uses is never briefly unreferenced.
   */
  replaceRefs(
    sessionId: string,
    messageId: string,
    hashes: readonly string[]
  ): void {
    const current = this.#io.sql<{ hash: string }>(
      `SELECT hash FROM cf_agents_session_attachment_refs
        WHERE session_id = ? AND message_id = ?`,
      [sessionId, messageId]
    );
    const wanted = new Set(hashes);
    const held = new Set(current.map((row) => row.hash));
    const dropped: string[] = [];
    for (const hash of held) {
      if (wanted.has(hash)) continue;
      this.#io.sqlWrite(
        `DELETE FROM cf_agents_session_attachment_refs
          WHERE session_id = ? AND message_id = ? AND hash = ?`,
        [sessionId, messageId, hash]
      );
      dropped.push(hash);
    }
    this.addRefs(
      sessionId,
      messageId,
      hashes.filter((hash) => !held.has(hash))
    );
    if (dropped.length > 0) this.#collect(dropped);
  }

  /**
   * Drop the references held by the given messages and collect any payload
   * that no longer has a reader.
   */
  releaseMessages(sessionId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const ids = JSON.stringify(messageIds);
    const orphanCandidates = this.#io.sql<{ hash: string }>(
      `SELECT DISTINCT hash FROM cf_agents_session_attachment_refs
        WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    if (orphanCandidates.length === 0) return;
    this.#io.sqlWrite(
      `DELETE FROM cf_agents_session_attachment_refs
        WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    this.#collect(orphanCandidates.map((row) => row.hash));
  }

  /** Drop every reference held by one session and collect what it orphaned. */
  releaseSession(sessionId: string): void {
    const candidates = this.#io.sql<{ hash: string }>(
      "SELECT DISTINCT hash FROM cf_agents_session_attachment_refs WHERE session_id = ?",
      [sessionId]
    );
    if (candidates.length === 0) return;
    this.#io.sqlWrite(
      "DELETE FROM cf_agents_session_attachment_refs WHERE session_id = ?",
      [sessionId]
    );
    this.#collect(candidates.map((row) => row.hash));
  }

  /** Delete payloads that no reference points at any more. */
  #collect(hashes: readonly string[]): void {
    for (const hash of hashes) {
      const stillReferenced = this.#io.sql<{ hash: string }>(
        "SELECT hash FROM cf_agents_session_attachment_refs WHERE hash = ? LIMIT 1",
        [hash]
      );
      if (stillReferenced.length > 0) continue;
      this.#io.sqlWrite(
        "DELETE FROM cf_agents_session_attachment_chunks WHERE hash = ?",
        [hash]
      );
      this.#io.sqlWrite(
        "DELETE FROM cf_agents_session_attachment_meta WHERE hash = ?",
        [hash]
      );
    }
  }
}
