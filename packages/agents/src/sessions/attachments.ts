/**
 * Attachment offload for the Sessions capability.
 *
 * One mechanism moves every kind of large payload out of a message row and
 * back: data-URL file parts, text and reasoning parts, and strings nested in
 * tool outputs. The stored form keeps the part's shape and replaces the
 * payload with an `attachment:sha256:<hex>` pointer; bytes live in
 * content-addressed storage (chunked SQLite or R2). Reading back inlines the
 * payload again by default, so a round-trip is exact. Nothing is truncated.
 *
 * Ordering: blob writes complete BEFORE the message row commits, so a stored
 * pointer always has durable bytes behind it. Whole-file hashes deduplicate
 * retries, and attachment lifetime is derived from message references.
 */

import {
  AttachmentBlobStore,
  SESSION_ATTACHMENT_CHUNK_BYTES,
  type AttachmentBlobRow,
  type AttachmentByteSource
} from "./attachment-storage";
import { SessionAttachmentMissingError } from "./errors";
import type { SessionsIo } from "./io";
import { byteLength } from "./sanitize";
import type {
  AttachmentReconstructor,
  ReconstructMode,
  ResolvedAttachment,
  SessionMessage,
  SessionMessagePart,
  SessionsAttachmentOptions,
  SessionsOptions
} from "./types";

export const ATTACHMENT_URL_PREFIX = "attachment:sha256:";

/**
 * Serialized ceiling for one message row. Anything larger is offloaded
 * largest-string-first until it fits; it is never truncated.
 */
export const MAX_INLINE_ROW_BYTES = SESSION_ATTACHMENT_CHUNK_BYTES;

const DEFAULT_R2_THRESHOLD_BYTES = 1_500_000;
const DEFAULT_R2_PREFIX = "cf-agents/sessions/attachments";
const DEFAULT_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_BASE_PATH = "/attachments";
const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_MAX_MAINTENANCE_ROWS = 64;
const STRING_STREAM_CHARS = 256 * 1024;
const BASE64_STREAM_CHARS = (SESSION_ATTACHMENT_CHUNK_BYTES / 3) * 4;
const TEXT_MEDIA_TYPE = "text/plain";
/** Nested tool-output walks stop here so hostile output cannot recurse forever. */
const MAX_WALK_DEPTH = 8;

/** One offloaded blob referenced from a stored message. */
export interface StoredAttachment {
  /** sha-256 hex of the raw payload — the content address. */
  hash: string;
  /** Logical locator: `<basePath>/sha256/<hash>`. */
  path: string;
  mediaType: string;
  bytes: number;
  filename?: string;
}

/** Attachment policy with defaults applied. */
export interface ResolvedAttachmentOptions {
  readonly bucket: SessionsAttachmentOptions["r2"];
  readonly r2ThresholdBytes: number;
  readonly r2Prefix: string;
  readonly maxAttachmentBytes: number;
  readonly basePath: string;
  readonly keepRecentMessages: number;
  readonly maxMaintenanceRowsPerPass: number;
  readonly maintenance: boolean;
  readonly reconstruct: AttachmentReconstructor;
}

/**
 * What one offload pass moves out of a message row.
 *
 * There is no content-type distinction: a `data:` URL file part, a long text
 * part, and a long string nested in tool output are all just payloads. Only
 * two things move one out of the row, and both are read from the engine's
 * resolved options rather than passed here:
 *
 *  1. R2, when a bucket is configured. Extracting into R2 is the only move
 *     that reclaims Durable Object space — SQLite chunks live in the same
 *     10 GB as the row they came out of — so it is the only eager one.
 *  2. The row budget below, which applies with or without a bucket.
 */
export interface OffloadPolicy {
  /**
   * Serialized row ceiling. Payloads are offloaded largest-first until the
   * row fits. Content is never truncated; a row that still does not fit is
   * rejected by the caller.
   */
  rowBudgetBytes: number;
}

/** Result of one offload pass. */
export interface OffloadResult {
  /** Rewritten message, or the original reference when nothing moved. */
  message: SessionMessage;
  /** Blobs written for this message (existing blobs are reused, not listed twice). */
  attachments: StoredAttachment[];
  /** File parts and strings replaced by pointers. */
  parts: number;
  /** Payload bytes removed from the row. */
  bytes: number;
  /** Serialized row size after offload, when a finite row budget was applied. */
  rowBytes?: number;
}

