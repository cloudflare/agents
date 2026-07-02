# @cloudflare/voice-assemblyai

AssemblyAI streaming speech-to-text provider for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

Uses AssemblyAI's real-time WebSocket API to transcribe audio continuously. A single session is created per call; the model handles turn detection and barge-in server-side. Targets [Universal 3.5 Pro Realtime](https://www.assemblyai.com/docs/speech-to-text/streaming) (`universal-3-5-pro`) — AssemblyAI's next-generation flagship real-time model, with 19 languages, improved prompting, and conversational context carryover.

## Install

```bash
npm install @cloudflare/voice-assemblyai
```

## Usage

Set `transcriber` on your voice agent:

```typescript
import { Agent } from "agents";
import {
  withVoice,
  WorkersAITTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new AssemblyAISTT({
    apiKey: this.env.ASSEMBLYAI_API_KEY
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic
  }
}
```

Provide the key as a Worker secret: `npx wrangler secret put ASSEMBLYAI_API_KEY`. Get a key from the [AssemblyAI dashboard](https://www.assemblyai.com/dashboard/api-keys).

As the user speaks, the client receives `transcript_interim` messages — exposed by the `useVoiceAgent` React hook as `interimTranscript` — for a live transcript. These are stable partial segments (not word-by-word), kept flowing during long turns by `continuousPartials`.

## Conversational context (`agent_context`)

Universal 3.5 Pro Realtime carries prior finalized turns forward as context to improve accuracy on the next turn (`previousContextNTurns`, on by default). You can additionally feed it the agent's most recent spoken reply so it knows the question the user is answering — especially valuable for short replies (`"yes"`, `"7pm"`, a single name) and spelled-out entities (emails, account IDs). After the agent asks _"What's your email address?"_, this helps the model produce `"user@assemblyai.com"` instead of `"user at assemblyai dot com"`.

**The voice pipeline does this automatically.** After the agent finishes speaking each reply (and the opening greeting), `withVoice` calls the session's `updateAgentContext()` with the spoken text, which is sent to AssemblyAI as an `UpdateConfiguration` message mid-session. No extra wiring is required.

Setting `previousContextNTurns: 0` disables carryover entirely — the model ignores `agent_context`, so the provider skips the automatic updates rather than send messages the server would discard.

You can also seed context at connection time with the `agentContext` option (e.g. for an opening line spoken before the user's first turn), or call `updateAgentContext()` yourself for custom integrations:

```typescript
const session = transcriber.createSession(options);
session.updateAgentContext?.("Sure — what date would you like to book?");
```

## Options

| Option                  | Default                                | Description                                                                                                                                                      |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                | (required)                             | AssemblyAI API key (sent as the `Authorization` header, raw key)                                                                                                 |
| `mode`                  | `"balanced"` _(server default)_        | Latency/accuracy preset: `"min_latency"`, `"balanced"`, or `"max_accuracy"`. Sets the per-mode defaults for turn silence, partials, VAD, and interruption timing |
| `domain`                | _none_                                 | Domain mode, e.g. `"medical-v1"` for Medical Mode (en/es/de/fr)                                                                                                  |
| `keyterms`              | _none_                                 | Words/phrases to boost recognition (`string[]`). Can be combined with `prompt`                                                                                   |
| `prompt`                | _AssemblyAI default_                   | Natural-language context about the audio (domain, topic, scenario) — not formatting instructions. Max 1750 characters. Omit to use the optimized default         |
| `agentContext`          | _none_                                 | Seed the agent's spoken reply as context at connection time. Max 1750 characters. Updated automatically mid-call by the pipeline                                 |
| `previousContextNTurns` | _server (~3)_                          | Max prior conversation entries carried forward as context (0–100). `0` disables carryover (and the provider then skips `agent_context` updates)                  |
| `languageCode`          | _multilingual_                         | Bias the model toward a single language (e.g. `"en"`, `"es"`, `"ja"`) when the session is monolingual. Omit for default code-switching                           |
| `voiceFocus`            | _none_                                 | Noise suppression: `"near-field"` (headsets/handsets) or `"far-field"` (conference rooms, laptop mics). Omit to disable                                          |
| `voiceFocusThreshold`   | _server_                               | How aggressively Voice Focus suppresses background audio (0–1, higher = more aggressive). Requires `voiceFocus`                                                  |
| `minTurnSilence`        | _mode default_                         | Min silence (ms) before an end-of-turn check. Omit to use the `mode` default                                                                                     |
| `maxTurnSilence`        | _mode default_                         | Max silence (ms) before a turn is forced to end. Omit to use the `mode` default                                                                                  |
| `interruptionDelay`     | _mode default_                         | First-partial / barge-in timing (0–1000 ms). Omit to use the `mode` default                                                                                      |
| `vadThreshold`          | _mode default_                         | VAD silence-confidence (0–1). Raise in noisy environments                                                                                                        |
| `continuousPartials`    | _mode default_                         | Steady ~3 s partials during long turns for a live transcript. Set `false` to opt out                                                                             |
| `languageDetection`     | `false`                                | Return detected-language metadata on Turn events; surface via `onLanguageDetected`                                                                               |
| `onLanguageDetected`    | _none_                                 | `(code, confidence) => void` — fired when a turn carries language metadata                                                                                       |
| `baseUrl`               | `wss://streaming.assemblyai.com/v3/ws` | WebSocket URL override, e.g. the EU host `wss://streaming.eu.assemblyai.com/v3/ws`                                                                               |

## How it works

1. When the call starts, a WebSocket session is opened to AssemblyAI (`speech_model=universal-3-5-pro`)
2. All audio chunks are forwarded continuously via `feed()` (16 kHz mono PCM). Frames smaller than AssemblyAI's 50 ms-per-message minimum (e.g. 20 ms telephony frames) are coalesced before sending
3. AssemblyAI emits `Turn` events — partials (`end_of_turn: false`) go to `onInterim`, the final transcript (`end_of_turn: true`) to `onUtterance`; `SpeechStarted` drives barge-in via `onSpeechStart`
4. The pipeline runs `onTurn()` with the stable transcript
5. After the agent speaks its reply, the pipeline calls `updateAgentContext()`, which sends an `UpdateConfiguration` with the spoken text so it primes the next user turn
6. On `close()`, a `Terminate` message is sent and the socket is closed (billing accrues on connection-open time, so closing promptly matters)

## AssemblyAI documentation

- [Streaming speech-to-text](https://www.assemblyai.com/docs/streaming/getting-started/transcribe-streaming-audio) — overview, quickstart, connection parameters, and session-based billing
- [Optimizing accuracy and latency](https://www.assemblyai.com/docs/streaming/getting-started/optimizing-accuracy-and-latency) — how `minTurnSilence` / `maxTurnSilence` / `continuousPartials` and `mode` shape end-of-turn timing and the partial-transcript stream
- [How Prompting and Keyterms works](https://www.assemblyai.com/docs/streaming/prompting-and-keyterms) — using `prompt` for audio context and `keyterms` to boost domain vocabulary (the two can be combined)
- [Conversation Context](https://www.assemblyai.com/docs/streaming/universal-3-pro/context-carryover) — how `agentContext`, `updateAgentContext()`, and `previousContextNTurns` carry prior turns and the agent's spoken replies forward for better recognition
- [Voice Focus](https://www.assemblyai.com/docs/streaming/voice-focus) — background-noise suppression via `voiceFocus` (`near-field` / `far-field`) and `voiceFocusThreshold`
- [Endpoints & data zones](https://www.assemblyai.com/docs/streaming/endpoints-and-data-zones) — regional hosts for `baseUrl`, e.g. the EU endpoint `wss://streaming.eu.assemblyai.com/v3/ws`
