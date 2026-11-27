import { sendDelivery } from "agents/internal";
import type { DeliverySink } from "agents/internal";
import type { Tasks } from "agents/tasks";
import type { ThinkSubmissionInspection } from "./submissions";
import type { ThinkWorkflowPromptContext } from "./turn-types";
import { tableExists } from "./config-store";

/**
 * The workflow event a terminal submission owes, delivered until the
 * workflow accepts it.
 *
 * @internal
 */
export type WorkflowNotification = {
  workflowName: string;
  workflowId: string;
  event: { type: string; payload: WorkflowEventPayload };
};

/** What a submission's workflow event carries. */
type WorkflowEventPayload = {
  submissionId?: string;
  status?: string;
  output?: unknown;
  error?: string;
  [key: string]: unknown;
};

/** The sink workflow notifications are delivered through. @internal */
export const WORKFLOW_NOTIFICATION_SINK = "think-workflow-notification";

/**
 * One delivery per submission and event type. The id is the queue item id
 * the released version used, so a repeat joins the open delivery.
 *
 * @internal
 */
export function workflowNotificationId(
  submissionId: string,
  eventType: string
): string {
  return `workflow-notification:${submissionId}:${eventType}`;
}

/**
 * The sink. The delivery defaults (2 s doubling, ten-minute cap, giving up
 * twelve hours after the notification was sent) ride out an outage of the
 * workflow binding without waking the object forever for a workflow that
 * is gone. `onGiveUp` gets the give-up error (Think passes it to `onError`).
 *
 * @internal
 */
export function workflowNotificationSink(
  send: (notification: WorkflowNotification) => Promise<void>,
  onGiveUp: (error: Error) => void | Promise<void>
): DeliverySink<WorkflowNotification> {
  return {
    deliver: (notification) => send(notification),
    onGiveUp,
    giveUpError: (notification, _id, attempts, cause) =>
      new Error(
        `Workflow notification for submission ${JSON.stringify(
          notification.event.payload?.submissionId
        )} (${notification.workflowName}/${notification.workflowId}, ${notification.event.type}) ` +
          `could not be delivered after ${attempts} attempts; giving up: ` +
          (cause instanceof Error ? cause.message : String(cause))
      )
  };
}

/**
 * The delivery a queue item or scheduled retry of the released version
 * carries (`_cfDeliverWorkflowNotification`). A retry keeps its give-up
 * window (`firstFailedAt`) and its backoff (`attempts`).
 *
 * TEMPORARY: remove with `_cfDeliverWorkflowNotification` in the next minor.
 *
 * @internal
 */
export function legacyWorkflowNotification(
  payload: WorkflowNotification & { attempts?: number; firstFailedAt?: number }
): {
  id: string;
  notification: WorkflowNotification;
  resume?: { sentAt: number; attempts: number };
} {
  return {
    id: workflowNotificationId(
      payload.event.payload?.submissionId ?? "",
      payload.event.type
    ),
    notification: {
      workflowName: payload.workflowName,
      workflowId: payload.workflowId,
      event: payload.event
    },
    ...(payload.firstFailedAt !== undefined && {
      resume: {
        sentAt: payload.firstFailedAt,
        attempts: payload.attempts ?? 1
      }
    })
  };
}

/**
 * Send the undelivered rows of the retired `cf_think_workflow_notifications`
 * table as deliveries (run from the alarm), deleting each row once its
 * delivery is stored, and drop the table when none is left. A row whose
 * send fails stays for the next start; the rest go on. A missing table
 * means a fresh object or a finished migration.
 *
 * TEMPORARY: one-shot upgrade path. Remove in the next minor.
 *
 * @internal
 */
