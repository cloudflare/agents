---
"@cloudflare/voice-twilio": patch
---

Fix Twilio Media Streams calls failing to connect, play audio, or stop playback on barge-in. Durable Object WebSocket upgrades now keep their HTTP(S) URL, agent audio works with both `Blob` and `ArrayBuffer` delivery, and sustained caller speech clears Twilio's buffered audio while interrupting the active VoiceAgent response.
