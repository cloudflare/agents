import { Agent, type AgentContext, type Connection } from "../../index.ts";
import { MCPConnectionState } from "../../mcp/client-connection.ts";

// Test Agent for state management tests
export type TestState = {
  count: number;
  items: string[];
  lastUpdated: string | null;
};

export class TestStateAgent extends Agent<Cloudflare.Env, TestState> {
  // Capture the DEFAULT_STATE sentinel reference for cache reset in tests.
  // Child field initializers run after super(), at which point _state is DEFAULT_STATE.
  // @ts-expect-error - accessing private field for testing
  private _stateSentinel: TestState = this._state;

  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Track onStateChanged calls for testing
  stateUpdateCalls: Array<{ state: TestState; source: string }> = [];

  onStateChanged(state: TestState, source: Connection | "server") {
    this.stateUpdateCalls.push({
      state,
      source: source === "server" ? "server" : source.id
    });
  }

  // HTTP handler for testing agentFetch and path routing
  // Only handles specific test paths - returns 404 for others to preserve routing test behavior
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").pop() || "";

    // Handle specific paths for browser integration tests
    if (path === "state") {
      return Response.json({ state: this.state });
    }
    if (path === "state-updates") {
      return Response.json({ updates: this.stateUpdateCalls });
    }
    if (path === "echo") {
      const body = await request.text();
      return Response.json({ method: request.method, body, path });
    }
    if (path === "connections") {
      // Count active connections using PartyServer's getConnections()
      let count = 0;
      for (const _ of this.getConnections()) {
        count++;
      }
      return Response.json({ count });
    }

    // Return 404 for unhandled paths - preserves expected routing behavior
    return new Response("Not found", { status: 404 });
  }

  // Test helper methods (no @callable needed for DO RPC)
  getState() {
    return this.state;
  }

  updateState(state: TestState) {
    this.setState(state);
  }

  getStateUpdateCalls() {
    return this.stateUpdateCalls;
  }

  clearStateUpdateCalls() {
    this.stateUpdateCalls = [];
  }

  // Test helper to insert corrupted state directly into DB (without caching)
  insertCorruptedState() {
    // Insert invalid JSON directly using the correct row ID
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_row_id', 'invalid{json')`
    );
  }

  // Access state and check if it recovered to initialState
  getStateAfterCorruption(): TestState {
    // Reset the in-memory cache so the getter re-reads from DB
    // @ts-expect-error - accessing private field for testing
    this._state = this._stateSentinel;
    // This should trigger the try-catch and fallback to initialState
    return this.state;
  }

  // Get the current schema version from cf_agents_state
  getSchemaVersion(): number {
    const rows = this.ctx.storage.sql
      .exec("SELECT state FROM cf_agents_state WHERE id = 'cf_schema_version'")
      .toArray() as { state: string | null }[];
    return rows.length > 0 ? Number(rows[0].state) : 0;
  }

  // Return sorted DDL for all cf_agents_* tables from sqlite_master.
  // Used by the schema snapshot test to detect DDL changes.
  getSchemaSnapshot(): string[] {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'cf_agents_%' ORDER BY name"
      )
      .toArray() as { name: string; sql: string }[];
    return rows.map((r) => r.sql);
  }

  // Check if a table exists
  tableExists(tableName: string): boolean {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name=?",
        tableName
      )
      .toArray() as [{ cnt: number }];
    return rows[0].cnt > 0;
  }

  // Count rows in cf_agents_state (excluding internal schema version row)
  getStateRowCount(): number {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT count(*) as cnt FROM cf_agents_state WHERE id != 'cf_schema_version'"
      )
      .toArray() as [{ cnt: number }];
    return rows[0].cnt;
  }

  // Get all row IDs in cf_agents_state (excluding internal schema version row)
  getStateRowIds(): string[] {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id FROM cf_agents_state WHERE id != 'cf_schema_version' ORDER BY id"
      )
      .toArray() as { id: string }[];
    return rows.map((r) => r.id);
  }

  // Simulate a legacy DO that has a STATE_WAS_CHANGED row (pre-optimization)
  insertLegacyWasChangedRow() {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_was_changed', 'true')`
    );
  }

  // Reset schema version to 0 (simulates a pre-versioning DO)
  resetSchemaVersion() {
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_state WHERE id = 'cf_schema_version'"
    );
  }

  // Re-run the real migration logic from the Agent base class.
  // Useful for testing migration behavior since getAgentByName returns
  // the same DO instance (constructor won't re-run). ctx.abort() is
  // unavailable in local dev, so we call _ensureSchema() directly.
  runSchemaMigration() {
    this._ensureSchema();
  }

  // Set state to a falsy value directly in the DB (for testing row-existence logic)
  insertFalsyState(value: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_row_id', ?)",
      value
    );
    // Reset in-memory cache to sentinel so getter re-reads from DB
    // @ts-expect-error - accessing private field for testing
    this._state = this._stateSentinel;
  }

  // Simulate orphaned wasChanged: legacy DO crashed during corruption recovery,
  // leaving STATE_WAS_CHANGED but deleting STATE_ROW_ID.
  insertOrphanedWasChanged() {
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_state WHERE id = 'cf_state_row_id'"
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_was_changed', 'true')`
    );
    // @ts-expect-error - accessing private field for testing
    this._state = this._stateSentinel;
  }
}

