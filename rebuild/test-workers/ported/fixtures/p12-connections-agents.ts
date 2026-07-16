import { Think, callable, hostAgent } from "../compat.js";
import { TestP12CallableAgent } from "./p12-callable-agents.js";

type CountState = { count: number };
type RoutingState = {
  count: number;
  items: string[];
  lastUpdated: string | null;
};

class TestReadonlyAgentImpl extends Think<CountState> {
  protected override getInitialState(): CountState {
    return { count: 0 };
  }

  protected override shouldConnectionBeReadonly(
    meta: Record<string, unknown>
  ): boolean {
    return meta.readonly === true;
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
  async checkReadonly(_connectionId: string): Promise<boolean> {
    return false;
  }

  @callable()
  async setReadonly(
    _connectionId: string,
    readonly: boolean
  ): Promise<{ success: boolean; readonly: boolean }> {
    return { success: false, readonly };
  }

  @callable()
  async getStateUpdateAttempts(): Promise<
    Array<{ source: string; count: number; allowed: boolean }>
  > {
    return [];
  }

  @callable()
  async getMyConnectionId(): Promise<string | null> {
    return null;
  }

  @callable()
  async getConnectionUserState(_connectionId: string): Promise<{
    state: Record<string, unknown> | null;
    isReadonly: boolean;
  }> {
    return {
      state: null,
      isReadonly: false
    };
  }

  @callable()
  async setConnectionUserState(
    _connectionId: string,
    newState: Record<string, unknown>
  ): Promise<{
    state: Record<string, unknown>;
    isReadonly: boolean;
  }> {
    return {
      state: newState,
      isReadonly: false
    };
  }

  @callable()
  async setConnectionUserStateCallback(
    _connectionId: string,
    updates: Record<string, unknown>
  ): Promise<{
    state: Record<string, unknown>;
    isReadonly: boolean;
  }> {
    return {
      state: { existing: "data", ...updates },
      isReadonly: false
    };
  }
}

class TestNoIdentityAgentImpl extends Think<RoutingState> {
  protected override getInitialState(): RoutingState {
    return { count: 0, items: [], lastUpdated: null };
  }

  @callable()
  async getState(): Promise<RoutingState> {
    return this.state;
  }

  @callable()
  async updateState(state: RoutingState): Promise<void> {
    this.setState(state);
  }
}

const TestReadonlyAgentBase = hostAgent(TestReadonlyAgentImpl);
export class TestReadonlyAgent extends TestReadonlyAgentBase {}

const TestNoIdentityAgentBase = hostAgent(TestNoIdentityAgentImpl, {
  transport: {
    shouldSendProtocolMessages: () => false
  }
});
export class TestNoIdentityAgent extends TestNoIdentityAgentBase {
  getState(): Promise<RoutingState> {
    return this.withAgent((agent) => agent.getState());
  }

  updateState(state: RoutingState): Promise<void> {
    return this.withAgent((agent) => agent.updateState(state));
  }
}

export class TestCallableAgent extends TestP12CallableAgent {}
