import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface ChildState {
  counter: number;
  createdAt: string;
  createdBy: string;
}

export class ChildAgent extends Agent<Env, ChildState> {
  initialState: ChildState = {
    counter: 0,
    createdAt: "",
    createdBy: ""
  };

  // Called by SupervisorAgent via Durable Object RPC (not @callable)
  initialize(createdBy: string): ChildState {
    const newState = {
      ...this.state,
      createdBy,
      createdAt: new Date().toISOString()
    };
    this.setState(newState);
    return newState;
  }

  // Increment counter - called by SupervisorAgent
  increment(): ChildState {
    const newState = {
      ...this.state,
      counter: this.state.counter + 1
    };
    this.setState(newState);
    return newState;
  }

  // Get current state - called by SupervisorAgent
  getChildState(): ChildState {
    return this.state;
  }

  // Reset the child
  reset(): ChildState {
    const newState = {
      ...this.initialState,
      createdAt: this.state.createdAt,
      createdBy: this.state.createdBy
    };
    this.setState(newState);
    return newState;
  }
}