// Test Agent without initialState to test undefined behavior
export class TestStateAgentNoInitial extends Agent {
  // Capture the DEFAULT_STATE sentinel reference for cache reset in tests.
  // @ts-expect-error - accessing private field for testing
  private _stateSentinel: unknown = this._state;

  // No initialState defined - should return undefined

  getState() {
    return this.state;
  }

  updateState(state: unknown) {
    this.setState(state);
  }

  getSchemaVersion(): number {
    const rows = this.ctx.storage.sql
      .exec("SELECT state FROM cf_agents_state WHERE id = 'cf_schema_version'")
      .toArray() as { state: string | null }[];
    return rows.length > 0 ? Number(rows[0].state) : 0;
  }

  getStateRowCount(): number {
    // Exclude the schema version row from the count
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT count(*) as cnt FROM cf_agents_state WHERE id != 'cf_schema_version'"
      )
      .toArray() as [{ cnt: number }];
    return rows[0].cnt;
  }

  getStateRowIds(): string[] {
    // Exclude the schema version row
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id FROM cf_agents_state WHERE id != 'cf_schema_version' ORDER BY id"
      )
      .toArray() as { id: string }[];
    return rows.map((r) => r.id);
  }

  // Insert corrupted state for no-initialState agent
  insertCorruptedState() {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_row_id', 'invalid{json')`
    );
  }

  // Reset in-memory cache and read from DB
  getStateAfterCorruption() {
    // @ts-expect-error - accessing private field for testing
    this._state = this._stateSentinel;
    return this.state;
  }

  // Set state to a falsy value directly in the DB
  insertFalsyState(value: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_row_id', ?)",
      value
    );
    // Reset in-memory cache to sentinel so getter re-reads from DB
    // @ts-expect-error - accessing private field for testing
    this._state = this._stateSentinel;
  }

  // Simulate orphaned wasChanged: legacy DO crashed during corruption recovery,
  // leaving STATE_WAS_CHANGED but deleting STATE_ROW_ID.
  insertOrphanedWasChanged() {
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_state WHERE id = 'cf_state_row_id'"
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_was_changed', 'true')`
    );
    // @ts-expect-error - accessing private field for testing
    this._state = this._stateSentinel;
  }

  // Simulate legacy state row without wasChanged: old SDK version that only wrote
  // STATE_ROW_ID (before wasChanged was added), or crash between the two writes.
  insertStateRowWithoutWasChanged(value: string) {
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_state WHERE id = 'cf_state_was_changed'"
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_state_row_id', ?)",
      value
    );
    // @ts-expect-error - accessing private field for testing
    this._state = this._stateSentinel;
  }

  // Reset schema version to 0 (simulates a pre-versioning DO)
  resetSchemaVersion() {
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_state WHERE id = 'cf_schema_version'"
    );
  }

  // Re-run the real migration logic from the Agent base class.
  runSchemaMigration() {
    this._ensureSchema();
  }
}

// Test Agent with throwing onStateChanged - for testing broadcast order
export class TestThrowingStateAgent extends Agent<Cloudflare.Env, TestState> {
  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Track if onStateChanged was called
  onStateChangedCalled = false;

  // Track errors routed through onError (should not affect broadcasts)
  onErrorCalls: string[] = [];

