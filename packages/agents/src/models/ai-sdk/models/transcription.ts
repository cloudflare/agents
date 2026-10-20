/**
 * Speech recognition over the Cloudflare run path.
 *
 * `whisper-large-v3-turbo` takes the audio as base64 (`{ audio: "<base64>" }`,
 * verified live); the two older whisper ids take it as an unsigned-byte array.
 * Deepgram's Nova-3 takes it as a raw body (`audio: { body, contentType }`),
 * which the transport sends as one, its other fields alongside. Flux takes
 * websocket connections only, so it is refused with a clear error.
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
  unsupported,
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
 * Models that declare `audio: { body, contentType }`. JSON cannot carry that
 * body (base64 and byte arrays answer `400 required properties at '/audio' are
 * 'body,contentType'`), so the audio travels as a raw body.
 */
const RAW_AUDIO = new Set(["@cf/deepgram/nova-3"]);

/** Deepgram's Flux answers `only supports websocket connections` over HTTP. */
const WEBSOCKET_ONLY = new Set(["@cf/deepgram/flux"]);

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

/**
 * Builds the request for a raw-audio model: the audio as a raw body, and
 * `language` as a field. The whisper-only options have no equivalent there.
 */
function buildRawAudioRequest(
  modelId: string,
  options: TranscriptionModelV4CallOptions,
  extra: TranscriptionOptions
): ModalityRequest {
  const warnings: SharedV4Warning[] = [];
  for (const feature of [
    "task",
    "initialPrompt",
    "prefix",
    "vadFilter"
  ] as const) {
    if (extra[feature] !== undefined) {
      warnings.push(unsupported(feature, `${modelId} has no ${feature}.`));
    }
  }
  return {
    audio: { bytes: toBytes(options.audio), contentType: options.mediaType },
    input: extra.language === undefined ? {} : { language: extra.language },
    warnings
  };
}

/** Builds the run-path body for one leg. */
export function buildTranscriptionRequest(
  modelId: string,
  options: TranscriptionModelV4CallOptions
): ModalityRequest {
  const warnings: SharedV4Warning[] = [];
  const extra = transcriptionOptions(options.providerOptions);
  if (RAW_AUDIO.has(modelId)) {
    return buildRawAudioRequest(modelId, options, extra);
  }
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

/** What one transcription answer reads as, whichever family sent it. */
interface Transcript {
  text: string;
  segments: Segment[];
  language: string | undefined;
  durationInSeconds: number | undefined;
}

/** Reads a timed `{ text|word, start, end }` entry as a segment. */
function timed(entry: unknown, textKeys: string[]): Segment[] {
  const item = record(entry);
  if (item === undefined) return [];
  const value = textKeys.map((key) => text(item[key])).find(Boolean);
  if (value === undefined) return [];
  return [
    {
      endSecond: count(item.end) ?? 0,
      startSecond: count(item.start) ?? 0,
      text: value
    }
  ];
}

/**
 * Reads a Deepgram answer: `results.channels[0].alternatives[0]`. Its
 * sentences are the segments when it sends paragraphs, and its words
 * otherwise.
 */
function readDeepgram(body: Record<string, unknown>): Transcript {
  const channel = record(array(record(body.results)?.channels)?.[0]);
  const alternative = record(array(channel?.alternatives)?.[0]);
  const paragraphs = array(record(alternative?.paragraphs)?.paragraphs) ?? [];
  const sentences = paragraphs.flatMap(
    (paragraph) => array(record(paragraph)?.sentences) ?? []
  );
  const segments =
    sentences.length > 0
      ? sentences.flatMap((sentence) => timed(sentence, ["text"]))
      : (array(alternative?.words) ?? []).flatMap((word) =>
          timed(word, ["punctuated_word", "word"])
        );
  return {
    durationInSeconds: count(record(body.metadata)?.duration),
    language:
      text(array(alternative?.languages)?.[0]) ??
      text(channel?.detected_language),
    segments,
    text: text(alternative?.transcript) ?? ""
  };
}

/** Reads a whisper answer. */
function readWhisper(body: Record<string, unknown>): Transcript {
  const info = record(body.transcription_info);
  return {
    durationInSeconds: count(info?.duration),
    language: text(info?.language),
    segments: readSegments(body),
    text: text(body.text) ?? ""
  };
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
    const answer = await this.send({
      abortSignal: options.abortSignal,
      // Checked per leg, so an unsupported model is skipped without a request
      // and the next leg of a fallback chain still runs.
      build: (modelId) => {
        if (WEBSOCKET_ONLY.has(modelId)) {
          throw new CloudflareAIError({
            code: "bad-request",
            isRetryable: false,
            message:
              `${modelId} takes websocket connections only. Use ` +
              "@cf/deepgram/nova-3 or @cf/openai/whisper-large-v3-turbo.",
            model: modelId,
            requestBodyValues: undefined,
            url: this.endpoint
          });
        }
        return buildTranscriptionRequest(modelId, options);
      },
      headers: options.headers,
      providerOptions: options.providerOptions
    });

    const body = record(answer.json) ?? {};
    // The answer's shape decides how to read it, never the model id.
    const transcript =
      record(body.results) === undefined
        ? readWhisper(body)
        : readDeepgram(body);
    return {
      durationInSeconds: transcript.durationInSeconds,
      language: transcript.language,
      providerMetadata: answer.providerMetadata as Record<string, JSONObject>,
      request: { body: JSON.stringify(answer.input) },
      response: {
        body: answer.json,
        headers: answer.headers,
        modelId: answer.modelId,
        timestamp: answer.timestamp
      },
      segments: transcript.segments,
      text: transcript.text,
      warnings: answer.warnings
    };
  }
}
