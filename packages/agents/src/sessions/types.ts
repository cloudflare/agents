/**
 * Types for the Sessions capability.
 *
 * @experimental The whole `agents/sessions` surface may change before
 * stabilizing.
 */

import type { StoredAttachment } from "./attachments";

/**
 * Minimal message part shape used by Sessions internals.
 * Vercel AI SDK's `UIMessagePart` is structurally compatible.
 */
export interface SessionMessagePart {
  type: string;
  text?: string;
  reasoning?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  result?: unknown;
  /** File parts (AI SDK `FileUIPart`): IANA media type of the payload. */
  mediaType?: string;
  /** File parts: a `data:` URL, remote URL, or `attachment:` pointer. */
  url?: string;
  /** File parts: original filename, when one was supplied. */
  filename?: string;
}

/**
 * Minimal message shape used by Sessions internals.
 * Vercel AI SDK's `UIMessage` is structurally compatible — you can pass
 * `UIMessage` objects directly without conversion.
 */
export interface SessionMessage {
  id: string;
  role: string;
  parts: SessionMessagePart[];
  metadata?: unknown;
  createdAt?: Date;
}

export interface SearchResult {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  sessionId?: string;
}

export interface StoredCompaction {
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  createdAt: string;
}

/** Per-row info for the active branch path, root → leaf order. */
export interface SessionRowStat {
  id: string;
  /** Stored message role (e.g. "user" / "assistant"). */
  role: string;
  /** Serialized content size of the stored row in bytes. */
  bytes: number;
  /** Token estimate stamped when the row was written. */
  tokenEstimate: number;
  /** Largest inline payload the maintenance pass could still offload. */
  mediaCandidateBytes: number;
  /** Stored bytes of the attachments this row points at (0 when none). */
  attachmentBytes: number;
}

/** Result of a byte-budgeted history read. */
export interface RecentHistoryResult {
  /**
   * The most recent messages on the active branch path that fit
   * `maxContentBytes` when hydrated (stored bytes plus, when reconstructing
   * inline, the attachment bytes each row re-inflates), root → leaf order,
   * with compaction overlays applied within the window. The window always
   * covers at least the leaf row (and `minRecentMessages` rows when
   * requested); rows whose stored content fails to parse are skipped.
   */
  messages: SessionMessage[];
  /** True when older messages were left out to satisfy the byte budget. */
  truncated: boolean;
  /** Summed stored content size of the FULL path, in bytes. */
  totalContentBytes: number;
}

/** O(1)-maintained aggregate over one session's active branch path. */
export interface SessionStats {
  sessionId: string;
  /**
   * Heuristic token estimate for the active path with compaction overlays
   * applied: stamped per-row estimates, minus compacted spans, plus their
   * summaries. Model-reported usage stays the authoritative count — this
   * estimate only gates cheap triggers.
   */
  tokenEstimate: number;
  /** Summed stored content bytes of the active path. */
  totalContentBytes: number;
  /** Summed offloaded attachment bytes referenced by the active path. */
  attachmentBytes: number;
  /** Message count of the active path. */
  pathLength: number;
}

/** One row of {@link Sessions.listSessions} — derived, never registry-backed. */
export interface SessionSummary {
  sessionId: string;
  messageCount: number;
  /** Epoch ms of the most recent append. */
  lastMessageAt: number;
}

/** Result of an append/upsert write. */
export interface AppendResult {
  /** False when the id already existed and the write was an idempotent no-op. */
  inserted: boolean;
  /** The STORED form of the message (sanitized, pointerized). */
  message: SessionMessage;
  /** Attachments offloaded from this message during the write. */
  attachments: StoredAttachment[];
}

/** Totals from one bounded maintenance pass over aged rows. */
export interface SessionMaintenanceResult {
  /** Stored message rows rewritten by the pass. */
  messages: number;
  /** File parts and strings moved to attachment storage. */
  parts: number;
  /**
   * Payload bytes moved out. A `data:` URL is counted by its decoded size,
   * so the row itself shrinks by rather more than this.
   */
  bytes: number;
  /** True when another eligible row remains after this bounded pass. */
  backlogRemains: boolean;
}

/** Change-feed events dispatched synchronously after each durable write. */
export type SessionChangeEvent =
  | {
      type: "append";
      sessionId: string;
      message: SessionMessage;
      parentId?: string | null;
      inserted: boolean;
    }
  | { type: "update"; sessionId: string; message: SessionMessage }
  | { type: "delete"; sessionId: string; messageIds: string[] }
  | { type: "clear"; sessionId: string }
  | { type: "compact"; sessionId: string }
  | {
      /**
       * A maintenance pass moved inline payloads of a stored row to
       * attachment storage. Cache-owning hosts patch the row; no status or
       * compaction side effects accompany it.
       */
      type: "maintenance-rewrite";
      sessionId: string;
      message: SessionMessage;
    };

export type SessionChangeListener = (
  event: SessionChangeEvent
) => void | Promise<void>;

/** Options accepted by history reads. */
export interface HistoryReadOptions {
  /** Read the path ending at this leaf instead of the active leaf. */
  leafId?: string | null;
  /**
   * How `attachment:` pointers materialize:
   * - `"inline"` (default): bytes are read back — file parts become `data:`
   *   URLs again and offloaded text returns as text, an exact round-trip.
   * - `"pointer"`: pointers stay as written; no bytes are read.
   * Or a custom {@link AttachmentReconstructor} for file parts.
   */
  reconstruct?: ReconstructMode;
  /** Abort a streamed read between chunks. */
  signal?: AbortSignal;
}

