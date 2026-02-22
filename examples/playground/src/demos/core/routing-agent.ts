import { callable } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface RoutingAgentState {
  counter: number;
  agentName: string;
  createdAt: string;
}

export class RoutingAgent extends Agent<Env, RoutingAgentState> {
  initialState: RoutingAgentState = {
    counter: 0,
    agentName: "",
    createdAt: ""
  };

  onStart() {
    if (!this.state.createdAt) {
      this.setState({
        ...this.state,
        agentName: this.name,
        createdAt: new Date().toISOString()
      });
    }
  }

  @callable()
  increment(): RoutingAgentState {
    const newState = {
      ...this.state,
      counter: this.state.counter + 1
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  getInfo(): RoutingAgentState {
    return this.state;
  }
}
