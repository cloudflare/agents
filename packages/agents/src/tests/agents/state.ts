import { Agent, type Connection } from "../../index.ts";

// Test Agent for state management tests
export type TestState = {
  count: number;
  items: string[];
  lastUpdated: string | null;
};

export class TestStateAgent extends Agent<Record<string, unknown>, TestState> {
  observability = undefined;

  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Track onStateUpdate calls for testing
  stateUpdateCalls: Array<{ state: TestState; source: string }> = [];

  onStateUpdate(state: TestState, source: Connection | "server") {
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
    // Insert invalid JSON directly, also set wasChanged to trigger the read path
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('STATE', 'invalid{json')`
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('STATE_WAS_CHANGED', 'true')`
    );
  }

  // Access state and check if it recovered to initialState
  getStateAfterCorruption(): TestState {
    // This should trigger the try-catch and fallback to initialState
    return this.state;
  }
}

// Test Agent without initialState to test undefined behavior
export class TestStateAgentNoInitial extends Agent<Record<string, unknown>> {
  observability = undefined;

  // No initialState defined - should return undefined

  getState() {
    return this.state;
  }

  updateState(state: unknown) {
    this.setState(state);
  }
}

// Test Agent with throwing onStateUpdate - for testing broadcast order
export class TestThrowingStateAgent extends Agent<
  Record<string, unknown>,
  TestState
> {
  observability = undefined;

  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Track if onStateUpdate was called
  onStateUpdateCalled = false;

  // Track errors routed through onError (should not affect broadcasts)
  onErrorCalls: string[] = [];

  // Validation hook: throw to reject the update (gates persist+broadcast)
  validateStateChange(nextState: TestState, _source: Connection | "server") {
    if (nextState.count === -1) {
      throw new Error("Invalid state: count cannot be -1");
    }
  }

  // Notification hook: should not gate broadcasts; errors go to onError
  onStateUpdate(state: TestState, _source: Connection | "server") {
    this.onStateUpdateCalled = true;
    if (state.count === -2) {
      throw new Error("onStateUpdate failed: count cannot be -2");
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

  // Check if onStateUpdate was called
  wasOnStateUpdateCalled(): boolean {
    return this.onStateUpdateCalled;
  }

  // Reset the flag
  resetOnStateUpdateCalled() {
    this.onStateUpdateCalled = false;
  }

  getOnErrorCalls() {
    return this.onErrorCalls;
  }

  clearOnErrorCalls() {
    this.onErrorCalls = [];
  }
}

// Test Agent using the new onStateChanged hook (successor to onStateUpdate)
export class TestPersistedStateAgent extends Agent<
  Record<string, unknown>,
  TestState
> {
  observability = undefined;

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
export class TestBothHooksAgent extends Agent<
  Record<string, unknown>,
  TestState
> {
  observability = undefined;

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
export class TestNoIdentityAgent extends Agent<
  Record<string, unknown>,
  TestState
> {
  observability = undefined;

  // Opt out of sending identity to clients (for security-sensitive instance names)
  static options = { sendIdentityOnConnect: false };

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
