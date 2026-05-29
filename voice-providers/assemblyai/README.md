# @cloudflare/voice-assemblyai

AssemblyAI streaming speech-to-text provider for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

Uses AssemblyAI's real-time WebSocket API to transcribe audio continuously. A single session is created per call; the model handles turn detection and barge-in server-side. Defaults to [Universal-3 Pro Streaming](https://www.assemblyai.com/docs/streaming/universal-3-pro) (`u3-rt-pro`).

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

As the user speaks, the client receives `transcript_interim` messages — exposed by the `useVoiceAgent` React hook as `interimTranscript` — for a live transcript. On `u3-rt-pro` these are stable partial segments (not word-by-word), kept flowing during long turns by `continuousPartials` (on by default).

## Options

| Option               | Default                                | Description                                                                                                                                                               |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`             | (required)                             | AssemblyAI API key (sent as the `Authorization` header, raw key)                                                                                                          |
| `speechModel`        | `"u3-rt-pro"`                          | `u3-rt-pro`, `universal-streaming-english`, or `universal-streaming-multilingual`. `prompt`, `continuousPartials`, `interruptionDelay`, and barge-in are `u3-rt-pro`-only |
| `domain`             | _none_                                 | Domain mode, e.g. `"medical-v1"` for Medical Mode (en/es/de/fr)                                                                                                           |
| `keyterms`           | _none_                                 | Words/phrases to boost recognition (`string[]`)                                                                                                                           |
| `prompt`             | _AssemblyAI default_                   | Custom transcription prompt. **`u3-rt-pro` only.** Omit to use the optimized default                                                                                      |
| `minTurnSilence`     | `400` ms _(server 100)_                | Min silence before an end-of-turn check (lower = snappier, higher = more patient)                                                                                         |
| `maxTurnSilence`     | `1280` ms _(server 1000)_              | Max silence before a turn is forced to end                                                                                                                                |
| `interruptionDelay`  | `500` ms                               | First-partial / barge-in timing (0–1000 ms). **`u3-rt-pro` only.**                                                                                                        |
| `vadThreshold`       | _server_                               | VAD silence-confidence (0–1). Raise in noisy environments                                                                                                                 |
| `continuousPartials` | `true` _(u3-rt-pro)_                   | Steady ~3 s partials during long turns for a live transcript. **`u3-rt-pro` only.** Set `false` to opt out                                                                |
| `languageDetection`  | `false`                                | Return detected-language metadata (`universal-streaming-multilingual`); surface via `onLanguageDetected`                                                                  |
| `onLanguageDetected` | _none_                                 | `(code, confidence) => void` — fired when a turn carries language metadata                                                                                                |
| `baseUrl`            | `wss://streaming.assemblyai.com/v3/ws` | WebSocket URL override, e.g. the EU host `wss://streaming.eu.assemblyai.com/v3/ws`                                                                                        |

## How it works

1. When the call starts, a WebSocket session is opened to AssemblyAI
2. All audio chunks are forwarded continuously via `feed()` (16 kHz mono PCM)
3. AssemblyAI emits `Turn` events — partials (`end_of_turn: false`) go to `onInterim`, the final transcript (`end_of_turn: true`) to `onUtterance`; `SpeechStarted` drives barge-in via `onSpeechStart`
4. The pipeline runs `onTurn()` with the stable transcript
5. On `close()`, a `Terminate` message is sent and the socket is closed (billing accrues on connection-open time, so closing promptly matters)

## AssemblyAI documentation

- [Universal-3 Pro Streaming](https://www.assemblyai.com/docs/streaming/universal-3-pro) — overview, quickstart, connection parameters, and session-based billing for the default `u3-rt-pro` model
- [Turn detection & partials](https://www.assemblyai.com/docs/streaming/universal-3-pro/turn-detection-and-partials) — how `minTurnSilence` / `maxTurnSilence` / `continuousPartials` shape end-of-turn timing and the partial-transcript stream
- [Message sequence](https://www.assemblyai.com/docs/streaming/universal-3-pro/u3-pro-message-sequence) — the `Begin` / `SpeechStarted` / `Turn` / `Termination` events this provider maps to `onSpeechStart` / `onInterim` / `onUtterance`
- [Build your own voice agent — Streaming API](https://www.assemblyai.com/docs/voice-agents/u3-pro-streaming-api) — the raw WebSocket pattern (turn detection, barge-in, interruption) that this provider wraps
- [Endpoints & data zones](https://www.assemblyai.com/docs/streaming/endpoints-and-data-zones) — regional hosts for `baseUrl`, e.g. the EU endpoint `wss://streaming.eu.assemblyai.com/v3/ws`
- [Medical Mode](https://www.assemblyai.com/docs/streaming/medical-mode) — `domain: "medical-v1"` for clinical terminology
- [Keyterms prompting](https://www.assemblyai.com/docs/streaming/keyterms-prompting) — bias recognition toward domain vocabulary via `keyterms`
