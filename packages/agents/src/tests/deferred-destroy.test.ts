import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "..";
import { TestMcpJurisdiction } from "./worker";
import type { Agent } from "..";

/**
 * #1625: teardown must not ride the initiating request's `waitUntil` (the
 * runtime gives a canceled request's trailing work little to no grace, so a
 * multi-step destroy() got cut short, leaving half-deleted session DOs).
 * `_cf_scheduleDestroy` instead persists a "condemned" marker + an immediate
 * alarm; the alarm invocation runs the real teardown with its own budget, and
 * the marker survives any interruption so the next wake converges.
 */

const DESTROY_PENDING_KEY = "cf_agents_destroy_pending";

/**
 * Assert (with retries) that teardown fully completed for the named agent:
 * the condemned marker is gone (it is removed by the final deleteAll, so
 * "marker gone" === "teardown finished") and no alarm remains armed.
 *
 * `destroy()` ends by aborting the isolate, which poisons any stub created
 * before the abort — so every retry resolves a FRESH stub.
 */
async function expectTeardownCompleted(
  namespace: DurableObjectNamespace<Agent<Cloudflare.Env>>,
  name: string
): Promise<void> {
  await vi.waitFor(
    async () => {
      const stub = await getAgentByName(namespace, name);
      await runInDurableObject(stub, async (_instance, ctx) => {
        expect(await ctx.storage.get(DESTROY_PENDING_KEY)).toBeUndefined();
        expect(await ctx.storage.getAlarm()).toBeNull();
      });
    },
    { timeout: 10_000 }
  );
}

const scheduleAgentNs = () =>
  env.TestScheduleAgent as unknown as DurableObjectNamespace<
    Agent<Cloudflare.Env>
  >;

