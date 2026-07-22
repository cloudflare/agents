# Stateless Elicitation

A Stateless MCP server demonstrating Stateless Elicitation through multi-round-trip requests (MRTR). The MCP endpoint is `/mcp` (for example, `http://localhost:8787/mcp` under `wrangler dev`).

The `increase-counter` tool is write-once and stateless. One tool call progresses through two input rounds:

1. The server returns `input_required` to ask for an amount.
2. The client retries with the amount; the server returns `input_required` again to ask for confirmation.
3. The client retries with both responses; the server returns the ordinary final tool result.

The SDK carries and validates `requestState` between rounds. The tool does not suspend a Worker or store a pending Promise. The caller supplies the current counter value, and the final result contains the next value.

For existing Legacy deployments that require pushed `elicitation/create`, Durable Object session state, and SSE replay, see the [`mcp-elicitation`](../mcp-elicitation/) **Legacy Elicitation** example.

## Run

```sh
pnpm install
pnpm run dev
```

Connect a Stateless MCP client to `http://localhost:8787/mcp`, then call:

```json
{
  "name": "increase-counter",
  "arguments": { "current": 10 }
}
```

## Key pattern

```ts
const amount = acceptedContent(
  context.mcpReq.inputResponses,
  "amount",
  z.object({ amount: z.number() })
);

if (!amount) {
  return inputRequired({
    inputRequests: {
      amount: inputRequired.elicit({
        message: "By how much should the counter increase?",
        requestedSchema: {
          type: "object",
          properties: { amount: { type: "number" } },
          required: ["amount"]
        }
      })
    }
  });
}
```
