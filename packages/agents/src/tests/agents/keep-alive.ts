import { Agent } from "../../index.ts";

export class TestKeepAliveAgent extends Agent<Record<string, unknown>> {
  private _keepAliveDisposer: (() => void) | null = null;
  keepAliveCallCount = 0;

  async startKeepAlive(): Promise<string> {
    const dispose = await this.keepAlive();
    this._keepAliveDisposer = dispose;
    this.keepAliveCallCount++;
    return "started";
  }

  async stopKeepAlive(): Promise<string> {
    if (this._keepAliveDisposer) {
      this._keepAliveDisposer();
      this._keepAliveDisposer = null;
      this.keepAliveCallCount--;
    }
    return "stopped";
  }

  async runWithKeepAliveWhile(): Promise<string> {
    return this.keepAliveWhile(async () => {
      return "completed";
    });
  }

  async runWithKeepAliveWhileError(): Promise<string> {
    try {
      await this.keepAliveWhile(async () => {
        throw new Error("task failed");
      });
      return "should not reach";
    } catch {
      return "caught";
    }
  }
}