/** The hash referenced by an `attachment:` pointer, or null. */
export function parseAttachmentUrl(url: string | undefined): string | null {
  if (!url || !url.startsWith(ATTACHMENT_URL_PREFIX)) return null;
  const hash = url.slice(ATTACHMENT_URL_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

export function attachmentUrl(hash: string): string {
  return `${ATTACHMENT_URL_PREFIX}${hash}`;
}

type DataUrl = { mediaType: string; base64: boolean; payload: string };

function parseDataUrl(url: string): DataUrl | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const base64 = header.endsWith(";base64");
  const mediaType =
    (base64 ? header.slice(0, -7) : header).split(";")[0] ||
    "application/octet-stream";
  return { mediaType, base64, payload: url.slice(comma + 1) };
}

/** Approximate decoded size of a `data:` URL without decoding it. */
export function estimatedDataUrlBytes(url: string): number {
  const parsed = parseDataUrl(url);
  if (!parsed) return 0;
  return parsed.base64
    ? Math.floor((parsed.payload.length * 3) / 4)
    : parsed.payload.length;
}

function isInlineFilePart(
  part: SessionMessagePart
): part is SessionMessagePart & {
  url: string;
} {
  return (
    part.type === "file" &&
    typeof part.url === "string" &&
    part.url.startsWith("data:")
  );
}

function isToolPart(part: SessionMessagePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function hasText(
  part: SessionMessagePart
): part is SessionMessagePart & { text: string } {
  return (
    (part.type === "text" || part.type === "reasoning") &&
    typeof part.text === "string"
  );
}

/** Marker used when a pointer's payload cannot be materialized. */
function missingText(mediaType: string, filename?: string): string {
  const name = filename ? ` ${JSON.stringify(filename)}` : "";
  return `[attachment${name} (${mediaType}) is no longer available]`;
}

function missingFilePart(part: SessionMessagePart): SessionMessagePart {
  return {
    type: "text",
    text: missingText(
      part.mediaType ?? "application/octet-stream",
      part.filename
    )
  };
}

// ── Byte sources ────────────────────────────────────────────────────────────

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
      const code = value.charCodeAt(end - 1);
      if (end < value.length && code >= 0xd800 && code <= 0xdbff) end--;
      controller.enqueue(encoder.encode(value.slice(offset, end)));
      offset = end;
    }
  });
}

/** Decode base64 in bounded windows so a large data URL never doubles in memory. */
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

function dataUrlSource(
  url: string
): { source: AttachmentByteSource; mediaType: string } | null {
  const parsed = parseDataUrl(url);
  if (!parsed) return null;
  if (!parsed.base64) {
    try {
      const bytes = new TextEncoder().encode(
        decodeURIComponent(parsed.payload)
      );
      return {
        mediaType: parsed.mediaType,
        source: { kind: "replayable", open: () => byteArrayStream(bytes) }
      };
    } catch {
      return null;
    }
  }
  const payload = /[\t\n\f\r ]/.test(parsed.payload)
    ? parsed.payload.replace(/[\t\n\f\r ]/g, "")
    : parsed.payload;
  if (payload.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    return null;
  }
  return {
    mediaType: parsed.mediaType,
    source: { kind: "replayable", open: () => base64Stream(payload) }
  };
}

