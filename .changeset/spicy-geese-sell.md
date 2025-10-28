---
"agents": patch
---

Add CORS support to MCP handler and tests

Introduces CORS configuration to experimental_createMcpHandler, including handling OPTIONS preflight requests and adding CORS headers to responses and errors. Exports corsHeaders from utils. Adds comprehensive tests for CORS behavior in handler.test.ts.
