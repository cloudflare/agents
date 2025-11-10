import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, WorkerTransport } from "agents/mcp";
import * as z from "zod";
import { Agent, getAgentByName } from "agents";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";

type Env = {
  MyAgent: DurableObjectNamespace<MyAgent>;
};

interface State {
  counter: number;
}

export class MyAgent extends Agent<Env, State> {
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
    storage: this.ctx.storage
  });

  initialState = {
    counter: 0
  };

  onStart(): void | Promise<void> {
    this.server.registerTool(
      "increase-counter",
      {
        description: "Increase the counter",
        inputSchema: z.object({
          "do you want to increase the counter?": z.boolean()
        }).shape
      },
      async (args, extra) => {
        console.log("args", args);
        console.log("extra", extra);
        try {
          const basicInfo = await this.server.server.elicitInput({
            message: "By how much do you want to increase the counter?",
            requestedSchema: {
              type: "object",
              properties: {
                amount: {
                  type: "number",
                  title: "Amount",
                  description: "The amount to increase the counter by",
                  minLength: 1
                }
              },
              required: ["amount"]
            }
          });

          if (basicInfo.action !== "accept" || !basicInfo.content) {
            return {
              content: [{ type: "text", text: "Counter increase cancelled." }]
            };
          }

          if (basicInfo.content.amount && Number(basicInfo.content.amount)) {
            this.state.counter += Number(basicInfo.content.amount);

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
    return createMcpHandler(this.server as any, {
      transport: this.transport
    })(request, this.env, {} as ExecutionContext);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const sessionId =
      request.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const agent = await getAgentByName(env.MyAgent, sessionId);
    return await agent.onMcpRequest(request);
  }
};
