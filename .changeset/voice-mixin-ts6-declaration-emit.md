---
"@cloudflare/voice": patch
---

Fix TypeScript 6 declaration emit for `withVoice` and `withVoiceInput` mixin functions. TS6 enforces TS4094 which disallows `#private` members in exported anonymous class types. Added explicit return type interfaces (`VoiceAgentMixinMembers`, `VoiceInputMixinMembers`) so the generated `.d.ts` only exposes the public API surface.
