import type { TTSProvider } from "agents/voice";

export interface ElevenLabsTTSOptions {
  /** ElevenLabs API key. */
  apiKey: string;
  /** Voice ID. Browse voices at https://elevenlabs.io/app/voice-library @default "JBFqnCBsd6RMkjVDRZzb" (George) */
  voiceId?: string;
  /** Model ID. @default "eleven_flash_v2_5" (lowest latency) */
  modelId?: string;
  /** Output format. @default "mp3_44100_128" */
  outputFormat?: string;
}

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

/**
 * ElevenLabs text-to-speech provider for the Agents voice pipeline.
 *
 * Implements `TTSProvider` from `agents/voice`. Use by overriding
 * `synthesize()` on your `VoiceAgent` subclass:
 *
 * @example
 * ```typescript
 * import { VoiceAgent } from "agents/voice";
 * import { ElevenLabsTTS } from "@cloudflare/agents-voice-elevenlabs";
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   #tts: ElevenLabsTTS | null = null;
 *
 *   #getTTS() {
 *     if (!this.#tts) {
 *       this.#tts = new ElevenLabsTTS({ apiKey: this.env.ELEVENLABS_API_KEY });
 *     }
 *     return this.#tts;
 *   }
 *
 *   async synthesize(text: string) {
 *     return this.#getTTS().synthesize(text);
 *   }
 *
 *   async onTurn(transcript, context) { ... }
 * }
 * ```
 */
export class ElevenLabsTTS implements TTSProvider {
  #apiKey: string;
  #voiceId: string;
  #modelId: string;
  #outputFormat: string;

  constructor(options: ElevenLabsTTSOptions) {
    this.#apiKey = options.apiKey;
    this.#voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
    this.#modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.#outputFormat = options.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  }

  async synthesize(text: string): Promise<ArrayBuffer | null> {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.#voiceId}?output_format=${this.#outputFormat}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": this.#apiKey
          },
          body: JSON.stringify({
            text,
            model_id: this.#modelId
          })
        }
      );

      if (!response.ok) {
        console.error(
          `[ElevenLabsTTS] Error: ${response.status} ${response.statusText}`
        );
        return null;
      }

      return await response.arrayBuffer();
    } catch (error) {
      console.error("[ElevenLabsTTS] Error:", error);
      return null;
    }
  }
}
