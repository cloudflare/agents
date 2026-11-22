import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import { withCapabilityHarness } from "../shared/capability-harness";

class Jobs extends LifecycleCapability {
  readonly ran: string[] = [];
  readonly attempts: number[] = [];

  constructor(id: string) {
    super(id);
  }

  onJob({ job, attempt }: LifecycleJobContext): void {
    this.ran.push(job.id);
    this.attempts.push(attempt);
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }
}

describe("jobs whose owner is not installed", () => {
  it("keeps the jobs untouched, holds the wake, and runs them in order once the owner returns", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      // A deploy installs the owner and it queues two jobs, the older first.
      const before = install(new Jobs("returning-owner"));
      await before.lifecycle.start();
      const now = Date.now();
      await before.capability.push({ id: "older", fn: "run", time: now - 2 });
      await before.capability.push({ id: "newer", fn: "run", time: now - 1 });
      const rows = () => [
        ...storage.sql.exec(
          "SELECT id, time, attempts, held_since FROM cf_agents_jobs ORDER BY time"
        )
      ];
      // History the older job carries: one unreported attempt and a hold.
      storage.sql.exec(
        "UPDATE cf_agents_jobs SET attempts = 1, held_since = ? WHERE id = 'older'",
        now - 60_000
      );
      const stored = rows();

      // The next deploy does not install it. Its alarms find the jobs
      // ownerless, several times.
      const without = install(new Jobs("someone-else"));
      await without.lifecycle.start();
      const capture = captureDiagnosticsEvents(
        "agents:lifecycle",
        without.lifecycle.name
      );
      try {
        for (let i = 0; i < 3; i++) await without.lifecycle.alarm();
        expect(
          capture.events.filter((event) => event.type === "job:owner_missing")
        ).toHaveLength(1);
      } finally {
        capture.stop();
      }

      // Nothing about the jobs changed, and the wake waits a minute.
      expect(rows()).toEqual(stored);
      expect(await storage.getAlarm()).toBeGreaterThanOrEqual(now + 55_000);

      // The owner comes back (a fresh isolate) and both run, older first,
      // the older one continuing its attempt count.
      const after = install(new Jobs("returning-owner"));
      await after.lifecycle.start();
      await after.lifecycle.alarm();
      expect(after.capability.ran).toEqual(["older", "newer"]);
      expect(after.capability.attempts).toEqual([2, 1]);
    });
  });

  it("reports a job whose unreported attempts ran out", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs("exhausted-owner");
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      await jobs.push({ id: "work", fn: "run", time: Date.now() + 60_000 });
      storage.sql.exec(
        "UPDATE cf_agents_jobs SET attempts = 3, time = ? WHERE id = 'work'",
        Date.now() - 1
      );
      const capture = captureDiagnosticsEvents(
        "agents:lifecycle",
        lifecycle.name
      );
      try {
        await lifecycle.alarm();
        expect(
          capture.events.find((event) => event.type === "job:exhausted")
            ?.payload
        ).toMatchObject({ capability: "exhausted-owner", attempts: 3 });
      } finally {
        capture.stop();
      }
    });
  });
});
