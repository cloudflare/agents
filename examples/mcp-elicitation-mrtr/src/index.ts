import {
  McpServer,
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const amountSchema = z.object({ amount: z.number() });
const confirmationSchema = z.object({ confirm: z.boolean() });

function createServer() {
  const server = new McpServer({
    name: "stateless-mrtr-elicitation-demo",
    version: "1.0.0"
  });

  server.registerTool(
    "increase-counter",
    {
      description:
        "Calculate a counter increase using two stateless elicitation rounds",
      inputSchema: z.object({
        current: z.number().describe("Current counter value")
      })
    },
    async (
      { current },
      context
    ): Promise<CallToolResult | InputRequiredResult> => {
      const amountResponse = inputResponse(
        context.mcpReq.inputResponses,
        "amount"
      );
      if (
        amountResponse.kind === "elicit" &&
        amountResponse.action !== "accept"
      ) {
        return cancelled();
      }

      const amount = acceptedContent(
        context.mcpReq.inputResponses,
        "amount",
        amountSchema
      );
      if (!amount) {
        return inputRequired({
          inputRequests: {
            amount: inputRequired.elicit({
              message: "By how much should the counter increase?",
              requestedSchema: {
                type: "object",
                properties: {
                  amount: {
                    type: "number",
                    title: "Amount",
                    description: "The amount to add to the current value"
                  }
                },
                required: ["amount"]
              }
            })
          }
        });
      }

      const confirmationResponse = inputResponse(
        context.mcpReq.inputResponses,
        "confirmation"
      );
      if (
        confirmationResponse.kind === "elicit" &&
        confirmationResponse.action !== "accept"
      ) {
        return cancelled();
      }

      const confirmation = acceptedContent(
        context.mcpReq.inputResponses,
        "confirmation",
        confirmationSchema
      );
      if (!confirmation) {
        return inputRequired({
          inputRequests: {
            confirmation: inputRequired.elicit({
              message: `Increase ${current} by ${amount.amount}?`,
              requestedSchema: {
                type: "object",
                properties: {
                  confirm: {
                    type: "boolean",
                    title: "Confirm increase"
                  }
                },
                required: ["confirm"]
              }
            })
          }
        });
      }

      if (!confirmation.confirm) return cancelled();
      const next = current + amount.amount;
      return {
        content: [
          {
            type: "text",
            text: `Counter increased by ${amount.amount}; next value is ${next}`
          }
        ]
      };
    }
  );

  return server;
}

function cancelled(): CallToolResult {
  return {
    content: [{ type: "text", text: "Counter increase cancelled." }]
  };
}

export default createMcpHandler(createServer, {
  route: "/mcp",
  legacy: "reject"
});
