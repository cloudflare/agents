---
"agents": patch
---

Export the `OrphanPersistStore<M = UIMessage>` type from `agents/chat`.

This is the minimal message store the chat-recovery orphan-persist write goes
through — the write subset of `SessionProvider` (the `getMessage`,
`appendMessage`, and `updateMessage` methods). It is parameterized over the
host's message type so the seam itself is not AI-SDK-specific: the AI-SDK chat
hosts (`@cloudflare/ai-chat`, `@cloudflare/think`) instantiate it at the
`UIMessage` default, while `SessionProvider` satisfies it at its own
`SessionMessage`. Both hosts now route their orphan-persist write through a host
adapter typed against this interface, turning the previous by-convention
alignment into a type-enforced contract.

Additive export only — no behavior change to existing APIs.
