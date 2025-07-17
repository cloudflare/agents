import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type Env = {
  MyMCP: DurableObjectNamespace<MyMCP>;
};

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0"
  });

  initialState: State = {
    counter: 1
  };

  async init() {
    this.server.resource("counter", "mcp://resource/counter", (uri) => {
      return {
        contents: [{ text: String(this.state.counter), uri: uri.href }]
      };
    });

    this.server.tool(
      "add",
      "Add to the counter, stored in the MCP",
      { a: z.number() },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });

        return {
          content: [
            {
              text: String(`Added ${a}, total is now ${this.state.counter}`),
              type: "text"
            }
          ]
        };
      }
    );
  }

  onStateUpdate(state: State) {
    console.log({ stateUpdate: state });
  }
}

export default MyMCP.serve("/mcp", {
  binding: "MyMCP"
});
