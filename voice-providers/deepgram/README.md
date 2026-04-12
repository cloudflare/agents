# @cloudflare/voice-deepgram

Deepgram continuous speech-to-text provider for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

Uses Deepgram's real-time WebSocket API with server-side VAD and endpointing to transcribe audio continuously. A single session is created per call and the model handles utterance boundary detection.

## Install

```bash
npm install @cloudflare/voice-deepgram
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
import { DeepgramSTT } from "@cloudflare/voice-deepgram";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new DeepgramSTT({
    apiKey: this.env.DEEPGRAM_API_KEY
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic
  }
}
```

The client receives `transcript_interim` messages in real time, which can be displayed as the user speaks. The `useVoiceAgent` React hook exposes this as `interimTranscript`.

## Options

| Option          | Default      | Description                                                    |
| --------------- | ------------ | -------------------------------------------------------------- |
| `apiKey`        | (required)   | Deepgram API key                                               |
| `model`         | `"nova-3"`   | Deepgram model                                                 |
| `language`      | `"en"`       | Language code (e.g. `"en"`, `"es"`, `"fr"`)                    |
| `smartFormat`   | `true`       | Enable smart formatting (numbers, dates, currency)             |
| `punctuate`     | `true`       | Enable automatic punctuation                                   |
| `fillerWords`   | `false`      | Include filler words (um, uh) in transcripts                   |
| `endpointingMs` | `300`        | Silence duration in ms before finalizing an utterance          |
| `encoding`      | `"linear16"` | Audio encoding. Must match the voice pipeline (16-bit PCM).    |
| `sampleRate`    | `16000`      | Sample rate in Hz. Must match the voice pipeline (16kHz).      |
| `channels`      | `1`          | Number of audio channels. Must match the voice pipeline (mono) |

## How it works

1. When the call starts, a WebSocket session is opened to Deepgram
2. All audio chunks are forwarded to Deepgram continuously via `feed()`
3. Deepgram sends back interim and final transcript segments
4. When Deepgram detects an utterance boundary (`speech_final`), the complete transcript is emitted via `onUtterance`
5. The pipeline runs `onTurn()` with the stable transcript

## Without a Deepgram key

If you do not have a Deepgram API key, use `WorkersAIFluxSTT` or `WorkersAINova3STT` from `@cloudflare/voice` -- no external API key required.
