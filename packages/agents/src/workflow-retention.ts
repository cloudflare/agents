const DEFAULT_TRACKING_RETENTION_SECONDS = 30 * 24 * 60 * 60;

type WorkflowRetention = NonNullable<
  WorkflowInstanceCreateOptions["retention"]
>;
type WorkflowRetentionDuration = NonNullable<
  WorkflowRetention["successRetention"]
>;

const UNIT_SECONDS = {
  second: 1,
  minute: 60,
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
  year: 365 * 24 * 60 * 60
} as const;

/**
 * Normalize the Workflows duration syntax for Agent SQLite expiry arithmetic.
 * Numeric Workflow durations are milliseconds; tracking stores whole seconds
 * and rounds up so a local row is never deleted before platform retention.
 */
function retentionSeconds(duration: WorkflowRetentionDuration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(`Invalid Workflow retention duration: ${duration}`);
    }
    return Math.ceil(duration / 1000);
  }

  const match = duration.match(
    /^(.+) (second|minute|hour|day|week|month|year)s?$/
  );
  if (!match) {
    throw new Error(`Invalid Workflow retention duration: ${duration}`);
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid Workflow retention duration: ${duration}`);
  }

  const unit = match[2] as keyof typeof UNIT_SECONDS;
  return Math.ceil(amount * UNIT_SECONDS[unit]);
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
