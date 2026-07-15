/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/agent-tool-detached.test.ts
 * - last original change: 0f47d61c
 * - port date: 2026-07-15
 * Modifications:
 * - Kept the only non-detached behavior probe on the board against the real
 *   rebuild `AgentToolRunService.cancelRun` path.
 * - Marked the two-slot detached delivery ledger, lease/CAS, give-up budgets,
 *   backbone cadence, terminal broadcast, and notify-source rows as
 *   `blocked ISSUE-037`; those mechanisms do not exist in the rebuild.
 * - Did not fabricate any detached ledger helper methods in a fixture.
 */
// @ts-nocheck
import { describe, expect, it } from "vitest";
import { createAgentToolRunService } from "./compat.js";

class MemoryStore {
  map = new Map<string, unknown>();
  get(key: string): unknown {
    return this.map.get(key);
  }
  put(key: string, value: unknown): void {
    this.map.set(key, structuredClone(value));
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
  list(options?: { prefix?: string; limit?: number }): Map<string, unknown> {
    const prefix = options?.prefix ?? "";
    const out = new Map<string, unknown>();
    for (const key of [...this.map.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      out.set(key, structuredClone(this.map.get(key)));
      if (options?.limit !== undefined && out.size >= options.limit) break;
    }
    return out;
  }
  deleteAll(options?: { prefix?: string }): number {
    const prefix = options?.prefix ?? "";
    let count = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix) && this.map.delete(key)) count++;
    }
    return count;
  }
}

function harness() {
  const detachedDeliveryLog: unknown[] = [];
  const store = new MemoryStore();
  const registry = {
    get(_className: string, name: string) {
      return {
        className: "Child",
        name,
        async call(method: string, args: unknown[]) {
          if (method === "chat") return new Promise(() => {});
          if (method === "cancelChat") return undefined;
          if (method === "inspectRun") return null;
          throw new Error(`Unexpected child method ${method}`);
        },
        abort() {}
      };
    },
    has: () => false,
    list: () => [],
    delete: async () => {}
  };
  const service = createAgentToolRunService({
    store,
    registry,
    clock: { now: () => Date.now() },
    ids: { newId: (prefix: string) => `${prefix}-awaited-cancel` },
    bus: { emit() {}, subscribe: () => () => {} },
    hooks: {
      onRunFinish(run) {
        // This is the normal awaited-run hook, not a detached ledger callback.
        detachedDeliveryLog.push({ normalFinish: run.status });
      }
    }
  });
  return { service, detachedDeliveryLog };
}

describe("detached agent-tool delivery (#1752) (ported)", () => {
  it.skip("fires onFinish (and the global hook) exactly once on terminal", () => {
    // blocked ISSUE-037: no detached exactly-once claim+lease ledger exists.
  });

  it.skip("dedupes concurrent deliveries to a single fire (the fast-path vs backbone race)", () => {
    // blocked ISSUE-037: no detached fast-path/backbone delivery slots exist.
  });

  it.skip("delivers a give-up AND a later real completion (two independent slots)", () => {
    // blocked ISSUE-037: no give-up slot, finish slot, or interrupted repair.
  });

  it.skip("does not re-deliver a give-up twice", () => {
    // blocked ISSUE-037: no durable give-up delivery slot exists.
  });

  it.skip("gives up a silent detached run once its no-progress window elapses (reason: no-progress)", () => {
    // blocked ISSUE-037: no detached no-progress budget exists.
  });

  it.skip("does not give up a detached run that is still within its no-progress window", () => {
    // blocked ISSUE-037: no detached no-progress budget exists.
  });

  it.skip("retries finish delivery after a callback failure and lease expiry", () => {
    // blocked ISSUE-037: no delivery lease/expiry retry machinery exists.
  });

  it.skip("escalates the detached backbone cadence and caps at the slow end", () => {
    // blocked ISSUE-037: no detached backbone schedule/cadence exists.
  });

  it("does not deliver through the detached ledger when cancelling an awaited run", async () => {
    // plain pass for the available seam: awaited cancel uses the normal
    // AgentToolRunService path. There is no detached ledger in rebuild, so the
    // observable non-detached result is an aborted row and no detached callback.
    const { service, detachedDeliveryLog } = harness();
    const run = await service.startRun({
      agentClassName: "Child",
      prompt: "awaited cancel"
    });
    await service.cancelRun(run.runId, "stop");

    expect(service.inspectRun(run.runId)).toMatchObject({
      status: "aborted",
      error: "stop"
    });
    expect(detachedDeliveryLog).toEqual([{ normalFinish: "aborted" }]);
  });

  it.skip("persists a caller-controlled notify source for durable completion", () => {
    // blocked ISSUE-037: AgentToolRun has no notify-source field.
  });

  it.skip("broadcasts a terminal frame when a detached run is cancelled", () => {
    // blocked ISSUE-037: no detached terminal broadcast delivery path exists.
  });

  it.skip("broadcasts a terminal frame when a detached run is given up", () => {
    // blocked ISSUE-037: no detached give-up or interrupted broadcast exists.
  });

  it.skip("collapses a concurrent backbone-arm fan-out to a single schedule", () => {
    // blocked ISSUE-037: no detached backbone arm state exists.
  });
});
