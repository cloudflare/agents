/**
 * Types for the Sessions capability.
 *
 * @experimental The whole `agents/sessions` surface may change before
 * stabilizing.
 */

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
  /** File parts: a `data:` URL or a remote URL. */
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
  /**
   * Serialized content size in bytes: the message row plus every
   * continuation row it was split across.
   */
  bytes: number;
  /** Token estimate stamped when the row was written. */
  tokenEstimate: number;
}

/** Result of a byte-budgeted history read. */
export interface RecentHistoryResult {
  /**
   * The most recent messages on the active branch path whose stored bytes
   * (row plus continuation rows) fit `maxContentBytes`, root → leaf order,
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
  /** The STORED form of the message (sanitized). */
  message: SessionMessage;
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
/**
 * How a read presents attachment payloads.
 *
 * - `"inline"` (default) rebuilds the `data:` URL the payload was extracted
 *   from, so a read returns exactly what was written.
 * - `"pointer"` leaves the `attachment:sha256:` reference in place, for
 *   callers that only need to know a payload exists — scanning, copying, or
 *   assembling context — and should not pay to materialize it.
 */
export type AttachmentMode = "inline" | "pointer";

export interface HistoryReadOptions {
  /** Read the path ending at this leaf instead of the active leaf. */
  leafId?: string | null;
  /** Abort a streamed read between chunks. */
  signal?: AbortSignal;
  /** Attachment presentation. Default `"inline"`. */
  attachments?: AttachmentMode;
}

/** Options accepted by batched history reads. */
export interface HistoryBatchReadOptions extends HistoryReadOptions {
  /** Maximum messages per yielded batch. Default 50. */
  batchSize?: number;
  /**
   * Maximum serialized bytes per yielded batch. Default 4 MiB. A single
   * message larger than the limit is yielded alone.
   */
  maxBatchBytes?: number;
}

/** Policy for a Sessions capability. */
export interface SessionsOptions {
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
   * `"client"` marks untrusted intake: reserved metadata keys are stripped.
   * Default `"server"`.
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
