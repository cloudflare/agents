import { Think } from "../../think";
import type { FiberRecoveryContext } from "../../think";

/** The fiber run table of a release before fibers ran on Tasks. */
function createLegacyFiberTableForTest(storage: DurableObjectStorage): void {
  // As a release before the one schema record left the Agent: its version
  // under its own key, so the start's fiber import is still to run.
  const record = storage.kv.get<Record<string, number>>(
    "cf_agents:schema_versions"
  );
  if (record && " " in record) {
    delete record[" "];
    storage.kv.put("cf_agents:schema_versions", record);
  }
  storage.kv.put("cf_agents:schema_version", 14);
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_runs (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, snapshot TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER, outcome TEXT,
      error_message TEXT, recovery_crashes INTEGER NOT NULL DEFAULT 0
    )
  `);
}

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
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition IN ('__cf_fiber', '__cf_managed_fiber')
        AND status IN ('pending', 'running')
    `;
    return rows[0].count;
  }

  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    const id = `fiber-${Date.now()}`;
    createLegacyFiberTableForTest(this.ctx.storage);

    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  async triggerRecovery(): Promise<void> {
    await (
      this as unknown as { _recoverFibers(): Promise<void> }
    )._recoverFibers();
  }

  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  override getModel(): never {
    throw new Error("Fiber tests do not use chat");
  }
}