  // Validation hook: throw to reject the update (gates persist+broadcast)
  validateStateChange(nextState: TestState, _source: Connection | "server") {
    if (nextState.count === -1) {
      throw new Error("Invalid state: count cannot be -1");
    }
  }

  // Notification hook: should not gate broadcasts; errors go to onError
  onStateChanged(state: TestState, _source: Connection | "server") {
    this.onStateChangedCalled = true;
    if (state.count === -2) {
      throw new Error("onStateChanged failed: count cannot be -2");
    }
  }

  override onError(error: unknown): void {
    this.onErrorCalls.push(
      error instanceof Error ? error.message : String(error)
    );
    // Do not throw - this is a test agent
  }

  // Test helper to update state via RPC
  updateState(state: TestState) {
    this.setState(state);
  }

  // Check if onStateChanged was called
  wasOnStateChangedCalled(): boolean {
    return this.onStateChangedCalled;
  }

  // Reset the flag
  resetOnStateChangedCalled() {
    this.onStateChangedCalled = false;
  }

  getOnErrorCalls() {
    return this.onErrorCalls;
  }

  clearOnErrorCalls() {
    this.onErrorCalls = [];
  }
}

// Test Agent using the new onStateChanged hook (successor to onStateUpdate)
export class TestPersistedStateAgent extends Agent<Cloudflare.Env, TestState> {
  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Track onStateChanged calls
  persistedCalls: Array<{ state: TestState; source: string }> = [];

  onStateChanged(state: TestState, source: Connection | "server") {
    this.persistedCalls.push({
      state,
      source: source === "server" ? "server" : source.id
    });
  }

  getState() {
    return this.state;
  }

  updateState(state: TestState) {
    this.setState(state);
  }

  getPersistedCalls() {
    return this.persistedCalls;
  }

  clearPersistedCalls() {
    this.persistedCalls = [];
  }
}

// Test Agent that overrides BOTH hooks on the same class — should throw at runtime
export class TestBothHooksAgent extends Agent<Cloudflare.Env, TestState> {
  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Defining both on the same class is an error
  onStateUpdate(state: TestState, _source: Connection | "server") {
    void state;
  }

  onStateChanged(state: TestState, _source: Connection | "server") {
    void state;
  }

  getState() {
    return this.state;
  }

  updateState(state: TestState) {
    this.setState(state);
  }
}

// Test Agent with sendIdentityOnConnect disabled
export class TestNoIdentityAgent extends Agent<Cloudflare.Env, TestState> {
  // Opt out of sending identity to clients (for security-sensitive instance names)
  static options = { sendIdentityOnConnect: false };

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    // Mock connectToServer to prevent DNS errors from fake MCP server URLs
    const mcp = this.mcp;
    mcp.connectToServer = async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const conn = mcp.mcpConnections[id];
      if (conn) {
        conn.connectionState = MCPConnectionState.FAILED;
      }
      return { state: MCPConnectionState.FAILED, error: "test: mock server" };
    };
  }

  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  getState() {
    return this.state;
  }

  updateState(state: TestState) {
    this.setState(state);
  }

  // Test method: calls addMcpServer without callbackPath — should throw enforcement error
  async testAddMcpServerWithoutCallbackPath(): Promise<{
    threw: boolean;
    message: string;
  }> {
    try {
      await this.addMcpServer("test-server", "https://mcp.example.com", {
        callbackHost: "https://example.com"
      });
      return { threw: false, message: "" };
    } catch (err) {
      return {
        threw: true,
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // Test method: calls addMcpServer with callbackPath — should not throw the enforcement error
  async testAddMcpServerWithCallbackPath(): Promise<{
    threw: boolean;
    message: string;
  }> {
    try {
      await this.addMcpServer("test-server", "https://mcp.example.com", {
        callbackHost: "https://example.com",
        callbackPath: "/mcp-callback"
      });
      return { threw: false, message: "" };
    } catch (err) {
      return {
        threw: true,
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // Test method: calls addMcpServer without callbackHost — should skip callbackPath enforcement
  async testAddMcpServerWithoutCallbackHost(): Promise<{
    threw: boolean;
    message: string;
  }> {
    try {
      await this.addMcpServer("test-server", "https://mcp.example.com");
      return { threw: false, message: "" };
    } catch (err) {
      return {
        threw: true,
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
