---
"@cloudflare/codemode": minor
---

Remove experimental_codemode() and CodeModeProxy from @cloudflare/codemode/ai. The @cloudflare/codemode/ai entrypoint no longer exists.

Replace with createCodeTool() from @cloudflare/codemode which returns a standard AI SDK Tool. The package no longer owns an LLM call or model choice. Users call streamText/generateText with their own model and pass the codemode tool.

ToolDispatcher (extends RpcTarget) replaces CodeModeProxy (extends WorkerEntrypoint) for dispatching tool calls from the sandbox back to the host. It is passed as a parameter to the dynamic worker's evaluate() method instead of being injected as an env binding, removing the need for CodeModeProxy and globalOutbound service bindings. Only a WorkerLoader binding is required now. globalOutbound on DynamicWorkerExecutor defaults to null which blocks fetch/connect at the runtime level. New Executor interface (execute(code, fns) => ExecuteResult) allows custom sandbox implementations. DynamicWorkerExecutor is the Cloudflare Workers implementation. Console output captured in ExecuteResult.logs. Configurable execution timeout.

AST-based code normalization via acorn replaces regex. sanitizeToolName() exported for converting MCP-style tool names to valid JS identifiers.
