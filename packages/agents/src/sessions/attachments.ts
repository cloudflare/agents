/**
 * Attachment offload for the Sessions capability.
 *
 * Large file parts are stored as content-addressed blobs in Sessions-owned
 * chunked SQLite or an optional private R2 tier. The message row keeps a small
 * pointer part, still structurally a valid AI SDK `FileUIPart`, with an
 * `attachment:sha256:<hex>` URL. Reconstruction is a read-side plugin: the
 * default materializes the original `data:` URL; a custom
 * {@link AttachmentReconstructor} can seed a Workspace or emit a hosted URL.
 *
 * Ordering: blob writes complete BEFORE the message row commits, so a stored
 * pointer always has durable bytes behind it. A crash in between can leave a
 * staged SQLite upload or private R2 object; bounded later maintenance reaps
 * it. Whole-file hashes deduplicate successful retries.
 */

import { SessionAttachmentMissingError } from "./errors";
import {
  SESSION_ATTACHMENT_CHUNK_BYTES,
  SessionAttachmentStorage,
  type AttachmentByteSource,
  type SessionAttachmentStorageIo
} from "./attachment-storage";
import type {
  AttachmentReconstructor,
  ReconstructMode,
  ResolvedAttachment,
  SessionMessage,
  SessionMessagePart,
  SessionsAttachmentOptions
} from "./types";

export const ATTACHMENT_URL_PREFIX = "attachment:sha256:";

const DEFAULT_INLINE_THRESHOLD_BYTES = 32 * 1024;
const DEFAULT_BASE_PATH = "/attachments";
const STRING_STREAM_CHARS = 256 * 1024;
const BASE64_STREAM_CHARS = (SESSION_ATTACHMENT_CHUNK_BYTES / 3) * 4;
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

async function streamDataUrl(
  stream: ReadableStream<Uint8Array>,
  mediaType: string
): Promise<string> {
  const encoded: string[] = [`data:${mediaType};base64,`];
  const reader = stream.getReader();
  let carry = new Uint8Array();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      let bytes = value;
      if (carry.byteLength > 0) {
        const merged = new Uint8Array(carry.byteLength + value.byteLength);
        merged.set(carry);
        merged.set(value, carry.byteLength);
        bytes = merged;
      }
      const completeBytes = bytes.byteLength - (bytes.byteLength % 3);
      if (completeBytes > 0) {
        encoded.push(encodeBase64(bytes.subarray(0, completeBytes)));
      }
      carry = bytes.slice(completeBytes);
    }
    if (carry.byteLength > 0) encoded.push(encodeBase64(carry));
    return encoded.join("");
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
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

function byteArrayStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent && bytes.byteLength > 0) {
        sent = true;
        controller.enqueue(bytes);
      }
      controller.close();
    }
  });
}

function stringStream(value: string): ReadableStream<Uint8Array> {
  let offset = 0;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= value.length) {
        controller.close();
        return;
      }
      let end = Math.min(value.length, offset + STRING_STREAM_CHARS);
      if (
        end < value.length &&
        end > offset &&
        value.charCodeAt(end - 1) >= 0xd800 &&
        value.charCodeAt(end - 1) <= 0xdbff
      ) {
        end--;
      }
      controller.enqueue(encoder.encode(value.slice(offset, end)));
      offset = end;
    }
  });
}

function attachmentSource(
  data: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string,
  bytes: number | undefined
): AttachmentByteSource {
  if (typeof data === "string") {
    return { kind: "replayable", open: () => stringStream(data) };
  }
  if (data instanceof Uint8Array) {
    return { kind: "replayable", open: () => byteArrayStream(data) };
  }
  if (data instanceof ArrayBuffer) {
    const view = new Uint8Array(data);
    return { kind: "replayable", open: () => byteArrayStream(view) };
  }
  return {
    kind: "stream",
    stream: data,
    ...(bytes !== undefined ? { bytes } : {})
  };
}

function normalizeBase64Payload(payload: string): string | null {
  const normalized = /[\t\n\f\r ]/.test(payload)
    ? payload.replace(/[\t\n\f\r ]/g, "")
    : payload;
  if (normalized.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  return normalized;
}

function base64Stream(payload: string): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.length) {
        controller.close();
        return;
      }
      let end = Math.min(payload.length, offset + BASE64_STREAM_CHARS);
      if (end < payload.length) end -= (end - offset) % 4;
      const binary = atob(payload.slice(offset, end));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }
      offset = end;
      controller.enqueue(bytes);
    }
  });
}

