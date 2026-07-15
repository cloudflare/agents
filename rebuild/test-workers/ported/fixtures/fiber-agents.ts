import {
  Think,
  hostAgent,
  type FiberRecoveryContext,
  type ModelChunk,
  type ModelClient
} from "../compat.js";

type RecoveredFiberInfo = {
  id: string;
  name: string;
  snapshot: unknown;
};

const rpcMethodNames = [
  "runSimpleFiber",
  "getExecutionLog",
  "getRunningFiberCount",
  "runCheckpointFiber",
  "runFailingFiber",
  "fireAndForgetFiber",
  "insertInterruptedFiber",
  "triggerRecovery",
  "getRecoveredFibers",
  "waitFor"
] as const;

type DispatchAgent = {
  __dispatchFiber(method: string, args: unknown[]): Promise<unknown>;
};

type ShellWithAgent = {
  withAgent<T>(fn: (agent: DispatchAgent) => T | Promise<T>): Promise<T>;
};

function installRpcMethods(target: { prototype: object }): void {
  for (const method of rpcMethodNames) {
    if (method in target.prototype) continue;
    Object.defineProperty(target.prototype, method, {
      value(this: ShellWithAgent, ...args: unknown[]) {
        return this.withAgent((agent) => agent.__dispatchFiber(method, args));
      }
    });
  }
}

class ThinkFiberTestAgentImpl extends Think {
  private readonly executionLog: string[] = [];
  private readonly recoveredFibers: RecoveredFiberInfo[] = [];

  protected override getModel(): ModelClient {
    return {
      async *stream(): AsyncIterable<ModelChunk> {
        throw new Error("Fiber tests do not use chat");
      }
    };
  }

  protected override async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void> {
    this.recoveredFibers.push({
      id: ctx.fiberId,
      name: ctx.name,
      snapshot: ctx.snapshot
    });
  }

  async __dispatchFiber(method: string, args: unknown[]): Promise<unknown> {
    const fn = (this as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown RPC method: ${method}`);
    }
    return fn.apply(this, args);
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
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
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
    return this.listFibers({ status: ["running"] }).length;
  }

  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    const now = Date.now();
    const fiberId = `fiber-${now}-${crypto.randomUUID()}`;
    this.host.store.put(`fiber:run:${fiberId}`, {
      id: fiberId,
      name,
      managed: false,
      snapshot: snapshot ?? null,
      metadata: null,
      createdAt: now
    });
  }

  async triggerRecovery(): Promise<void> {
    await this.fiberService.checkInterrupted();
  }

  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const ThinkFiberTestAgentBase = hostAgent(ThinkFiberTestAgentImpl);

export class ThinkFiberTestAgent extends ThinkFiberTestAgentBase {
  runSimpleFiber(value: string): Promise<string> {
    return this.withAgent(
      (agent) =>
        agent.__dispatchFiber("runSimpleFiber", [value]) as Promise<string>
    );
  }

  getExecutionLog(): Promise<string[]> {
    return this.withAgent(
      (agent) =>
        agent.__dispatchFiber("getExecutionLog", []) as Promise<string[]>
    );
  }

  getRunningFiberCount(): Promise<number> {
    return this.withAgent(
      (agent) =>
        agent.__dispatchFiber("getRunningFiberCount", []) as Promise<number>
    );
  }

  runCheckpointFiber(steps: string[]): Promise<string[]> {
    return this.withAgent(
      (agent) =>
        agent.__dispatchFiber("runCheckpointFiber", [steps]) as Promise<
          string[]
        >
    );
  }

  runFailingFiber(): Promise<string> {
    return this.withAgent(
      (agent) => agent.__dispatchFiber("runFailingFiber", []) as Promise<string>
    );
  }

  fireAndForgetFiber(value: string): Promise<void> {
    return this.withAgent(
      (agent) =>
        agent.__dispatchFiber("fireAndForgetFiber", [value]) as Promise<void>
    );
  }

  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void> {
    return this.withAgent(
      (agent) =>
        agent.__dispatchFiber("insertInterruptedFiber", [
          name,
          snapshot
        ]) as Promise<void>
    );
  }

  triggerRecovery(): Promise<void> {
    return this.withAgent(
      (agent) => agent.__dispatchFiber("triggerRecovery", []) as Promise<void>
    );
  }

  getRecoveredFibers(): Promise<RecoveredFiberInfo[]> {
    return this.withAgent(
      (agent) =>
        agent.__dispatchFiber("getRecoveredFibers", []) as Promise<
          RecoveredFiberInfo[]
        >
    );
  }

  waitFor(ms: number): Promise<void> {
    return this.withAgent(
      (agent) => agent.__dispatchFiber("waitFor", [ms]) as Promise<void>
    );
  }
}
installRpcMethods(ThinkFiberTestAgent);
