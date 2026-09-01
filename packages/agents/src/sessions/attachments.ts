/**
 * Attachment offload for the Sessions capability.
 *
 * Large file parts are stored as content-addressed blobs in a structural
 * attachment store (a `@cloudflare/shell` Workspace satisfies it) and the
 * message row keeps a small pointer part — still structurally a valid AI SDK
 * `FileUIPart`, with an `attachment:sha256:<hex>` URL. Reconstruction is a
 * read-side plugin: the default materializes the original `data:` URL back
 * into the part; a custom {@link AttachmentReconstructor} can emit a
 * workspace-path marker or a hosted URL instead.
 *
 * Ordering: blob writes complete BEFORE the message row commits, so a stored
 * pointer always has durable bytes behind it. A crash in between leaves an
 * orphan blob at a content-addressed path — benign: a retry of the same
 * content reuses it, and deletes reap blobs no row references any more.
 */

import {
  SessionAttachmentMissingError,
  SessionAttachmentStoreError,
  SessionAttachmentStoreMissingError,
  SessionAttachmentTooLargeError
} from "./errors";
import type {
  AttachmentReconstructor,
  ReconstructMode,
  ResolvedAttachment,
  SessionAttachmentStore,
  SessionMessage,
  SessionMessagePart,
  SessionsAttachmentOptions
} from "./types";

export const ATTACHMENT_URL_PREFIX = "attachment:sha256:";

const DEFAULT_INLINE_THRESHOLD_BYTES = 32 * 1024;
const DEFAULT_BASE_PATH = "/attachments";
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_KEEP_RECENT_MESSAGES = 8;

/** One offloaded blob referenced from a stored message. */
export interface StoredAttachment {
  /** sha-256 hex of the raw payload — the content address. */
  hash: string;
  /** Store path: `<basePath>/sha256/<hash>`. */
  path: string;
  mediaType: string;
  bytes: number;
  filename?: string;
}

/** @internal Raw `cf_agents_session_attachments` SQLite row. */
export type AttachmentRow = {
  hash: string;
  message_id: string;
  part_index: number;
  session_id: string;
  path: string;
  media_type: string;
  bytes: number;
  filename: string | null;
  created_at: number;
};

