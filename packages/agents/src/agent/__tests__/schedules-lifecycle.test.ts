import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../..";
import { registerAgentSchedulerHost } from "../../schedules/host";
import { AgentScheduler } from "../../schedules/manager";

function createSchedulerHarness(initialVersion?: number) {
  const owner = {} as Agent;
  let version = initialVersion;
  const queries: string[] = [];
  const put = vi.fn(async (_key: string, value: number) => {
    version = value;
  });

  registerAgentSchedulerHost(owner, {
    agent: owner,
    storage: {
      get: vi.fn(async () => version),
      put
    } as unknown as DurableObjectStorage,
    sql: vi.fn() as never,
    rawSql: ((query: string) => {
      queries.push(query);
      return {
        toArray: () =>
          query.includes("sqlite_master")
            ? [
                {
                  sql: "CREATE TABLE cf_agents_schedules (type TEXT CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')))"
                }
              ]
            : []
      };
    }) as SqlStorage["exec"],
    emit: vi.fn(),
    retryDefaults: () => ({
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 3000
    }),
    hungScheduleTimeoutSeconds: () => 300,
    validateScheduleCallback: vi.fn(),
    isFacet: () => false,
    selfPath: () => [],
    rootAlarmOwner: vi.fn() as never,
    isSameAgentPathPrefix: () => false,
    dispatchFacetCallback: vi.fn() as never,
    scheduleNextAlarm: vi.fn(),
    isDestroyed: () => false,
    onError: vi.fn()
  });

  return { owner, put, queries };
}

describe("AgentScheduler lifecycle", () => {
  it("does not migrate while default and replacement components construct", () => {
    const { owner, queries } = createSchedulerHarness();

    new AgentScheduler(owner);
    new AgentScheduler(owner);

    expect(queries).toEqual([]);
  });

  it("migrates the installed component once on start", async () => {
    const { owner, put, queries } = createSchedulerHarness();
    const scheduler = new AgentScheduler(owner);

    await scheduler.onStart({ props: undefined });
    const queryCount = queries.length;

    expect(queryCount).toBeGreaterThan(0);
    expect(put).toHaveBeenCalledWith("cf_agents:schedules_schema_version", 1);

    await scheduler.onStart({ props: undefined });
    expect(queries).toHaveLength(queryCount);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("skips migration when the component schema is current", async () => {
    const { owner, put, queries } = createSchedulerHarness(1);
    const scheduler = new AgentScheduler(owner);

    await scheduler.onStart({ props: undefined });

    expect(queries).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });
});
