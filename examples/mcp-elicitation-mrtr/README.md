# Stateless Elicitation

A Stateless MCP server demonstrating Stateless Elicitation through multi-round-trip requests (MRTR). The MCP endpoint is `/mcp` (for example, `http://localhost:8787/mcp` under `wrangler dev`).

The `increase-counter` tool is write-once and stateless. One tool call progresses through two input rounds:

1. The server returns `input_required` to ask for an amount and seals the current value into `requestState`.
2. The client retries with the amount. The server seals the current value and accepted amount into new `requestState`, then asks for confirmation.
3. The client retries with the confirmation and latest `requestState`. The server verifies and reads that state before returning the ordinary final tool result.

Each retry carries only that round's input responses. The signed `requestState` carries trusted intermediate data between fresh Worker requests. The tool does not suspend a Worker, store a pending Promise, or share a server instance between requests.

For existing Legacy deployments that require pushed `elicitation/create`, Durable Object session state, and SSE replay, see the [`mcp-elicitation`](../mcp-elicitation/) **Legacy Elicitation** example.

## Run

Create a local signing secret of at least 32 bytes, then run the Worker:

```sh
printf 'MRTR_REQUEST_STATE_KEY=replace-with-at-least-32-random-bytes\n' > .dev.vars
pnpm install
pnpm run dev
```

Before deploying, store a production secret with `wrangler secret put MRTR_REQUEST_STATE_KEY`. Do not reuse the local example value.

Connect a Stateless MCP client to `http://localhost:8787/mcp`, then call:

```json
{
  "name": "increase-counter",
  "arguments": { "current": 10 }
}
```

## Key pattern

```ts
const state = context.mcpReq.requestState<CounterRequestState>();

if (!state) {
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
    },
    requestState: await requestStateCodec.mint(
      { step: "amount", current },
      context
    )
  });
}
```
