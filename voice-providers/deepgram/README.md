# @cloudflare/voice-deepgram

Deepgram streaming speech-to-text provider for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

Uses Deepgram's real-time WebSocket API to transcribe audio incrementally as it arrives, producing interim and final results in real time. This eliminates STT latency from the critical path — by the time the user stops speaking, the transcript is already (nearly) ready.

## Install

```bash
npm install @cloudflare/voice-deepgram
```

## Usage

Set `streamingStt` on your voice agent:

```typescript
import { Agent } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { DeepgramStreamingSTT } from "@cloudflare/voice-deepgram";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  streamingStt = new DeepgramStreamingSTT({
    apiKey: this.env.DEEPGRAM_API_KEY
  });

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic — transcript arrives with near-zero STT latency
  }
}
```

The client receives `transcript_interim` messages in real time, which can be displayed as the user speaks. The `useVoiceAgent` React hook exposes this as `interimTranscript`.

## Options

| Option        | Default      | Description                                                    |
| ------------- | ------------ | -------------------------------------------------------------- |
| `apiKey`      | (required)   | Deepgram API key                                               |
| `model`       | `"nova-3"`   | Deepgram model. Nova-3 is the latest and most accurate.        |
| `language`    | `"en"`       | Language code (e.g. `"en"`, `"es"`, `"fr"`)                    |
| `smartFormat` | `true`       | Enable smart formatting (numbers, dates, currency)             |
| `punctuate`   | `true`       | Enable automatic punctuation                                   |
| `fillerWords` | `false`      | Include filler words (um, uh) in transcripts                   |
| `encoding`    | `"linear16"` | Audio encoding. Must match the voice pipeline (16-bit PCM).    |
| `sampleRate`  | `16000`      | Sample rate in Hz. Must match the voice pipeline (16kHz).      |
| `channels`    | `1`          | Number of audio channels. Must match the voice pipeline (mono) |

## How it works

1. When the user starts speaking, a WebSocket session is opened to Deepgram
2. Audio chunks are forwarded to Deepgram in real time via `feed()`
3. Deepgram sends back interim (unstable) and final (stable) transcript segments
4. These are relayed to the client as `transcript_interim` messages
5. When the user stops speaking, `finish()` sends a `CloseStream` message and returns the full transcript
6. The transcript is passed to `onTurn()` with near-zero additional STT latency

## Without a Deepgram key

If you do not have a Deepgram API key, the default voice agent uses Workers AI STT (batch mode) with no external API key required. Streaming STT is opt-in.
