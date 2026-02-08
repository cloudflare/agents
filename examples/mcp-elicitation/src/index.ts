import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createMcpHandler,
  type TransportState,
  WorkerTransport
} from "agents/mcp";
import * as z from "zod";
import { Agent, getAgentByName } from "agents";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { env } from "cloudflare:workers";

const STATE_KEY = "mcp_transport_state";

interface State {
  counter: number;
}

export class MyAgent extends Agent<Cloudflare.Env, State> {
  server = new McpServer(
    {
      name: "test",
      version: "1.0.0"
    },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
  );

  transport = new WorkerTransport({
    sessionIdGenerator: () => this.name,
    storage: {
      get: () => {
        return this.ctx.storage.kv.get<TransportState>(STATE_KEY);
      },
      set: (state: TransportState) => {
        this.ctx.storage.kv.put<TransportState>(STATE_KEY, state);
      }
    }
  });

  initialState = {
    counter: 0
  };

  onStart(): void | Promise<void> {
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

  async onMcpRequest(request: Request) {
    return createMcpHandler(this.server, {
      transport: this.transport
    })(request, this.env, {} as ExecutionContext);
  }
}

export default {
  async fetch(request: Request) {
    const sessionId =
      request.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const agent = await getAgentByName(env.MyAgent, sessionId);
    return await agent.onMcpRequest(request);
  }
};