export async function migrateWorkflowNotificationTable(
  sql: SqlStorage,
  send: (
    id: string,
    notification: WorkflowNotification,
    resume: { sentAt: number; attempts: number }
  ) => Promise<unknown>
): Promise<void> {
  if (!tableExists(sql, "cf_think_workflow_notifications")) return;
  const rows = sql
    .exec<{
      notification_id: string;
      submission_id: string;
      workflow_name: string;
      workflow_id: string;
      event_type: string;
      payload_json: string;
      created_at: number;
    }>(
      `SELECT notification_id, submission_id, workflow_name, workflow_id, event_type, payload_json,
              created_at
       FROM cf_think_workflow_notifications
       WHERE delivered_at IS NULL
       ORDER BY created_at ASC, notification_id ASC`
    )
    .toArray();
  for (const row of rows) {
    let payload: WorkflowEventPayload;
    try {
      payload = JSON.parse(row.payload_json) as WorkflowEventPayload;
    } catch {
      // Nothing to deliver: it can go.
      sql.exec(
        "DELETE FROM cf_think_workflow_notifications WHERE notification_id = ?",
        row.notification_id
      );
      continue;
    }
    try {
      // From the alarm, with its window counted from when it was written:
      // a start does not wait on the workflow.
      await send(
        workflowNotificationId(row.submission_id, row.event_type),
        {
          workflowName: row.workflow_name,
          workflowId: row.workflow_id,
          event: { type: row.event_type, payload }
        },
        { sentAt: row.created_at, attempts: 0 }
      );
      sql.exec(
        "DELETE FROM cf_think_workflow_notifications WHERE notification_id = ?",
        row.notification_id
      );
    } catch (error) {
      // Kept for the next start; the rest go on.
      console.error(
        `[Think] could not migrate the workflow notification for submission ${row.submission_id}`,
        error
      );
    }
  }
  const [left] = sql
    .exec(
      "SELECT 1 FROM cf_think_workflow_notifications WHERE delivered_at IS NULL LIMIT 1"
    )
    .toArray();
  if (left) return;
  sql.exec("DROP TABLE cf_think_workflow_notifications");
}

/** The submission metadata key a workflow's prompt is kept under. */
const WORKFLOW_PROMPT_METADATA_KEY = "__thinkWorkflowPrompt";

/**
 * The workflow prompt a submission's metadata carries, if it is one a
 * workflow step submitted.
 *
 * @internal
 */
export function workflowPromptContext(
  metadata: Record<string, unknown> | null | undefined
): ThinkWorkflowPromptContext | null {
  const workflowPromptValue = metadata?.[WORKFLOW_PROMPT_METADATA_KEY];
  if (
    workflowPromptValue === null ||
    typeof workflowPromptValue !== "object" ||
    Array.isArray(workflowPromptValue)
  ) {
    return null;
  }
  const workflowPrompt = workflowPromptValue as Record<string, unknown>;
  const workflowValue = workflowPrompt.workflow;
  if (
    workflowValue === null ||
    typeof workflowValue !== "object" ||
    Array.isArray(workflowValue)
  ) {
    return null;
  }
  const workflowRecord = workflowValue as Record<string, unknown>;
  if (
    typeof workflowRecord.name !== "string" ||
    typeof workflowRecord.id !== "string" ||
    typeof workflowRecord.stepName !== "string" ||
    typeof workflowRecord.eventType !== "string"
  ) {
    return null;
  }
  const output = workflowPrompt.output;
  const outputRecord =
    output !== null && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : null;
  return {
    workflow: {
      name: workflowRecord.name,
      id: workflowRecord.id,
      stepName: workflowRecord.stepName,
      eventType: workflowRecord.eventType
    },
    ...(outputRecord
      ? {
          output: {
            schema: outputRecord.schema
          }
        }
      : {}),
    ...(typeof workflowPrompt.fingerprint === "string" && {
      fingerprint: workflowPrompt.fingerprint
    })
  };
}

/**
 * Send the workflow event a terminal submission owes. False when the
 * submission is not a workflow's. A repeat while the delivery is open joins
 * it (the id is stable).
 *
 * @internal
 */
export function sendWorkflowNotification(
  tasks: Tasks,
  submission: ThinkSubmissionInspection,
  output?: unknown
): boolean {
  const workflowPrompt = workflowPromptContext(submission.metadata ?? null);
  if (!workflowPrompt) return false;

  const { status, error } = submission;
  const payload = {
    submissionId: submission.submissionId,
    status,
    ...(status === "completed" && { output }),
    ...(error && { error })
  };
  void sendDelivery(
    tasks,
    WORKFLOW_NOTIFICATION_SINK,
    workflowNotificationId(
      submission.submissionId,
      workflowPrompt.workflow.eventType
    ),
    {
      workflowName: workflowPrompt.workflow.name,
      workflowId: workflowPrompt.workflow.id,
      event: { type: workflowPrompt.workflow.eventType, payload }
    } satisfies WorkflowNotification
  ).catch((error) => {
    console.error("[Think] Failed to send workflow notification", error);
  });
  return true;
}
