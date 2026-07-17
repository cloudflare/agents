/**
 * Forced Durable Object eviction coverage for the Codemode runtime.
 *
 * The helper explicitly tears down the running test host and its runtime facet.
 * These tests verify reconstruction from durable execution state; they do not
 * assert natural idle hibernation or hibernation eligibility.
 */
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ProxyToolOutput } from "../proxy-tool";
import type { ExecutionState, PendingAction } from "../runtime";

interface Host {
  run(code: string): Promise<ProxyToolOutput>;
  approve(executionId: string): Promise<ProxyToolOutput>;
  reject(seq: number, executionId: string): Promise<boolean>;
  pending(executionId?: string): Promise<PendingAction[]>;
  executions(): Promise<ExecutionState[]>;
  sideEffects(): Promise<{
    created: Array<{ title: string }>;
    deleted: unknown[];
    notes: string[];
  }>;
  lifecycle(): Promise<{
    opened: string[];
    disposed: Array<{ executionId: string; status: string }>;
  }>;
  passEnds(): Promise<Array<{ executionId: string; status: string }>>;
  executionCounts(): Promise<{ listItems: number; getBytes: number }>;
}

const testEnv = env as unknown as {
  CodemodeTestHost: DurableObjectNamespace;
};

function makeHost(): { host: Host; stub: DurableObjectStub } {
  const id = testEnv.CodemodeTestHost.idFromName(
    `evict-host-${crypto.randomUUID()}`
  );
  const stub = testEnv.CodemodeTestHost.get(id);
  return { host: stub as unknown as Host, stub };
}

describe("Codemode recovery after forced Durable Object eviction", () => {
  it("replays recorded reads without executing them on the fresh connector", async () => {
    const { host, stub } = makeHost();
    const first = (await host.run(`async () => {
      const before = await items.list_items();
      const bytes = await items.get_bytes();
      const created = await items.create_item({ title: "x" });
      return {
        beforeCount: before.length,
        bytes: Array.from(bytes),
        created
      };
    }`)) as ProxyToolOutput;

    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;
    expect(await host.executionCounts()).toEqual({
      listItems: 1,
      getBytes: 1
    });

    await evictDurableObject(stub);

    // The connector counters are instance-only. Both reset to zero, while the
    // pending action remains in the runtime facet's durable log.
    expect(await host.executionCounts()).toEqual({
      listItems: 0,
      getBytes: 0
    });
    expect(await host.pending(first.executionId)).toEqual([
      expect.objectContaining({
        executionId: first.executionId,
        connector: "items",
        method: "create_item"
      })
    ]);

    const resumed = (await host.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") return;

    expect(resumed.result).toEqual({
      beforeCount: 0,
      bytes: [1, 2, 3, 4, 5],
      created: { id: 1, title: "x" }
    });
    expect(await host.executionCounts()).toEqual({
      listItems: 0,
      getBytes: 0
    });
    expect((await host.sideEffects()).created).toEqual([{ title: "x" }]);
  });

  it("disposes the fresh connector when a rehydrated run completes", async () => {
    const { host, stub } = makeHost();
    const first = (await host.run(
      `async () => await items.create_item({ title: "dispose-me" })`
    )) as ProxyToolOutput;

    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;
    expect(await host.passEnds()).toEqual([
      { executionId: first.executionId, status: "paused" }
    ]);
    expect((await host.lifecycle()).disposed).toEqual([]);

    await evictDurableObject(stub);

    expect(await host.passEnds()).toEqual([]);
    const resumed = (await host.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    expect((await host.lifecycle()).disposed).toEqual([
      { executionId: first.executionId, status: "completed" }
    ]);
    expect(await host.passEnds()).toEqual([
      { executionId: first.executionId, status: "completed" }
    ]);
  });

  it("rejects a pending run reconstructed from storage", async () => {
    const { host, stub } = makeHost();
    const first = (await host.run(
      `async () => await items.create_item({ title: "nope" })`
    )) as ProxyToolOutput;

    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    await evictDurableObject(stub);

    expect(await host.reject(first.pending[0].seq, first.executionId)).toBe(
      true
    );
    expect((await host.lifecycle()).disposed).toEqual([
      { executionId: first.executionId, status: "rejected" }
    ]);
    expect(
      (await host.executions()).find(
        (execution) => execution.id === first.executionId
      )?.status
    ).toBe("rejected");
    expect((await host.sideEffects()).created).toEqual([]);
    expect(await host.pending()).toEqual([]);
  });
});
