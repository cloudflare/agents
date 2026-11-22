/**
 * Durable programmatic submissions: the public types, and how a submission
 * maps onto its request in the Inbox capability. `Think` runs the turn; the
 * inbox keeps the record, its order and its waiters.
 */

import type { UIMessage } from "ai";
import {
  Inbox,
  type InboxImport,
  type InboxRequest,
  type InboxSettlement,
  type InboxTerminalStatus
} from "agents/internal";

export type ThinkSubmissionStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "skipped"
  | "error";

export type ThinkSubmissionInspection = {
  submissionId: string;
  idempotencyKey?: string;
  requestId?: string;
  status: ThinkSubmissionStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Id of the assistant message this submission's turn persisted. */
  messageId?: string;
};

export type SubmitMessagesResult = ThinkSubmissionInspection & {
  accepted: boolean;
};

export type WaitForSubmissionOptions = {
  /**
   * Stop waiting after this many milliseconds and return the submission as it
   * is then, still `pending` or `running`, or `null` if it was deleted.
   */
  timeoutMs?: number;
};

/** What {@link Think.cancelSubmission} did. */
export type CancelSubmissionResult =
  | {
      /** No submission has this id. */
      outcome: "not_found";
      submissionId: string;
    }
  | {
      /** The submission had already finished; nothing changed. */
      outcome: "already_terminal";
      submissionId: string;
      submission: ThinkSubmissionInspection;
    }
  | {
      /** The submission is now `aborted`. */
      outcome: "cancelled";
      submissionId: string;
      /**
       * `"pending"`: removed before its turn started. `"running"`: its turn
       * had been claimed and was signalled to abort; side effects already
       * under way may still finish.
       */
      previousStatus: "pending" | "running";
      /**
       * Whether any of the submission's messages were written to the
       * conversation when it was cancelled. A claimed submission can still be
       * `false` when it is cancelled before its turn applies them.
       */
      messagesApplied: boolean;
      submission: ThinkSubmissionInspection;
    };

export type ListSubmissionsOptions = {
  status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
  limit?: number;
};

export type DeleteSubmissionsOptions = {
  status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
  completedBefore?: Date;
  limit?: number;
};

/** A turn's durable cutover fact, not the stream transport's lifecycle. */
export type SubmissionTurnResult =
  | { status: "completed"; output?: unknown }
  | { status: "aborted" | "retry" | "error" };

/** Inbox kind (and lane) of programmatic submissions. */
export const SUBMISSION_KIND = "submission";

/** What a submission's inbox request carries. */
export type SubmissionPayload = { messages: UIMessage[] };

/** What a submission's turn records about itself, as inbox progress. */
export type SubmissionProgress = {
  /** The request id of the turn answering it; recovery moves it. */
  requestId?: string;
  streamId?: string;
  /** Set once its messages were appended to the session. */
  messagesAppliedAt?: number;
  /** The cutover outcome, written with the stream's settle. */
  resultStatus?: SubmissionTurnResult["status"];
  output?: unknown;
  /** The assistant message its turn persisted. */
  messageId?: string;
  /** Its workflow event was queued; a repeated terminal report skips it. */
  workflowNotified?: boolean;
};

/** One submission as the turn and recovery code reads it. */
export type ThinkSubmissionRow = {
  submission_id: string;
  idempotency_key: string | null;
  request_id: string | null;
  stream_id: string | null;
  status: ThinkSubmissionStatus;
  metadata: Record<string, unknown> | null;
  error_message: string | null;
  created_at: number;
  messages_applied_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result_status: SubmissionTurnResult["status"] | null;
  output: unknown;
  message_id: string | null;
  /** Chat recovery owns its turn and ends it. */
  detached: boolean;
};

