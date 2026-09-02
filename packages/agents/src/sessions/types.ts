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
  | { type: "compact"; sessionId: string };

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

/**
 * Attachment ceiling, locator, and reconstruction policy.
 *
 * There is nothing here about WHEN a payload is extracted, because that is
 * not a policy: a payload stays inline in its message row until the row
 * would exceed `MAX_INLINE_ROW_BYTES`, and then the largest payloads are
 * chunked out until it fits.
 */
export interface SessionsAttachmentOptions {
  /** Ceiling for one attachment payload. Default 32 MiB. */
  readonly maxAttachmentBytes?: number;
  /** Logical locator prefix exposed to reconstructors. Default "/attachments". */
  readonly basePath?: string;
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
