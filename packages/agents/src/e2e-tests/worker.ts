/**
 * E2E test worker — agent with multiple fiber methods for eviction testing.
 * Runs under wrangler dev with persistent SQLite storage.
 *
 * Uses a short keepAliveIntervalMs (2s) so alarm-based recovery
 * happens quickly in tests instead of waiting the default 30s.
 */
import { Agent, callable, routeAgentRequest } from "agents";

type Env = {
  RunFiberTestAgent: DurableObjectNamespace<RunFiberTestAgent>;
  SubAgentFiberParent: DurableObjectNamespace<SubAgentFiberParent>;
  SubAgentFiberChild: DurableObjectNamespace<SubAgentFiberChild>;
};

export type StepResult = {
  index: number;
  value: string;
  completedAt: number;
};

export type SlowFiberSnapshot = {
  completedSteps: StepResult[];
  totalSteps: number;
};

// ── RunFiberTestAgent (uses Agent.runFiber directly, no mixin) ────────

import type { FiberRecoveryContext as RunFiberRecoveryContext } from "agents";

export class RunFiberTestAgent extends Agent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  recoveredFibers: RunFiberRecoveryContext[] = [];

  override async onFiberRecovered(ctx: RunFiberRecoveryContext) {
    this.recoveredFibers.push(ctx);
    // Re-start the fiber from checkpoint
    if (ctx.name === "slowSteps") {
      void this.runFiber("slowSteps", async (fiber) => {
        const snapshot = ctx.snapshot as {
          completedSteps: Array<{ index: number; value: string }>;
          totalSteps: number;
        } | null;
        const completedSteps = snapshot?.completedSteps ?? [];
        const totalSteps = snapshot?.totalSteps ?? 0;
        const startIndex = completedSteps.length;

        for (let i = startIndex; i < totalSteps; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          completedSteps.push({ index: i, value: `step-${i}-done` });
          fiber.stash({ completedSteps: [...completedSteps], totalSteps });
        }
      }).catch(console.error);
    }
  }

  @callable()
  startSlowFiber(totalSteps: number): string {
    void this.runFiber("slowSteps", async (ctx) => {
      const completedSteps: Array<{ index: number; value: string }> = [];

      for (let i = 0; i < totalSteps; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        completedSteps.push({ index: i, value: `step-${i}-done` });
        ctx.stash({ completedSteps: [...completedSteps], totalSteps });
      }
    }).catch(console.error);

    return "started";
  }

  @callable()
  getFiberStatus(): {
    hasRunningFibers: boolean;
    runCount: number;
    recoveredCount: number;
    recoveredSnapshots: unknown[];
  } {
    const rows = this.sql<{ id: string; snapshot: string | null }>`
      SELECT id, snapshot FROM cf_agents_runs
    `;
    return {
      hasRunningFibers: rows.length > 0,
      runCount: rows.length,
      recoveredCount: this.recoveredFibers.length,
      recoveredSnapshots: this.recoveredFibers.map((f) => f.snapshot)
    };
  }

  @callable()
  getRecoveredFibers(): RunFiberRecoveryContext[] {
    return this.recoveredFibers;
  }

  @callable()
  getRunningFiberSnapshot(): unknown {
    const rows = this.sql<{ snapshot: string | null }>`
      SELECT snapshot FROM cf_agents_runs LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0].snapshot ? JSON.parse(rows[0].snapshot) : null;
  }
}

// ── Sub-agent runFiber recovery ───────────────────────────────────────

export class SubAgentFiberChild extends Agent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  recoveredFibers: RunFiberRecoveryContext[] = [];

  override async onFiberRecovered(ctx: RunFiberRecoveryContext) {
    this.recoveredFibers.push(ctx);
  }

  async startSlowFiber(totalSteps: number): Promise<string> {
    void this.runFiber("subSlowSteps", async (ctx) => {
      const completedSteps: Array<{ index: number; value: string }> = [];

      for (let i = 0; i < totalSteps; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        completedSteps.push({ index: i, value: `sub-step-${i}-done` });
        ctx.stash({ completedSteps: [...completedSteps], totalSteps });
      }
    }).catch(console.error);

    return "started";
  }

  getFiberStatus(): {
    hasRunningFibers: boolean;
    runCount: number;
    recoveredCount: number;
    recoveredSnapshots: unknown[];
  } {
    const rows = this.sql<{ id: string; snapshot: string | null }>`
      SELECT id, snapshot FROM cf_agents_runs
    `;
    return {
      hasRunningFibers: rows.length > 0,
      runCount: rows.length,
      recoveredCount: this.recoveredFibers.length,
      recoveredSnapshots: this.recoveredFibers.map((f) => f.snapshot)
    };
  }

  getRecoveredFibers(): RunFiberRecoveryContext[] {
    return this.recoveredFibers;
  }

  getRunningFiberSnapshot(): unknown {
    const rows = this.sql<{ snapshot: string | null }>`
      SELECT snapshot FROM cf_agents_runs LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0].snapshot ? JSON.parse(rows[0].snapshot) : null;
  }
}

export class SubAgentFiberParent extends Agent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  @callable()
  async startChildSlowFiber(
    childName: string,
    totalSteps: number
  ): Promise<string> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.startSlowFiber(totalSteps);
  }

  @callable()
  async getChildRunningFiberSnapshot(childName: string): Promise<unknown> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.getRunningFiberSnapshot();
  }

  @callable()
  async getChildFiberStatus(childName: string): Promise<{
    hasRunningFibers: boolean;
    runCount: number;
    recoveredCount: number;
    recoveredSnapshots: unknown[];
  }> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.getFiberStatus();
  }

  @callable()
  async getChildRecoveredFibers(
    childName: string
  ): Promise<RunFiberRecoveryContext[]> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.getRecoveredFibers();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
