/**
 * Durable programmatic submissions: the public types, and how a submission
 * maps onto its run on the Tasks capability. `Think` runs the turn; Tasks
 * keeps the record, its order in the submissions lane and its waiters.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { UIMessage } from "ai";
import type { TaskJson, TaskStatus } from "agents/tasks";
import {
  MAX_FRAMEWORK_METADATA_BYTES,
  TaskSettlement,
  type TaskRecord
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

/** The Task definition (and lane) of programmatic submissions. */
export const SUBMISSION_KIND = "__cf_think_submission";
export const SUBMISSION_LANE = "submissions";
/** The metadata key holding what a submission's turn records about itself. */
export const SUBMISSION_PROGRESS_KEY = "__cf_progress";

/** What a submission's run carries as its input. */
export type SubmissionPayload = { messages: UIMessage[] };

/** What a submission's turn records about itself, in its run's metadata. */
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
  /** Chat recovery owns its turn and ends it (the run is parked). */
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

export type TerminalSubmissionStatus = Exclude<
  ThinkSubmissionStatus,
  "pending" | "running"
>;

export const TERMINAL_SUBMISSION_STATUSES: TerminalSubmissionStatus[] = [
  "completed",
  "aborted",
  "skipped",
  "error"
];

export function isTerminalSubmissionStatus(
  status: ThinkSubmissionStatus
): status is TerminalSubmissionStatus {
  return status !== "pending" && status !== "running";
}

/**
 * The run filter for these submission statuses: a `running` submission may
 * also be a parked `pending` run (chat recovery owns its turn), so a
 * `pending` run matches only as the statuses asked for it.
 */
export function submissionTaskStatuses(
  statuses: readonly ThinkSubmissionStatus[]
): { status: TaskStatus[]; parked?: boolean } {
  const out = new Set<TaskStatus>(statuses);
  const running = out.has("running");
  const pending = out.has("pending");
  out.add("pending");
  if (running && pending) return { status: [...out] };
  if (running) return { status: [...out], parked: true };
  if (pending) return { status: [...out], parked: false };
  out.delete("pending");
  return { status: [...out] };
}

/** A Task status as the submission status it is. */
function submissionStatus(record: TaskRecord): ThinkSubmissionStatus {
  // A parked submission's turn is still under way, owned by chat recovery.
  if (record.status === "pending" && record.waitReason === "park") {
    return "running";
  }
  return record.status;
}

/** What a submission's turn recorded about itself. */
export function submissionProgress(record: TaskRecord): SubmissionProgress {
  return (record.metadata?.[SUBMISSION_PROGRESS_KEY] ??
    {}) as SubmissionProgress;
}

