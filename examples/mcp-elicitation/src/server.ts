import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "Elicitation Demo",
    version: "1.0.0"
  });

  initialState: State = { counter: 0 };

  async init() {
    this.server.registerTool(
      "increase-counter",
      {
        description: "Increase the counter",
        inputSchema: {
          confirm: z.boolean().describe("Do you want to increase the counter?")
        }
      },
      async ({ confirm }) => {
        if (!confirm) {
          return {
            content: [{ type: "text", text: "Counter increase cancelled." }]
          };
        }

        const result = await this.elicitInput({
          message: "By how much do you want to increase the counter?",
          requestedSchema: {
            type: "object",
            properties: {
              amount: {
                type: "number",
                title: "Amount",
                description: "The amount to increase the counter by"
              }
            },
            required: ["amount"]
          }
        });

        if (result.action !== "accept" || !result.content) {
          return {
            content: [{ type: "text", text: "Counter increase cancelled." }]
          };
        }

        const amount = Number(result.content.amount);
        if (!amount) {
          return {
            content: [
              { type: "text", text: "Counter increase failed, invalid amount." }
            ]
          };
        }

        this.setState({ ...this.state, counter: this.state.counter + amount });

        return {
          content: [
            {
              type: "text",
              text: `Counter increased by ${amount}, current value is ${this.state.counter}`
            }
          ]
        };
      }
    );
  }
}

export default MyMCP.serve("/mcp", { binding: "MyMCP" });
