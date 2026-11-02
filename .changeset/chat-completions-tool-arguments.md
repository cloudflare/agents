---
"agents": patch
---

Pi models on the chat-completions wire (Workers AI, and OpenAI-compatible models through AI Gateway) now parse streamed tool-call arguments with pi-ai's own parser. When a model sends arguments that aren't valid JSON, the tool call now fails with an error the model can see and fix, instead of running with whatever arguments could be salvaged.

See [Models for pi-ai](https://developers.cloudflare.com/agents/models/pi-ai/).
