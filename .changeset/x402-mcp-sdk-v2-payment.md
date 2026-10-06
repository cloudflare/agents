---
"agents": patch
---

`withX402(...).paidTool` now reads the payment from MCP SDK v2 servers, and matches the `PAYMENT-SIGNATURE` / `X-PAYMENT` headers case-insensitively.
