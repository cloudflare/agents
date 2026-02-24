---
"@cloudflare/ai-chat": patch
---

Fix abort/cancel support for streaming responses. The framework now properly cancels the reader loop when the abort signal fires and sends a done signal to the client. Added a warning log when cancellation arrives but the stream has not closed (indicating the user forgot to pass `abortSignal` to their LLM call). Also fixed vitest project configs to scope test file discovery and prevent e2e/react tests from being picked up by the wrong runner.
