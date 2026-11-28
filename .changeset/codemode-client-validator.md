---
"@cloudflare/codemode": patch
---

Fix `codeMcpServer` throwing on Workers when an upstream tool declares an `outputSchema`. The internal MCP client now uses the Workers-safe `CfWorkerJsonSchemaValidator` instead of Ajv.
