/**
 * Span shape for one Lifecycle job dispatch.
 *
 * The alarm loop delivers each due job to its owner the way a push-based
 * broker delivers a message to a consumer callback, so a dispatch is an OTel
 * messaging "process" span: the job queue is the messaging system, the
 * owning capability is the destination, and the job id is the message id.
 * Queue-specific detail that semconv has no attribute for lives under
 * `cloudflare.agents.job.*`.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/#process-span
 */

import { instrumentationScopeAttributes } from "../observability/agent-span-attributes";
import type { TraceAttributes } from "../observability/tracing/tracer";
import type { JobStorageRow, LifecycleJobOutcome } from "./job-queue";

/**
 * `messaging.system` for the Lifecycle job queue. Semconv has no well-known
 * value for it, so this is a custom one in the style of `aws.sns`.
 */
const MESSAGING_SYSTEM = "cloudflare.agents";

/** The semconv operation name for delivering a message to a consumer. */
const PROCESS_OPERATION = "process";

/**
 * What happened to a dispatched job's row. Orthogonal to failure: a job that
 * failed and was completed by its owner's failure hook reports `completed`
 * alongside `error.type`.
 */
export type JobSpanOutcome =
  /** The row was deleted. */
  | "completed"
  /** The row was re-timed to `cloudflare.agents.job.reschedule_at`. */
  | "rescheduled"
  /** The row stays due and wakes again immediately. */
  | "yielded"
  /** A platform failure deferred the preserved row to a fresh invocation. */
  | "deferred"
  /** No installed owner handles the row, so it was deleted unrun. */
  | "dropped"
  /** The host was torn down mid-dispatch; the row was left untouched. */
  | "abandoned";

/**
 * Span name: `{messaging.operation.name} {messaging.destination.name}`.
 * Capability ids are a small fixed set, so the name stays low-cardinality;
 * the job's `fn` is an attribute because user callback names need not be.
 */
export function jobSpanName(row: JobStorageRow): string {
  return `${PROCESS_OPERATION} ${row.capability}`;
}

/**
 * Attributes known when the dispatch starts. The semconv attributes semconv
 * wants at creation time for sampling decisions are all here.
 */
export function jobSpanAttributes(input: {
  readonly row: JobStorageRow;
  readonly nowMs: number;
  readonly hungReset: boolean;
}): TraceAttributes {
  const { row } = input;
  return {
    ...instrumentationScopeAttributes,
    "messaging.system": MESSAGING_SYSTEM,
    "messaging.operation.name": PROCESS_OPERATION,
    "messaging.operation.type": PROCESS_OPERATION,
    "messaging.destination.name": row.capability,
    "messaging.message.id": row.id,
    "cloudflare.agents.job.fn": row.fn,
    // How late the dispatch started relative to the job's due time.
    "cloudflare.agents.job.lag_ms": Math.max(0, input.nowMs - row.time),
    "cloudflare.agents.job.singleflight": row.singleflight === 1,
    "cloudflare.agents.job.exclusive": row.exclusive === 1,
    "cloudflare.agents.job.recovery_loop": row.recovery_loop === 1,
    "cloudflare.agents.job.hung_reset": input.hungReset
  };
}

/** How one dispatch settled, as reported on its span. */
export type JobSpanReport = {
  readonly outcome: JobSpanOutcome;
  /** Owner `onJob` invocations made; 0 when the job never reached one. */
  readonly attempts: number;
  /** Retry budget for this dispatch; absent when the job never reached one. */
  readonly maxAttempts?: number;
  /** The new due time, for `rescheduled` only. */
  readonly rescheduleAt?: number;
};

/** The row disposition a drive result asks for. */
export function jobSpanDisposition(
  outcome: LifecycleJobOutcome
): Pick<JobSpanReport, "outcome" | "rescheduleAt"> {
  if (outcome === undefined) return { outcome: "completed" };
  if (outcome === "yield") return { outcome: "yielded" };
  return { outcome: "rescheduled", rescheduleAt: outcome.rescheduleAt };
}

/** Attributes known once the dispatch has settled. */
export function jobSpanFinishAttributes(
  report: JobSpanReport
): TraceAttributes {
  return {
    "cloudflare.agents.job.outcome": report.outcome,
    "cloudflare.agents.job.attempt.count": report.attempts,
    "cloudflare.agents.job.retry.max_attempts": report.maxAttempts,
    "cloudflare.agents.job.reschedule_at": report.rescheduleAt
  };
}

/** Marker set while the span is open when a dispatch outlives its hung timeout. */
export const SLOW_DISPATCH_ATTRIBUTES: TraceAttributes = {
  "cloudflare.agents.job.slow_dispatch": true
};
