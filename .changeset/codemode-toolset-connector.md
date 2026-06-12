---
"@cloudflare/codemode": minor
---

Add `ToolSetConnector` — adapt an AI SDK `ToolSet` into a codemode connector.

`toolSetConnector(ctx, { tools })` (default name `tools`) turns existing AI SDK tools into connector tools for the durable runtime, converting their input schemas to JSON Schema for the sandbox type declarations. Tools with `needsApproval: true` are mapped to `requiresApproval: true` on the connector tool — calling one pauses the execution durably for human approval instead of the tool being unavailable. Tools without an `execute` function (client-side / provider-executed) are excluded from both the bindings and the generated types, with a one-time warning — the sandbox can't call them. The runtime tool's description now also instructs the model to stop and wait when an execution returns `status: "paused"`.
