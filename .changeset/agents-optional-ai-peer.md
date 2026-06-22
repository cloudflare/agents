---
"agents": patch
---

Make the `ai` peer optional again. The root `agents` runtime and declaration graph no longer reference AI SDK types; AI-specific entry points still require the peer when imported.