describe("deferred destroy (#1625)", () => {
  it("_cf_scheduleDestroy tears the agent down via its own alarm invocation", async () => {
    const name = crypto.randomUUID();
    const stub = await getAgentByName(env.TestScheduleAgent, name);
    // Seed durable state so there is something to tear down.
    await stub.schedule(86400, "testCallback", undefined);
    expect(await stub.getSchedules()).toHaveLength(1);

    await stub._cf_scheduleDestroy();

    // The immediate alarm auto-fires and completes the teardown.
    await expectTeardownCompleted(scheduleAgentNs(), name);
    const fresh = await getAgentByName(env.TestScheduleAgent, name);
    expect(await fresh.getSchedules()).toHaveLength(0);
  });

  it("a pending destroy pre-empts alarm work and converges from a half-torn state", async () => {
    const name = crypto.randomUUID();
    const stub = await getAgentByName(env.TestScheduleAgent, name);
    // Seed a due schedule that an ordinary alarm cycle would execute.
    await stub.schedule(0, "intervalCallback", undefined);

    // Simulate a destroy that a previous invocation started but couldn't
    // finish (#1625): some internal tables already dropped, the durable
    // marker still present. The alarm is set in the future so it cannot
    // auto-fire before we trigger it deterministically.
    await runInDurableObject(stub, async (instance, ctx) => {
      const agent = instance as unknown as {
        sql: (
          strings: TemplateStringsArray,
          ...values: (string | number | boolean | null)[]
        ) => unknown;
      };
      agent.sql`DROP TABLE IF EXISTS cf_agents_schedules`;
      agent.sql`DROP TABLE IF EXISTS cf_agents_queues`;
      await ctx.storage.put(DESTROY_PENDING_KEY, true);
      await ctx.storage.setAlarm(Date.now() + 86_400_000);
    });

    // The next wake finishes the teardown instead of resuming normal work
    // (running schedules, re-arming) on the condemned agent. destroy()
    // aborts the isolate as its final step, so the abort may land before
    // the test helper's stub call returns — swallow exactly that error.
    await runDurableObjectAlarm(stub).catch((error) => {
      if (!String(error).includes("destroyed")) throw error;
    });

    await expectTeardownCompleted(scheduleAgentNs(), name);
    const fresh = await getAgentByName(env.TestScheduleAgent, name);
    expect(await fresh.getSchedules()).toHaveLength(0);
  });

  it("_scheduleNextAlarm keeps the destroy alarm armed instead of deleting it as no-work", async () => {
    const stub = await getAgentByName(
      env.TestScheduleAgent,
      crypto.randomUUID()
    );
    // No schedules, no keepAlive leases — without the pending-destroy guard,
    // _scheduleNextAlarm's "no work pending" branch would delete the alarm
    // armed by _cf_scheduleDestroy and the teardown would never land.
    await runInDurableObject(stub, async (instance, ctx) => {
      await ctx.storage.put(DESTROY_PENDING_KEY, true);
      await ctx.storage.setAlarm(Date.now() + 86_400_000);
      await (
        instance as unknown as { _scheduleNextAlarm(): Promise<void> }
      )._scheduleNextAlarm();
      expect(await ctx.storage.getAlarm()).not.toBeNull();
      // Leave no pending destroy behind for this DO (the test asserts the
      // guard only): clear the marker and alarm.
      await ctx.storage.delete(DESTROY_PENDING_KEY);
      await ctx.storage.deleteAlarm();
    });
  });

  it("_scheduleNextAlarm keeps the destroy alarm immediate even while a keepAlive lease is held", async () => {
    const stub = await getAgentByName(
      env.TestScheduleAgent,
      crypto.randomUUID()
    );
    // With an active keepAlive ref (and no pending destroy), _scheduleNextAlarm
    // would push the alarm out to now + keepAliveIntervalMs. The pending-destroy
    // guard must win so teardown still lands immediately instead of waiting a
    // full heartbeat — otherwise a keepAlive-holding agent delays its own
    // condemnation by up to keepAliveIntervalMs each reschedule.
    await runInDurableObject(stub, async (instance, ctx) => {
      const agent = instance as unknown as {
        _keepAliveRefs: number;
        _scheduleNextAlarm(): Promise<void>;
      };
      agent._keepAliveRefs = 1;
      await ctx.storage.put(DESTROY_PENDING_KEY, true);
      await ctx.storage.setAlarm(Date.now() + 86_400_000);

      const before = Date.now();
      await agent._scheduleNextAlarm();
      const alarm = await ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      // Immediate (within a small window of `before`), NOT pushed out to the
      // keepAlive horizon (default 30s).
      expect(alarm! - before).toBeLessThan(5_000);

      // Leave nothing pending behind for this DO.
      agent._keepAliveRefs = 0;
      await ctx.storage.delete(DESTROY_PENDING_KEY);
      await ctx.storage.deleteAlarm();
    });
  });

  it("a direct destroy leaves no marker behind (clean completion)", async () => {
    const name = crypto.randomUUID();
    const stub = await getAgentByName(env.TestScheduleAgent, name);
    await stub.schedule(86400, "testCallback", undefined);

    // destroy() aborts the isolate after completing, so the RPC may reject.
    await (stub.destroy() as Promise<void>).catch(() => {});

    await expectTeardownCompleted(scheduleAgentNs(), name);
  });

  it("MCP streamable-http session DELETE condemns the session DO and teardown completes", async () => {
    const handler = TestMcpJurisdiction.serve("/mcp", {
      binding: "TEST_MCP_JURISDICTION",
      transport: "streamable-http"
    });

    // Initialize a session.
    const initResponse = await handler.fetch(
      new Request("http://example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
            protocolVersion: "2025-03-26"
          }
        })
      }),
      env,
      createExecutionContext()
    );
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // End the session. The handler awaits the (fast) destroy scheduling —
    // NOT the teardown itself — before responding, so a canceled client
    // request can no longer cut the teardown short.
    const deleteResponse = await handler.fetch(
      new Request("http://example.com/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId! }
      }),
      env,
      createExecutionContext()
    );
    expect(deleteResponse.status).toBe(204);

    // The session DO's own alarm invocation completes the teardown.
    await expectTeardownCompleted(
      env.TEST_MCP_JURISDICTION as unknown as DurableObjectNamespace<
        Agent<Cloudflare.Env>
      >,
      `streamable-http:${sessionId}`
    );
  });
});
