import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { Agent, getAgentByName } from "agents";
import {
  createLegacyMcpHandler,
  DurableObjectEventStore,
  type TransportState,
  WorkerTransport
} from "agents/mcp";
import { env as bindings } from "cloudflare:workers";
import * as z from "zod";

const STATE_KEY = "mcp_transport_state";

interface State {
  counter: number;
}

/**
 * Retained Legacy stateful elicitation example.
 *
 * New stateless servers should use examples/mcp-elicitation-mrtr instead.
 */
export class LegacyElicitationAgent extends Agent<Cloudflare.Env, State> {
  server = new McpServer(
    {
      name: "legacy-elicitation-demo",
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
    // Persist SSE events so 2025 clients can reconnect with Last-Event-ID.
    eventStore: new DurableObjectEventStore(this.ctx.storage)
  });

  handler = createLegacyMcpHandler(this.server, {
    route: "/mcp",
    transport: this.transport
  });

  initialState = { counter: 0 };

  onStart(): void {
    this.registerFormElicitationTool();
    this.registerUrlElicitationTool();
  }

  private registerFormElicitationTool() {
    this.server.registerTool(
      "increase-counter",
      {
        description: "Increase a persistent counter after asking for an amount",
        inputSchema: {
          confirm: z.boolean().describe("Do you want to increase the counter?")
        }
      },
      async ({ confirm }, extra) => {
        if (!confirm) return this.cancelled("Counter increase");

        const result = await this.server.server.elicitInput(
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

        if (result.action !== "accept" || !result.content) {
          return this.cancelled("Counter increase");
        }
        const amount = Number(result.content.amount);
        if (!Number.isFinite(amount)) {
          return {
            content: [
              {
                type: "text" as const,
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
              type: "text" as const,
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
          "Pretends to link an external account using 2025 url-mode elicitation",
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
          return this.cancelled("Account connection");
        }
        return {
          content: [
            {
              type: "text" as const,
              text: "Account connection page opened. Complete it in your browser."
            }
          ]
        };
      }
    );
  }

  private cancelled(action: string) {
    return {
      content: [{ type: "text" as const, text: `${action} cancelled.` }]
    };
  }

  onMcpRequest(request: Request) {
    return this.handler(request, this.env, {} as ExecutionContext);
  }
}

export default {
  async fetch(request: Request) {
    const sessionId =
      request.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const agent = await getAgentByName(
      bindings.LegacyElicitationAgent,
      sessionId
    );
    return agent.onMcpRequest(request);
  }
};
