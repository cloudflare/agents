/**
 * Workers AI provider implementations for the voice pipeline.
 *
 * These are convenience classes that wrap the Workers AI binding
 * (env.AI) for STT, TTS, and VAD. They are not required — any
 * object satisfying the provider interfaces works.
 */

import type { STTProvider, TTSProvider, VADProvider } from "./types";

// --- Audio utilities ---

function toStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    }
  });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Convert raw PCM audio to WAV format. Exported for custom providers. */
export function pcmToWav(
  pcmData: ArrayBuffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): ArrayBuffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmData.byteLength;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, headerSize).set(new Uint8Array(pcmData));

  return buffer;
}

// --- Loose AI binding type ---

/** Loose type for the Workers AI binding — avoids hard dependency on @cloudflare/workers-types. */
interface AiLike {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

// --- STT ---

export interface WorkersAISTTOptions {
  /** STT model name. @default "@cf/deepgram/nova-3" */
  model?: string;
  /** Language code (e.g. "en", "es", "fr"). @default "en" */
  language?: string;
}

/**
 * Workers AI speech-to-text provider.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   stt = new WorkersAISTT(this.env.AI);
 * }
 * ```
 */
export class WorkersAISTT implements STTProvider {
  #ai: AiLike;
  #model: string;
  #language: string;

  constructor(ai: AiLike, options?: WorkersAISTTOptions) {
    this.#ai = ai;
    this.#model = options?.model ?? "@cf/deepgram/nova-3";
    this.#language = options?.language ?? "en";
  }

  async transcribe(
    audioData: ArrayBuffer,
    signal?: AbortSignal
  ): Promise<string> {
    const wavBuffer = pcmToWav(audioData, 16000, 1, 16);
    const result = (await this.#ai.run(
      this.#model,
      {
        audio: {
          body: toStream(wavBuffer),
          contentType: "audio/wav"
        },
        language: this.#language,
        punctuate: true,
        smart_format: true
      },
      signal ? { signal } : undefined
    )) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
          }>;
        }>;
      };
    };

    return result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }
}

// --- TTS ---

export interface WorkersAITTSOptions {
  /** TTS model name. @default "@cf/deepgram/aura-1" */
  model?: string;
  /** TTS speaker voice. @default "asteria" */
  speaker?: string;
}

/**
 * Workers AI text-to-speech provider.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   tts = new WorkersAITTS(this.env.AI);
 * }
 * ```
 */
export class WorkersAITTS implements TTSProvider {
  #ai: AiLike;
  #model: string;
  #speaker: string;

  constructor(ai: AiLike, options?: WorkersAITTSOptions) {
    this.#ai = ai;
    this.#model = options?.model ?? "@cf/deepgram/aura-1";
    this.#speaker = options?.speaker ?? "asteria";
  }

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const response = (await this.#ai.run(
      this.#model,
      { text, speaker: this.#speaker },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;

    return await response.arrayBuffer();
  }
}

// --- VAD ---

export interface WorkersAIVADOptions {
  /** VAD model name. @default "@cf/pipecat-ai/smart-turn-v2" */
  model?: string;
  /** Audio window in seconds (uses last N seconds of audio). @default 2 */
  windowSeconds?: number;
}

/**
 * Workers AI voice activity detection provider.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   vad = new WorkersAIVAD(this.env.AI);
 * }
 * ```
 */
export class WorkersAIVAD implements VADProvider {
  #ai: AiLike;
  #model: string;
  #windowSeconds: number;

  constructor(ai: AiLike, options?: WorkersAIVADOptions) {
    this.#ai = ai;
    this.#model = options?.model ?? "@cf/pipecat-ai/smart-turn-v2";
    this.#windowSeconds = options?.windowSeconds ?? 2;
  }

  async checkEndOfTurn(
    audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }> {
    const maxBytes = this.#windowSeconds * 16000 * 2;
    const vadAudio =
      audioData.byteLength > maxBytes
        ? audioData.slice(audioData.byteLength - maxBytes)
        : audioData;

    const wavBuffer = pcmToWav(vadAudio, 16000, 1, 16);

    const result = (await this.#ai.run(this.#model, {
      audio: {
        body: toStream(wavBuffer),
        contentType: "application/octet-stream"
      }
    })) as { is_complete?: boolean; probability?: number };

    return {
      isComplete: result.is_complete ?? false,
      probability: result.probability ?? 0
    };
  }
}