function bytesSource(
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Build a data URL from a stream, carrying at most two bytes between reads. */
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

// ── Reconstructors ──────────────────────────────────────────────────────────

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
 * logical Sessions locator.
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

// ── String leaves ───────────────────────────────────────────────────────────

type Leaf = {
  partIndex: number;
  kind: "file" | "text" | "output";
  keys: (string | number)[];
  bytes: number;
};

function collectLeaves(parts: readonly SessionMessagePart[]): Leaf[] {
  const leaves: Leaf[] = [];
  parts.forEach((part, partIndex) => {
    if (isInlineFilePart(part)) {
      leaves.push({
        partIndex,
        kind: "file",
        keys: [],
        bytes: estimatedDataUrlBytes(part.url)
      });
    } else if (hasText(part) && !parseAttachmentUrl(part.text)) {
      leaves.push({
        partIndex,
        kind: "text",
        keys: [],
        bytes: byteLength(part.text)
      });
    } else if (isToolPart(part) && part.output !== undefined) {
      collectStringLeaves(part.output, [], 0, (keys, bytes) =>
        leaves.push({ partIndex, kind: "output", keys, bytes })
      );
    }
  });
  return leaves;
}

function collectStringLeaves(
  value: unknown,
  keys: (string | number)[],
  depth: number,
  found: (keys: (string | number)[], bytes: number) => void
): void {
  if (typeof value === "string") {
    if (parseAttachmentUrl(value)) return;
    // A `data:` URL measures as its decoded payload; that is a size, not a
    // classification — it is offloaded on exactly the same terms as prose.
    found(
      keys,
      value.startsWith("data:")
        ? estimatedDataUrlBytes(value)
        : byteLength(value)
    );
    return;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectStringLeaves(item, [...keys, index], depth + 1, found)
    );
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    collectStringLeaves(item, [...keys, key], depth + 1, found);
  }
}

function readAt(value: unknown, keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function writeAt(
  value: unknown,
  keys: readonly (string | number)[],
  replacement: unknown
): unknown {
  if (keys.length === 0) return replacement;
  const [head, ...rest] = keys;
  if (Array.isArray(value)) {
    const copy = value.slice();
    copy[head as number] = writeAt(value[head as number], rest, replacement);
    return copy;
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    [head]: writeAt(record[head as string], rest, replacement)
  };
}

/**
 * The largest inline payload a later maintenance pass could move out of this
 * row, which is what the stamped hint has to mean for bounded passes to
 * terminate. The pass compares it against whatever threshold is in force at
 * the time, so lowering `r2ThresholdBytes` makes older rows discoverable
 * without restamping them.
 *
 * Without a bucket the pass has nowhere useful to move anything — chunking a
 * payload leaves the bytes in the same Durable Object — so every row stamps
 * 0 and never becomes a candidate.
 */
export function maintenanceCandidateBytes(
  message: SessionMessage,
  options: Pick<ResolvedAttachmentOptions, "bucket">
): number {
  if (!options.bucket) return 0;
  let maximum = 0;
  for (const leaf of collectLeaves(message.parts)) {
    maximum = Math.max(maximum, leaf.bytes);
  }
  return maximum;
}

/** Walk every string leaf of a tool output, replacing through `visit`. */
async function mapStrings(
  value: unknown,
  depth: number,
  visit: (value: string) => Promise<string>
): Promise<unknown> {
  if (typeof value === "string") return visit(value);
  if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
    return value;
  }
  let changed = false;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const next = await mapStrings(item, depth + 1, visit);
      if (next !== item) changed = true;
      output.push(next);
    }
    return changed ? output : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = await mapStrings(item, depth + 1, visit);
    if (next !== item) changed = true;
    output[key] = next;
  }
  return changed ? output : value;
}

/** Rewrite every pointer in a message through per-kind visitors. */
async function mapPointers(
  message: SessionMessage,
  visit: {
    file(
      part: SessionMessagePart,
      hash: string,
      index: number
    ): Promise<SessionMessagePart>;
    text(hash: string): Promise<string>;
  }
): Promise<SessionMessage> {
  let changed = false;
  const parts: SessionMessagePart[] = [];
  for (let index = 0; index < message.parts.length; index++) {
    const part = message.parts[index];
    let next = part;
    if (part.type === "file") {
      const hash = parseAttachmentUrl(part.url);
      if (hash) next = await visit.file(part, hash, index);
    } else if (hasText(part)) {
      const hash = parseAttachmentUrl(part.text);
      if (hash) next = { ...part, text: await visit.text(hash) };
    } else if (isToolPart(part) && part.output !== undefined) {
      const output = await mapStrings(part.output, 0, async (value) => {
        const hash = parseAttachmentUrl(value);
        return hash ? visit.text(hash) : value;
      });
      if (output !== part.output) next = { ...part, output };
    }
    if (next !== part) changed = true;
    parts.push(next);
  }
  return changed ? { ...message, parts } : message;
}

