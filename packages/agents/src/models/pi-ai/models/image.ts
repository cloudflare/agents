/**
 * Image generation for pi-ai: `ai.images(id)` builds a pi `ImagesModel` and
 * `ai.generateImages(model, context)` runs it through the transport.
 *
 * Workers AI text-to-image models take `{ prompt, width?, height?, seed?,
 * num_steps?, guidance?, negative_prompt?, image? }` and answer with raw PNG
 * bytes or, for some models, JSON `{ image: "<base64>" }`; both are mapped to
 * a pi `image` output part.
 */

import type {
  AssistantImages,
  ImagesContext,
  ImagesModel,
  ImagesOptions
} from "@earendil-works/pi-ai";
import type { CompatWarning } from "../../core/chat-completions";
import { buildImageInput, imageMediaTypeOf } from "../../core/images";
import type {
  ModelOptions,
  ProviderGatewaySettings
} from "../../core/settings";
import { resolveOptions } from "../../core/settings";
import type { Transport } from "../../core/transport";
import { unwrapEnvelope } from "../../core/transport";
import { CLOUDFLARE_PROVIDER_ID } from "../catalog";
import { assertOk } from "../errors";
import { COMPAT_DIAGNOSTIC } from "../wires/chat-completions";
import { emptyUsage } from "../wires/shared";

/**
 * The `api` marker on image models from this provider.
 *
 * @experimental This surface is experimental and may change.
 */
export const CLOUDFLARE_AI_IMAGES_API = "cloudflare-ai-images";

/** @experimental This surface is experimental and may change. */
export type CloudflareImagesModel = ImagesModel<
  typeof CLOUDFLARE_AI_IMAGES_API
>;

/**
 * Per-model options for image models: gateway options plus the generation
 * knobs Workers AI understands. Anything given here is the default for every
 * call; `generateImages` options override it.
 *
 * @experimental This surface is experimental and may change.
 */
export interface PiImagesModelOptions extends ModelOptions {
  name?: string;
  width?: number;
  height?: number;
  /** Diffusion steps, for models that accept it. */
  steps?: number;
  /** Classifier-free guidance scale, for models that accept it. */
  guidance?: number;
  negativePrompt?: string;
  seed?: number;
}

/** Per-call options for {@link generateImages}. */
export interface PiImagesCallOptions extends ImagesOptions {
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  negativePrompt?: string;
  seed?: number;
}

const IMAGE_OPTIONS: unique symbol = Symbol.for(
  "agents.models.pi-ai.image-options"
);

type TaggedImagesModel = CloudflareImagesModel & {
  [IMAGE_OPTIONS]?: PiImagesModelOptions;
};

/** Builds the pi image model for a catalog id. */
export function buildImagesModel(
  modelId: string,
  options: PiImagesModelOptions | undefined
): CloudflareImagesModel {
  const model: TaggedImagesModel = {
    api: CLOUDFLARE_AI_IMAGES_API,
    baseUrl: "",
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: modelId,
    input: ["text", "image"],
    name: options?.name ?? modelId,
    output: ["image"],
    provider: CLOUDFLARE_PROVIDER_ID
  };
  if (options !== undefined) {
    Object.defineProperty(model, IMAGE_OPTIONS, {
      configurable: true,
      enumerable: true,
      value: options,
      writable: false
    });
  }
  return model;
}

