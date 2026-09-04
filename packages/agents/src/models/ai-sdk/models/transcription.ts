/**
 * Speech recognition over the Cloudflare run path.
 *
 * Whisper is the family that works here. `whisper-large-v3-turbo` takes the
 * audio as base64 (`{ audio: "<base64>" }`, verified live); the two older
 * whisper ids take it as an unsigned-byte array. Deepgram's recognition models
 * want an object body the JSON run path cannot carry, so they are refused with
 * a clear error rather than a platform `400`.
 */

import type {
  JSONObject,
  SharedV4Warning,
  TranscriptionModelV4,
  TranscriptionModelV4CallOptions,
  TranscriptionModelV4Result
} from "@ai-sdk/provider";
import { CloudflareAIError } from "../errors";
import { PROVIDER_OPTIONS_KEY, type ModelOptions } from "../settings";
import { array, count, record, text } from "../wires/shared";
import {
  CloudflareModalityModel,
  toBase64,
  toBytes,
  type ModalityConfig,
  type ModalityRequest
} from "./modality";

/**
 * Whisper ids that take the audio as an unsigned-byte array rather than as
 * base64.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/whisper/
 */
const BYTE_ARRAY_AUDIO = new Set([
  "@cf/openai/whisper",
  "@cf/openai/whisper-tiny-en"
]);

/**
 * Deepgram's recognition models declare `audio: { body: object, contentType }`.
 * Every documented encoding of that shape answered `400 required properties at
 * '/audio' are 'body,contentType'` on the live run path, because `body` has to
 * be the audio object itself and JSON cannot carry it. Refuse early rather
 * than send a body known to fail.
 */
const UNSUPPORTED = new Set(["@cf/deepgram/nova-3", "@cf/deepgram/flux"]);

/** Recognition knobs read from `providerOptions.cloudflare`. */
interface TranscriptionOptions {
  language?: string;
  /** `"transcribe"` (the default) or `"translate"`. */
  task?: string;
  /** Context for the model about what the audio contains. */
  initialPrompt?: string;
  /** Text prepended to the transcript to steer it. */
  prefix?: string;
  /** Run voice-activity detection before transcribing. */
  vadFilter?: boolean;
}

function transcriptionOptions(
  providerOptions: TranscriptionModelV4CallOptions["providerOptions"]
): TranscriptionOptions {
  const raw = record(providerOptions?.[PROVIDER_OPTIONS_KEY]) ?? {};
  const vadFilter = raw.vadFilter;
  return {
    ...(text(raw.language) === undefined
      ? {}
      : { language: text(raw.language) }),
    ...(text(raw.task) === undefined ? {} : { task: text(raw.task) }),
    ...(text(raw.initialPrompt) === undefined
      ? {}
      : { initialPrompt: text(raw.initialPrompt) }),
    ...(text(raw.prefix) === undefined ? {} : { prefix: text(raw.prefix) }),
    ...(typeof vadFilter === "boolean" ? { vadFilter } : {})
  };
}

/** Builds the run-path body for one whisper leg. */
export function buildTranscriptionRequest(
  modelId: string,
  options: TranscriptionModelV4CallOptions
): ModalityRequest {
  const warnings: SharedV4Warning[] = [];
  const extra = transcriptionOptions(options.providerOptions);
  const input: Record<string, unknown> = BYTE_ARRAY_AUDIO.has(modelId)
    ? { audio: Array.from(toBytes(options.audio)) }
    : { audio: toBase64(options.audio) };
  if (extra.language !== undefined) input.language = extra.language;
  if (extra.task !== undefined) input.task = extra.task;
  if (extra.initialPrompt !== undefined) {
    input.initial_prompt = extra.initialPrompt;
  }
  if (extra.prefix !== undefined) input.prefix = extra.prefix;
  if (extra.vadFilter !== undefined) input.vad_filter = extra.vadFilter;
  return { input, warnings };
}

interface Segment {
  text: string;
  startSecond: number;
  endSecond: number;
}

/**
 * Reads segments out of a whisper answer. `segments` is what the large models
 * send; the smaller ones send only `words`, whose timings are the best segment
 * boundaries available.
 */
function readSegments(body: Record<string, unknown>): Segment[] {
  const segments = array(body.segments);
  if (segments !== undefined) {
    return segments.flatMap((entry) => {
      const segment = record(entry);
      const value = text(segment?.text);
      if (segment === undefined || value === undefined) return [];
      return [
        {
          endSecond: count(segment.end) ?? 0,
          startSecond: count(segment.start) ?? 0,
          text: value
        }
      ];
    });
  }
  return (array(body.words) ?? []).flatMap((entry) => {
    const word = record(entry);
    const value = text(word?.word);
    if (word === undefined || value === undefined) return [];
    return [
      {
        endSecond: count(word.end) ?? 0,
        startSecond: count(word.start) ?? 0,
        text: value
      }
    ];
  });
}

/**
 * A `TranscriptionModelV4` over the Workers AI speech-recognition catalog.
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareTranscriptionModel
  extends CloudflareModalityModel
  implements TranscriptionModelV4
{
  constructor(
    modelId: string,
    options: ModelOptions | undefined,
    config: ModalityConfig
  ) {
    super(modelId, options, config);
  }

  async doGenerate(
    options: TranscriptionModelV4CallOptions
  ): Promise<TranscriptionModelV4Result> {
    if (UNSUPPORTED.has(this.modelId)) {
      throw new CloudflareAIError({
        code: "bad-request",
        isRetryable: false,
        message:
          `${this.modelId} takes the audio as an object body, which the JSON ` +
          "run path cannot carry. Use @cf/openai/whisper-large-v3-turbo.",
        model: this.modelId,
        requestBodyValues: undefined,
        url: this.endpoint
      });
    }

    const answer = await this.send({
      abortSignal: options.abortSignal,
      build: (modelId) => buildTranscriptionRequest(modelId, options),
      headers: options.headers,
      providerOptions: options.providerOptions
    });

    const body = record(answer.json) ?? {};
    const info = record(body.transcription_info);
    const language = text(info?.language);
    const duration = count(info?.duration);
    return {
      durationInSeconds: duration,
      language,
      providerMetadata: answer.providerMetadata as Record<string, JSONObject>,
      request: { body: JSON.stringify(answer.input) },
      response: {
        body: answer.json,
        headers: answer.headers,
        modelId: answer.modelId,
        timestamp: answer.timestamp
      },
      segments: readSegments(body),
      text: text(body.text) ?? "",
      warnings: answer.warnings
    };
  }
}