/** The hash referenced by an `attachment:` pointer URL, or null. */
export function parseAttachmentUrl(url: string | undefined): string | null {
  if (!url || !url.startsWith(ATTACHMENT_URL_PREFIX)) return null;
  const hash = url.slice(ATTACHMENT_URL_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

export function attachmentUrl(hash: string): string {
  return `${ATTACHMENT_URL_PREFIX}${hash}`;
}

/** Marker part emitted when a pointer's payload cannot be materialized. */
function missingAttachmentPart(
  mediaType: string,
  filename: string | undefined
): SessionMessagePart {
  const name = filename ? ` ${JSON.stringify(filename)}` : "";
  return {
    type: "text",
    text: `[attachment${name} (${mediaType}) is no longer available]`
  };
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode a `data:` URL into bytes plus its media type, or null. */
export function decodeDataUrl(
  url: string
): { bytes: Uint8Array; mediaType: string } | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const isBase64 = header.endsWith(";base64");
  const mediaType =
    (isBase64 ? header.slice(0, -7) : header).split(";")[0] ||
    "application/octet-stream";
  try {
    const bytes = isBase64
      ? decodeBase64(payload)
      : new TextEncoder().encode(decodeURIComponent(payload));
    return { bytes, mediaType };
  } catch {
    return null;
  }
}

/**
 * Approximate decoded size of a `data:` URL without decoding it — used to
 * gate offload so below-threshold parts never pay a decode.
 */
export function estimatedDataUrlBytes(url: string): number {
  const comma = url.indexOf(",");
  if (comma < 0) return 0;
  const payloadLength = url.length - comma - 1;
  return url.lastIndexOf(";base64,", comma) >= 0
    ? Math.floor((payloadLength * 3) / 4)
    : payloadLength;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Default read-side plugin: inline the payload as a `data:` URL again. */
export const inlineReconstructor: AttachmentReconstructor = {
  async part(attachment) {
    return {
      type: "file",
      mediaType: attachment.mediaType,
      ...(attachment.filename !== undefined
        ? { filename: attachment.filename }
        : {}),
      url: await attachment.dataUrl()
    };
  }
};

/**
 * Zero-IO plugin: replace the pointer with a short text marker naming the
 * store path — the "hand the model a workspace path" materialization.
 */
export const pointerReconstructor: AttachmentReconstructor = {
  part(attachment) {
    const name = attachment.filename
      ? `${JSON.stringify(attachment.filename)} `
      : "";
    return {
      type: "text",
      text: `[file ${name}(${attachment.mediaType}, ${attachment.bytes} bytes) stored at ${attachment.path}]`
    };
  }
};

/** @internal SQL and telemetry the engine borrows from the capability. */
export interface AttachmentEngineIo {
  sql<T>(query: string, params: (string | number | null)[]): T[];
  sqlWrite(query: string, params: (string | number | null)[]): number;
  emit(type: string, payload: Record<string, unknown>): void;
}

/** Result of extracting oversized inline media from one message. */
export interface ExtractionResult {
  message: SessionMessage;
  attachments: StoredAttachment[];
  /** True when at least one part was rewritten. */
  changed: boolean;
}

/**
 * @internal Per-capability attachment machinery. Owns the pointer contract;
 * varies only by where bytes live (the store seam) and how pointers
 * materialize (the reconstructor plugin).
 */
export class AttachmentEngine {
  readonly #options: SessionsAttachmentOptions | undefined;
  readonly #io: AttachmentEngineIo;
  readonly #knownBlobs = new Map<string, StoredAttachment>();
  #store: SessionAttachmentStore | undefined;
  #warnedNoStore = false;

  constructor(
    options: SessionsAttachmentOptions | undefined,
    io: AttachmentEngineIo
  ) {
    this.#options = options;
    this.#io = io;
  }

  get configured(): boolean {
    return this.#options !== undefined;
  }

  get inlineThresholdBytes(): number {
    return (
      this.#options?.inlineThresholdBytes ?? DEFAULT_INLINE_THRESHOLD_BYTES
    );
  }

  get keepRecentMessages(): number {
    const keep = this.#options?.keepRecentMessages;
    const resolved = typeof keep === "function" ? keep() : keep;
    return Math.max(1, resolved ?? DEFAULT_KEEP_RECENT_MESSAGES);
  }

  get maxEvictionRowsPerPass(): number {
    return Math.max(1, this.#options?.maxEvictionRowsPerPass ?? 64);
  }

  get defaultReconstructor(): AttachmentReconstructor {
    return this.#options?.reconstruct ?? inlineReconstructor;
  }

  resolveReconstructor(
    mode: ReconstructMode | undefined
  ): AttachmentReconstructor | null {
    if (mode === "pointer") return null;
    if (mode === undefined || mode === "inline") {
      return mode === "inline"
        ? inlineReconstructor
        : this.defaultReconstructor;
    }
    return mode;
  }

  #resolveStore(): SessionAttachmentStore | undefined {
    if (this.#store) return this.#store;
    const store = this.#options?.store;
    this.#store = typeof store === "function" ? store() : store;
    return this.#store;
  }

  #requireStore(operation: string): SessionAttachmentStore {
    const store = this.#resolveStore();
    if (!store) throw new SessionAttachmentStoreMissingError(operation);
    return store;
  }

  #path(hash: string): string {
    const base = this.#options?.basePath ?? DEFAULT_BASE_PATH;
    return `${base.replace(/\/+$/, "")}/sha256/${hash}`;
  }

  /**
   * Store one payload content-addressed and return its pointer part plus
   * record. The attachment ROW is written when a message referencing the
   * pointer is appended; a put that is never referenced is reaped by GC.
   */
  async put(
    data: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string,
    options: { mediaType: string; filename?: string }
  ): Promise<{ part: SessionMessagePart; attachment: StoredAttachment }> {
    const store = this.#requireStore("attachments.put()");
    const bytes = await this.#collectBytes(data);
    const attachment = await this.#writeBlob(store, bytes, options);
    return {
      part: {
        type: "file",
        mediaType: attachment.mediaType,
        ...(attachment.filename !== undefined
          ? { filename: attachment.filename }
          : {}),
        url: attachmentUrl(attachment.hash)
      },
      attachment
    };
  }

  /** Return stored metadata for one hash, when known. */
  get(hash: string): StoredAttachment | null {
    const known = this.#knownBlobs.get(hash);
    if (known) return known;
    const row = this.#io.sql<AttachmentRow>(
      `SELECT * FROM cf_agents_session_attachments
       WHERE hash = ? LIMIT 1`,
      [hash]
    )[0];
    if (!row) return null;
    const attachment: StoredAttachment = {
      hash: row.hash,
      path: row.path,
      mediaType: row.media_type,
      bytes: row.bytes,
      ...(row.filename !== null ? { filename: row.filename } : {})
    };
    this.#knownBlobs.set(hash, attachment);
    return attachment;
  }

  /** Open one stored payload by pointer hash. */
  async open(hash: string): Promise<ReadableStream<Uint8Array>> {
    const store = this.#requireStore("attachments.open()");
    const path = this.get(hash)?.path ?? this.#path(hash);
    let stream: ReadableStream<Uint8Array> | null;
    try {
      stream = await store.readFileStream(path);
    } catch (cause) {
      throw new SessionAttachmentStoreError(path, "readFileStream", cause);
    }
    if (!stream) throw new SessionAttachmentMissingError(hash, path);
    return stream;
  }

  async #collectBytes(
    data: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string
  ): Promise<Uint8Array> {
    const max =
      this.#options?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      const parts: Uint8Array[] = [];
      let total = 0;
      // Streams are buffered: hashing needs the full payload, and stores
      // buffer stream writes anyway. The ceiling keeps DO memory bounded.
      for await (const part of data) {
        total += part.byteLength;
        if (total > max) {
          throw new SessionAttachmentTooLargeError(total, max);
        }
        parts.push(part);
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
    }
    if (bytes.byteLength > max) {
      throw new SessionAttachmentTooLargeError(bytes.byteLength, max);
    }
    return bytes;
  }

  async #writeBlob(
    store: SessionAttachmentStore,
    bytes: Uint8Array,
    options: { mediaType: string; filename?: string }
  ): Promise<StoredAttachment> {
    const hash = await sha256Hex(bytes);
    const path = this.#path(hash);
    let existing: { size: number } | null;
    try {
      existing = await store.stat(path);
    } catch (cause) {
      throw new SessionAttachmentStoreError(path, "stat", cause);
    }
    if (!existing) {
      try {
        await store.writeFileBytes(path, bytes, options.mediaType);
      } catch (cause) {
        throw new SessionAttachmentStoreError(path, "writeFileBytes", cause);
      }
      this.#io.emit("session:attachment:stored", {
        hash,
        bytes: bytes.byteLength,
        mediaType: options.mediaType
      });
    }
    const attachment: StoredAttachment = {
      hash,
      path,
      mediaType: options.mediaType,
      bytes: bytes.byteLength,
      ...(options.filename !== undefined ? { filename: options.filename } : {})
    };
    this.#knownBlobs.set(hash, attachment);
    if (this.#knownBlobs.size > 256) {
      const oldest = this.#knownBlobs.keys().next().value;
      if (oldest !== undefined) this.#knownBlobs.delete(oldest);
    }
    return attachment;
  }

  /**
   * Offload oversized inline `data:` file parts from one message. Blob
   * writes complete before this returns, so the caller's row commit always
   * points at durable bytes. Below-threshold and non-`data:` parts pass
   * through untouched; with no store configured the message is returned
   * unchanged (with a one-time warning when oversized media flows past).
   */
  async extract(message: SessionMessage): Promise<ExtractionResult> {
    const store = this.#resolveStore();
    const attachments: StoredAttachment[] = [];
    if (!this.configured || !store) {
      if (
        !this.#warnedNoStore &&
        message.parts.some(
          (part) =>
            part.type === "file" &&
            typeof part.url === "string" &&
            part.url.startsWith("data:") &&
            estimatedDataUrlBytes(part.url) >= this.inlineThresholdBytes
        )
      ) {
        this.#warnedNoStore = true;
        console.warn(
          "[Sessions] Oversized inline media was stored without an " +
            "attachment store; configure { attachments: { store } } to " +
            "offload it."
        );
      }
      return { message, attachments, changed: false };
    }

    let changed = false;
    const parts: SessionMessagePart[] = [];
    for (const part of message.parts) {
      if (
        part.type !== "file" ||
        typeof part.url !== "string" ||
        !part.url.startsWith("data:") ||
        estimatedDataUrlBytes(part.url) < this.inlineThresholdBytes
      ) {
        parts.push(part);
        continue;
      }
      const decoded = decodeDataUrl(part.url);
      if (!decoded) {
        parts.push(part);
        continue;
      }
      const attachment = await this.#writeBlob(store, decoded.bytes, {
        mediaType: part.mediaType ?? decoded.mediaType,
        ...(part.filename !== undefined ? { filename: part.filename } : {})
      });
      attachments.push(attachment);
      parts.push({
        ...part,
        mediaType: attachment.mediaType,
        url: attachmentUrl(attachment.hash)
      });
      changed = true;
    }
    return {
      message: changed ? { ...message, parts } : message,
      attachments,
      changed
    };
  }

  /**
   * Record reference rows for every pointer part of a stored message.
   * Idempotent on (hash, message_id, part_index). `known` carries records
   * from a just-run extraction so their metadata never needs a store probe.
   */
  recordReferences(
    sessionId: string,
    message: SessionMessage,
    known: readonly StoredAttachment[],
    now: number
  ): number {
    const knownByHash = new Map(this.#knownBlobs);
    for (const attachment of known) {
      knownByHash.set(attachment.hash, attachment);
    }

    let totalBytes = 0;
    const referenced = new Set<string>();
    message.parts.forEach((part, index) => {
      const hash = parseAttachmentUrl(part.url);
      if (!hash) return;
      const record = knownByHash.get(hash);
      const bytes = record?.bytes ?? this.#referencedBytes(hash) ?? 0;
      this.#io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_attachments
           (hash, message_id, part_index, session_id, path, media_type, bytes, filename, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hash,
          message.id,
          index,
          sessionId,
          record?.path ?? this.#path(hash),
          record?.mediaType ?? part.mediaType ?? "application/octet-stream",
          bytes,
          record?.filename ?? part.filename ?? null,
          now
        ]
      );
      referenced.add(hash);
      totalBytes += bytes;
    });

    // Tool-output eviction leaves a marker inside the existing part rather
    // than changing its shape to a file part. Negative indexes retain those
    // blob references for GC without colliding with real message-part indexes.
    let syntheticPartIndex = -1;
    for (const attachment of known) {
      if (referenced.has(attachment.hash)) continue;
      this.#io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_attachments
           (hash, message_id, part_index, session_id, path, media_type, bytes, filename, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attachment.hash,
          message.id,
          syntheticPartIndex--,
          sessionId,
          attachment.path,
          attachment.mediaType,
          attachment.bytes,
          attachment.filename ?? null,
          now
        ]
      );
      referenced.add(attachment.hash);
      totalBytes += attachment.bytes;
    }
    return totalBytes;
  }

  /**
   * Replace one message's derived reference rows synchronously, then reap
   * blobs that the old row no longer references. New references exist before
   * any asynchronous store delete starts.
   */
  replaceReferences(
    sessionId: string,
    message: SessionMessage,
    known: readonly StoredAttachment[],
    now: number
  ): Promise<void> {
    const previous = this.#io.sql<{ hash: string; path: string }>(
      `SELECT hash, path FROM cf_agents_session_attachments
       WHERE message_id = ? AND session_id = ?`,
      [message.id, sessionId]
    );
    this.#io.sqlWrite(
      `DELETE FROM cf_agents_session_attachments
       WHERE message_id = ? AND session_id = ?`,
      [message.id, sessionId]
    );
    this.recordReferences(sessionId, message, known, now);
    return this.#reapUnreferenced(
      new Map(previous.map((row) => [row.hash, row.path]))
    );
  }

  /** Known byte size of a hash from any existing reference row. */
  #referencedBytes(hash: string): number | undefined {
    const rows = this.#io.sql<{ bytes: number }>(
      "SELECT bytes FROM cf_agents_session_attachments WHERE hash = ? LIMIT 1",
      [hash]
    );
    return rows[0]?.bytes;
  }

  /**
   * Trust boundary for client-source writes: a pointer part is accepted
   * only when its hash is already referenced somewhere in this session
   * (a legitimate echo of stored history). Anything else — a forged or
   * cross-session pointer — degrades to a marker.
   */
  guardClientPointers(
    sessionId: string,
    message: SessionMessage
  ): SessionMessage {
    let changed = false;
    const parts = message.parts.map((part) => {
      const hash = parseAttachmentUrl(part.url);
      if (!hash) return part;
      const known = this.#io.sql<{ hash: string }>(
        `SELECT hash FROM cf_agents_session_attachments
         WHERE hash = ? AND session_id = ? LIMIT 1`,
        [hash, sessionId]
      );
      if (known.length > 0) return part;
      changed = true;
      return missingAttachmentPart(
        part.mediaType ?? "application/octet-stream",
        part.filename
      );
    });
    return changed ? { ...message, parts } : message;
  }

  /**
   * Materialize pointer parts of one stored message through a
   * reconstructor. `null` reconstructor (pointer mode) returns the message
   * untouched with zero IO. Missing payloads degrade to markers — reads
   * never throw on data loss.
   */
  async materialize(
    sessionId: string,
    message: SessionMessage,
    reconstructor: AttachmentReconstructor | null
  ): Promise<SessionMessage> {
    if (!reconstructor) return message;
    let changed = false;
    const parts: SessionMessagePart[] = [];
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index];
      const hash = parseAttachmentUrl(part.url);
      if (!hash) {
        parts.push(part);
        continue;
      }
      changed = true;
      parts.push(
        await this.materializePartWith(
          reconstructor,
          sessionId,
          message.id,
          index,
          part,
          hash
        )
      );
    }
    return changed ? { ...message, parts } : message;
  }

  /** @internal Materialize one pointer part through a given reconstructor. */
  async materializePartWith(
    reconstructor: AttachmentReconstructor,
    sessionId: string,
    messageId: string,
    partIndex: number,
    part: SessionMessagePart,
    hash: string
  ): Promise<SessionMessagePart> {
    const store = this.#resolveStore();
    const rows = this.#io.sql<AttachmentRow>(
      `SELECT * FROM cf_agents_session_attachments
       WHERE hash = ? AND message_id = ? AND part_index = ?`,
      [hash, messageId, partIndex]
    );
    const row =
      rows[0] ??
      this.#io.sql<AttachmentRow>(
        "SELECT * FROM cf_agents_session_attachments WHERE hash = ? LIMIT 1",
        [hash]
      )[0];
    const mediaType =
      row?.media_type ?? part.mediaType ?? "application/octet-stream";
    const filename = row?.filename ?? part.filename ?? undefined;
    const path = row?.path ?? this.#path(hash);
    if (!store) {
      this.#io.emit("session:attachment:missing", { hash, sessionId });
      return missingAttachmentPart(mediaType, filename);
    }

    let bytesCache: Uint8Array | null | undefined;
    const readBytes = async (): Promise<Uint8Array | null> => {
      if (bytesCache !== undefined) return bytesCache;
      try {
        bytesCache = await store.readFileBytes(path);
      } catch {
        bytesCache = null;
      }
      return bytesCache;
    };

    const resolved: ResolvedAttachment = {
      hash,
      path,
      mediaType,
      bytes: row?.bytes ?? 0,
      ...(filename !== undefined ? { filename } : {}),
      data: async () => {
        const bytes = await readBytes();
        if (!bytes) throw new SessionAttachmentMissingError(hash, path);
        return bytes;
      },
      dataUrl: async () => {
        const bytes = await readBytes();
        if (!bytes) throw new SessionAttachmentMissingError(hash, path);
        return `data:${mediaType};base64,${encodeBase64(bytes)}`;
      },
      stream: () => store.readFileStream(path)
    };

    try {
      return await reconstructor.part(resolved, {
        sessionId,
        messageId,
        partIndex
      });
    } catch (error) {
      if (error instanceof SessionAttachmentMissingError) {
        this.#io.emit("session:attachment:missing", { hash, sessionId });
        return missingAttachmentPart(mediaType, filename);
      }
      throw error;
    }
  }

  /**
   * Drop reference rows for deleted messages and reap blobs nothing
   * references any more. References are DERIVED, never refcounted: the row
   * deletes and the existence probe run in the caller's synchronous block;
   * only the store deletes are async and best-effort.
   */
  async collectGarbage(sessionId: string, messageIds: string[]): Promise<void> {
    const affected = new Map<string, string>();
    for (const messageId of messageIds) {
      const rows = this.#io.sql<{ hash: string; path: string }>(
        `SELECT hash, path FROM cf_agents_session_attachments
         WHERE message_id = ? AND session_id = ?`,
        [messageId, sessionId]
      );
      for (const row of rows) affected.set(row.hash, row.path);
      this.#io.sqlWrite(
        `DELETE FROM cf_agents_session_attachments
         WHERE message_id = ? AND session_id = ?`,
        [messageId, sessionId]
      );
    }
    await this.#reapUnreferenced(affected);
  }

  /** Reap newly written blobs when an append loses an idempotency race. */
  async discardUnreferenced(
    attachments: readonly StoredAttachment[]
  ): Promise<void> {
    await this.#reapUnreferenced(
      new Map(
        attachments.map((attachment) => [attachment.hash, attachment.path])
      )
    );
  }

  /** Clear-time sweep: drop the session's reference rows, reap orphans. */
  async collectSessionGarbage(sessionId: string): Promise<void> {
    const rows = this.#io.sql<{ hash: string; path: string }>(
      `SELECT DISTINCT hash, path FROM cf_agents_session_attachments
       WHERE session_id = ?`,
      [sessionId]
    );
    this.#io.sqlWrite(
      "DELETE FROM cf_agents_session_attachments WHERE session_id = ?",
      [sessionId]
    );
    await this.#reapUnreferenced(
      new Map(rows.map((row) => [row.hash, row.path]))
    );
  }

  async #reapUnreferenced(attachments: Map<string, string>): Promise<void> {
    const store = this.#resolveStore();
    for (const [hash, path] of attachments) {
      const remaining = this.#io.sql<{ hash: string }>(
        "SELECT hash FROM cf_agents_session_attachments WHERE hash = ? LIMIT 1",
        [hash]
      );
      if (remaining.length > 0) continue;
      this.#knownBlobs.delete(hash);
      if (store) {
        try {
          await store.deleteFile(path);
          this.#io.emit("session:attachment:reaped", { hash });
        } catch {
          // Best-effort: an unreaped blob is storage overhead, not
          // incorrectness; the next GC touching this hash retries.
        }
      }
    }
  }

  /** Attachment bytes referenced by a set of message ids (path stats). */
  attachmentBytesByMessage(
    sessionId: string,
    messageIds: string[]
  ): Map<string, number> {
    const result = new Map<string, number>();
    if (messageIds.length === 0) return result;
    const rows = this.#io.sql<{ message_id: string; total: number }>(
      `SELECT message_id, SUM(bytes) AS total
       FROM cf_agents_session_attachments
       WHERE session_id = ?
         AND message_id IN (SELECT value FROM json_each(?))
       GROUP BY message_id`,
      [sessionId, JSON.stringify(messageIds)]
    );
    for (const row of rows) result.set(row.message_id, row.total);
    return result;
  }
}
