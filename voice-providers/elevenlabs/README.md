# @cloudflare/voice-elevenlabs

ElevenLabs speech-to-text and text-to-speech providers for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

## Install

```bash
npm install @cloudflare/voice-elevenlabs
```

## Speech to text

Set `transcriber` on your voice agent:

```typescript
import { Agent } from "agents";
import {
  withVoice,
  WorkersAITTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { ElevenLabsSTT } from "@cloudflare/voice-elevenlabs";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new ElevenLabsSTT({
    apiKey: this.env.ELEVENLABS_API_KEY,
    keyterms: ["Cloudflare", "Workers AI"]
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic
  }
}
```

`ElevenLabsSTT` targets Scribe v2 Realtime and uses ElevenLabs' VAD commit strategy so committed transcript segments map to voice-agent turns.

## Text to speech

Override `synthesize()` on your voice agent:

```typescript
import { Agent } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  #tts: ElevenLabsTTS | null = null;

  #getTTS() {
    if (!this.#tts) {
      this.#tts = new ElevenLabsTTS({
        apiKey: this.env.ELEVENLABS_API_KEY
      });
    }
    return this.#tts;
  }

  async synthesize(text: string) {
    return this.#getTTS().synthesize(text);
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic
  }
}
```

## STT Options

| Option                    | Default                | Description                                         |
| ------------------------- | ---------------------- | --------------------------------------------------- |
| `apiKey`                  | (required)             | ElevenLabs API key                                  |
| `modelId`                 | `"scribe_v2_realtime"` | Realtime STT model ID                               |
| `audioFormat`             | `"pcm_16000"`          | Input audio format from the voice pipeline          |
| `sampleRate`              | `16000`                | Input sample rate                                   |
| `languageCode`            | auto                   | Optional language hint                              |
| `keyterms`                | none                   | Recognition bias terms                              |
| `noVerbatim`              | `false`                | Remove filler words, false starts, and disfluencies |
| `filterBackgroundAudio`   | `false`                | Ask ElevenLabs to filter background audio           |
| `vadSilenceThresholdSecs` | `1.5`                  | Silence threshold for VAD commit                    |
| `vadThreshold`            | `0.4`                  | VAD confidence threshold                            |
| `minSpeechDurationMs`     | `100`                  | Minimum speech duration                             |
| `minSilenceDurationMs`    | `100`                  | Minimum silence duration                            |

## TTS Options

| Option         | Default                           | Description                                                                                    |
| -------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apiKey`       | (required)                        | ElevenLabs API key                                                                             |
| `voiceId`      | `"JBFqnCBsd6RMkjVDRZzb"` (George) | Voice ID. Browse at [elevenlabs.io/app/voice-library](https://elevenlabs.io/app/voice-library) |
| `modelId`      | `"eleven_flash_v2_5"`             | Model ID. `eleven_flash_v2_5` has the lowest latency.                                          |
| `outputFormat` | `"mp3_44100_128"`                 | Audio output format.                                                                           |

## Without the key

If you do not have an ElevenLabs API key, the default `VoiceAgent` uses Workers AI TTS (Deepgram Aura) with no API key required.