/** Every pointer hash a message carries (file parts, text, nested strings). */
export function pointerHashes(message: SessionMessage): string[] {
  const hashes = new Set<string>();
  for (const part of message.parts) {
    if (part.type === "file") {
      const hash = parseAttachmentUrl(part.url);
      if (hash) hashes.add(hash);
    } else if (hasText(part)) {
      const hash = parseAttachmentUrl(part.text);
      if (hash) hashes.add(hash);
    } else if (isToolPart(part) && part.output !== undefined) {
      collectPointerStrings(part.output, 0, hashes);
    }
  }
  return [...hashes];
}

function collectPointerStrings(
  value: unknown,
  depth: number,
  hashes: Set<string>
): void {
  if (typeof value === "string") {
    const hash = parseAttachmentUrl(value);
    if (hash) hashes.add(hash);
    return;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
    return;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectPointerStrings(item, depth + 1, hashes);
  }
}

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * @internal Per-capability attachment machinery: policy, durable byte
 * storage, the pointer contract, reference tracking, and read-side
 * reconstruction.
 */
export class AttachmentEngine {
  readonly #io: SessionsIo;
  readonly #input: SessionsOptions["attachments"];
  readonly store: AttachmentBlobStore;
  readonly #created = new WeakSet<StoredAttachment>();

  constructor(options: SessionsOptions["attachments"], io: SessionsIo) {
    this.#io = io;
    this.#input = options;
    this.store = new AttachmentBlobStore(io, () => this.options);
  }

  /** Policy with defaults applied; re-read on every access. */
  get options(): ResolvedAttachmentOptions {
    const input =
      typeof this.#input === "function" ? this.#input() : this.#input;
    return {
      bucket: input?.r2,
      r2ThresholdBytes: positive(
        input?.r2ThresholdBytes,
        DEFAULT_R2_THRESHOLD_BYTES
      ),
      r2Prefix: input?.r2Prefix ?? DEFAULT_R2_PREFIX,
      maxAttachmentBytes: positive(
        input?.maxAttachmentBytes,
        DEFAULT_MAX_ATTACHMENT_BYTES
      ),
      basePath: input?.basePath ?? DEFAULT_BASE_PATH,
      keepRecentMessages: positive(
        input?.keepRecentMessages,
        DEFAULT_KEEP_RECENT_MESSAGES
      ),
      maxMaintenanceRowsPerPass: positive(
        input?.maxMaintenanceRowsPerPass,
        DEFAULT_MAX_MAINTENANCE_ROWS
      ),
      maintenance: input?.maintenance ?? true,
      reconstruct: input?.reconstruct ?? inlineReconstructor
    };
  }

  ensureTables(): void {
    this.store.ensureTables();
  }

  resolveReconstructor(
    mode: ReconstructMode | undefined
  ): AttachmentReconstructor | null {
    if (mode === "pointer") return null;
    if (mode === "inline") return inlineReconstructor;
    return mode ?? this.options.reconstruct;
  }

