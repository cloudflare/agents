import { Think } from "../../think";
import type { FiberRecoveryContext } from "../../think";

type RecoveredFiberInfo = {
  id: string;
  name: string;
  snapshot: unknown;
};

export class ThinkFiberTestAgent extends Think {
  executionLog: string[] = [];
  recoveredFibers: RecoveredFiberInfo[] = [];

  override async onFiberRecovered(ctx: FiberRecoveryContext) {
    this.recoveredFibers.push({
      id: ctx.id,
      name: ctx.name,
      snapshot: ctx.snapshot
    });
  }

  async runSimpleFiber(value: string): Promise<string> {
    return this.runFiber("simple", async () => {
      this.executionLog.push(`executed:${value}`);
      return value;
    });
  }

  async runCheckpointFiber(steps: string[]): Promise<string[]> {
    return this.runFiber("checkpoint", async (ctx) => {
      const completed: string[] = [];
      for (const step of steps) {
        completed.push(step);
        ctx.stash({
          completedSteps: [...completed],
          currentStep: step
        });
        this.executionLog.push(`step:${step}`);
      }
      return completed;
    });
  }

  async runFailingFiber(): Promise<string> {
    try {
      await this.runFiber("failing", async () => {
        this.executionLog.push("failing");
        throw new Error("Intentional fiber error");
      });
      return "completed";
    } catch (e) {
      return (e as Error).message;
    }
  }

  async fireAndForgetFiber(value: string): Promise<void> {
    void this.runFiber("fire-and-forget", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.executionLog.push(`bg:${value}`);
    });
  }

  async getExecutionLog(): Promise<string[]> {
    return this.executionLog;
  }

  async getRecoveredFibers(): Promise<RecoveredFiberInfo[]> {
    return this.recoveredFibers;
  }

  async getRunningFiberCount(): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count;
  }

  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    const id = `fiber-${Date.now()}`;
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  async triggerRecovery(): Promise<void> {
    await (
      this as unknown as { _checkRunFibers(): Promise<void> }
    )._checkRunFibers();
  }

  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  override getModel(): never {
    throw new Error("Fiber tests do not use chat");
  }
}
