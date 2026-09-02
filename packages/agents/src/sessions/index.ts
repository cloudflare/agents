/**
 * Durable conversation storage for Lifecycle Objects.
 *
 * @experimental The whole `agents/sessions` surface may change before
 * stabilizing.
 */

export { DEFAULT_SESSION_ID, Sessions } from "./sessions";
export { Session, type CompactionFunction } from "./handle";
export { MAX_INLINE_ROW_BYTES } from "./chunking";
export {
  ATTACHMENT_URL_PREFIX,
  attachmentUrl,
  parseAttachmentUrl
} from "./attachment-ingest";
export { ATTACHMENT_CHUNK_BYTES } from "./attachment-store";
export {
  estimateAttachmentTokens,
  estimateMessageTokens,
  estimateStringTokens
} from "./tokens";
export {
  COMPACTION_PREFIX,
  createCompactFunction,
  isCompactionMessage,
  type CompactOptions,
  type CompactResult
} from "./compaction-helpers";
export {
  SessionSearchDisabledError,
  SessionSerializationError
} from "./errors";
export type {
  AppendOptions,
  AttachmentMode,
  AppendResult,
  HistoryBatchReadOptions,
  HistoryReadOptions,
  RecentHistoryResult,
  SearchResult,
  SessionChangeEvent,
  SessionChangeListener,
  SessionMessage,
  SessionMessagePart,
  SessionRowStat,
  SessionStats,
  SessionSummary,
  SessionsOptions,
  StoredCompaction,
  WriteOptions
} from "./types";
