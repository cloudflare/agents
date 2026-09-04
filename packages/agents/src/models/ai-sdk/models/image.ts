/**
 * Image generation over the Cloudflare run path.
 *
 * Two answer shapes exist and the content type tells them apart: the diffusion
 * models stream raw bytes (`image/png`), while `flux-1-schnell` and the
 * Leonardo models answer JSON `{ image: "<base64>" }` — and flux's base64 is
 * JPEG, so nothing here infers a media type from the model name.
 */

import type {
  ImageModelV4,
  ImageModelV4CallOptions,
  ImageModelV4File,
  ImageModelV4ProviderMetadata,
  ImageModelV4Result,
  ImageModelV4Usage,
  JSONArray,
  JSONObject,
  SharedV4Warning
} from "@ai-sdk/provider";
import { buildImageInput, imageMediaTypeOf } from "../../core/images";
import { CloudflareAIError } from "../errors";
import { PROVIDER_OPTIONS_KEY, type ModelOptions } from "../settings";
import { count, record, text } from "../wires/shared";
import {
  CloudflareModalityModel,
  toBase64,
  toBytes,
  unsupported,
  type ModalityAnswer,
  type ModalityConfig,
  type ModalityRequest
} from "./modality";

/** Generation knobs read from `providerOptions.cloudflare`. */
interface ImageOptions {
  /** Diffusion steps. Sent as `num_steps`, or `steps` on the flux-1 models. */
  steps?: number;
  /** Classifier-free guidance scale. */
  guidance?: number;
  /** What to keep out of the image. */
  negativePrompt?: string;
  /** How strongly img2img transforms the input image, between 0 and 1. */
  strength?: number;
}

function imageOptions(
  providerOptions: ImageModelV4CallOptions["providerOptions"]
): ImageOptions {
  const raw = record(providerOptions?.[PROVIDER_OPTIONS_KEY]) ?? {};
  const negativePrompt = text(raw.negativePrompt);
  return {
    ...(count(raw.steps) === undefined ? {} : { steps: count(raw.steps) }),
    ...(count(raw.guidance) === undefined
      ? {}
      : { guidance: count(raw.guidance) }),
    ...(count(raw.strength) === undefined
      ? {}
      : { strength: count(raw.strength) }),
    ...(negativePrompt === undefined ? {} : { negativePrompt })
  };
}

/** `1024x768` → `{ width: 1024, height: 768 }`. */
function parseSize(
  size: `${number}x${number}`
): { width: number; height: number } | undefined {
  const [width, height] = size.split("x").map(Number);
  return Number.isFinite(width) && Number.isFinite(height)
    ? { height, width }
    : undefined;
}

/** The base64 bytes of a file the caller passed for img2img or masking. */
function fileData(file: ImageModelV4File): string | undefined {
  if (file.type === "file") return toBase64(file.data);
  return undefined;
}

/**
 * Builds the run-path body. The knobs and the flux-1 subset rule live in
 * `core/images.ts`, shared with the pi-ai module so the two cannot drift; the
 * AI SDK call options and the `files`/`mask` byte handling are mapped here.
 */