  #path(hash: string): string {
    return `${this.options.basePath.replace(/\/+$/, "")}/sha256/${hash}`;
  }

  #describe(row: AttachmentBlobRow): StoredAttachment {
    return {
      hash: row.hash,
      path: this.#path(row.hash),
      mediaType: row.media_type,
      bytes: row.bytes,
      ...(row.filename !== null ? { filename: row.filename } : {})
    };
  }

  /** Store one payload content-addressed and return its pointer part. */
  async put(
    data: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string,
    options: { mediaType: string; filename?: string; bytes?: number }
  ): Promise<{ part: SessionMessagePart; attachment: StoredAttachment }> {
    const attachment = await this.#writeBlob(bytesSource(data, options.bytes), {
      mediaType: options.mediaType,
      ...(options.filename !== undefined ? { filename: options.filename } : {})
    });
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

  get(hash: string): StoredAttachment | null {
    const row = this.store.get(hash);
    return row ? this.#describe(row) : null;
  }

  getMany(hashes: readonly string[]): Map<string, StoredAttachment> {
    const result = new Map<string, StoredAttachment>();
    for (const [hash, row] of this.store.getMany(hashes)) {
      result.set(hash, this.#describe(row));
    }
    return result;
  }

  open(hash: string): Promise<ReadableStream<Uint8Array>> {
    return this.store.open(hash);
  }

  /** Summed stored bytes of the given blobs. */
  referencedBytes(hashes: readonly string[]): number {
    let total = 0;
    for (const row of this.store.getMany(hashes).values()) total += row.bytes;
    return total;
  }

  async #writeBlob(
    source: AttachmentByteSource,
    metadata: { mediaType: string; filename?: string }
  ): Promise<StoredAttachment> {
    const { row, created } = await this.store.put(source, metadata);
    const attachment = this.#describe(row);
    if (created) {
      this.#created.add(attachment);
      this.#io.emit("session:attachment:stored", {
        hash: row.hash,
        bytes: row.bytes,
        mediaType: row.media_type,
        backend: row.backend
      });
    }
    return attachment;
  }

  /**
   * Move payloads out of a message row: with a bucket, anything at or above
   * the R2 threshold; then, bucket or not, whatever is largest until the row
   * fits its budget. Blob writes complete before this returns, so a stored
   * pointer always has durable bytes behind it.
   */
  async offload(
    message: SessionMessage,
    policy: OffloadPolicy
  ): Promise<OffloadResult> {
    const parts = message.parts.slice();
    const attachments: StoredAttachment[] = [];
    let count = 0;
    let bytes = 0;
    const leaves = collectLeaves(parts).sort((a, b) => b.bytes - a.bytes);

    // A leaf the R2 pass already moved must not be offloaded again by the
    // budget pass: its slot now holds a pointer, and storing that pointer
    // string as a payload would lose the original bytes.
    const taken = new Set<Leaf>();
    const take = async (leaf: Leaf): Promise<void> => {
      if (taken.has(leaf)) return;
      taken.add(leaf);
      const attachment = await this.#offloadLeaf(parts, leaf);
      if (!attachment) return;
      attachments.push(attachment);
      count++;
      bytes += leaf.bytes;
    };

    // Rule 1: R2 is the only tier that reclaims Durable Object space, so it
    // is the only reason to extract a payload the row could still hold.
    const { bucket, r2ThresholdBytes } = this.options;
    if (bucket) {
      for (const leaf of leaves) {
        if (leaf.bytes >= r2ThresholdBytes) await take(leaf);
      }
    }

    let rowBytes: number | undefined;
    if (Number.isFinite(policy.rowBudgetBytes)) {
      const measure = (): number =>
        (rowBytes = byteLength(JSON.stringify({ ...message, parts })));
      for (const leaf of leaves) {
        if (measure() <= policy.rowBudgetBytes) break;
        await take(leaf);
      }
      measure();
    }

    return {
      message: count > 0 ? { ...message, parts } : message,
      attachments,
      parts: count,
      bytes,
      ...(rowBytes !== undefined ? { rowBytes } : {})
    };
  }

  async #offloadFile(part: SessionMessagePart & { url: string }): Promise<{
    part: SessionMessagePart;
    attachment: StoredAttachment;
  } | null> {
    const decoded = dataUrlSource(part.url);
    if (!decoded) return null;
    const attachment = await this.#writeBlob(decoded.source, {
      mediaType: part.mediaType ?? decoded.mediaType,
      ...(part.filename !== undefined ? { filename: part.filename } : {})
    });
    return {
      part: {
        ...part,
        mediaType: attachment.mediaType,
        url: attachmentUrl(attachment.hash)
      },
      attachment
    };
  }

  async #offloadLeaf(
    parts: SessionMessagePart[],
    leaf: Leaf
  ): Promise<StoredAttachment | null> {
    const part = parts[leaf.partIndex];
    if (!part) return null;
    if (leaf.kind === "file") {
      if (!isInlineFilePart(part)) return null;
      const offloaded = await this.#offloadFile(part);
      if (!offloaded) return null;
      parts[leaf.partIndex] = offloaded.part;
      return offloaded.attachment;
    }
    if (leaf.kind === "text") {
      if (!hasText(part)) return null;
      const attachment = await this.#writeString(part.text, false);
      parts[leaf.partIndex] = { ...part, text: attachmentUrl(attachment.hash) };
      return attachment;
    }
    const value = readAt(part.output, leaf.keys);
    if (typeof value !== "string") return null;
    const attachment = await this.#writeString(value, true);
    parts[leaf.partIndex] = {
      ...part,
      output: writeAt(part.output, leaf.keys, attachmentUrl(attachment.hash))
    };
    return attachment;
  }

  /**
   * Store a string. Tool-output strings that are data URLs (screenshots,
   * downloads) store their decoded bytes under their own media type so the
   * blob is a real file; everything else is stored as UTF-8 text.
   */
  #writeString(
    value: string,
    dataUrlAware: boolean
  ): Promise<StoredAttachment> {
    if (dataUrlAware) {
      const decoded = dataUrlSource(value);
      if (decoded && decoded.mediaType !== TEXT_MEDIA_TYPE) {
        return this.#writeBlob(decoded.source, {
          mediaType: decoded.mediaType
        });
      }
    }
    return this.#writeBlob(bytesSource(value, undefined), {
      mediaType: TEXT_MEDIA_TYPE
    });
  }

  /**
   * Trust boundary for client-source writes: a pointer is accepted only when
   * its bytes are stored in this object. Anything else degrades to a marker
   * so no row ever points at nothing.
   */
  async guardClientPointers(message: SessionMessage): Promise<SessionMessage> {
    const hashes = pointerHashes(message);
    if (hashes.length === 0) return message;
    const allowed = this.store.getMany(hashes);
    return mapPointers(message, {
      file: async (part, hash) =>
        allowed.has(hash) ? part : missingFilePart(part),
      text: async (hash) =>
        allowed.has(hash) ? attachmentUrl(hash) : missingText(TEXT_MEDIA_TYPE)
    });
  }

  /**
   * Materialize every pointer of a stored message. `null` (pointer mode)
   * returns the message untouched with zero IO. Missing payloads degrade to
   * markers — reads never throw on data loss.
   */
  materialize(
    sessionId: string,
    message: SessionMessage,
    reconstructor: AttachmentReconstructor | null
  ): Promise<SessionMessage> {
    if (!reconstructor) return Promise.resolve(message);
    return mapPointers(message, {
      file: (part, hash, index) =>
        this.#materializeFile(
          reconstructor,
          sessionId,
          message.id,
          index,
          part,
          hash
        ),
      text: (hash) => this.#readString(sessionId, hash)
    });
  }

  async #readString(sessionId: string, hash: string): Promise<string> {
    const row = this.store.get(hash);
    try {
      if (!row) throw new SessionAttachmentMissingError(hash);
      const stream = await this.store.open(hash);
      return row.media_type === TEXT_MEDIA_TYPE
        ? await new Response(stream).text()
        : await streamDataUrl(stream, row.media_type);
    } catch (error) {
      if (!(error instanceof SessionAttachmentMissingError)) throw error;
      this.#io.emit("session:attachment:missing", { hash, sessionId });
      return missingText(row?.media_type ?? TEXT_MEDIA_TYPE);
    }
  }

  async #materializeFile(
    reconstructor: AttachmentReconstructor,
    sessionId: string,
    messageId: string,
    partIndex: number,
    part: SessionMessagePart,
    hash: string
  ): Promise<SessionMessagePart> {
    const row = this.store.get(hash);
    const mediaType =
      part.mediaType ?? row?.media_type ?? "application/octet-stream";
    const filename = part.filename ?? row?.filename ?? undefined;
    const path = this.#path(hash);
    let bytesCache: Uint8Array | undefined;
    const open = (): Promise<ReadableStream<Uint8Array>> =>
      this.store.open(hash);
    const resolved: ResolvedAttachment = {
      hash,
      path,
      mediaType,
      bytes: row?.bytes ?? 0,
      ...(filename !== undefined ? { filename } : {}),
      data: async () => {
        bytesCache ??= new Uint8Array(
          await new Response(await open()).arrayBuffer()
        );
        return bytesCache;
      },
      dataUrl: async () =>
        bytesCache
          ? `data:${mediaType};base64,${encodeBase64(bytesCache)}`
          : streamDataUrl(await open(), mediaType),
      stream: async () => {
        try {
          return await open();
        } catch (error) {
          if (error instanceof SessionAttachmentMissingError) return null;
          throw error;
        }
      }
    };
    try {
      const result = await reconstructor.part(resolved, {
        sessionId,
        messageId,
        partIndex,
        part
      });
      return result.type === part.type ? { ...part, ...result } : result;
    } catch (error) {
      if (!(error instanceof SessionAttachmentMissingError)) throw error;
      this.#io.emit("session:attachment:missing", { hash, sessionId });
      return { type: "text", text: missingText(mediaType, filename) };
    }
  }

  // ── References (derived, never refcounted) ────────────────────────────────

  /** Insert reference rows for a new message inside the caller's transaction. */
  recordReferences(
    sessionId: string,
    messageId: string,
    hashes: readonly string[]
  ): void {
    for (const hash of hashes) {
      this.#io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_attachments
           (session_id, message_id, hash) VALUES (?, ?, ?)`,
        [sessionId, messageId, hash]
      );
    }
  }

  /**
   * Diff a message's reference rows against its current pointers inside the
   * caller's transaction. Returns the hashes it dropped, for reaping after
   * commit. Unchanged references cost no writes.
   */
  replaceReferences(
    sessionId: string,
    messageId: string,
    hashes: readonly string[]
  ): string[] {
    const existing = new Set(
      this.#io
        .sql<{ hash: string }>(
          `SELECT hash FROM cf_agents_session_attachments
           WHERE session_id = ? AND message_id = ?`,
          [sessionId, messageId]
        )
        .map((row) => row.hash)
    );
    const wanted = new Set(hashes);
    this.recordReferences(
      sessionId,
      messageId,
      [...wanted].filter((hash) => !existing.has(hash))
    );
    const removed = [...existing].filter((hash) => !wanted.has(hash));
    if (removed.length > 0) {
      this.#io.sqlWrite(
        `DELETE FROM cf_agents_session_attachments
         WHERE session_id = ? AND message_id = ?
           AND hash IN (SELECT value FROM json_each(?))`,
        [sessionId, messageId, JSON.stringify(removed)]
      );
    }
    return removed;
  }

  /** Drop reference rows of deleted messages inside the caller's transaction. */
  deleteMessageReferences(
    sessionId: string,
    messageIds: readonly string[]
  ): string[] {
    if (messageIds.length === 0) return [];
    const ids = JSON.stringify([...new Set(messageIds)]);
    const affected = this.#io.sql<{ hash: string }>(
      `SELECT DISTINCT hash FROM cf_agents_session_attachments
       WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    this.#io.sqlWrite(
      `DELETE FROM cf_agents_session_attachments
       WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    return affected.map((row) => row.hash);
  }

  /** Drop one session's reference rows inside the caller's transaction. */
  deleteSessionReferences(sessionId: string): string[] {
    const rows = this.#io.sql<{ hash: string }>(
      "SELECT DISTINCT hash FROM cf_agents_session_attachments WHERE session_id = ?",
      [sessionId]
    );
    this.#io.sqlWrite(
      "DELETE FROM cf_agents_session_attachments WHERE session_id = ?",
      [sessionId]
    );
    return rows.map((row) => row.hash);
  }

  /** Delete payloads whose hashes no message references any more. */
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
      try {
        if (await this.store.delete(hash)) {
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

  /**
   * After a coupled write failed to persist its row: delete only the blobs
   * that write created. Reused blobs are never inferred to be abandoned.
   */
  discardUnreferenced(attachments: readonly StoredAttachment[]): Promise<void> {
    return this.reapUnreferenced(
      attachments.filter((a) => this.#created.has(a)).map((a) => a.hash)
    );
  }

  /** Explicitly delete an unreferenced payload. */
  async delete(hash: string): Promise<boolean> {
    const referenced = this.#io.sql<{ hash: string }>(
      "SELECT hash FROM cf_agents_session_attachments WHERE hash = ? LIMIT 1",
      [hash]
    );
    if (referenced.length > 0) return false;
    return this.store.delete(hash);
  }
}

function positive(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback));
}
