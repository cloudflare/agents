import {
  McpServer,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type RequestStateCodec
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const amountSchema = z.object({ amount: z.number() });
const confirmationSchema = z.object({ confirm: z.boolean() });

type CounterRequestState =
  | { step: "amount"; current: number }
  | { step: "confirmation"; current: number; amount: number };

type Env = { MRTR_REQUEST_STATE_KEY: string };

function createServer(
  requestStateCodec: RequestStateCodec<CounterRequestState>
) {
  const server = new McpServer(
    {
      name: "stateless-mrtr-elicitation-demo",
      version: "1.0.0"
    },
    { requestState: { verify: requestStateCodec.verify } }
  );

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
      const state = context.mcpReq.requestState<CounterRequestState>();
      if (!state) {
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
          },
          requestState: await requestStateCodec.mint(
            { step: "amount", current },
            context
          )
        });
      }

      if (state.step === "amount") {
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
        if (!amount) return cancelled();

        return inputRequired({
          inputRequests: {
            confirmation: inputRequired.elicit({
              message: `Increase ${state.current} by ${amount.amount}?`,
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
          },
          requestState: await requestStateCodec.mint(
            {
              step: "confirmation",
              current: state.current,
              amount: amount.amount
            },
            context
          )
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
      if (!confirmation?.confirm) return cancelled();

      const next = state.current + state.amount;
      return {
        content: [
          {
            type: "text",
            text: `Counter increased by ${state.amount}; next value is ${next}`
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

export default {
  fetch(request, env, ctx) {
    if (!env.MRTR_REQUEST_STATE_KEY) {
      throw new Error("MRTR_REQUEST_STATE_KEY must be configured");
    }
    const requestStateCodec = createRequestStateCodec<CounterRequestState>({
      key: env.MRTR_REQUEST_STATE_KEY,
      bind: ({ mcpReq }) => mcpReq.method
    });
    return createMcpHandler(() => createServer(requestStateCodec), {
      route: "/mcp",
      legacy: "reject"
    })(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
