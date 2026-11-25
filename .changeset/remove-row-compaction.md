---
"agents": minor
---

Deprecate `enforceRowSizeLimit` in `agents/chat`. It stays exported only for released `@cloudflare/think` (0.21–0.24) and `@cloudflare/ai-chat` (0.10–0.11), which import it; Sessions stores large messages whole. `ROW_MAX_BYTES` is removed from `agents/chat`, and `ROW_VALUE_BYTES` (one row's budget) is exported in its place.
