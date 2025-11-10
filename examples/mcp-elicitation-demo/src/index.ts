import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, WorkerTransport } from "agents/mcp";
import * as z from "zod";
import { Agent, getAgentByName } from "agents";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";

type Env = {
  MyAgent: DurableObjectNamespace<MyAgent>;
};

export class MyAgent extends Agent {
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
    sessionIdGenerator: () => this.name
  });

  onStart(): void | Promise<void> {
    this.server.registerTool(
      "validate",
      {
        description: "validate a user",
        inputSchema: z.object({
          name: z.string()
        }).shape
      },
      async (args, extra) => {
        console.log("args", args);
        console.log("extra", extra);
        try {
          const basicInfo = await this.server.server.elicitInput({
            message: "Step 1: Enter basic user information",
            requestedSchema: {
              type: "object",
              properties: {
                age: {
                  type: "number",
                  title: "Age",
                  description: "The user age",
                  minLength: 1
                }
              },
              required: ["age"]
            }
          });

          if (basicInfo.action !== "accept" || !basicInfo.content) {
            return {
              content: [{ type: "text", text: "User creation cancelled." }]
            };
          }
          return {
            content: [
              { type: "text", text: `User is ${basicInfo.content.age}` }
            ]
          };
        } catch (error) {
          console.log(error);

          return {
            content: [{ type: "text", text: "User creation failed." }]
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
