import { OutboxPayloadTooLargeError, type OutboxSink } from "agents/chat";

/**
 * The workflow event a terminal submission owes, delivered through the
 * Outbox until the workflow accepts it.
 */
export type WorkflowNotification = {
  workflowName: string;
  workflowId: string;
  event: { type: string; payload: unknown };
};

/** Outbox sink that delivers workflow notifications. */
export const WORKFLOW_NOTIFICATION_SINK = "__cf_think_workflow_notification";

/** One notification per submission and event type. */
export function workflowNotificationKey(
  submissionId: string,
  eventType: string
): string {
  return `${submissionId}:${eventType}`;
}

/**
 * The sink. The Outbox defaults (2s doubling, ten-minute cap, giving up
 * twelve hours after the first attempt) ride out an outage of the workflow
 * binding without waking the object forever for a workflow that is gone.
 */
export function workflowNotificationSink(
  sendWorkflowEvent: (notification: WorkflowNotification) => Promise<void>,
  reportGiveUp: (error: Error) => void | Promise<void>
): OutboxSink<WorkflowNotification> {
  return {
    deliver: (notification) => sendWorkflowEvent(notification),
    onGiveUp: (notification, delivery, error) => {
      const submissionId = (
        notification.event.payload as { submissionId?: string } | undefined
      )?.submissionId;
      return reportGiveUp(
        new Error(
          `Workflow notification for submission ${JSON.stringify(submissionId)} ` +
            `(${notification.workflowName}/${notification.workflowId}, ${notification.event.type}) ` +
            `could not be delivered after ${delivery.attempts} attempts; giving up: ` +
            (error instanceof Error ? error.message : String(error))
        )
      );
    }
  };
}

/**
 * Store a notification for delivery. One whose output is too large for
 * the Outbox is replaced by an error notification under the same key, so
 * the workflow's `step.prompt()` fails instead of waiting for an event that
 * never comes.
 */
export async function sendWorkflowNotification(
  send: (notification: WorkflowNotification, key: string) => Promise<unknown>,
  notification: WorkflowNotification,
  key: string
): Promise<void> {
  try {
    await send(notification, key);
  } catch (error) {
    if (!(error instanceof OutboxPayloadTooLargeError)) throw error;
    const { submissionId } = (notification.event.payload ?? {}) as {
      submissionId?: string;
    };
    await send(
      {
        ...notification,
        event: {
          type: notification.event.type,
          payload: {
            submissionId,
            status: "error",
            error:
              "The submission's output is too large to deliver to the workflow (over 1 MB of JSON)."
          }
        }
      },
      key
    );
  }
}

/**
 * The notification a queue item or scheduled retry from an earlier release
 * carries. TEMPORARY: remove with `_cfDeliverWorkflowNotification`.
 */
export function legacyWorkflowNotification(payload: WorkflowNotification): {
  notification: WorkflowNotification;
  key: string;
} {
  const submissionId =
    (payload.event.payload as { submissionId?: string } | undefined)
      ?.submissionId ?? "";
  return {
    notification: {
      workflowName: payload.workflowName,
      workflowId: payload.workflowId,
      event: payload.event
    },
    key: workflowNotificationKey(submissionId, payload.event.type)
  };
}

/**
 * Move undelivered rows of the retired `cf_think_workflow_notifications`
 * table into the Outbox and drop the table. A missing table means a fresh
 * object or a finished migration.
 */
export async function migrateWorkflowNotificationTable(
  storage: DurableObjectStorage,
  send: (notification: WorkflowNotification, key: string) => Promise<unknown>
): Promise<void> {
  const tables = storage.sql
    .exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cf_think_workflow_notifications'"
    )
    .toArray();
  if (tables.length === 0) return;
  const rows = storage.sql
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
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    try {
      await sendWorkflowNotification(
        send,
        {
          workflowName: row.workflow_name,
          workflowId: row.workflow_id,
          event: { type: row.event_type, payload }
        },
        workflowNotificationKey(row.submission_id, row.event_type)
      );
    } catch (error) {
      // One bad row does not hold back the rest on every start.
      console.error(
        `[Think] could not migrate the workflow notification for submission ${row.submission_id}`,
        error
      );
    }
  }
  storage.sql.exec("DROP TABLE cf_think_workflow_notifications");
}