/** Options accepted by batched history reads. */
export interface HistoryBatchReadOptions extends HistoryReadOptions {
  /** Maximum messages per yielded batch. Default 50. */
  batchSize?: number;
  /**
   * Maximum serialized bytes per yielded batch. Default 4 MiB. A single
   * reconstructed message can exceed the limit and is yielded alone.
   */
  maxBatchBytes?: number;
}

/** How attachment pointers are reconstructed during a history read. */
export type ReconstructMode = "inline" | "pointer" | AttachmentReconstructor;

/** A stored attachment resolved for reconstruction. */
export interface ResolvedAttachment {
  hash: string;
  /** Logical Sessions locator. This is not a Workspace filesystem path. */
  path: string;
  mediaType: string;
  bytes: number;
  filename?: string;
  /** Lazily read the full payload. */
  data(): Promise<Uint8Array>;
  /** Lazily build a `data:` URL for the payload. */
  dataUrl(): Promise<string>;
  /** Lazily open the payload as a stream. */
  stream(): Promise<ReadableStream<Uint8Array> | null>;
}

export interface ReconstructContext {
  sessionId: string;
  messageId: string;
  partIndex: number;
  /** The stored pointer part being replaced. */
  part: SessionMessagePart;
}

/**
 * THE read-side plugin for file parts: decides how a stored pointer part
 * becomes a message part again. The default inlines a `data:` URL; a custom
 * reconstructor can emit a workspace-path marker for the model, a hosted
 * URL, or anything else — per part, sync or async. A result of the same part
 * type is spread over the stored part, so host fields survive.
 */
export interface AttachmentReconstructor {
  part(
    attachment: ResolvedAttachment,
    context: ReconstructContext
  ): SessionMessagePart | Promise<SessionMessagePart>;
}

/** R2 object body needed by the Sessions attachment adapter. */
export interface SessionAttachmentObject {
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * Narrow R2 port used by Sessions-owned attachment storage. A Cloudflare
 * `R2Bucket` satisfies this interface. Sessions owns object keys, metadata,
 * deduplication, and garbage collection.
 */
export interface SessionAttachmentBucket {
  get(key: string): Promise<SessionAttachmentObject | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** Attachment storage-tier, offload, maintenance, and reconstruction policy. */
export interface SessionsAttachmentOptions {
  /**
   * Optional large-object tier. Without R2, every offloaded payload lives in
   * chunked Durable Object SQLite.
   */
  readonly r2?: SessionAttachmentBucket;
  /**
   * Payloads at or above this size use R2 when configured. Smaller payloads
   * stay in Sessions-owned SQLite chunks. Default 1,500,000 bytes.
   */
  readonly r2ThresholdBytes?: number;
  /** Private R2 object-key prefix. Default `cf-agents/sessions/attachments`. */
  readonly r2Prefix?: string;
  /**
   * File parts whose decoded payload is at least this many bytes are
   * offloaded at write time; the maintenance pass applies the same threshold
   * to every inline payload of aged rows. Default 32 KiB.
   */
  readonly inlineThresholdBytes?: number;
  /** Ceiling for one attachment payload. Default 32 MiB. */
  readonly maxAttachmentBytes?: number;
  /** Logical locator prefix exposed to reconstructors. Default "/attachments". */
  readonly basePath?: string;
  /**
   * Rows this many positions from the leaf keep inline payloads untouched;
   * older rows are drained by the maintenance pass. Default 8.
   */
  readonly keepRecentMessages?: number;
  /** Maximum aged rows rewritten by one maintenance pass. Default 64. */
  readonly maxMaintenanceRowsPerPass?: number;
  /** Run the aged-row maintenance pass. Default true. */
  readonly maintenance?: boolean;
  /** Read-side materialization default for file parts. Default: inline. */
  readonly reconstruct?: AttachmentReconstructor;
}

/** Policy for a Sessions capability. */
export interface SessionsOptions {
  /**
   * Attachment policy. A thunk is re-read on every access so Agent subclasses
   * can point it at fields (bindings, policy) initialized after the field
   * initializer runs.
   */
  readonly attachments?:
    | SessionsAttachmentOptions
    | (() => SessionsAttachmentOptions | undefined);
  /**
   * Message-metadata keys reserved for server-side writers. Stripped from
   * writes marked `source: "client"`. Default: none.
   */
  readonly reservedMetadataKeys?: readonly string[];
  /**
   * Maintain the FTS index that backs `search()`. Default false: each FTS
   * insert costs extra billed row writes on every append, and most hosts
   * never search. Enabling it also lifts legacy FTS data during migration.
   */
  readonly searchIndexing?: boolean;
}

/** Trust policy shared by append and update writes. */
export interface WriteOptions {
  /**
   * `"client"` marks untrusted intake: reserved metadata keys and forged
   * attachment pointers are stripped. Default `"server"`.
   */
  source?: "client" | "server";
}

/** Options accepted by append writes. */
export interface AppendOptions extends WriteOptions {
  /**
   * - `undefined` / omitted → auto-detect: attach to the current latest leaf.
   * - `null` → create a root message with no parent.
   * - string → attach to the given parent id (falls back to root when the
   *   parent does not belong to this session).
   */
  parentId?: string | null;
}
