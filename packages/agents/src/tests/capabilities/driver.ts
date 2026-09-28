import { DurableObject } from "cloudflare:workers";
import { HarnessDriver, type HarnessDriverRuntime } from "../../driver";
import { Lifecycle } from "../../lifecycle";

type DriverInput = { text: string };
type DriverResult = { answer: string };

type RuntimeState =
  | { status: "active" }
  | { status: "completed"; result: DriverResult };

export class DriverHarnessObject extends DurableObject<Cloudflare.Env> {
  #gate: Promise<void> | undefined;
  #releaseGate: (() => void) | undefined;
  #started = new Set<string>();

  readonly runtime: HarnessDriverRuntime<DriverInput, DriverResult> = {
    inspect: async (_scope, operationId) => {
      const state = await this.ctx.storage.get<RuntimeState>(
        `runtime:${operationId}`
      );
      return state ?? { status: "not-admitted" };
    },
    admit: async (_scope, operationId) => {
      await this.ctx.storage.put(`runtime:${operationId}`, {
        status: "active"
      });
      const count =
        (await this.ctx.storage.get<number>(`admit:${operationId}`)) ?? 0;
      await this.ctx.storage.put(`admit:${operationId}`, count + 1);
    },
    drive: async (_scope, operationId) => {
      this.#started.add(operationId);
      if (this.#gate) await this.#gate;
      const result = { answer: operationId };
      await this.ctx.storage.put(`runtime:${operationId}`, {
        status: "completed",
        result
      });
      return { status: "completed", result };
    },
    cancel: async (_scope, operationId) => {
      await this.ctx.storage.delete(`runtime:${operationId}`);
      return { status: "cancelled" };
    }
  };

  readonly driver = new HarnessDriver({
    id: "test",
    runtime: this.runtime,
    settle: async (submission, result) => {
      await this.ctx.storage.put(`settled:${submission.operationId}`, result);
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.driver);

  submit(scope: string, operationId: string, text: string) {
    return this.driver.submit(scope, { text }, { operationId });
  }

  settled(operationId: string) {
    return this.ctx.storage.get<DriverResult>(`settled:${operationId}`);
  }

  admissions(operationId: string) {
    return this.ctx.storage.get<number>(`admit:${operationId}`);
  }

  pending(scope?: string) {
    return this.driver.pending(scope);
  }

  enableGate() {
    this.#gate = new Promise<void>((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  started() {
    return [...this.#started];
  }

  releaseGate() {
    this.#releaseGate?.();
    this.#gate = undefined;
    this.#releaseGate = undefined;
  }
}
