import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import * as z from "zod";

interface State {
  counter: number;
}

export class MyAgent extends McpAgent<Cloudflare.Env, State> {
  server = new McpServer(
    {
      name: "test",
      version: "1.0.0"
    }
  );

  initialState = {
    counter: 0
  };

  async onStart() {
    this.server.registerTool(
      "increase-counter",
      {
        description: "Increase the counter",
        inputSchema: {
          confirm: z.boolean().describe("Do you want to increase the counter?")
        }
      },
      async ({ confirm }, extra) => {
        if (!confirm) {
          return {
            content: [{ type: "text", text: "Counter increase cancelled." }]
          };
        }
        try {
          const basicInfo = await this.server.server.elicitInput(
            {
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
            },
            { relatedRequestId: extra.requestId }
          );

          if (basicInfo.action !== "accept" || !basicInfo.content) {
            return {
              content: [{ type: "text", text: "Counter increase cancelled." }]
            };
          }

          if (basicInfo.content.amount && Number(basicInfo.content.amount)) {
            this.setState({
              ...this.state,
              counter: this.state.counter + Number(basicInfo.content.amount)
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Counter increased by ${basicInfo.content.amount}, current value is ${this.state.counter}`
                }
              ]
            };
          }

          return {
            content: [
              { type: "text", text: "Counter increase failed, invalid amount." }
            ]
          };
        } catch (error) {
          console.log(error);

          return {
            content: [{ type: "text", text: "Counter increase failed." }]
          };
        }
      }
    );
  }
}

export default MyAgent.serve("/mcp", { binding: "MyAgent" });
