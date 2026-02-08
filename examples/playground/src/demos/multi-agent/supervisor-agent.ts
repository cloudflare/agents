import { Agent, callable, getAgentByName } from "agents";
import type { ChildAgent, ChildState } from "./child-agent";

export interface SupervisorState {
  childIds: string[];
}

export class SupervisorAgent extends Agent<Env, SupervisorState> {
  initialState: SupervisorState = {
    childIds: []
  };

  @callable({ description: "Create a new child agent" })
  async createChild(
    childId: string
  ): Promise<{ childId: string; state: ChildState }> {
    // Get or create the child agent
    const child = await getAgentByName<Env, ChildAgent>(
      this.env.ChildAgent,
      childId
    );

    // Initialize the child with this supervisor's name
    const state = await child.initialize(this.name);

    // Track the child ID
    if (!this.state.childIds.includes(childId)) {
      this.setState({
        childIds: [...this.state.childIds, childId]
      });
    }

    return { childId, state };
  }

  @callable({ description: "Get all child states" })
  async getChildStates(): Promise<Array<{ id: string; state: ChildState }>> {
    const results = await Promise.all(
      this.state.childIds.map(async (id) => {
        const child = await getAgentByName<Env, ChildAgent>(
          this.env.ChildAgent,
          id
        );
        const state = await child.getChildState();
        return { id, state };
      })
    );
    return results;
  }

  @callable({ description: "Increment a specific child's counter" })
  async incrementChild(childId: string): Promise<ChildState> {
    const child = await getAgentByName<Env, ChildAgent>(
      this.env.ChildAgent,
      childId
    );
    return await child.increment();
  }

  @callable({ description: "Increment all children's counters" })
  async incrementAll(): Promise<Array<{ id: string; state: ChildState }>> {
    const results = await Promise.all(
      this.state.childIds.map(async (id) => {
        const child = await getAgentByName<Env, ChildAgent>(
          this.env.ChildAgent,
          id
        );
        const state = await child.increment();
        return { id, state };
      })
    );
    return results;
  }

  @callable({ description: "Get aggregate statistics" })
  async getStats(): Promise<{
    totalChildren: number;
    totalCounter: number;
    children: Array<{ id: string; state: ChildState }>;
  }> {
    const children = await this.getChildStates();
    const totalCounter = children.reduce((sum, c) => sum + c.state.counter, 0);
    return {
      totalChildren: children.length,
      totalCounter,
      children
    };
  }

  @callable({ description: "Remove a child from tracking" })
  async removeChild(childId: string): Promise<boolean> {
    if (this.state.childIds.includes(childId)) {
      this.setState({
        childIds: this.state.childIds.filter((id) => id !== childId)
      });
      return true;
    }
    return false;
  }

  @callable({ description: "Clear all children" })
  clearChildren(): void {
    this.setState({ childIds: [] });
  }
}
