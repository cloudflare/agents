import { Think, hostAgent } from "../compat.js";

export type TestP12State = {
  count: number;
  items: string[];
  lastUpdated: string | null;
};

const INITIAL_STATE: TestP12State = {
  count: 0,
  items: [],
  lastUpdated: null
};

class TestP12StateAgentImpl extends Think<TestP12State> {
  stateUpdateCalls: Array<{ state: TestP12State; source: string }> = [];

  protected override getInitialState(): TestP12State {
    return INITIAL_STATE;
  }

  protected override onStateChanged(
    state: TestP12State,
    source: { kind: string }
  ): void {
    this.stateUpdateCalls.push({ state, source: source.kind });
  }

  getState(): TestP12State {
    return this.state;
  }

  updateState(state: TestP12State): void {
    this.setState(state);
  }

  getStateUpdateCalls(): Array<{ state: TestP12State; source: string }> {
    return this.stateUpdateCalls;
  }

  clearStateUpdateCalls(): void {
    this.stateUpdateCalls = [];
  }
}

class TestP12StateAgentNoInitialImpl extends Think<unknown> {
  getState(): unknown {
    try {
      return this.state;
    } catch {
      return undefined;
    }
  }

  updateState(state: unknown): void {
    this.setState(state);
  }
}

class TestP12ThrowingStateAgentImpl extends Think<TestP12State> {
  onErrorCalls: string[] = [];

  protected override getInitialState(): TestP12State {
    return INITIAL_STATE;
  }

  protected override validateStateChange(nextState: TestP12State): void {
    if (nextState.count === -1) {
      throw new Error("Invalid state: count cannot be -1");
    }
  }

  protected override onStateChanged(state: TestP12State): void {
    if (state.count === -2) {
      throw new Error("onStateChanged failed: count cannot be -2");
    }
  }

  getState(): TestP12State {
    return this.state;
  }

  updateState(state: TestP12State): void {
    this.setState(state);
  }

  getOnErrorCalls(): string[] {
    return this.onErrorCalls;
  }

  clearOnErrorCalls(): void {
    this.onErrorCalls = [];
  }
}

class TestP12PersistedStateAgentImpl extends Think<TestP12State> {
  persistedCalls: Array<{ state: TestP12State; source: string }> = [];

  protected override getInitialState(): TestP12State {
    return INITIAL_STATE;
  }

  protected override onStateChanged(
    state: TestP12State,
    source: { kind: string }
  ): void {
    this.persistedCalls.push({ state, source: source.kind });
  }

  getState(): TestP12State {
    return this.state;
  }

  updateState(state: TestP12State): void {
    this.setState(state);
  }

  getPersistedCalls(): Array<{ state: TestP12State; source: string }> {
    return this.persistedCalls;
  }

  clearPersistedCalls(): void {
    this.persistedCalls = [];
  }
}

class TestP12BothHooksAgentImpl extends Think<TestP12State> {
  protected override getInitialState(): TestP12State {
    return INITIAL_STATE;
  }

  onStateUpdate(_state: TestP12State): void {}

  protected override onStateChanged(_state: TestP12State): void {}

  updateState(state: TestP12State): void {
    this.setState(state);
  }
}

const TestP12StateAgentBase = hostAgent(TestP12StateAgentImpl);
const TestP12StateAgentNoInitialBase = hostAgent(
  TestP12StateAgentNoInitialImpl
);
const TestP12ThrowingStateAgentBase = hostAgent(TestP12ThrowingStateAgentImpl);
const TestP12PersistedStateAgentBase = hostAgent(
  TestP12PersistedStateAgentImpl
);
const TestP12BothHooksAgentBase = hostAgent(TestP12BothHooksAgentImpl);

export class TestP12StateAgent extends TestP12StateAgentBase {
  getState(): Promise<TestP12State> {
    return this.withAgent((agent) => agent.getState());
  }

  updateState(state: TestP12State): Promise<void> {
    return this.withAgent((agent) => agent.updateState(state));
  }

  getStateUpdateCalls(): Promise<
    Array<{ state: TestP12State; source: string }>
  > {
    return this.withAgent((agent) => agent.getStateUpdateCalls());
  }

  clearStateUpdateCalls(): Promise<void> {
    return this.withAgent((agent) => agent.clearStateUpdateCalls());
  }
}

export class TestP12StateAgentNoInitial extends TestP12StateAgentNoInitialBase {
  getState(): Promise<unknown> {
    return this.withAgent((agent) => agent.getState());
  }

  updateState(state: unknown): Promise<void> {
    return this.withAgent((agent) => agent.updateState(state));
  }
}

export class TestP12ThrowingStateAgent extends TestP12ThrowingStateAgentBase {
  getState(): Promise<TestP12State> {
    return this.withAgent((agent) => agent.getState());
  }

  updateState(state: TestP12State): Promise<void> {
    return this.withAgent((agent) => agent.updateState(state));
  }

  getOnErrorCalls(): Promise<string[]> {
    return this.withAgent((agent) => agent.getOnErrorCalls());
  }

  clearOnErrorCalls(): Promise<void> {
    return this.withAgent((agent) => agent.clearOnErrorCalls());
  }
}

export class TestP12PersistedStateAgent extends TestP12PersistedStateAgentBase {
  getState(): Promise<TestP12State> {
    return this.withAgent((agent) => agent.getState());
  }

  updateState(state: TestP12State): Promise<void> {
    return this.withAgent((agent) => agent.updateState(state));
  }

  getPersistedCalls(): Promise<Array<{ state: TestP12State; source: string }>> {
    return this.withAgent((agent) => agent.getPersistedCalls());
  }

  clearPersistedCalls(): Promise<void> {
    return this.withAgent((agent) => agent.clearPersistedCalls());
  }
}

export class TestP12BothHooksAgent extends TestP12BothHooksAgentBase {
  updateState(state: TestP12State): Promise<void> {
    return this.withAgent((agent) => agent.updateState(state));
  }
}
