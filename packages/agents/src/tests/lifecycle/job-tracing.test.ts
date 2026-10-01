import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { setLifecycleTracer } from "../../lifecycle/durable-object-lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";
import { RecordingTracer } from "../observability/recording-tracer";

const LATER = Date.UTC(2099, 0, 1);

/** Fast retries so failing jobs exhaust their budget without waiting. */
const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };

/**
 * Job owner whose behavior is chosen by the job's `fn`, covering every way a
 * dispatch can settle.
 */
class TracedJobs extends LifecycleCapability {
  constructor(private readonly tracer: RecordingTracer) {
    super("traced");
  }

  async onJob({
    job,
    attempt
  }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    switch (job.fn) {
      case "ok":
        return undefined;
      case "flaky":
        if (attempt === 1) throw new TypeError("first attempt fails");
        return undefined;
      case "broken":
        throw new RangeError("always fails");
      case "later":
        return { rescheduleAt: LATER };
      case "again":
        return "yield";
      case "lost":
        throw new Error("Network connection lost.");
      case "nested":
        await this.tracer.withSpan("owner work", {}, async () => undefined);
        return undefined;
      default:
        throw new Error(`unexpected fn ${job.fn}`);
    }
  }

  async onJobError(): Promise<LifecycleJobOutcome> {
    return { rescheduleAt: LATER };
  }

  /** This capability's scoped job surface, for seeding. */
  jobs() {
    return this.lifecycle.jobs;
  }
}

type Seed = {
  /** Owner of the seeded job; `host` has no `onJob` on the harness. */
  readonly owner?: "traced" | "host";
  readonly job: LifecycleJobPushOptions;
  /** Mark the row in flight `startedAgoMs` ago before the alarm runs. */
  readonly inFlight?: { readonly startedAgoMs: number };
};

/** Push the seeds, drive one alarm, and return what was traced. */
async function traceAlarm(seeds: readonly Seed[]): Promise<{
  readonly tracer: RecordingTracer;
  readonly alarm: PromiseSettledResult<void>;
}> {
  const tracer = new RecordingTracer();
  return withCapabilityHarness(async ({ install, storage }) => {
    const capability = new TracedJobs(tracer);
    const { lifecycle } = install(capability);
    setLifecycleTracer(lifecycle, tracer);
    await lifecycle.start();

    for (const seed of seeds) {
      const jobs = seed.owner === "host" ? lifecycle.jobs : capability.jobs();
      await jobs.push(seed.job);
      if (seed.inFlight) {
        storage.sql.exec(
          `UPDATE cf_agents_jobs SET running = 1, execution_started_at = ?
           WHERE id = ?`,
          Date.now() - seed.inFlight.startedAgoMs,
          seed.job.id ?? ""
        );
      }
    }

    const [alarm] = await Promise.allSettled([lifecycle.alarm()]);
    await storage.deleteAlarm();
    return { tracer, alarm };
  });
}

