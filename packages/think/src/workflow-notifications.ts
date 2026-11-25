import type { DeliverySink } from "agents/internal";
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
 * is gone. The give-up error reaches the agent's `onError`.
 *
 * @internal
 */
export function workflowNotificationSink(
  send: (notification: WorkflowNotification) => Promise<void>
): DeliverySink<WorkflowNotification> {
  return {
    deliver: (notification) => send(notification),
    giveUpError: (notification, _id, attempts, cause) =>
      // Deliberately no `cause`: Tasks keeps a run whose error's cause chain
      // is a platform-class failure, which would keep it past the cutoff.
      new Error(
        `Workflow notification for submission ${JSON.stringify(
          notification.event.payload?.submissionId
        )} (${notification.workflowName}/${notification.workflowId}, ${notification.event.type}) ` +
          `could not be delivered after ${attempts} attempts over 12h; giving up: ` +
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
 * table as deliveries and drop the table. A missing table means a fresh
 * object or a finished migration. One bad row does not hold back the rest.
 *
 * TEMPORARY: one-shot upgrade path. Remove in the next minor.
 *
 * @internal
 */
export async function migrateWorkflowNotificationTable(
  sql: SqlStorage,
  send: (id: string, notification: WorkflowNotification) => Promise<unknown>
): Promise<void> {
  if (!tableExists(sql, "cf_think_workflow_notifications")) return;
  const rows = sql
    .exec<{
      submission_id: string;
      workflow_name: string;
      workflow_id: string;
      event_type: string;
      payload_json: string;
    }>(
      `SELECT submission_id, workflow_name, workflow_id, event_type, payload_json
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
      continue;
    }
    try {
      await send(workflowNotificationId(row.submission_id, row.event_type), {
        workflowName: row.workflow_name,
        workflowId: row.workflow_id,
        event: { type: row.event_type, payload }
      });
    } catch (error) {
      console.error(
        `[Think] could not migrate the workflow notification for submission ${row.submission_id}`,
        error
      );
    }
  }
  sql.exec("DROP TABLE cf_think_workflow_notifications");
}
