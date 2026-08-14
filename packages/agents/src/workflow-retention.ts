import { ms } from "itty-time";

const DEFAULT_TRACKING_RETENTION_SECONDS = 30 * 24 * 60 * 60;

type WorkflowRetention = NonNullable<
  WorkflowInstanceCreateOptions["retention"]
>;
type WorkflowRetentionDuration = NonNullable<
  WorkflowRetention["successRetention"]
>;

function retentionSeconds(duration: WorkflowRetentionDuration): number {
  const durationMs = ms(duration);
  if (!Number.isFinite(durationMs)) {
    throw new Error(`Invalid Workflow retention duration: ${duration}`);
  }
  return Math.ceil(durationMs / 1000);
}

export function normalizeWorkflowRetention(
  retention: WorkflowInstanceCreateOptions["retention"]
): {
  successRetentionSeconds: number;
  errorRetentionSeconds: number;
} {
  return {
    successRetentionSeconds:
      retention?.successRetention === undefined
        ? DEFAULT_TRACKING_RETENTION_SECONDS
        : retentionSeconds(retention.successRetention),
    errorRetentionSeconds:
      retention?.errorRetention === undefined
        ? DEFAULT_TRACKING_RETENTION_SECONDS
        : retentionSeconds(retention.errorRetention)
  };
}
