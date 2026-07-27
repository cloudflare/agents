---
"agents": patch
"@cloudflare/think": patch
---

Keep AI SDK v7 `chat` and `execute_tool` spans under their `invoke_agent` operation span, record requested, approved, and denied `tool_approval` segments under `execute_tool`, and close WebSocket spans before asynchronous work leaves the native invocation. The namespace wrapper establishes parent context before model or tool work without restoring unrelated `AsyncLocalStorage` state such as provider or tool authorization.
