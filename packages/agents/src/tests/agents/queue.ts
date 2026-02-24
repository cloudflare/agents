import { Agent, callable } from "../../index.ts";

export class TestQueueAgent extends Agent<Record<string, unknown>> {
  static options = { retry: { maxAttempts: 1 } };
  observability = undefined;

  // Track which callbacks were executed and in what order
  executedCallbacks: string[] = [];

  // A queue callback that succeeds
  async successCallback(payload: { value: string }) {
    this.executedCallbacks.push(`success:${payload.value}`);
  }

  // A queue callback that throws an error
  async throwingCallback(_payload: { value: string }) {
    throw new Error("Intentional queue callback error");
  }

  @callable()
  async enqueueSuccess(value: string): Promise<string> {
    return this.queue("successCallback", { value });
  }

  @callable()
  async enqueueThrowing(value: string): Promise<string> {
    return this.queue("throwingCallback", { value });
  }

  @callable()
  async getExecutedCallbacks(): Promise<string[]> {
    return this.executedCallbacks;
  }

  @callable()
  async resetExecutedCallbacks(): Promise<void> {
    this.executedCallbacks = [];
  }

  @callable()
  async getQueueLength(): Promise<number> {
    const result = this.sql`SELECT COUNT(*) as count FROM cf_agents_queues`;
    return (result[0] as { count: number }).count;
  }

  @callable()
  async waitForFlush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = this.sql`SELECT COUNT(*) as count FROM cf_agents_queues`;
      if ((result[0] as { count: number }).count === 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
