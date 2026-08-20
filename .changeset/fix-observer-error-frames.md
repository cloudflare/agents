---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Treat `useAgentChat` observer error frames as terminal responses.

Plain-text error bodies are no longer parsed as stream chunks or merged into an empty assistant message. Error frames now clear observer streaming, replay, recovery, and tool-continuation state even when they omit `done`, matching the transport-owned stream behavior.

Existing observer UIs that displayed error bodies as assistant messages must move those diagnostics to a dedicated error surface.