function dataUrlSource(url: string): {
  source: AttachmentByteSource;
  mediaType: string;
} | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const base64 = header.endsWith(";base64");
  const mediaType =
    (base64 ? header.slice(0, -7) : header).split(";")[0] ||
    "application/octet-stream";

  if (!base64) {
    const decoded = decodeDataUrl(url);
    return decoded
      ? {
          mediaType: decoded.mediaType,
          source: {
            kind: "replayable",
            open: () => byteArrayStream(decoded.bytes)
          }
        }
      : null;
  }

  const normalized = normalizeBase64Payload(payload);
  if (normalized === null) return null;
  return {
    mediaType,
    source: {
      kind: "replayable",
      open: () => base64Stream(normalized)
    }
  };
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
 * Zero-IO plugin: replace the pointer with a short text marker naming its
 * logical Sessions locator. This does not claim the attachment is a Workspace
 * file; use a custom reconstructor to seed one when a tool needs a file path.
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
export interface AttachmentEngineIo extends SessionAttachmentStorageIo {}

/** Result of extracting oversized inline media from one message. */
export interface ExtractionResult {
  message: SessionMessage;
  attachments: StoredAttachment[];
  /** True when at least one part was rewritten. */
  changed: boolean;
}

/**
 * @internal Per-capability attachment machinery. Owns the pointer contract,
 * durable byte storage, reference tracking, and read-side reconstruction.
 */
export class AttachmentEngine {
  readonly #optionsInput:
    | SessionsAttachmentOptions
    | (() => SessionsAttachmentOptions | undefined)
    | undefined;
  readonly #io: AttachmentEngineIo;
  readonly #storage: SessionAttachmentStorage;
  readonly #knownBlobs = new Map<string, StoredAttachment>();
  readonly #createdAttachments = new WeakSet<StoredAttachment>();

  constructor(
    options:
      | SessionsAttachmentOptions
      | (() => SessionsAttachmentOptions | undefined)
      | undefined,
    io: AttachmentEngineIo
  ) {
    this.#optionsInput = options;
    this.#io = io;
    this.#storage = new SessionAttachmentStorage(options, io);
  }

