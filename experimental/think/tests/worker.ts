import { routeAgentRequest } from "agents";
import { AgentFacet } from "../src/agent-facet";

export { ThinkAgent, Chat } from "../src/server";

/**
 * Minimal AgentFacet subclass for testing the base class directly.
 */
export class TestFacet extends AgentFacet {
  callCount = 0;
  lastPayload: unknown = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS test_data (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `;
  }

  testSql(key: string, value: string): void {
    this
      .sql`INSERT OR REPLACE INTO test_data (key, value) VALUES (${key}, ${value})`;
  }

  testSqlRead(key: string): string | null {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM test_data WHERE key = ${key}
    `;
    return rows[0]?.value ?? null;
  }

  testCallback(payload: unknown): void {
    this.callCount++;
    this.lastPayload = payload;
  }

  getCallCount(): number {
    return this.callCount;
  }

  getLastPayload(): unknown {
    return this.lastPayload;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

export type Env = {
  ThinkAgent: DurableObjectNamespace<import("../src/server").ThinkAgent>;
  Chat: DurableObjectNamespace<import("../src/chat").Chat>;
  TestFacet: DurableObjectNamespace<TestFacet>;
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
