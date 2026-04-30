---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Add agent tool orchestration for running Think and AIChatAgent sub-agents as
retained, streaming tools from a parent agent. The new surface includes
`runAgentTool`, `agentTool`, parent-side run replay and cleanup, Think and
AIChatAgent child adapter support, and headless React/client event state
helpers.
