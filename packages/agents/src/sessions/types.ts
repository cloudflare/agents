/**
 * Types for the Sessions capability.
 *
 * @experimental The whole `agents/sessions` surface may change before
 * stabilizing.
 */

import type { StoredAttachment } from "./attachments";
import type { ContextBlock, ContextConfig } from "./context";

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
  /** Largest payload eligible for aged media maintenance. */
  mediaCandidateBytes: number;
}

/** Result of a byte-budgeted history read. */
export interface RecentHistoryResult {
  /**
   * The most recent messages on the active branch path whose summed stored
   * content size fits `maxContentBytes`, root → leaf order, with compaction
   * overlays applied within the window. The window always covers at least
   * the leaf row (and `minRecentMessages` rows when requested), but rows
   * whose stored content fails to parse are skipped — so a corrupt leaf can
   * yield fewer messages than the window covers.
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
  /** The STORED form of the message (sanitized, row-capped, pointerized). */
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
  | { type: "compact"; sessionId: string }
  | {
      type: "eviction";
      sessionId: string;
      result: SessionEvictionResult;
    }
  | {
      /**
       * A maintenance pass (e.g. aged media eviction) rewrote a stored row.
       * Cache-owning hosts patch the row; no status or compaction side
       * effects accompany it.
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
   * How `attachment:` pointer parts materialize:
   * - `"inline"` (default): bytes are read back and the part becomes a
   *   `data:`-URL file part again — an exact round-trip of what was written.
   * - `"pointer"`: parts keep their `attachment:` URL; no bytes are read.
   * Or a custom {@link AttachmentReconstructor}.
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
}

/**
 * THE read-side plugin: decides how a stored pointer part becomes a message
 * part again. The default inlines a `data:` URL; a custom reconstructor can
 * emit a workspace-path marker for the model, a hosted URL, or anything
 * else — per part, sync or async.
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
  delete(key: string | string[]): Promise<void>;
}

/** Attachment extraction, storage-tier, and reconstruction policy. */
export interface SessionsAttachmentOptions {
  /**
   * Optional large-object tier. Without R2, Sessions stores every offloaded
   * payload in chunked Durable Object SQLite. A thunk supports late-bound
   * Worker bindings on Agent subclasses.
   */
  readonly r2?:
    | SessionAttachmentBucket
    | (() => SessionAttachmentBucket | undefined);
  /**
   * Payloads at or above this size use R2 when configured. Smaller payloads
   * stay in Sessions-owned SQLite chunks. Default 1,500,000 bytes.
   */
  readonly r2ThresholdBytes?: number | (() => number);
  /** Private R2 object-key prefix. Default `cf-agents/sessions/attachments`. */
  readonly r2Prefix?: string;
  /**
   * File parts whose decoded payload is at least this many bytes are
   * offloaded at append time. Default 32 KiB.
   */
  readonly inlineThresholdBytes?: number | (() => number);
  /** Aged-row payload threshold. Defaults to `inlineThresholdBytes`. */
  readonly evictionThresholdBytes?: number | (() => number);
  /** Logical locator prefix exposed to reconstructors. Default "/attachments". */
  readonly basePath?: string;
  /** Ceiling for one attachment accepted by `attachments.put`. Default 8 MiB. */
  readonly maxAttachmentBytes?: number;
  /**
   * Messages this many positions from the leaf keep inline media untouched;
   * older rows are drained by the aged-eviction pass. Default 8. A thunk
   * defers to first use for hosts with late-bound policy fields.
   */
  readonly keepRecentMessages?: number | (() => number);
  /** Maximum aged rows rewritten by one maintenance pass. Default 64. */
  readonly maxEvictionRowsPerPass?: number | (() => number);
  /** Enable aged-row maintenance. Default true. */
  readonly evictAged?: boolean | (() => boolean);
  /** Preserve evicted payloads in the store. Default true. */
  readonly preserveEvicted?: boolean | (() => boolean);
  /** Read-side materialization default. Default: inline `data:` URLs. */
  readonly reconstruct?: AttachmentReconstructor;
}

/** Totals from one bounded aged-media maintenance pass. */
export interface SessionEvictionResult {
  /** Stored message rows rewritten by the pass. */
  messages: number;
  /** Individual file parts or nested tool-output strings externalized. */
  parts: number;
  /** Raw payload bytes removed from SQLite rows. */
  bytes: number;
  /** True when another eligible row remains after this bounded pass. */
  backlogRemains: boolean;
}

/** Policy for a Sessions capability. */
export interface SessionsOptions {
  /** Attachment offload. Omitted → file parts stay inline (legacy behavior). */
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
  /** Missing `updateMessage` policy. Default `"error"`. */
  readonly missingUpdate?: "ignore" | "error";
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

/** Context block options accepted by {@link Session.withContext}. */
export type SessionContextOptions = Omit<ContextConfig, "label">;

/** Input passed to a custom session token counter. */
export interface SessionTokenCounterInput {
  /** Messages returned by `session.getHistory()` for the active branch. */
  messages: SessionMessage[];
  /** Frozen system prompt managed by the session context system. */
  systemPrompt: string;
  /** Loaded context blocks that were used to build `systemPrompt`. */
  contextBlocks: ContextBlock[];
}

export type SessionTokenCounter = (
  input: SessionTokenCounterInput
) => number | Promise<number>;

export interface CompactAfterOptions {
  /**
   * Authoritative token counter consulted to CONFIRM a compaction trigger
   * after the O(1) stamped-estimate gate crosses the threshold. Reads
   * history, so it never runs on the append hot path by itself.
   */
  tokenCounter?: SessionTokenCounter;
}

/**
 * Context passed to the registered compaction function so its boundary
 * logic can share the session's authoritative token accounting.
 */
export interface CompactContext {
  tokenCounter?: SessionTokenCounter;
}

export type CompactionErrorHandler = (error: unknown) => void | Promise<void>;

/** @internal Raw `cf_agents_session_messages` SQLite row. */
export type SessionMessageRow = {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: string;
  content: string;
  token_estimate: number;
  created_at: number;
};
