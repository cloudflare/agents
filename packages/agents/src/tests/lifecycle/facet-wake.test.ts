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
    // The facet's driver ran it and settled its failure itself; the root's
    // call did not fail, and nothing is left to wake.
    await vi.waitFor(async () => {
      expect(await agent.middleRan("m")).toContain("fail-always");
      expect(await agent.rootJobs()).toEqual([]);
    });
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

    const started = Date.now();
    await runDurableObjectAlarm(agent);
    // The root waited on the facet no longer than its drive budget, and its
    // own job ran in the same alarm.
    expect(Date.now() - started).toBeLessThan(6_500);
    expect(await agent.ran()).toContain("root-job");

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
});