function imageOptionsOf(
  model: ImagesModel<string>
): PiImagesModelOptions | undefined {
  const options = (model as TaggedImagesModel)[IMAGE_OPTIONS];
  return options !== null && typeof options === "object" ? options : undefined;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Reads an image out of the run path's response, whichever shape it used. */
async function readImage(
  response: Response
): Promise<{ data: string; mimeType: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = unwrapEnvelope(await response.json());
    const record =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
    if (typeof record.image === "string") {
      // The bytes decide the media type, never the model name: flux-1-schnell
      // answers JPEG where every other model in this catalog answers PNG.
      return { data: record.image, mimeType: imageMediaTypeOf(record.image) };
    }
    throw new Error("The image model returned JSON without an image field.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const data = bytesToBase64(bytes);
  return {
    data,
    mimeType: contentType.split(";")[0] || imageMediaTypeOf(data)
  };
}

/**
 * pi-ai's `AssistantImages` has no warnings channel, so a knob this catalog
 * drops is reported the way the language wires report theirs: as a diagnostic
 * of type {@link COMPAT_DIAGNOSTIC}.
 *
 * @experimental This surface is experimental and may change.
 */
export interface CloudflareAssistantImages extends AssistantImages {
  diagnostics?: {
    type: string;
    timestamp: number;
    details: { warnings: CompatWarning[] };
  }[];
}

/** Everything `generateImages` needs from `createAI`. */
export interface ImagesConfig {
  transport: Transport;
  providerGateway: string | ProviderGatewaySettings | undefined;
}

/**
 * Generates images with a Cloudflare catalog model. Text input parts join into
 * the prompt; the first image part, when present, is passed as the source
 * image for image-to-image models. Failures are reported through
 * `stopReason`/`errorMessage`, as pi-ai's images contract expects.
 */
export async function generateImages(
  config: ImagesConfig,
  model: ImagesModel<string>,
  context: ImagesContext,
  options: PiImagesCallOptions | undefined
): Promise<CloudflareAssistantImages> {
  const modelOptions = imageOptionsOf(model);
  const resolved = resolveOptions(
    config.providerGateway,
    modelOptions,
    undefined
  );
  const prompt = context.input
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n");
  const source = context.input.find((part) => part.type === "image");

  const setting = <
    K extends keyof PiImagesCallOptions & keyof PiImagesModelOptions
  >(
    key: K
  ): PiImagesCallOptions[K] | undefined =>
    options?.[key] !== undefined ? options[key] : modelOptions?.[key];
  // The knob names and the flux-1 subset rule are shared with the AI SDK
  // module, so a model that takes only `{ prompt, steps }` gets only that from
  // either provider.
  const built = buildImageInput(model.id, prompt, {
    ...(setting("width") === undefined ? {} : { width: setting("width") }),
    ...(setting("height") === undefined ? {} : { height: setting("height") }),
    ...(setting("steps") === undefined ? {} : { steps: setting("steps") }),
    ...(setting("guidance") === undefined
      ? {}
      : { guidance: setting("guidance") }),
    ...(setting("negativePrompt") === undefined
      ? {}
      : { negativePrompt: setting("negativePrompt") }),
    ...(setting("seed") === undefined ? {} : { seed: setting("seed") }),
    ...(source === undefined ? {} : { sourceImage: true })
  });
  const input = built.input;
  const warnings: CompatWarning[] = built.warnings;
  if (!built.minimal && source !== undefined && source.type === "image") {
    input.image = Array.from(base64ToBytes(source.data));
  }

  const result: CloudflareAssistantImages = {
    api: model.api,
    model: model.id,
    output: [],
    provider: model.provider,
    stopReason: "stop",
    timestamp: Date.now(),
    usage: emptyUsage()
  };

  try {
    const response = await config.transport.run({
      gateway: resolved.gateway,
      headers: resolved.headers,
      input,
      model: model.id,
      signal: options?.signal
    });
    await assertOk(response, {
      model: model.id,
      requestBodyValues: input,
      url: config.transport.url
    });
    const image = await readImage(response);
    result.output.push({
      data: image.data,
      mimeType: image.mimeType,
      type: "image"
    });
    const requestId = response.headers.get("cf-aig-log-id");
    if (requestId !== null) result.responseId = requestId;
  } catch (error) {
    result.stopReason = options?.signal?.aborted ? "aborted" : "error";
    result.errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);
  }
  // pi-ai's `AssistantImages` has no warnings channel, so a dropped knob is
  // reported the way the language wires report theirs: as a diagnostic.
  if (warnings.length > 0) {
    result.diagnostics = [
      { details: { warnings }, timestamp: Date.now(), type: COMPAT_DIAGNOSTIC }
    ];
  }
  return result;
}