/** The metadata the app gave, without what Think keeps there. */
function appMetadata(record: TaskRecord): Record<string, unknown> | undefined {
  if (!record.metadata) return undefined;
  const { [SUBMISSION_PROGRESS_KEY]: _progress, ...rest } = record.metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The error message a submission ended with (an abort's reason). */
function submissionError(record: TaskRecord): string | undefined {
  if (record.error) return record.error.message;
  if (record.status === "aborted" || record.status === "skipped") {
    return record.reason;
  }
  return undefined;
}

export function submissionRow(record: TaskRecord): ThinkSubmissionRow {
  const progress = submissionProgress(record);
  return {
    submission_id: record.runId,
    idempotency_key: record.idempotencyKey ?? null,
    request_id: progress.requestId ?? record.runId,
    stream_id: progress.streamId ?? null,
    status: submissionStatus(record),
    metadata: appMetadata(record) ?? null,
    error_message: submissionError(record) ?? null,
    created_at: record.createdAt,
    messages_applied_at: progress.messagesAppliedAt ?? null,
    started_at: record.startedAt ?? null,
    completed_at: record.settledAt ?? null,
    result_status: progress.resultStatus ?? null,
    output: progress.output,
    message_id: progress.messageId ?? null,
    detached: record.status === "pending" && record.waitReason === "park"
  };
}

export function submissionInspection(
  record: TaskRecord
): ThinkSubmissionInspection {
  const progress = submissionProgress(record);
  const metadata = appMetadata(record);
  const error = submissionError(record);
  return {
    submissionId: record.runId,
    ...(record.idempotencyKey !== undefined && {
      idempotencyKey: record.idempotencyKey
    }),
    requestId: progress.requestId ?? record.runId,
    status: submissionStatus(record),
    ...(error !== undefined && { error }),
    ...(metadata !== undefined && { metadata }),
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined && { startedAt: record.startedAt }),
    ...(record.settledAt !== undefined && { completedAt: record.settledAt }),
    ...(progress.messageId !== undefined && { messageId: progress.messageId })
  };
}

/** What a submission's outcome is, as the value a release hands its run. */
export type SubmissionOutcome = {
  status: TerminalSubmissionStatus;
  error?: string;
  output?: TaskJson;
};

/** What a submission a turn reset ended reports as its error. */
export const SKIPPED_BY_RESET = "Submission was skipped by turn reset.";

/** A cancel reason as the text a cancelled submission reports. */
export function cancelReason(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : String(reason);
}

/** What a submission's turn or its recovery decided. */
export type SubmissionResult = SubmissionOutcome | { status: "detached" };

/** Chat recovery owns the turn now and ends the submission later. */
export function submissionDetached(): SubmissionResult {
  return { status: "detached" };
}

/** End a submission `error`. */
export function submissionFailed(error?: unknown): SubmissionOutcome {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  return { status: "error", ...(message !== undefined && { error: message }) };
}

/** How a submission with this final status ends its run. */
export function submissionOutcome(
  status: ThinkSubmissionStatus,
  error: string | null | undefined,
  output?: unknown
): SubmissionOutcome {
  if (status === "completed") {
    return output === undefined
      ? { status }
      : { status, output: output as TaskJson };
  }
  if (status === "aborted" || status === "skipped") return { status };
  return { status: "error", ...(error ? { error } : {}) };
}

/** What a submission's run returns for a result. */
export function submissionSettlement(
  outcome: SubmissionResult
): TaskSettlement | TaskJson | undefined {
  switch (outcome.status) {
    case "detached":
      return TaskSettlement.park("detached");
    case "completed":
      return outcome.output;
    case "aborted":
      return TaskSettlement.aborted();
    case "skipped":
      return TaskSettlement.skipped();
    default:
      return TaskSettlement.failed(
        new Error(outcome.error ?? "Submission failed")
      );
  }
}

const utf8 = new TextEncoder();

/**
 * Room a migrated open submission keeps for the progress it records (ids
 * and timestamps; a structured output too large for the room is left to
 * the run's result, see `progressOutputFits`).
 */
const PROGRESS_HEADROOM_BYTES = 100_000;

/**
 * The metadata a new submission is stored with: the app's own fields, without
 * Think's progress key (Think writes it), checked against the room that
 * leaves the turn's progress (ids, timestamps) beside it.
 *
 * @throws When the app's metadata leaves no room for the progress.
 */
export function admittedSubmissionMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, TaskJson> | undefined {
  if (metadata === undefined) return undefined;
  const { [SUBMISSION_PROGRESS_KEY]: _progress, ...app } = metadata;
  const limit = MAX_FRAMEWORK_METADATA_BYTES - PROGRESS_HEADROOM_BYTES;
  const bytes = jsonBytes(app);
  if (bytes > limit) {
    throw new Error(
      `Submission metadata is ${bytes} bytes; at most ${limit} fit beside the submission's progress`
    );
  }
  return app as Record<string, TaskJson>;
}

/**
 * Largest structured output a submission may complete with. Only a workflow
 * prompt has one, and its workflow is sent it in one event, which holds at
 * most 1 MiB (Workflows' event payload limit); the rest of the event (ids,
 * status) gets the margin.
 */
const MAX_SUBMISSION_OUTPUT_BYTES = 1_048_576 - 4_096;

/** Whether a submission's structured output can be delivered. */
export function submissionOutputFits(output: unknown): boolean {
  return (
    output === undefined || jsonBytes(output) <= MAX_SUBMISSION_OUTPUT_BYTES
  );
}

/** A submission that completed with an output too large to deliver. */
export function submissionOutputTooLarge(output: unknown): SubmissionOutcome {
  return submissionFailed(
    `Structured output is ${jsonBytes(output)} bytes; a workflow event holds at most ${MAX_SUBMISSION_OUTPUT_BYTES}`
  );
}

/**
 * Whether a turn's structured output still fits in a submission's metadata
 * beside what it holds. One that does not is not recorded as progress: the
 * run's result carries it once the submission settles.
 */
export function progressOutputFits(
  metadata: Record<string, TaskJson> | undefined,
  output: unknown
): boolean {
  if (output === undefined) return true;
  return (
    jsonBytes(metadata ?? {}) + jsonBytes(output) + 16 <=
    MAX_FRAMEWORK_METADATA_BYTES
  );
}

function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

function parseJsonValue(value: string | null | undefined): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** The run of a row of the retired `cf_think_submissions` table. */
export function legacySubmissionImport(row: LegacySubmissionRow): {
  runId: string;
  definition: string;
  status: TaskStatus;
  attempt: number;
  input?: TaskJson;
  metadata?: Record<string, TaskJson>;
  idempotencyKey?: string;
  lane: string;
  error?: string;
  result?: TaskJson;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
} {
  const messages = parseJsonValue(row.messages_json);
  // A completed submission's output is its run's result; an open one's is
  // evidence its turn recorded, kept with the rest of its progress.
  const output =
    row.output_json != null
      ? (parseJsonValue(row.output_json) as TaskJson)
      : undefined;
  const completed = row.status === "completed";
  const metadata = parseJsonValue(row.metadata_json);
  const progress: SubmissionProgress = {
    ...(row.request_id !== null && { requestId: row.request_id }),
    ...(row.stream_id !== null && { streamId: row.stream_id }),
    ...(row.messages_applied_at !== null && {
      messagesAppliedAt: row.messages_applied_at
    }),
    ...(row.result_status != null && { resultStatus: row.result_status }),
    ...(output !== undefined && !completed && { output }),
    ...(row.message_id != null && { messageId: row.message_id })
  };
  // Released versions had no limit but the row's: what a run cannot hold
  // is dropped (and logged), so the submission itself still moves.
  let appFields: Record<string, TaskJson> =
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
      ? { ...(metadata as Record<string, TaskJson>) }
      : {};
  // Think's own progress takes this key; an app field of that name was
  // never readable back, and must not count as room.
  delete appFields[SUBMISSION_PROGRESS_KEY];
  // An open submission still records its progress as it runs: leave room.
  // A finished one never writes again.
  const open = row.status === "pending" || row.status === "running";
  const budget =
    MAX_FRAMEWORK_METADATA_BYTES - (open ? PROGRESS_HEADROOM_BYTES : 0);
  let bytes = jsonBytes({ ...appFields, [SUBMISSION_PROGRESS_KEY]: progress });
  if (bytes > budget) {
    // Drop the largest fields first (key and value, as stored), keeping
    // every one that still fits. Sizes are measured once.
    const sized = Object.entries(appFields)
      .map(([key, value]) => ({
        key,
        size: jsonBytes(key) + jsonBytes(value) + 2
      }))
      .sort((a, b) => b.size - a.size);
    const dropped: string[] = [];
    for (const { key, size } of sized) {
      if (bytes <= budget) break;
      delete appFields[key];
      dropped.push(key);
      bytes -= size;
    }
    if (bytes > budget && progress.output !== undefined) {
      bytes -= jsonBytes(progress.output);
      delete progress.output;
    }
    console.warn(
      `[Think] Submission "${row.submission_id}": metadata too large to keep; dropped ${dropped.length > 0 ? `fields ${dropped.join(", ")}` : "its recorded output"}`
    );
  }
  let result = completed ? output : undefined;
  if (result !== undefined && !submissionOutputFits(result)) {
    console.warn(
      `[Think] Submission "${row.submission_id}": its output is too large to keep and was dropped`
    );
    result = undefined;
  }
  return {
    runId: row.submission_id,
    definition: SUBMISSION_KIND,
    status: row.status,
    // Only a running row has a run under way; a pending one starts afresh.
    attempt: row.status === "running" ? 1 : 0,
    ...(row.idempotency_key !== null && {
      idempotencyKey: row.idempotency_key
    }),
    // Messages that do not parse fail the submission when it runs.
    ...(Array.isArray(messages) && {
      input: { messages } as unknown as TaskJson
    }),
    metadata: {
      ...appFields,
      [SUBMISSION_PROGRESS_KEY]: progress as TaskJson
    },
    lane: SUBMISSION_LANE,
    ...(row.error_message !== null && { error: row.error_message }),
    ...(result !== undefined && { result }),
    createdAt: row.created_at,
    ...(row.started_at !== null && { startedAt: row.started_at }),
    ...(row.completed_at !== null && { settledAt: row.completed_at })
  };
}

/**
 * Runs each submission's status reports one after another, in the order
 * they arrive, so an app that stores the latest status never ends on an
 * earlier one (a slow `running` hook finishing after `aborted`). Reports of
 * different submissions do not wait for each other. A report caused from
 * inside a running report of the same submission (its hook cancelled it)
 * runs at once: queued behind that report, neither would return. Holds one
 * promise per submission with a report in flight, removed when its last
 * one ends.
 *
 * @internal
 */
export class SubmissionStatusQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #running = new AsyncLocalStorage<{
    readonly queue: SubmissionStatusQueue;
    readonly submissionId: string;
  }>();

  /**
   * Whether this is running inside a report of this queue's: of the given
   * submission's, or of any when none is given.
   */
  reporting(submissionId?: string): boolean {
    const inside = this.#running.getStore();
    return (
      inside?.queue === this &&
      (submissionId === undefined || inside.submissionId === submissionId)
    );
  }

  /** Run `report` after the submission's earlier reports have ended. */
  run(submissionId: string, report: () => Promise<void>): Promise<void> {
    const inside = this.#running.getStore();
    const marked = () =>
      this.#running.run({ queue: this, submissionId }, report);
    if (inside?.queue === this && inside.submissionId === submissionId) {
      return marked();
    }
    const previous = this.#tails.get(submissionId) ?? Promise.resolve();
    // A failed report does not hold up the next; its caller still sees it.
    const next = previous.then(marked);
    const tail = next.catch(() => {});
    this.#tails.set(submissionId, tail);
    void tail.then(() => {
      if (this.#tails.get(submissionId) === tail) {
        this.#tails.delete(submissionId);
      }
    });
    return next;
  }
}