/** A row of the retired `cf_think_submissions` table. */
export type LegacySubmissionRow = {
  submission_id: string;
  idempotency_key: string | null;
  request_id: string | null;
  stream_id: string | null;
  status: ThinkSubmissionStatus;
  messages_json: string;
  metadata_json: string | null;
  error_message: string | null;
  created_at: number;
  messages_applied_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result_status?: SubmissionTurnResult["status"] | null;
  output_json?: string | null;
  message_id?: string | null;
};

export const TERMINAL_SUBMISSION_STATUSES: InboxTerminalStatus[] = [
  "completed",
  "aborted",
  "skipped",
  "error"
];

export function isTerminalSubmissionStatus(
  status: ThinkSubmissionStatus
): status is InboxTerminalStatus {
  return status !== "pending" && status !== "running";
}

export function submissionRow(request: InboxRequest): ThinkSubmissionRow {
  const progress = (request.progress ?? {}) as SubmissionProgress;
  return {
    submission_id: request.id,
    idempotency_key: request.idempotencyKey ?? null,
    request_id: progress.requestId ?? request.id,
    stream_id: progress.streamId ?? null,
    status: request.status,
    metadata: request.metadata ?? null,
    error_message: request.error ?? null,
    created_at: request.createdAt,
    messages_applied_at: progress.messagesAppliedAt ?? null,
    started_at: request.startedAt ?? null,
    completed_at: request.settledAt ?? null,
    result_status: progress.resultStatus ?? null,
    output: progress.output,
    message_id: progress.messageId ?? null,
    detached: request.detached
  };
}

export function submissionInspection(
  request: InboxRequest
): ThinkSubmissionInspection {
  const progress = (request.progress ?? {}) as SubmissionProgress;
  return {
    submissionId: request.id,
    idempotencyKey: request.idempotencyKey,
    requestId: progress.requestId ?? request.id,
    status: request.status,
    error: request.error,
    metadata: request.metadata,
    createdAt: request.createdAt,
    startedAt: request.startedAt,
    completedAt: request.settledAt,
    ...(progress.messageId !== undefined && { messageId: progress.messageId })
  };
}

/** How a submission with this final status ends its inbox request. */
export function submissionOutcome(
  status: ThinkSubmissionStatus,
  error: string | null | undefined,
  output?: unknown
): InboxSettlement {
  switch (status) {
    case "completed":
      return Inbox.completed(output);
    case "aborted":
      return Inbox.aborted();
    case "skipped":
      return Inbox.skipped();
    default:
      return Inbox.failed(error ?? undefined);
  }
}

function parseJsonValue(value: string | null | undefined): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** The inbox record of a row of the retired `cf_think_submissions` table. */
export function legacySubmissionImport(row: LegacySubmissionRow): InboxImport {
  const messages = parseJsonValue(row.messages_json);
  const metadata = parseJsonValue(row.metadata_json);
  return {
    id: row.submission_id,
    kind: SUBMISSION_KIND,
    status: row.status,
    // Only a running row has a run under way; a pending one starts afresh.
    attempt: row.status === "running" ? 1 : 0,
    ...(row.idempotency_key !== null && {
      idempotencyKey: row.idempotency_key
    }),
    // Messages that do not parse fail the submission when it runs.
    ...(Array.isArray(messages) && { payload: { messages } }),
    ...(metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) && {
        metadata: metadata as Record<string, unknown>
      }),
    progress: {
      ...(row.request_id !== null && { requestId: row.request_id }),
      ...(row.stream_id !== null && { streamId: row.stream_id }),
      ...(row.messages_applied_at !== null && {
        messagesAppliedAt: row.messages_applied_at
      }),
      ...(row.result_status != null && {
        resultStatus: row.result_status
      }),
      ...(row.output_json != null && {
        output: parseJsonValue(row.output_json)
      }),
      ...(row.message_id != null && { messageId: row.message_id })
    } satisfies SubmissionProgress,
    ...(row.error_message !== null && { error: row.error_message }),
    createdAt: row.created_at,
    ...(row.started_at !== null && { startedAt: row.started_at }),
    ...(row.completed_at !== null && { settledAt: row.completed_at })
  };
}
