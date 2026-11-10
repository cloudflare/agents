---
"@cloudflare/ai-chat": patch
"agents": patch
---

Fix chat turn races across tabs: clear stops pending replies, regenerate replaces a reply still streaming, a throwing `onChatMessage` sends an error frame, and repeated tool results no longer re-run the model.
