import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "WebMCP Demo",
    version: "1.0.0",
    websiteUrl: "https://github.com/cloudflare/agents"
  });

  initialState: State = {
    counter: 0
  };

  async init() {
    this.server.registerTool(
      "add",
      {
        description: "Add a number to the counter",
        inputSchema: { a: z.number() }
      },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });
        return {
          content: [
            {
              text: `Added ${a}, total is now ${this.state.counter}`,
              type: "text"
            }
          ]
        };
      }
    );

    this.server.registerTool(
      "greet",
      {
        description: "Greet someone by name",
        inputSchema: { name: z.string() }
      },
      async ({ name }) => {
        return {
          content: [
            {
              text: `Hello, ${name}! Welcome to the WebMCP demo.`,
              type: "text"
            }
          ]
        };
      }
    );

    this.server.registerTool(
      "get_counter",
      {
        description: "Get the current counter value"
      },
      async () => {
        return {
          content: [
            {
              text: `Counter is currently ${this.state.counter}`,
              type: "text"
            }
          ]
        };
      }
    );
  }
}

export default MyMCP.serve("/mcp", { binding: "MyMCP" });
