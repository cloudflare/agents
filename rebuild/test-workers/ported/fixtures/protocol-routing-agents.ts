import {
  Think,
  callable,
  hostAgent,
  type ChatMessage,
  type ModelChunk,
  type ModelClient
} from "../compat.js";

type CountState = { count: number };
type RoutingState = {
  count: number;
  items: string[];
  lastUpdated: string | null;
};

function noopModel(): ModelClient {
  return {
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}

class TestProtocolMessagesAgentImpl extends Think<CountState> {
  protected override getInitialState(): CountState {
    return { count: 0 };
  }

  protected override getModel(): ModelClient {
    return noopModel();
  }

  @callable()
  async incrementCount(): Promise<number> {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }

  @callable()
  async getState(): Promise<CountState> {
    return this.state;
  }

  @callable()
  async resetStateForLazyInitTest(): Promise<void> {
    this.setState({ count: 0 });
  }

  @callable()
  async getMyConnectionId(): Promise<string> {
    return "connection-id-unavailable-in-rebuild";
  }

  @callable()
  async checkProtocolEnabled(_connectionId: string): Promise<boolean> {
    return true;
  }

  @callable()
  async checkReadonly(_connectionId: string): Promise<boolean> {
    return false;
  }

  @callable()
  async getConnectionUserState(_connectionId: string): Promise<{
    state: Record<string, unknown> | null;
    isProtocolEnabled: boolean;
    isReadonly: boolean;
  }> {
    return {
      state: null,
      isProtocolEnabled: true,
      isReadonly: false
    };
  }

  @callable()
  async setConnectionUserState(
    _connectionId: string,
    newState: Record<string, unknown>
  ): Promise<{
    state: Record<string, unknown>;
    isProtocolEnabled: boolean;
    isReadonly: boolean;
  }> {
    return {
      state: newState,
      isProtocolEnabled: true,
      isReadonly: false
    };
  }

  @callable()
  async setConnectionUserStateCallback(
    _connectionId: string,
    updates: Record<string, unknown>
  ): Promise<{
    state: Record<string, unknown>;
    isProtocolEnabled: boolean;
    isReadonly: boolean;
  }> {
    return {
      state: { existing: "data", ...updates },
      isProtocolEnabled: true,
      isReadonly: false
    };
  }
}

class TestStateAgentImpl extends Think<RoutingState> {
  protected override getInitialState(): RoutingState {
    return { count: 0, items: [], lastUpdated: null };
  }

  protected override getModel(): ModelClient {
    return noopModel();
  }

  @callable()
  override async getMessages(): Promise<ChatMessage[]> {
    return this.history();
  }

  @callable()
  async getState(): Promise<RoutingState> {
    return this.state;
  }

  @callable()
  async updateState(state: RoutingState): Promise<void> {
    this.setState(state);
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").pop() ?? "";

    if (path === "state") {
      return Response.json({ state: this.state });
    }
    if (path === "echo") {
      const body = await request.text();
      return Response.json({ method: request.method, body, path });
    }

    return new Response("Not found", { status: 404 });
  }
}

class SimpleRoutingAgentImpl extends Think {
  protected override getModel(): ModelClient {
    return noopModel();
  }
}

const TestProtocolMessagesAgentBase = hostAgent(TestProtocolMessagesAgentImpl);
export class TestProtocolMessagesAgent extends TestProtocolMessagesAgentBase {
  incrementCount(): Promise<number> {
    return this.withAgent((agent) => agent.incrementCount());
  }
  getState(): Promise<CountState> {
    return this.withAgent((agent) => agent.getState());
  }
  resetStateForLazyInitTest(): Promise<void> {
    return this.withAgent((agent) => agent.resetStateForLazyInitTest());
  }
  getMyConnectionId(): Promise<string> {
    return this.withAgent((agent) => agent.getMyConnectionId());
  }
  checkProtocolEnabled(connectionId: string): Promise<boolean> {
    return this.withAgent((agent) => agent.checkProtocolEnabled(connectionId));
  }
  checkReadonly(connectionId: string): Promise<boolean> {
    return this.withAgent((agent) => agent.checkReadonly(connectionId));
  }
  getConnectionUserState(connectionId: string): Promise<{
    state: Record<string, unknown> | null;
    isProtocolEnabled: boolean;
    isReadonly: boolean;
  }> {
    return this.withAgent((agent) => agent.getConnectionUserState(connectionId));
  }
  setConnectionUserState(
    connectionId: string,
    newState: Record<string, unknown>
  ): Promise<{
    state: Record<string, unknown>;
    isProtocolEnabled: boolean;
    isReadonly: boolean;
  }> {
    return this.withAgent((agent) =>
      agent.setConnectionUserState(connectionId, newState)
    );
  }
  setConnectionUserStateCallback(
    connectionId: string,
    updates: Record<string, unknown>
  ): Promise<{
    state: Record<string, unknown>;
    isProtocolEnabled: boolean;
    isReadonly: boolean;
  }> {
    return this.withAgent((agent) =>
      agent.setConnectionUserStateCallback(connectionId, updates)
    );
  }
}

const TestStateAgentBase = hostAgent(TestStateAgentImpl, {
  onRequest: (request, agent) => agent.onRequest(request)
});
export class TestStateAgent extends TestStateAgentBase {
  getState(): Promise<RoutingState> {
    return this.withAgent((agent) => agent.getState());
  }

  updateState(state: RoutingState): Promise<void> {
    return this.withAgent((agent) => agent.updateState(state));
  }
}

const TestScheduleAgentBase = hostAgent(SimpleRoutingAgentImpl);
export class TestScheduleAgent extends TestScheduleAgentBase {}

const TestOAuthAgentBase = hostAgent(SimpleRoutingAgentImpl, {
  onRequest: () => new Response("Test OAuth Agent")
});
export class TestOAuthAgent extends TestOAuthAgentBase {}

const TestCaseSensitiveAgentBase = hostAgent(SimpleRoutingAgentImpl);
export class TestCaseSensitiveAgent extends TestCaseSensitiveAgentBase {}

const TestUserNotificationAgentBase = hostAgent(SimpleRoutingAgentImpl);
export class TestUserNotificationAgent extends TestUserNotificationAgentBase {}