  #options(): SessionsAttachmentOptions | undefined {
    return typeof this.#optionsInput === "function"
      ? this.#optionsInput()
      : this.#optionsInput;
  }

  get configured(): boolean {
    return this.#options() !== undefined;
  }

  get inlineThresholdBytes(): number {
    const threshold = this.#options()?.inlineThresholdBytes;
    const resolved = typeof threshold === "function" ? threshold() : threshold;
    return Math.max(1, resolved ?? DEFAULT_INLINE_THRESHOLD_BYTES);
  }

  get evictionThresholdBytes(): number {
    const threshold = this.#options()?.evictionThresholdBytes;
    const resolved = typeof threshold === "function" ? threshold() : threshold;
    return Math.max(1, resolved ?? this.inlineThresholdBytes);
  }

  get keepRecentMessages(): number {
    const keep = this.#options()?.keepRecentMessages;
    const resolved = typeof keep === "function" ? keep() : keep;
    return Math.max(1, resolved ?? DEFAULT_KEEP_RECENT_MESSAGES);
  }

  get maxEvictionRowsPerPass(): number {
    const maximum = this.#options()?.maxEvictionRowsPerPass;
    const resolved = typeof maximum === "function" ? maximum() : maximum;
    return Math.max(1, resolved ?? 64);
  }

  get agedEvictionEnabled(): boolean {
    const enabled = this.#options()?.evictAged;
    return (typeof enabled === "function" ? enabled() : enabled) ?? true;
  }

  get preserveEvicted(): boolean {
    const preserve = this.#options()?.preserveEvicted;
    return (typeof preserve === "function" ? preserve() : preserve) ?? true;
  }

  get defaultReconstructor(): AttachmentReconstructor {
    return this.#options()?.reconstruct ?? inlineReconstructor;
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

  /** Ensure the Sessions-owned attachment byte tables exist. */
  ensureTables(): void {
    this.#storage.ensureTables();
  }

  #path(hash: string): string {
    const base = this.#options()?.basePath ?? DEFAULT_BASE_PATH;
    return `${base.replace(/\/+$/, "")}/sha256/${hash}`;
  }

  #remember(attachment: StoredAttachment): void {
    this.#knownBlobs.set(attachment.hash, attachment);
    if (this.#knownBlobs.size <= 256) return;
    const oldest = this.#knownBlobs.keys().next().value;
    if (oldest !== undefined) this.#knownBlobs.delete(oldest);
  }

  /**
   * Store one durable payload content-addressed and return its pointer part
   * plus metadata. A standalone put remains valid until explicitly deleted;
   * the caller owns inserting the pointer into a message when desired.
   */
  async put(
    data: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string,
    options: { mediaType: string; filename?: string; bytes?: number }
  ): Promise<{ part: SessionMessagePart; attachment: StoredAttachment }> {
    const attachment = await this.#writeBlob(
      attachmentSource(data, options.bytes),
      options
    );
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

  /** @internal Store one aged tool-output string without full data-URL decode. */
  async putEvictedString(
    value: string,
    fallbackMediaType: string
  ): Promise<StoredAttachment> {
    const decoded = dataUrlSource(value);
    return this.#writeBlob(
      decoded?.source ?? attachmentSource(value, undefined),
      { mediaType: decoded?.mediaType ?? fallbackMediaType }
    );
  }

  /** Return durable whole-file metadata for one hash, when present. */
  get(hash: string): StoredAttachment | null {
    return this.getMany([hash]).get(hash) ?? null;
  }

  /** @internal Resolve several whole-file records with one cold SQL read. */
  getMany(hashes: readonly string[]): Map<string, StoredAttachment> {
    const unique = [...new Set(hashes)];
    const result = new Map<string, StoredAttachment>();
    const missing: string[] = [];
    for (const hash of unique) {
      const known = this.#knownBlobs.get(hash);
      if (known) result.set(hash, known);
      else missing.push(hash);
    }
    for (const blob of this.#storage.getMany(missing).values()) {
      const attachment: StoredAttachment = {
        hash: blob.hash,
        path: this.#path(blob.hash),
        mediaType: blob.mediaType,
        bytes: blob.bytes,
        ...(blob.filename !== undefined ? { filename: blob.filename } : {})
      };
      this.#remember(attachment);
      result.set(blob.hash, attachment);
    }
    return result;
  }

  /** Open one stored payload by pointer hash. */
  open(hash: string): Promise<ReadableStream<Uint8Array>> {
    return this.#storage.open(hash);
  }

  async #writeBlob(
    source: AttachmentByteSource,
    options: { mediaType: string; filename?: string }
  ): Promise<StoredAttachment> {
    const blob = await this.#storage.put(source, options);
    if (blob.created) {
      this.#io.emit("session:attachment:stored", {
        hash: blob.hash,
        bytes: blob.bytes,
        mediaType: options.mediaType,
        backend: blob.backend
      });
    }
    const attachment: StoredAttachment = {
      hash: blob.hash,
      path: this.#path(blob.hash),
      mediaType: options.mediaType,
      bytes: blob.bytes,
      ...(options.filename !== undefined ? { filename: options.filename } : {})
    };
    this.#remember(attachment);
    if (blob.created) this.#createdAttachments.add(attachment);
    return attachment;
  }

  /**
   * Offload oversized inline `data:` file parts from one message. Blob
   * writes complete before this returns, so the caller's row commit always
   * points at durable bytes. Below-threshold and non-`data:` parts pass
   * through untouched. Omitted attachment options retain legacy inline
   * behavior.
   */
  async extract(
    message: SessionMessage,
    thresholdBytes = this.inlineThresholdBytes
  ): Promise<ExtractionResult> {
    const attachments: StoredAttachment[] = [];
    if (!this.configured) {
      return { message, attachments, changed: false };
    }

    let changed = false;
    const parts: SessionMessagePart[] = [];
    for (const part of message.parts) {
      if (
        part.type !== "file" ||
        typeof part.url !== "string" ||
        !part.url.startsWith("data:") ||
        estimatedDataUrlBytes(part.url) < thresholdBytes
      ) {
        parts.push(part);
        continue;
      }
      const decoded = dataUrlSource(part.url);
      if (!decoded) {
        parts.push(part);
        continue;
      }
      const attachment = await this.#writeBlob(decoded.source, {
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
    const pointerHashes = message.parts.flatMap((part) => {
      const hash = parseAttachmentUrl(part.url);
      return hash ? [hash] : [];
    });
    const knownByHash = this.getMany(pointerHashes);
    for (const attachment of known) {
      knownByHash.set(attachment.hash, attachment);
    }

    let totalBytes = 0;
    const referenced = new Set<string>();
    message.parts.forEach((part, index) => {
      const hash = parseAttachmentUrl(part.url);
      if (!hash) return;
      const record = knownByHash.get(hash);
      const bytes = record?.bytes ?? 0;
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
          part.mediaType ?? record?.mediaType ?? "application/octet-stream",
          bytes,
          part.filename ?? record?.filename ?? null,
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
   * Replace one message's derived reference rows inside the caller's SQLite
   * transaction. Returns old hashes for payload cleanup after commit.
   */
  replaceReferenceRows(
    sessionId: string,
    message: SessionMessage,
    known: readonly StoredAttachment[],
    now: number
  ): string[] {
    const previous = this.#io.sql<{ hash: string }>(
      `SELECT DISTINCT hash FROM cf_agents_session_attachments
       WHERE message_id = ? AND session_id = ?`,
      [message.id, sessionId]
    );
    this.#io.sqlWrite(
      `DELETE FROM cf_agents_session_attachments
       WHERE message_id = ? AND session_id = ?`,
      [message.id, sessionId]
    );
    this.recordReferences(sessionId, message, known, now);
    return previous.map((row) => row.hash);
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
    const hashes = [
      ...new Set(
        message.parts
          .map((part) => parseAttachmentUrl(part.url))
          .filter((hash): hash is string => hash !== null)
      )
    ];
    if (hashes.length === 0) return message;
    const allowed = new Set(
      this.#io
        .sql<{ hash: string }>(
          `SELECT DISTINCT hash FROM cf_agents_session_attachments
           WHERE session_id = ? AND hash IN (SELECT value FROM json_each(?))`,
          [sessionId, JSON.stringify(hashes)]
        )
        .map((row) => row.hash)
    );
    let changed = false;
    const parts = message.parts.map((part) => {
      const hash = parseAttachmentUrl(part.url);
      if (!hash || allowed.has(hash)) return part;
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
    const pointers = message.parts.flatMap((part, index) => {
      const hash = parseAttachmentUrl(part.url);
      return hash ? [{ hash, index }] : [];
    });
    if (pointers.length === 0) return message;
    const rows = this.#io.sql<AttachmentRow>(
      `SELECT * FROM cf_agents_session_attachments
       WHERE message_id = ? AND session_id = ?
         AND hash IN (SELECT value FROM json_each(?))`,
      [
        message.id,
        sessionId,
        JSON.stringify([...new Set(pointers.map(({ hash }) => hash))])
      ]
    );
    const references = new Map(
      rows.map((row) => [`${row.hash}:${row.part_index}`, row])
    );
    const blobs = this.getMany(pointers.map(({ hash }) => hash));
    const parts: SessionMessagePart[] = [];
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index];
      const hash = parseAttachmentUrl(part.url);
      if (!hash) {
        parts.push(part);
        continue;
      }
      parts.push(
        await this.#materializePartWith(
          reconstructor,
          sessionId,
          message.id,
          index,
          part,
          hash,
          references.get(`${hash}:${index}`),
          blobs.get(hash)
        )
      );
    }
    return { ...message, parts };
  }

  async #materializePartWith(
    reconstructor: AttachmentReconstructor,
    sessionId: string,
    messageId: string,
    partIndex: number,
    part: SessionMessagePart,
    hash: string,
    row: AttachmentRow | undefined,
    blob: StoredAttachment | undefined
  ): Promise<SessionMessagePart> {
    const mediaType =
      row?.media_type ??
      part.mediaType ??
      blob?.mediaType ??
      "application/octet-stream";
    const filename =
      row?.filename ?? part.filename ?? blob?.filename ?? undefined;
    const path = row?.path ?? this.#path(hash);
    let bytesCache: Uint8Array | null | undefined;
    let dataUrlCache: string | null | undefined;
    const readBytes = async (): Promise<Uint8Array | null> => {
      if (bytesCache !== undefined) return bytesCache;
      try {
        bytesCache = new Uint8Array(
          await new Response(await this.#storage.open(hash)).arrayBuffer()
        );
      } catch {
        bytesCache = null;
      }
      return bytesCache;
    };

    const resolved: ResolvedAttachment = {
      hash,
      path,
      mediaType,
      bytes: row?.bytes ?? blob?.bytes ?? 0,
      ...(filename !== undefined ? { filename } : {}),
      data: async () => {
        const bytes = await readBytes();
        if (!bytes) throw new SessionAttachmentMissingError(hash, path);
        return bytes;
      },
      dataUrl: async () => {
        if (dataUrlCache !== undefined) {
          if (dataUrlCache === null) {
            throw new SessionAttachmentMissingError(hash, path);
          }
          return dataUrlCache;
        }
        try {
          dataUrlCache =
            bytesCache instanceof Uint8Array
              ? `data:${mediaType};base64,${encodeBase64(bytesCache)}`
              : await streamDataUrl(await this.#storage.open(hash), mediaType);
          return dataUrlCache;
        } catch {
          dataUrlCache = null;
          throw new SessionAttachmentMissingError(hash, path);
        }
      },
      stream: async () => {
        try {
          return await this.#storage.open(hash);
        } catch (error) {
          if (error instanceof SessionAttachmentMissingError) return null;
          throw error;
        }
      }
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
  /** Delete selected message-reference rows inside a caller transaction. */
  deleteMessageReferenceRows(
    sessionId: string,
    messageIds: readonly string[]
  ): string[] {
    if (messageIds.length === 0) return [];
    const ids = JSON.stringify([...new Set(messageIds)]);
    const affected = this.#io.sql<{ hash: string }>(
      `SELECT DISTINCT hash FROM cf_agents_session_attachments
       WHERE session_id = ?
         AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    this.#io.sqlWrite(
      `DELETE FROM cf_agents_session_attachments
       WHERE session_id = ?
         AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    return affected.map((row) => row.hash);
  }

  /**
   * Delete only blobs created by a coupled write that failed before recording
   * its references. Reused standalone or previously referenced blobs are
   * never inferred to be abandoned.
   */
  async discardUnreferenced(
    attachments: readonly StoredAttachment[]
  ): Promise<void> {
    const created = attachments
      .filter((attachment) => this.#createdAttachments.has(attachment))
      .map((attachment) => attachment.hash);
    await this.reapUnreferenced(created);
  }

  /** Delete one session's reference rows inside a caller transaction. */
  deleteSessionReferenceRows(sessionId: string): string[] {
    const rows = this.#io.sql<{ hash: string }>(
      `SELECT DISTINCT hash FROM cf_agents_session_attachments
       WHERE session_id = ?`,
      [sessionId]
    );
    this.#io.sqlWrite(
      "DELETE FROM cf_agents_session_attachments WHERE session_id = ?",
      [sessionId]
    );
    return rows.map((row) => row.hash);
  }

  /** Explicitly delete an unreferenced standalone attachment. */
  async delete(hash: string): Promise<boolean> {
    const referenced = this.#io.sql<{ hash: string }>(
      "SELECT hash FROM cf_agents_session_attachments WHERE hash = ? LIMIT 1",
      [hash]
    );
    if (referenced.length > 0) return false;
    this.#knownBlobs.delete(hash);
    return this.#storage.delete(hash);
  }

  /** Delete payloads whose hashes have no remaining message references. */
  async reapUnreferenced(hashes: readonly string[]): Promise<void> {
    const unique = [...new Set(hashes)];
    if (unique.length === 0) return;
    const remaining = new Set(
      this.#io
        .sql<{ hash: string }>(
          `SELECT DISTINCT hash FROM cf_agents_session_attachments
           WHERE hash IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(unique)]
        )
        .map((row) => row.hash)
    );
    for (const hash of unique) {
      if (remaining.has(hash)) continue;
      this.#knownBlobs.delete(hash);
      try {
        if (await this.#storage.delete(hash)) {
          this.#io.emit("session:attachment:reaped", { hash });
        }
      } catch (error) {
        this.#io.emit("session:attachment:delete-failed", {
          hash,
          error: error instanceof Error ? error.message : String(error)
        });
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
