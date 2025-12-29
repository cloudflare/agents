---
"@cloudflare/codemode": patch
"@cloudflare/ai-chat": patch
"agents": patch
---

feat: split ai-chat and codemode into separate packages

Extract @cloudflare/ai-chat and @cloudflare/codemode into their own packages
with comprehensive READMEs. Update agents README to remove chat-specific
content and point to new packages. Fix documentation imports to reflect
new package structure.

Maintains backward compatibility, no breaking changes.
