---
"@cloudflare/voice": patch
---

Fix audible clicks at audio chunk boundaries during agent speech. `VoiceClient` played each response chunk by starting it at `currentTime` and waiting for its `ended` event before scheduling the next, so every chunk seam carried a few milliseconds of silence (event-loop latency plus the next chunk's setup) — audible as a periodic click, roughly one per chunk. Chunks are now scheduled back-to-back on the audio clock via a playback cursor (`start(Math.max(currentTime, cursor))`), so consecutive chunks butt together sample-tight. Because chunks can now be scheduled ahead of playback, the client tracks every scheduled source and stops them all on interrupt/end-call (previously only the single active source needed stopping), and playback counts as active until the last scheduled chunk finishes so barge-in detection keeps working through the scheduled tail.
