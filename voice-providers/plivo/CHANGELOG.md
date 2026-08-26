# @cloudflare/voice-plivo

## 0.1.0

### Minor Changes

- [#2048](https://github.com/cloudflare/agents/pull/2048) [`3172a23`](https://github.com/cloudflare/agents/commit/3172a232d2c663db6bff126c7ca1ccddb5beb45d) Thanks [@cjol](https://github.com/cjol)! - Add Plivo audio streaming adapter for the Cloudflare Agents voice pipeline.

  `PlivoAdapter` bridges Plivo's bidirectional audio streaming WebSocket protocol to `VoiceAgent`, structured as a sibling to the Twilio provider. Audio is mulaw 8kHz on the Plivo side, decoded and resampled to 16kHz PCM for the agent. Includes barge-in support via Plivo's `clearAudio` event and a `setupPlivoApplication()` helper that configures the Plivo application and phone number through the REST API.
