# @cloudflare/voice-assemblyai

[AssemblyAI Universal-3 Pro Streaming](https://www.assemblyai.com/docs/streaming/universal-3-pro) speech-to-text provider for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

Universal-3 Pro is AssemblyAI's voice-agent model: sub-300 ms time-to-final, punctuation-based turn detection, barge-in signals, and a fully promptable interface. The provider opens a single WebSocket per call, streams 16 kHz mono PCM16, and routes AssemblyAI's `Turn` and `SpeechStarted` events to the pipeline's callbacks.

## Install

```bash
npm install @cloudflare/voice-assemblyai
```

## Usage

Set `transcriber` on your voice agent:

```typescript
import { Agent } from "agents";
import { withVoice, WorkersAITTS, type VoiceTurnContext } from "@cloudflare/voice";
import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new AssemblyAISTT({
    apiKey: this.env.ASSEMBLYAI_API_KEY,
    domain: "medical-v1",          // optional — Medical Mode
    keyterms: ["metoprolol"]        // optional — recognition boost
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic — transcript is the finalized utterance (Turn end_of_turn=true)
  }
}
```

Provide the key as a Worker secret:

```bash
npx wrangler secret put ASSEMBLYAI_API_KEY
```

## Options

| Option                | Default                                | Description                                                                                       |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apiKey`              | (required)                             | AssemblyAI API key — sent as the `Authorization` header (raw key, no prefix).                     |
| `domain`              | _none_                                 | Domain specialization, e.g. `"medical-v1"`. Future values (legal, finance) just work.             |
| `keyterms`            | _none_                                 | Domain vocabulary array → `keyterms_prompt` (JSON-encoded).                                       |
| `prompt`              | _none — server default used_           | Custom transcription prompt. **Omit to use AssemblyAI's optimized default (recommended).**        |
| `minTurnSilence`      | `100` ms _(server)_                    | Min silence before a speculative end-of-turn check. Tune for Fast/Balanced/Patient presets.       |
| `maxTurnSilence`      | `1000` ms _(server)_                   | Max silence before a turn is forced to end.                                                       |
| `interruptionDelay`   | `500` ms _(server)_                    | First-partial timing (0–1000 ms). Lower = faster barge-in; higher = more confident.               |
| `vadThreshold`        | _server_                               | VAD silence-confidence (0–1). Raise in noisy environments. AssemblyAI suggests ~0.3.              |
| `continuousPartials`  | `false`                                | Emit ~3 s partials during long uninterrupted turns.                                               |
| `languageDetection`   | `false`                                | Return language metadata on Turn events. Surface via `onLanguageDetected`.                        |
| `onLanguageDetected`  | _none_                                 | `(code, confidence) => void` — called when a Turn carries detected-language metadata.             |
| `baseUrl`             | `wss://streaming.assemblyai.com/v3/ws` | Full WebSocket URL override — see [AI Gateway / EU](#ai-gateway--eu-routing) below.               |

### Recommended voice-agent presets

| Profile      | `minTurnSilence` | `maxTurnSilence` | Use case                                  |
| ------------ | ---------------- | ---------------- | ----------------------------------------- |
| Fast         | 100              | 800              | IVR, quick confirmations, yes/no          |
| Balanced ⭐  | 100              | 1000             | General voice agents (recommended)        |
| Patient      | 200              | 2000             | Entity dictation, healthcare, long speech |

## AI Gateway / EU routing

Route the connection through Cloudflare AI Gateway by pointing `baseUrl` at your gateway endpoint:

```typescript
new AssemblyAISTT({
  apiKey: env.ASSEMBLYAI_API_KEY,
  baseUrl: `wss://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/assemblyai/v3/ws`
});
```

Use the EU host for data residency:

```typescript
new AssemblyAISTT({
  apiKey: env.ASSEMBLYAI_API_KEY,
  baseUrl: "wss://streaming.eu.assemblyai.com/v3/ws"
});
```

## Known limitations

- **No error path to the agent.** The shared `TranscriberSession` interface has no `onError` callback, so fatal failures (e.g. v3 error `1008` for auth) can only be `console.error`'d.
- **Language is set via `prompt`, not a language param.** `language_code` is silently ignored on u3-rt-pro; prepend `Transcribe Spanish.` to the prompt to guide the language. Detected-language metadata is available via `languageDetection` + `onLanguageDetected`.
- **Single model — u3-rt-pro (6 languages: en/es/de/fr/pt/it).** Use cases that need whisper-rt's broader language coverage are not served until a `model` option is added.

## How it works

1. On `start_call`, the provider opens a WebSocket to `wss://streaming.assemblyai.com/v3/ws` with the API key in the `Authorization` header.
2. The pipeline streams 16 kHz mono PCM16 in ~50 ms chunks via `feed()`; the session forwards them as binary frames.
3. AssemblyAI emits `Turn` events — `end_of_turn: false` → `onInterim`, `end_of_turn: true` → `onUtterance`. `SpeechStarted` → `onSpeechStart` for barge-in.
4. On `close()`, the session sends `{"type":"Terminate"}` and closes the socket. Billing accrues on connection-open duration, so closing promptly matters.

## Without an AssemblyAI key

If you do not have an AssemblyAI API key, use `WorkersAIFluxSTT` or `WorkersAINova3STT` from `@cloudflare/voice` — no external API key required.
