import {
  Agent,
  callable,
  getCurrentAgent,
  type Connection,
  type ConnectionContext
} from "agents";

export interface ReadonlyAgentState {
  counter: number;
  lastUpdatedBy: string | null;
}

export class ReadonlyAgent extends Agent<Env, ReadonlyAgentState> {
  initialState: ReadonlyAgentState = {
    counter: 0,
    lastUpdatedBy: null
  };

  shouldConnectionBeReadonly(
    _connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    return url.searchParams.get("mode") === "view";
  }

  @callable()
  increment(): ReadonlyAgentState {
    const newState = {
      ...this.state,
      counter: this.state.counter + 1,
      lastUpdatedBy: "server"
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  decrement(): ReadonlyAgentState {
    const newState = {
      ...this.state,
      counter: this.state.counter - 1,
      lastUpdatedBy: "server"
    };
    this.setState(newState);
    return newState;
  }

  @callable()
  resetCounter(): ReadonlyAgentState {
    this.setState(this.initialState);
    return this.initialState;
  }

  @callable()
  getPermissions(): { canEdit: boolean } {
    const { connection } = getCurrentAgent();
    if (connection) {
      return { canEdit: !this.isConnectionReadonly(connection) };
    }
    return { canEdit: false };
  }

  /** Toggle the calling connection's own readonly status. */
  @callable()
  setMyReadonly(readonly: boolean): { readonly: boolean } {
    const { connection } = getCurrentAgent();
    if (connection) {
      this.setConnectionReadonly(connection, readonly);
      return { readonly };
    }
    return { readonly: false };
  }
}
