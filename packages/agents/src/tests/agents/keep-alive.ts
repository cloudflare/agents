import { Agent, callable } from "../../index.ts";

export class TestKeepAliveAgent extends Agent<Record<string, unknown>> {
  private _keepAliveDisposer: (() => void) | null = null;
  keepAliveCallCount = 0;

  @callable()
  async startKeepAlive(): Promise<string> {
    const dispose = await this.keepAlive();
    this._keepAliveDisposer = dispose;
    this.keepAliveCallCount++;
    return "started";
  }

  @callable()
  async stopKeepAlive(): Promise<string> {
    if (this._keepAliveDisposer) {
      this._keepAliveDisposer();
      this._keepAliveDisposer = null;
      this.keepAliveCallCount--;
    }
    return "stopped";
  }

  @callable()
  async getKeepAliveCallCount(): Promise<number> {
    return this.keepAliveCallCount;
  }

  @callable()
  async getHeartbeatScheduleCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
      WHERE callback = '_cf_keepAliveHeartbeat'
    `;
    return result[0].count;
  }

  @callable()
  async getHeartbeatSchedule(): Promise<{
    id: string;
    callback: string;
    type: string;
    intervalSeconds: number;
  } | null> {
    const result = this.sql<{
      id: string;
      callback: string;
      type: string;
      intervalSeconds: number;
    }>`
      SELECT id, callback, type, intervalSeconds FROM cf_agents_schedules
      WHERE callback = '_cf_keepAliveHeartbeat'
      LIMIT 1
    `;
    return result[0] ?? null;
  }
}
