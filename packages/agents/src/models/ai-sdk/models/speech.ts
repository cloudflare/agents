/**
 * Text-to-speech over the Cloudflare run path.
 *
 * Deepgram's Aura models take `{ text, speaker?, encoding?, container? }` and
 * answer with raw MP3 bytes (`content-type: audio/mpeg`, verified live).
 * MeloTTS takes `{ prompt, lang? }` and answers with WAV, or with JSON
 * `{ audio: "<base64>" }` — so the content type decides, never the model id.
 */

import type {
  JSONObject,
  SharedV4Warning,
  SpeechModelV4,
  SpeechModelV4CallOptions,
  SpeechModelV4Result
} from "@ai-sdk/provider";
import { CloudflareAIError } from "../errors";
import type { ModelOptions } from "../settings";
import { record, text } from "../wires/shared";
import {
  CloudflareModalityModel,
  unsupported,
  type ModalityConfig,
  type ModalityRequest
} from "./modality";

/**
 * MeloTTS is the odd one out: the prompt key is `prompt`, the language key is
 * `lang`, and there is no voice.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/melotts/
 */
const MELOTTS = "@cf/myshell-ai/melotts";

/**
 * Output encodings Aura accepts. `outputFormat` maps onto this; anything else
 * is warned about rather than sent, because the run path validates the enum.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/aura-1/
 */
const AURA_ENCODINGS = new Set([
  "linear16",
  "flac",
  "mulaw",
  "alaw",
  "mp3",
  "opus",
  "aac"
]);

/** Builds the run-path body for one speech leg. */
export function buildSpeechRequest(
  modelId: string,
  options: SpeechModelV4CallOptions
): ModalityRequest {
  const warnings: SharedV4Warning[] = [];
  if (options.speed !== undefined) {
    warnings.push(
      unsupported("speed", "Workers AI speech models do not take a speed.")
    );
  }
  if (options.instructions !== undefined) {
    warnings.push(
      unsupported(
        "instructions",
        "Workers AI speech models take text, not instructions."
      )
    );
  }

  if (modelId === MELOTTS) {
    const input: Record<string, unknown> = { prompt: options.text };
    if (options.language !== undefined) input.lang = options.language;
    if (options.voice !== undefined) {
      warnings.push(unsupported("voice", `${MELOTTS} has a single voice.`));
    }
    if (options.outputFormat !== undefined) {
      warnings.push(
        unsupported("outputFormat", `${MELOTTS} picks its own audio format.`)
      );
    }
    return { input, warnings };
  }

  const input: Record<string, unknown> = { text: options.text };
  if (options.voice !== undefined) input.speaker = options.voice;
  if (options.outputFormat !== undefined) {
    if (AURA_ENCODINGS.has(options.outputFormat)) {
      input.encoding = options.outputFormat;
    } else {
      warnings.push(
        unsupported(
          "outputFormat",
          `Expected one of ${[...AURA_ENCODINGS].join(", ")}.`
        )
      );
    }
  }
  if (options.language !== undefined) {
    warnings.push(
      unsupported(
        "language",
        "Aura picks its language from the model id, e.g. @cf/deepgram/aura-2-es."
      )
    );
  }
  return { input, warnings };
}

/**
 * A `SpeechModelV4` over the Workers AI text-to-speech catalog.
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareSpeechModel
  extends CloudflareModalityModel
  implements SpeechModelV4
{
  constructor(
    modelId: string,
    options: ModelOptions | undefined,
    config: ModalityConfig
  ) {
    super(modelId, options, config);
  }

  async doGenerate(
    options: SpeechModelV4CallOptions
  ): Promise<SpeechModelV4Result> {
    const answer = await this.send({
      abortSignal: options.abortSignal,
      build: (modelId) => buildSpeechRequest(modelId, options),
      headers: options.headers,
      providerOptions: options.providerOptions
    });

    // Bytes stay bytes and base64 stays base64: the AI SDK converts either
    // way on demand, and converting here would only lose fidelity.
    let audio: string | Uint8Array;
    if (answer.bytes !== undefined) {
      audio = answer.bytes;
    } else {
      const body = record(answer.json) ?? {};
      const encoded = text(body.audio);
      if (encoded === undefined) {
        throw new CloudflareAIError({
          code: "provider-error",
          data: answer.json,
          isRetryable: false,
          message: "The speech model answered JSON without an `audio` field.",
          model: answer.modelId,
          requestBodyValues: answer.input,
          url: answer.url
        });
      }
      audio = encoded;
    }

    return {
      audio,
      providerMetadata: answer.providerMetadata as Record<string, JSONObject>,
      request: { body: answer.input },
      response: {
        headers: answer.headers,
        modelId: answer.modelId,
        timestamp: answer.timestamp
      },
      warnings: answer.warnings
    };
  }
}