describe("Lifecycle job tracing", () => {
  it("opens one semconv process span per dispatched job", async () => {
    const { tracer } = await traceAlarm([
      { job: { id: "job-ok", fn: "ok", time: Date.now() - 500 } }
    ]);

    expect(tracer.rootSpans.map((span) => span.name)).toEqual([
      "process traced"
    ]);
    const [span] = tracer.rootSpans;
    expect(span.ended).toBe(true);
    expect(span.attributes).toMatchObject({
      "instrumentation_scope.name": "agents",
      "messaging.system": "cloudflare.agents",
      "messaging.operation.name": "process",
      "messaging.operation.type": "process",
      "messaging.destination.name": "traced",
      "messaging.message.id": "job-ok",
      "cloudflare.agents.job.fn": "ok",
      "cloudflare.agents.job.singleflight": false,
      "cloudflare.agents.job.exclusive": false,
      "cloudflare.agents.job.recovery_loop": false,
      "cloudflare.agents.job.hung_reset": false,
      "cloudflare.agents.job.outcome": "completed",
      "cloudflare.agents.job.attempt.count": 1,
      "cloudflare.agents.job.retry.max_attempts": 3
    });
    expect(span.attributes["cloudflare.agents.job.lag_ms"]).toBeGreaterThan(
      400
    );
    expect(span.attributes["error.type"]).toBeUndefined();
    expect(span.status).toBeUndefined();
  });

  it("nests the owner's spans under the job that caused them", async () => {
    const { tracer } = await traceAlarm([
      { job: { id: "job-nested", fn: "nested", time: Date.now() } }
    ]);

    const [span] = tracer.rootSpans;
    expect(span.name).toBe("process traced");
    expect(span.children.map((child) => child.name)).toEqual(["owner work"]);
  });

  it("records a retried attempt as an exception event, not a failure", async () => {
    const { tracer } = await traceAlarm([
      {
        job: {
          id: "job-flaky",
          fn: "flaky",
          time: Date.now(),
          retry: FAST_RETRY
        }
      }
    ]);

    const [span] = tracer.rootSpans;
    expect(span.exceptions).toEqual([{ name: "TypeError" }]);
    expect(span.attributes).toMatchObject({
      "cloudflare.agents.job.outcome": "completed",
      "cloudflare.agents.job.attempt.count": 2
    });
    expect(span.attributes["error.type"]).toBeUndefined();
    expect(span.status).toBeUndefined();
  });

  it("marks an exhausted job failed and reports what its owner did", async () => {
    const { tracer } = await traceAlarm([
      {
        job: {
          id: "job-broken",
          fn: "broken",
          time: Date.now(),
          retry: FAST_RETRY
        }
      }
    ]);

    const [span] = tracer.rootSpans;
    expect(span.exceptions).toEqual([
      { name: "RangeError" },
      { name: "RangeError" },
      { name: "RangeError" }
    ]);
    expect(span.status).toBe("error");
    expect(span.attributes).toMatchObject({
      "error.type": "RangeError",
      "cloudflare.agents.job.outcome": "rescheduled",
      "cloudflare.agents.job.reschedule_at": LATER,
      "cloudflare.agents.job.attempt.count": 3
    });
  });

  it("reports reschedule and yield drive results", async () => {
    const { tracer } = await traceAlarm([
      { job: { id: "job-later", fn: "later", time: Date.now() - 2 } },
      { job: { id: "job-again", fn: "again", time: Date.now() - 1 } }
    ]);

    expect(
      tracer.rootSpans.map((span) => [
        span.attributes["messaging.message.id"],
        span.attributes["cloudflare.agents.job.outcome"],
        span.attributes["cloudflare.agents.job.reschedule_at"]
      ])
    ).toEqual([
      ["job-later", "rescheduled", LATER],
      ["job-again", "yielded", undefined]
    ]);
  });

  it("closes the span as deferred before a platform failure escapes", async () => {
    const { tracer, alarm } = await traceAlarm([
      {
        job: { id: "job-lost", fn: "lost", time: Date.now(), retry: FAST_RETRY }
      }
    ]);

    expect(alarm.status).toBe("rejected");
    const [span] = tracer.rootSpans;
    expect(span.ended).toBe(true);
    expect(span.endCount).toBe(1);
    expect(span.status).toBe("error");
    expect(span.attributes).toMatchObject({
      "error.type": "Error",
      "cloudflare.agents.job.outcome": "deferred",
      // A transient platform error is retried in-process before deferring.
      "cloudflare.agents.job.attempt.count": 3
    });
  });

  it("reports a job with no installed owner as dropped", async () => {
    const { tracer } = await traceAlarm([
      { owner: "host", job: { id: "job-orphan", fn: "ok", time: Date.now() } }
    ]);

    const [span] = tracer.rootSpans;
    expect(span.name).toBe("process host");
    expect(span.attributes).toMatchObject({
      "messaging.destination.name": "host",
      "cloudflare.agents.job.outcome": "dropped",
      "cloudflare.agents.job.attempt.count": 0
    });
  });

  it("opens no span for a skipped single-flight job, and flags a hung reset", async () => {
    const { tracer } = await traceAlarm([
      {
        job: { id: "job-busy", fn: "ok", time: Date.now(), singleflight: true },
        inFlight: { startedAgoMs: 1_000 }
      },
      {
        job: {
          id: "job-hung",
          fn: "ok",
          time: Date.now(),
          singleflight: true,
          hungTimeoutSeconds: 1
        },
        inFlight: { startedAgoMs: 5_000 }
      }
    ]);

    expect(
      tracer.rootSpans.map((span) => [
        span.attributes["messaging.message.id"],
        span.attributes["cloudflare.agents.job.hung_reset"]
      ])
    ).toEqual([["job-hung", true]]);
  });

  it("records nothing when the invocation is not traced", async () => {
    const tracer = new RecordingTracer({ isTraced: false });
    await withCapabilityHarness(async ({ install, storage }) => {
      const capability = new TracedJobs(tracer);
      const { lifecycle } = install(capability);
      setLifecycleTracer(lifecycle, tracer);
      await lifecycle.start();
      await capability.jobs().push({
        id: "job-untraced",
        fn: "flaky",
        time: Date.now(),
        retry: FAST_RETRY
      });
      await lifecycle.alarm();
      await storage.deleteAlarm();
    });

    const [span] = tracer.rootSpans;
    expect(span.name).toBe("process traced");
    expect(span.attributes).toEqual({});
    expect(span.exceptions).toEqual([]);
  });
});
