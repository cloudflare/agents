import { DurableObject } from "cloudflare:workers";
import {
  Driver,
  type DriverHandle,
  type DriverOperation,
  type DriverStep
} from "../../driver";
import { Lifecycle } from "../../lifecycle";

type DriverInput = { text: string };
type DriverResult = { answer: string };

/**
 * A durable fixture runtime: one step records that it started, optionally
 * blocks on a gate, then records a result and answers `done`. A repeated step
 * after an eviction finds the result and answers `done` again.
 */
export class DriverHarnessObject extends DurableObject<Cloudflare.Env> {
  #gate: Promise<void> | undefined;
  #releaseGate: (() => void) | undefined;
  #started = new Set<string>();

  readonly driver = new Driver();
  readonly #handle: DriverHandle<DriverInput> = this.driver.register<
    DriverInput,
    DriverResult
  >("test", { step: (operation) => this.#step(operation) });
  readonly lifecycle = Lifecycle.install(this).use(this.driver);

  async #step(
    operation: DriverOperation<DriverInput>
  ): Promise<DriverStep<DriverResult>> {
    const done = await this.ctx.storage.get<DriverResult>(
      `result:${operation.id}`
    );
    if (done) return { then: "done", result: done };

    const steps =
      (await this.ctx.storage.get<number>(`steps:${operation.id}`)) ?? 0;
    await this.ctx.storage.put(`steps:${operation.id}`, steps + 1);
    this.#started.add(operation.id);
    if (this.#gate) await this.#gate;

    const result = { answer: operation.id };
    await this.ctx.storage.put(`result:${operation.id}`, result);
    return { then: "done", result };
  }

  submit(scope: string, id: string, text: string) {
    return this.#handle.submit(scope, { text }, { id });
  }

  result(id: string) {
    return this.ctx.storage.get<DriverResult>(`result:${id}`);
  }

  steps(id: string) {
    return this.ctx.storage.get<number>(`steps:${id}`);
  }

  pending(scope?: string) {
    return this.#handle.pending(scope);
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