export function buildImageRequest(
  modelId: string,
  options: ImageModelV4CallOptions
): ModalityRequest {
  const warnings: SharedV4Warning[] = [];
  const extra = imageOptions(options.providerOptions);
  if (options.prompt === undefined) {
    warnings.push({
      message: "Cloudflare image models require a prompt; sent an empty one.",
      type: "other"
    });
  }
  if (options.aspectRatio !== undefined) {
    warnings.push(
      unsupported("aspectRatio", "Use `size` instead: Workers AI takes pixels.")
    );
  }

  let size: { width: number; height: number } | undefined;
  if (options.size !== undefined) {
    size = parseSize(options.size);
    if (size === undefined) {
      warnings.push(unsupported("size", `Could not read "${options.size}".`));
    }
  }

  const built = buildImageInput(modelId, options.prompt ?? "", {
    ...(size === undefined ? {} : { height: size.height, width: size.width }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(extra.steps === undefined ? {} : { steps: extra.steps }),
    ...(extra.guidance === undefined ? {} : { guidance: extra.guidance }),
    ...(extra.strength === undefined ? {} : { strength: extra.strength }),
    ...(extra.negativePrompt === undefined
      ? {}
      : { negativePrompt: extra.negativePrompt }),
    ...(options.mask === undefined ? {} : { mask: true }),
    ...(options.files?.[0] === undefined ? {} : { sourceImage: true })
  });
  const input = built.input;
  for (const warning of built.warnings) {
    warnings.push(unsupported(warning.feature, warning.message));
  }
  if (built.minimal) return { input, warnings };

  const source = options.files?.[0];
  if (source !== undefined) {
    const data = fileData(source);
    if (data === undefined) {
      warnings.push(
        unsupported("files", "Image URLs are not supported; send the bytes.")
      );
    } else {
      input.image_b64 = data;
    }
    if ((options.files?.length ?? 0) > 1) {
      warnings.push(
        unsupported("files", "Only the first image is used for img2img.")
      );
    }
  }
  if (options.mask !== undefined) {
    const data = fileData(options.mask);
    if (data === undefined) {
      warnings.push(
        unsupported("mask", "Mask URLs are not supported; send the bytes.")
      );
    } else {
      input.mask = Array.from(toBytes(data));
    }
  }
  return { input, warnings };
}

/** One generated image, in whichever shape the model answered with. */
interface GeneratedImage {
  base64: string | undefined;
  bytes: Uint8Array | undefined;
  mediaType: string;
}

function readImage(answer: ModalityAnswer): GeneratedImage {
  if (answer.bytes !== undefined) {
    return {
      base64: undefined,
      bytes: answer.bytes,
      mediaType: answer.mediaType === "" ? "image/png" : answer.mediaType
    };
  }
  const body = record(answer.json) ?? {};
  const base64 = text(body.image);
  if (base64 === undefined) {
    throw new CloudflareAIError({
      code: "provider-error",
      data: answer.json,
      isRetryable: false,
      message: "The image model answered JSON without an `image` field.",
      model: answer.modelId,
      requestBodyValues: answer.input,
      url: answer.url
    });
  }
  // The bytes decide the media type: flux-1-schnell answers with JPEG despite
  // every other model here answering with PNG.
  return { base64, bytes: undefined, mediaType: imageMediaTypeOf(base64) };
}

function imageUsage(json: unknown): ImageModelV4Usage | undefined {
  const usage = record(record(json)?.usage);
  if (usage === undefined) return undefined;
  return {
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    totalTokens: count(usage.total_tokens)
  };
}

/**
 * An `ImageModelV4` over the Cloudflare text-to-image catalog.
 *
 * The run path generates one image per call, so `maxImagesPerCall` is 1 and
 * `generateImage` fans a larger `n` out itself; a direct `doGenerate` with
 * `n > 1` is fanned out here instead.
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareImageModel
  extends CloudflareModalityModel
  implements ImageModelV4
{
  readonly maxImagesPerCall = 1;

  constructor(
    modelId: string,
    options: ModelOptions | undefined,
    config: ModalityConfig
  ) {
    super(modelId, options, config);
  }

  async doGenerate(
    options: ImageModelV4CallOptions
  ): Promise<ImageModelV4Result> {
    const wanted = Math.max(1, options.n);
    const answers = await Promise.all(
      Array.from({ length: wanted }, () =>
        this.send({
          abortSignal: options.abortSignal,
          build: (modelId) => buildImageRequest(modelId, options),
          headers: options.headers,
          providerOptions: options.providerOptions
        })
      )
    );

    const first = answers[0];
    const generated = answers.map(readImage);
    const images = generated.some((image) => image.base64 !== undefined)
      ? generated.map(
          (image) => image.base64 ?? toBase64(image.bytes as Uint8Array)
        )
      : generated.map((image) => image.bytes as Uint8Array);
    const usage = imageUsage(first.json);

    return {
      images,
      providerMetadata: {
        [PROVIDER_OPTIONS_KEY]: {
          ...(first.providerMetadata[PROVIDER_OPTIONS_KEY] as JSONObject),
          images: generated.map((image) => ({
            mediaType: image.mediaType
          })) as JSONArray
        }
      } as ImageModelV4ProviderMetadata,
      response: {
        headers: first.headers,
        modelId: first.modelId,
        timestamp: first.timestamp
      },
      ...(usage === undefined ? {} : { usage }),
      warnings: first.warnings
    };
  }
}
