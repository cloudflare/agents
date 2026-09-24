---
"@cloudflare/ai-chat": patch
---

Route platform transient response-reader errors, such as `Network connection lost.`, into bounded chat recovery instead of ending the turn with an error (#1964). The partial response is kept and a continuation is scheduled, as for a stream stall; a new turn that failed before producing any part is re-run instead. `onChatRecovery` can decline the recovery with `{ continue: false }`, and repeated transient errors back off and count against `maxAttempts`. Deploy and storage resets are left to the restart's recovery, and other reader errors still end the turn.
