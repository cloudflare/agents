---
"agents": minor
---

Add `withX402` from `agents/payments/x402` to require payment for an ordinary function using an upstream x402 resource server. Verification runs before execution and settlement follows success. Transport-independent outcomes carry payment challenges, successful results and receipts, or settlement failures.

Add `withX402` from `agents/payments/x402/mcp` to wrap MCP SDK v2 tool callbacks registered with `server.registerTool`. The adapter handles payment metadata, preserves tool results, and does not settle errors or intermediate input requests. Neither wrapper modifies a client or server instance.

Deprecate the feature-frozen `withX402` and `withX402Client` helpers from `agents/x402`. They remain available for compatibility; new integrations should use the paid function/tool wrappers and an ordinary MCP client with upstream x402 payment creation.
