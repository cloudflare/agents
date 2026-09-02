/**
 * Durable conversation storage for Lifecycle Objects.
 *
 * @experimental The whole `agents/sessions` surface may change before
 * stabilizing.
 */

export {
  DEFAULT_SESSION_ID,
  Sessions,
  type SessionsAttachments
} from "./sessions";
export { Session, type CompactionFunction } from "./handle";
export { attachmentResponse, type AttachmentResponseOptions } from "./http";
export {
  ATTACHMENT_URL_PREFIX,
  attachmentUrl,
  inlineReconstructor,
  MAX_INLINE_ROW_BYTES,
  parseAttachmentUrl,
  pointerReconstructor,
  type StoredAttachment
} from "./attachments";
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
  SessionAttachmentMissingError,
  SessionAttachmentStoreError,
  SessionAttachmentTooLargeError,
  SessionMessageTooLargeError,
  SessionSearchDisabledError,
  SessionSerializationError
} from "./errors";
export type {
  AppendOptions,
  AppendResult,
  AttachmentReconstructor,
  HistoryBatchReadOptions,
  HistoryReadOptions,
  ReconstructContext,
  ReconstructMode,
  RecentHistoryResult,
  ResolvedAttachment,
  SearchResult,
  SessionAttachmentBucket,
  SessionAttachmentObject,
  SessionChangeEvent,
  SessionChangeListener,
  SessionMaintenanceResult,
  SessionMessage,
  SessionMessagePart,
  SessionRowStat,
  SessionStats,
  SessionSummary,
  SessionsAttachmentOptions,
  SessionsOptions,
  StoredCompaction,
  WriteOptions
} from "./types";
