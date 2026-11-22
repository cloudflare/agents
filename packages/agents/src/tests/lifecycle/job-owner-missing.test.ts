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

  it("re-arms for an installed owner while a hundred owners are missing", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs("installed-owner");
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      // Creates the queue table, then fills it with a hundred jobs whose
      // owners are not installed.
      await jobs.push({ id: "seed", fn: "run", time: Date.now() + 600_000 });
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        storage.sql.exec(
          `INSERT INTO cf_agents_jobs (id, capability, fn, time)
           VALUES (?, ?, 'run', ?)`,
          `gone-${i}`,
          `gone-owner-${i}`,
          now - 1
        );
      }
      await lifecycle.alarm();
      // All hundred are kept, untouched.
      expect(
        [
          ...storage.sql.exec(
            "SELECT COUNT(*) AS n FROM cf_agents_jobs WHERE id LIKE 'gone-%' AND time = ?",
            now - 1
          )
        ][0]?.n
      ).toBe(100);

      // All hundred are held; an installed owner can still push and its
      // earlier deadline becomes the wake.
      const due = Date.now() + 10_000;
      await jobs.push({ id: "mine", fn: "run", time: due });
      expect(await storage.getAlarm()).toBe(due);
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
