import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
});
