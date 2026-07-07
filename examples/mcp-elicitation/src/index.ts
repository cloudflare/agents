import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  isLegacyRequest,
  McpServer,
  type CallToolResult,
  type InputRequiredResult
} from "@modelcontextprotocol/server";
import { Agent, getAgentByName } from "agents";
import {
  createMcpHandler,
  DurableObjectEventStore,
  type TransportState,
  WorkerTransport
} from "agents/mcp";
import { env as bindings } from "cloudflare:workers";
import * as z from "zod";

const STATE_KEY = "mcp_transport_state";

const AMOUNT_SCHEMA = {
  type: "object" as const,
  properties: {
    amount: {
      type: "number" as const,
      title: "Amount",
      description: "The amount to increase the counter by"
    }
  },
  required: ["amount"]
};

function createModernServer(): McpServer {
  const server = new McpServer({
    name: "elicitation-demo",
    version: "2.0.0"
  });

  // The modern path is stateless: callers provide the current value, and the
  // tool returns the next value after a multi-round-trip elicitation.
  server.registerTool(
    "increase-counter",
    {
      description: "Calculate a counter increase after asking for the amount",
      inputSchema: z.object({
        current: z.number().describe("Current counter value"),
        confirm: z.boolean().describe("Do you want to increase the counter?")
      })
    },
    async (
      { current, confirm },
      context
    ): Promise<CallToolResult | InputRequiredResult> => {
      if (!confirm) {
        return {
          content: [{ type: "text", text: "Counter increase cancelled." }]
        };
      }

      const response = inputResponse(context.mcpReq.inputResponses, "amount");
      if (response.kind === "elicit" && response.action !== "accept") {
        return {
          content: [{ type: "text", text: "Counter increase cancelled." }]
        };
      }

      const accepted = acceptedContent(
        context.mcpReq.inputResponses,
        "amount",
        z.object({ amount: z.number() })
      );
      if (!accepted) {
        return inputRequired({
          inputRequests: {
            amount: inputRequired.elicit({
              message: "By how much do you want to increase the counter?",
              requestedSchema: AMOUNT_SCHEMA
            })
          }
        });
      }

      const next = current + accepted.amount;
      return {
        content: [
          {
            type: "text",
            text: `Counter increased by ${accepted.amount}, next value is ${next}`
          }
        ]
      };
    }
  );

  return server;
}

const modernHandler = createMcpHandler(createModernServer, {
  route: "/mcp",
  legacy: "reject"
});

interface State {
  counter: number;
}

export class MyAgent extends Agent<Cloudflare.Env, State> {
  server = new LegacyMcpServer(
    {
      name: "elicitation-demo-legacy",
      version: "1.0.0"
    },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
  );

  transport = new WorkerTransport({
    sessionIdGenerator: () => this.name,
    storage: {
      get: () => this.ctx.storage.kv.get<TransportState>(STATE_KEY),
      set: (state: TransportState) => {
        this.ctx.storage.kv.put<TransportState>(STATE_KEY, state);
      }
    },
    eventStore: new DurableObjectEventStore(this.ctx.storage)
  });

  handler = createMcpHandler(this.server, { transport: this.transport });

  initialState = { counter: 0 };

  onStart(): void {
    // Existing 2025 clients keep their push-style elicitation and persistent
    // session unchanged on the SDK v1 server and WorkerTransport.
    this.registerUrlElicitationTool();
    this.server.registerTool(
      "increase-counter",
      {
        description: "Increase the persistent counter",
        inputSchema: {
          confirm: z.boolean().describe("Do you want to increase the counter?")
        }
      },
      async ({ confirm }, extra) => {
        if (!confirm) return this.cancelled();

        const result = await this.server.server.elicitInput(
          {
            message: "By how much do you want to increase the counter?",
            requestedSchema: AMOUNT_SCHEMA
          },
          { relatedRequestId: extra.requestId }
        );

        if (result.action !== "accept" || !result.content) {
          return this.cancelled();
        }
        const amount = Number(result.content.amount);
        if (!Number.isFinite(amount)) {
          return {
            content: [
              {
                type: "text",
                text: "Counter increase failed, invalid amount."
              }
            ]
          };
        }

        const counter = this.state.counter + amount;
        this.setState({ ...this.state, counter });
        return {
          content: [
            {
              type: "text",
              text: `Counter increased by ${amount}, current value is ${counter}`
            }
          ]
        };
      }
    );
  }

  private registerUrlElicitationTool() {
    this.server.registerTool(
      "connect-account",
      {
        description:
          "Pretends to link an external account. Demonstrates url-mode " +
          "elicitation: the sensitive URL goes to the user out-of-band " +
          "instead of into tool-result text.",
        inputSchema: {}
      },
      async (_args, extra) => {
        const result = await this.server.server.elicitInput(
          {
            mode: "url",
            message:
              "Open this link to connect your account, then come back and confirm.",
            url: "https://example.com/oauth/authorize?demo=true",
            elicitationId: crypto.randomUUID()
          },
          { relatedRequestId: extra.requestId }
        );

        if (result.action !== "accept") {
          return {
            content: [{ type: "text", text: "Account connection cancelled." }]
          };
        }
        return {
          content: [
            {
              type: "text",
              text: "Account connection page opened. Complete it in your browser."
            }
          ]
        };
      }
    );
  }

  private cancelled() {
    return {
      content: [{ type: "text" as const, text: "Counter increase cancelled." }]
    };
  }

  onMcpRequest(request: Request) {
    return this.handler(request, this.env, {} as ExecutionContext);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!(await isLegacyRequest(request))) {
      return modernHandler(request, env, ctx);
    }

    const sessionId =
      request.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const agent = await getAgentByName(bindings.MyAgent, sessionId);
    return agent.onMcpRequest(request);
  }
};
