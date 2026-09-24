---
"@cloudflare/ai-chat": patch
---

Route platform transient response-reader errors, such as `Network connection lost.`, into bounded chat recovery instead of ending the turn with an error (#1964). The partial response is kept and a continuation is scheduled, as for a stream stall. Deploy and storage resets are left to the restart's recovery, and other reader errors still end the turn.
