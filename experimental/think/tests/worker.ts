import { routeAgentRequest } from "agents";
import { AgentFacet } from "../src/agent-facet";
import { Chat, Workspace } from "../src/server";

export { ThinkAgent, Chat, Workspace } from "../src/server";

/**
 * Chat subclass that exposes internals needed for corruption resilience tests.
 */
export class TestChat extends Chat {
  /** Directly insert a row with invalid JSON into the messages table. */
  injectCorruptedRow(id: string): void {
    this.sql`
      INSERT INTO messages (id, message, created_at)
      VALUES (${id}, 'NOT_VALID_JSON{{{', CURRENT_TIMESTAMP)
    `;
  }

  /** Insert a row whose JSON is valid but lacks the required `id` field. */
  injectMissingIdRow(rowId: string): void {
    this.sql`
      INSERT INTO messages (id, message, created_at)
      VALUES (${rowId}, '{"role":"assistant","content":"orphan"}', CURRENT_TIMESTAMP)
    `;
  }
}

/**
 * Workspace subclass used by tests that expect methods to throw.
 *
 * The problem: in vitest-pool-workers, when a DO method throws an error the
 * Workers runtime marks the DO-side promise as an "uncaught exception" *before*
 * serialising it to the caller, even though the caller catches it. vitest sees
 * the DO-side rejection as an "Unhandled Rejection" and exits with code 1.
 *
 * Fix: wrap the throwing call *inside the DO* so the error is caught before
 * the DO's promise rejects. Each `try*` method returns a resolved result —
 * either the normal value or `{ __error: "message" }` — so the caller can
 * assert the error message without any cross-boundary rejection escaping.
 */
type ErrResult = { __error: string };
function toErr(e: unknown): ErrResult {
  return { __error: e instanceof Error ? e.message : String(e) };
}

export class TestWorkspace extends Workspace {
  async tryReadFile(path: string): Promise<string | null | ErrResult> {
    try {
      return await this.readFile(path);
    } catch (e) {
      return toErr(e);
    }
  }
  async tryDeleteFile(path: string): Promise<boolean | ErrResult> {
    try {
      return await this.deleteFile(path);
    } catch (e) {
      return toErr(e);
    }
  }
  async tryMkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<null | ErrResult> {
    try {
      await this.mkdir(path, options);
      return null;
    } catch (e) {
      return toErr(e);
    }
  }
  async tryRm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<null | ErrResult> {
    try {
      await this.rm(path, options);
      return null;
    } catch (e) {
      return toErr(e);
    }
  }
}

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
  TestChat: DurableObjectNamespace<TestChat>;
  Workspace: DurableObjectNamespace<import("../src/workspace").Workspace>;
  TestWorkspace: DurableObjectNamespace<TestWorkspace>;
  TestFacet: DurableObjectNamespace<TestFacet>;
  WORKSPACE_FILES: R2Bucket;
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
