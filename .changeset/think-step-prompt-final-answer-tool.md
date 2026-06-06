---
"@cloudflare/think": patch
---

Fix `ThinkWorkflow` `step.prompt({ output })` failing on Workers AI with `AiError 5023: JSON Schema mode is not supported with stream mode`.

Structured workflow prompts previously requested output via the AI SDK `Output.object` path, which streams a JSON Schema `response_format` — rejected by some providers (notably Workers AI). `step.prompt()` now runs a full agentic turn that returns its structured result by calling an internal `think_final_answer` tool whose arguments match the schema. This uses ordinary tool calling, so it works across every provider Think supports (verified on Workers AI, OpenAI, and Anthropic), keeps Think's streaming engine (persistence, recovery, resumable streams), and lets the agent use its own tools across multiple steps before producing the final structured answer.

The `think_final_answer` tool name is reserved; its call and result are stripped from the persisted conversation so the transcript and later turns do not see Think's internal plumbing.
