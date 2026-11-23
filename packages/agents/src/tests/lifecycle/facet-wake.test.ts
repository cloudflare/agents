import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "../../index";

/**
 * A facet has no alarm. Its jobs live in its own queue, and its Lifecycle
 * asks the root to hold one wake job for its path; the root's alarm calls
 * down and the facet runs its due jobs with the same driver as a root.
 */

let rootName = "";

async function root() {
  rootName = crypto.randomUUID();
  return getAgentByName(env.FacetWakeRoot, rootName);
}

/** The root's wake job id for a facet path below the current root. */
function wakeId(below: string): string {
  return `facet:FacetWakeRoot:${rootName}/${below}`;
}

describe("facet wake", () => {
  it("runs a facet's job from the root's alarm, one level down", async () => {
    const agent = await root();
    const pending = await agent.middlePush("m", "job-1", 0);
    expect(pending).toEqual(["job-1"]);

    const jobs = await agent.rootJobs();
    expect(jobs.map((job) => job.id)).toEqual([wakeId("FacetWakeMiddle:m")]);

    await runDurableObjectAlarm(agent);
    expect(await agent.middleRan("m")).toEqual(["job-1"]);
    // Nothing left in the facet: the root's wake job is gone.
    expect(await agent.rootJobs()).toEqual([]);
  });

  it("runs a job two levels down and keeps one wake per facet path", async () => {
    const agent = await root();
    await agent.leafPush("m", "l", "deep-1", 0);
    await agent.leafPush("m", "l", "deep-2", 60_000);
    await agent.middlePush("m", "mid-1", 120_000);

    const ids = (await agent.rootJobs()).map((job) => job.id).sort();
    expect(ids).toEqual([
      wakeId("FacetWakeMiddle:m"),
      wakeId("FacetWakeMiddle:m/FacetWakeLeaf:l")
    ]);

    await runDurableObjectAlarm(agent);
    expect(await agent.leafRan("m", "l")).toEqual(["deep-1"]);
    expect(await agent.leafPending("m", "l")).toEqual(["deep-2"]);
    // The reply moved the leaf's wake to its next job.
    const leafWake = (await agent.rootJobs()).find(
      (job) => job.id === wakeId("FacetWakeMiddle:m/FacetWakeLeaf:l")
    );
    expect(leafWake?.time).toBeGreaterThan(Date.now() + 50_000);
  });

  it("drops a deleted sub-tree's wakes", async () => {
    const agent = await root();
    await agent.leafPush("m", "l", "deep", 60_000);
    await agent.middlePush("m", "mid", 60_000);
    expect((await agent.rootJobs()).length).toBe(2);

    await agent.deleteMiddle("m");
    expect(await agent.rootJobs()).toEqual([]);
  });

  it("keeps a failing facet job inside the facet's own driver", async () => {
    const agent = await root();
    await agent.middlePush("m", "fail-always", 0);
    await runDurableObjectAlarm(agent);
    // The facet's driver retried it and gave it up itself: it ran more than
    // once inside the facet, and when it was given up nothing was left to
    // wake. The root's own alarm did not fail.
    await vi.waitFor(
      async () => {
        expect(
          (await agent.middleRan("m")).filter((id) => id === "fail-always")
            .length
        ).toBeGreaterThan(1);
        expect(await agent.middlePending("m")).toEqual([]);
        expect(await agent.rootJobs()).toEqual([]);
      },
      { timeout: 8_000 }
    );
  });

  it("keeps a facet's wake, backed off, when the call down fails", async () => {
    const agent = await root();
    await agent.failNextFacetDrives(1);
    await agent.middlePush("m", "after-failure", 0);

    const started = Date.now();
    await runDurableObjectAlarm(agent);
    // The failure stayed out of the root's driver: the wake is still there
    // for a later try, and the job has not run. (The real alarm may be the
    // one that drove it, so wait for its outcome.)
    await vi.waitFor(async () => {
      const [wake] = await agent.rootJobs();
      expect(wake?.time).toBeGreaterThanOrEqual(started + 25_000);
    });
    expect(await agent.middleRan("m")).toEqual([]);
  });

  it("ignores a wake report older than the one it holds", async () => {
    const agent = await root();
    await agent.reportFacetWake(
      "FacetWakeRoot:x/FacetWakeMiddle:y",
      50_000 + Date.now(),
      200
    );
    await agent.reportFacetWake("FacetWakeRoot:x/FacetWakeMiddle:y", null, 100);
    expect(await agent.rootJobs()).toHaveLength(1);
    await agent.reportFacetWake("FacetWakeRoot:x/FacetWakeMiddle:y", null, 300);
    expect(await agent.rootJobs()).toEqual([]);
  });

  it("backs off a path whose drives keep ending without a reply", async () => {
    const agent = await root();
    await agent.middlePush("m", "first", 60_000);
    const key = (await agent.rootJobs())[0]!.id.slice("facet:".length);
    // Three drives of this path ended with the isolate (a job over the
    // memory limit takes the root down with it, so nothing replied).
    agent.markUnreportedDrives(key, 3);

    const now = Date.now();
    await agent.middlePush("m", "due-now", 0);
    // The report is held to the path's back-off, not woken at once.
    const [wake] = await agent.rootJobs();
    expect(wake?.time).toBeGreaterThanOrEqual(now + 25_000);
  });

  it("does not hold the root's own jobs behind a slow facet job", async () => {
    const agent = await root();
    await agent.middlePush("m", "slow-job", 0);
    await agent.pushJob("root-job", 0);

    // Whichever alarm drives it (the real one may), the root waits on the
    // facet no longer than its drive budget: its own job runs while the
    // facet's slow job is still going.
    await runDurableObjectAlarm(agent);
    await vi.waitFor(
      async () => expect(await agent.ran()).toContain("root-job"),
      { timeout: 6_000 }
    );
    expect(await agent.middleRan("m")).toEqual([]);

    // The facet's job finished on its own and re-armed nothing left.
    await vi.waitFor(
      async () => {
        expect(await agent.middleRan("m")).toEqual(["slow-job"]);
        expect(
          (await agent.rootJobs()).filter((job) => job.id.startsWith("facet:"))
        ).toEqual([]);
      },
      { timeout: 8_000 }
    );
  }, 20_000);

  it("wakes every facet with jobs at once when the root starts again", async () => {
    const name = crypto.randomUUID();
    const agent = await getAgentByName(env.FacetWakeRoot, name);
    await agent.middlePush("m", "later", 60_000);

    const resetAt = Date.now();
    await agent.resetTree().catch(() => {});
    // Start the root again and leave the facet alone: only the root's wake
    // can start it now.
    const again = await getAgentByName(env.FacetWakeRoot, name);
    await again.rootJobs();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The facet started (its own start recovers what the reset cut off)
    // before this test reached it, so the root's restart drove it.
    const before = Date.now();
    const starts = await again.middleStarts("m");
    expect(starts.some((at) => at > resetAt && at < before)).toBe(true);
  });

  it("keeps the recheck delay of an unreplied drive whose wake was already due when the root starts again", async () => {
    const name = crypto.randomUUID();
    const agent = await getAgentByName(env.FacetWakeRoot, name);
    await agent.middlePush("m", "due", 60_000);
    const key = (await agent.rootJobs())[0]!.id.slice("facet:".length);
    // A drive went unanswered because it took the tree down with it; its
    // claimed wake is still due.
    await agent.markUnreportedDrives(key, 1);
    await agent.makeFacetWakesDueKeepingDrives();
    const marked = Date.now();

    await agent.resetTree().catch(() => {});
    const again = await getAgentByName(env.FacetWakeRoot, name);
    const [wake] = await again.rootJobs();
    expect(wake!.time).toBeGreaterThanOrEqual(marked + 25_000);
    // The root's alarm follows the moved wake, not the old minute.
    expect(await again.alarmAt()).toBe(wake!.time);
  });

  it("keeps the recheck delay for a facet whose last drive never replied", async () => {
    const name = crypto.randomUUID();
    const agent = await getAgentByName(env.FacetWakeRoot, name);
    await agent.middlePush("m", "later", 60_000);
    const key = (await agent.rootJobs())[0]!.id.slice("facet:".length);
    await agent.markUnreportedDrives(key, 1);
    const marked = Date.now();

    await agent.resetTree().catch(() => {});
    const again = await getAgentByName(env.FacetWakeRoot, name);
    const [wake] = await again.rootJobs();
    expect(wake!.time).toBeGreaterThanOrEqual(marked + 25_000);
    expect(wake!.time).toBeLessThan(marked + 60_000);
    expect(await again.alarmAt()).toBe(wake!.time);
  });

  it("gives up a facet job that keeps ending its isolate", async () => {
    const name = crypto.randomUUID();
    // The job ends the isolate, which may take this stub's root with it, so
    // every step gets a fresh stub.
    const fresh = () => getAgentByName(env.FacetWakeRoot, name);
    await (await fresh()).middlePush("m", "abort-always", 0);
    for (let wake = 0; wake < 8; wake++) {
      await (await fresh()).makeFacetWakesDue().catch(() => {});
      await runDurableObjectAlarm(await fresh()).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      const pending = await (
        await fresh()
      )
        .middlePending("m")
        .catch(() => ["unreachable"]);
      if (pending.length === 0) break;
    }
    // The facet's own driver counted each attempt before it ran, so after
    // the attempts ran out it gave the job up instead of running it again.
    const agent = await fresh();
    expect(await agent.middlePending("m")).toEqual([]);
    expect(await agent.middleRan("m")).toContain("gave-up:abort-always");
  }, 20_000);

  it("syncs a driven facet's claimed attempt before the job runs", async () => {
    const agent = await root();
    await agent.middlePush("m", "later", 60_000);
    await agent.middleCountSyncs("m");
    await agent.middlePush("m", "now", 0);
    const afterReport = await agent.middleSyncCount("m");
    await agent.makeFacetWakesDue();
    await runDurableObjectAlarm(agent);
    await vi.waitFor(async () => {
      expect(await agent.middleRan("m")).toContain("now");
    });
    // One sync for the claim of "now", before its job ran.
    expect(await agent.middleSyncCount("m")).toBeGreaterThan(afterReport);
  });

  it("sends its root no report while it has no jobs", async () => {
    const agent = await root();
    await agent.middleRearm("m");
    await agent.middleRearm("m");
    expect(await agent.armReportCount()).toBe(0);
    expect(await agent.rootJobs()).toEqual([]);
  });
});
