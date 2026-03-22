import { Agent } from "../../index.ts";

export class TestKeepAliveAgent extends Agent {
  private _keepAliveDisposers: Array<() => void> = [];

  async startKeepAlive(): Promise<string> {
    const dispose = await this.keepAlive();
    this._keepAliveDisposers.push(dispose);
    return "started";
  }

  async stopKeepAlive(): Promise<string> {
    const dispose = this._keepAliveDisposers.pop();
    if (dispose) {
      dispose();
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

  async getKeepAliveRefCount(): Promise<number> {
    return this._keepAliveRefs;
  }

  async getScheduleCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
    `;
    return result[0].count;
  }
}
