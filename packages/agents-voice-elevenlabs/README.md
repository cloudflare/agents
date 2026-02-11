# @cloudflare/agents-voice-elevenlabs

ElevenLabs text-to-speech provider for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

## Install

```bash
npm install @cloudflare/agents-voice-elevenlabs
```

## Usage

Override `synthesize()` on your `VoiceAgent` subclass:

```typescript
import { VoiceAgent, type VoiceTurnContext } from "agents/voice";
import { ElevenLabsTTS } from "@cloudflare/agents-voice-elevenlabs";

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

## Options

| Option         | Default                           | Description                                                                                    |
| -------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apiKey`       | (required)                        | ElevenLabs API key                                                                             |
| `voiceId`      | `"JBFqnCBsd6RMkjVDRZzb"` (George) | Voice ID. Browse at [elevenlabs.io/app/voice-library](https://elevenlabs.io/app/voice-library) |
| `modelId`      | `"eleven_flash_v2_5"`             | Model ID. `eleven_flash_v2_5` has the lowest latency.                                          |
| `outputFormat` | `"mp3_44100_128"`                 | Audio output format.                                                                           |

## Without the key

If you do not have an ElevenLabs API key, the default `VoiceAgent` uses Workers AI TTS (Deepgram Aura) with no API key required.
