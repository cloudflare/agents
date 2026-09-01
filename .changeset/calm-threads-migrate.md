---
"@cloudflare/ai-chat": minor
---

Store AIChatAgent messages through `agents/sessions` while preserving the mutable `messages` array, destructive regeneration, retention, broadcasts, and v4 message conversion. Existing `cf_ai_chat_agent_messages` rows migrate once into a linear Sessions chain and the old table remains as `cf_ai_chat_agent_messages__lifted_v1`. This is a one-way automatic migration; rollback requires restoring the tombstone table. Add opt-in Sessions-owned attachment storage through `sessionAttachments`, with optional R2 and no Workspace dependency.
