import { Agent } from "../../index.ts";
import type { FiberRecoveryContext } from "../../index.ts";

export class TestRunFiberAgent extends Agent {
  static options = { keepAliveIntervalMs: 2_000 };

  executionLog: string[] = [];
  recoveredFibers: FiberRecoveryContext[] = [];

  override async _onFiberRecovered(ctx: FiberRecoveryContext) {
    this.recoveredFibers.push(ctx);
  }

  // ── Test methods exposed via RPC ──────────────────────────────

  async runSimple(value: string): Promise<string> {
    return this.runFiber("simple", async () => {
      this.executionLog.push(`executed:${value}`);
      return value;
    });
  }

  async runWithCheckpoint(steps: string[]): Promise<string[]> {
    return this.runFiber("checkpoint", async (ctx) => {
      const completed: string[] = [];
      for (const step of steps) {
        completed.push(step);
        ctx.stash({ completedSteps: [...completed], currentStep: step });
        this.executionLog.push(`step:${step}`);
      }
      return completed;
    });
  }

  async runWithThisStash(value: string): Promise<string> {
    return this.runFiber("this-stash", async () => {
      this.stash({ value });
      return value;
    });
  }

  async runSlow(durationMs: number): Promise<string> {
    return this.runFiber("slow", async (ctx) => {
      this.executionLog.push("slow-start");
      ctx.stash({ started: true });
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      this.executionLog.push("slow-end");
      return "done";
    });
  }

  async runFailing(): Promise<string> {
    try {
      await this.runFiber("failing", async () => {
        this.executionLog.push("failing");
        throw new Error("Intentional error");
      });
      return "no-error";
    } catch (e) {
      return `error:${(e as Error).message}`;
    }
  }

  async fireAndForget(value: string): Promise<string> {
    const id = await new Promise<string>((resolve) => {
      void this.runFiber("background", async (ctx) => {
        resolve(ctx.id);
        this.executionLog.push(`background:${value}`);
        await new Promise((r) => setTimeout(r, 100));
        this.executionLog.push(`background-done:${value}`);
      }).catch(console.error);
    });
    return id;
  }

  async runConcurrent(): Promise<void> {
    void this.runFiber("concurrent-a", async (ctx) => {
      ctx.stash({ task: "a" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("a-done");
    }).catch(console.error);

    void this.runFiber("concurrent-b", async (ctx) => {
      ctx.stash({ task: "b" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("b-done");
    }).catch(console.error);
  }

  async runConcurrentWithThisStash(): Promise<void> {
    void this.runFiber("concurrent-this-a", async () => {
      this.stash({ task: "a" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("this-a-done");
    }).catch(console.error);

    void this.runFiber("concurrent-this-b", async () => {
      this.stash({ task: "b" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("this-b-done");
    }).catch(console.error);
  }

  async stashOutsideFiber(): Promise<string> {
    try {
      this.stash({ bad: true });
      return "no-error";
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ── Query methods ─────────────────────────────────────────────

  async getExecutionLog(): Promise<string[]> {
    return this.executionLog;
  }

  async getRecoveredFibers(): Promise<FiberRecoveryContext[]> {
    return this.recoveredFibers;
  }

  async getKeepAliveRefCount(): Promise<number> {
    return this._keepAliveRefs;
  }

  async getRunningFiberCount(): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count;
  }

  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Eviction simulation ───────────────────────────────────────

  async insertInterruptedFiber(
    id: string,
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  async triggerRecoveryCheck(): Promise<void> {
    await (
      this as unknown as { _checkRunFibers(): Promise<void> }
    )._checkRunFibers();
  }
}
