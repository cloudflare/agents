import { Agent, callable } from "agents";

export interface StateAgentState {
  counter: number;
  items: string[];
  lastUpdated: string | null;
}

export class StateAgent extends Agent<Env, StateAgentState> {
  initialState: StateAgentState = {
    counter: 0,
    items: [],
    lastUpdated: null
  };

  @callable()
  increment(): StateAgentState {
    const newState = {
      ...this.state,
      counter: this.state.counter + 1,
      lastUpdated: new Date().toISOString()
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  decrement(): StateAgentState {
    const newState = {
      ...this.state,
      counter: this.state.counter - 1,
      lastUpdated: new Date().toISOString()
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  setCounter(value: number): StateAgentState {
    const newState = {
      ...this.state,
      counter: value,
      lastUpdated: new Date().toISOString()
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  addItem(item: string): StateAgentState {
    const newState = {
      ...this.state,
      items: [...this.state.items, item],
      lastUpdated: new Date().toISOString()
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  removeItem(index: number): StateAgentState {
    const newState = {
      ...this.state,
      items: this.state.items.filter((_: string, i: number) => i !== index),
      lastUpdated: new Date().toISOString()
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  resetState(): StateAgentState {
    this.setState(this.initialState);
    return this.initialState;
  }
}
