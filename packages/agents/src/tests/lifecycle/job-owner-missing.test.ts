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
  it("keeps the job, looks again later, and runs it once the owner returns", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      // A deploy installs the owner and it pushes a job.
      const before = install(new Jobs("returning-owner"));
      await before.lifecycle.start();
      await before.capability.push({
        id: "work",
        fn: "run",
        time: Date.now() - 1
      });

      // The next deploy does not install it (a rollback, a conditional
      // install). Its alarm finds the job ownerless.
      const without = install(new Jobs("someone-else"));
      await without.lifecycle.start();
      const capture = captureDiagnosticsEvents(
        "agents:lifecycle",
        without.lifecycle.name
      );
      try {
        const now = Date.now();
        await without.lifecycle.alarm();

        const [row] = [
          ...storage.sql.exec(
            "SELECT time FROM cf_agents_jobs WHERE id = 'work'"
          )
        ];
        expect(row?.time).toBeGreaterThanOrEqual(now + 60_000);
        expect(
          capture.events.find((event) => event.type === "job:owner_missing")
            ?.payload
        ).toMatchObject({ capability: "returning-owner", id: "work" });
      } finally {
        capture.stop();
      }

      // Looking at an ownerless job is no attempt of it: it can be looked
      // at many times and still runs once its owner returns.
      for (let i = 0; i < 4; i++) {
        storage.sql.exec(
          "UPDATE cf_agents_jobs SET time = ? WHERE id = 'work'",
          Date.now() - 1
        );
        await without.lifecycle.alarm();
      }

      // The owner comes back and the job runs.
      storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ? WHERE id = 'work'",
        Date.now() - 1
      );
      const after = install(new Jobs("returning-owner"));
      await after.lifecycle.start();
      await after.lifecycle.alarm();
      expect(after.capability.ran).toEqual(["work"]);
      expect(after.capability.attempts).toEqual([1]);
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
