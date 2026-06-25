---
"@cloudflare/voice": patch
---

Fix assistant speech playing back slow on a new turn after an idle gap. `VoiceClient` routes playback through a `MediaStreamAudioDestinationNode` -> `HTMLAudioElement` bridge, and reusing that element for a fresh burst after it had been idle between turns made the new turn resume at the wrong rate (audible as slow-motion that re-converges to normal over the turn). The bridge is now torn down and rebuilt once it has fully drained and been idle past a short threshold, so each turn plays through a freshly created element. Rebuilds never happen mid-turn, since chunks within a turn keep at least one source scheduled on the playback cursor.
