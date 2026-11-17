/**
 * Workers AI text-to-image requests and answers, shared by both framework
 * modules.
 *
 * Three things about this catalog are easy to get wrong in one module and
 * right in the other, so neither module owns them: the flux-1 models take a
 * two-key subset of the common input shape, the FLUX.2 models take multipart
 * form data rather than JSON, and the media type of a JSON answer is in the
 * bytes rather than in the model name (flux-1-schnell answers JPEG while
 * every other model here answers PNG).
 *
 * @experimental This surface is experimental and may change.
 */

import type { CompatWarning } from "./chat-completions";
import type { MultipartFields, MultipartFile } from "./transport";

/**
 * `flux-1-schnell` takes `{ prompt, steps }` and nothing else — no size, no
 * seed, no guidance. Sending those anyway would be silently ignored, so they
 * come back as warnings instead.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
 */
const PROMPT_AND_STEPS_ONLY = /^@cf\/black-forest-labs\/flux-1/;

/**
 * The FLUX.2 models (`flux-2-dev`, `flux-2-klein-4b`, `flux-2-klein-9b`) take
 * their whole input as multipart form data, even a bare prompt: `prompt`,
 * `width`, `height`, `seed`, `guidance`, and up to four reference images as
 * `input_image_0` to `input_image_3`.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/flux-2-klein-9b/
 */
const MULTIPART_FORM = /^@cf\/black-forest-labs\/flux-2-/;

/**
 * The klein models are distilled to a fixed four steps, so `steps` is not
 * one of their fields; `flux-2-dev` takes it.
 */
const FIXED_STEPS = /^@cf\/black-forest-labs\/flux-2-klein-/;

/**
 * How many reference images a FLUX.2 model takes.
 *
 * @experimental This surface is experimental and may change.
 */
export const MAX_MULTIPART_SOURCE_IMAGES = 4;

/**
 * The generation knobs Workers AI text-to-image models share, in this
 * package's own spelling. Each module maps its own call options onto them.
 *
 * @experimental This surface is experimental and may change.
 */
export interface ImageGenerationSettings {
  width?: number;
  height?: number;
  /** Diffusion steps. Sent as `num_steps`, or `steps` on the flux models. */
  steps?: number;
  /** Classifier-free guidance scale. */
  guidance?: number;
  /** How strongly img2img transforms the input image, between 0 and 1. */
  strength?: number;
  negativePrompt?: string;
  seed?: number;
  /**
   * Whether the caller has a source image to attach. The field it goes in
   * differs per module, so only the warning is decided here.
   */
  sourceImage?: boolean;
  /** Whether the caller has an inpainting mask to attach. */
  mask?: boolean;
}

/**
 * How a model's request goes on the wire, which decides where a caller's
 * source image goes:
 *
 * - `json`: a JSON body, with the source image and mask in their own fields.
 * - `prompt-and-steps`: a JSON body of `{ prompt, steps }` only, so the caller
 *   must not attach a source image or a mask either.
 * - `multipart`: multipart form data. The caller passes `input` and its source
 *   images to {@link imageMultipartFields}.
 *
 * @experimental This surface is experimental and may change.
 */
export type ImageRequestBody = "json" | "prompt-and-steps" | "multipart";

/**
 * A run-path image body with the knobs the model could not take reported.
 *
 * @experimental This surface is experimental and may change.
 */
export interface BuiltImageRequest {
  input: Record<string, unknown>;
  warnings: CompatWarning[];
  body: ImageRequestBody;
}

/** Reports each knob that is set as one the model does not take. */
function dropped(
  modelId: string,
  message: string,
  knobs: readonly (readonly [feature: string, value: unknown])[]
): CompatWarning[] {
  return knobs
    .filter(([, value]) => value !== undefined)
    .map(([feature]) => ({ feature, message: `${modelId} ${message}` }));
}

/**
 * Builds the run-path body for a text-to-image model: `prompt`, `width`,
 * `height`, `num_steps`, `guidance`, `strength`, `negative_prompt` and `seed`;
 * the flux-1 two-key subset; or the FLUX.2 form fields. Every knob the model
 * does not take comes back as a warning.
 *
 * @experimental This surface is experimental and may change.
 */
export function buildImageInput(
  modelId: string,
  prompt: string,
  settings: ImageGenerationSettings
): BuiltImageRequest {
  const input: Record<string, unknown> = { prompt };

  if (PROMPT_AND_STEPS_ONLY.test(modelId)) {
    if (settings.steps !== undefined) input.steps = settings.steps;
    const warnings = dropped(modelId, "takes only a prompt and steps.", [
      ["size", settings.width ?? settings.height],
      ["seed", settings.seed],
      ["guidance", settings.guidance],
      ["negativePrompt", settings.negativePrompt],
      ["strength", settings.strength],
      ["files", settings.sourceImage === true ? true : undefined],
      ["mask", settings.mask === true ? true : undefined]
    ]);
    return { body: "prompt-and-steps", input, warnings };
  }

  if (MULTIPART_FORM.test(modelId)) {
    const fixedSteps = FIXED_STEPS.test(modelId);
    if (settings.width !== undefined) input.width = settings.width;
    if (settings.height !== undefined) input.height = settings.height;
    if (settings.seed !== undefined) input.seed = settings.seed;
    if (settings.guidance !== undefined) input.guidance = settings.guidance;
    if (settings.steps !== undefined && !fixedSteps) {
      input.steps = settings.steps;
    }
    const warnings = dropped(modelId, "does not take this.", [
      ["negativePrompt", settings.negativePrompt],
      ["strength", settings.strength],
      ["mask", settings.mask === true ? true : undefined]
    ]);
    if (fixedSteps && settings.steps !== undefined) {
      warnings.push({
        feature: "steps",
        message: `${modelId} always runs four steps.`
      });
    }
    return { body: "multipart", input, warnings };
  }

  if (settings.width !== undefined) input.width = settings.width;
  if (settings.height !== undefined) input.height = settings.height;
  if (settings.seed !== undefined) input.seed = settings.seed;
  if (settings.steps !== undefined) input.num_steps = settings.steps;
  if (settings.guidance !== undefined) input.guidance = settings.guidance;
  if (settings.strength !== undefined) input.strength = settings.strength;
  if (settings.negativePrompt !== undefined) {
    input.negative_prompt = settings.negativePrompt;
  }
  return { body: "json", input, warnings: [] };
}

/**
 * The form fields for a `multipart` image request: each `input` value as
 * text, then the reference images as `input_image_0`, `input_image_1`, and
 * so on. Images past {@link MAX_MULTIPART_SOURCE_IMAGES} are left out; the
 * caller warns about them.
 *
 * @experimental This surface is experimental and may change.
 */
export function imageMultipartFields(
  input: Record<string, unknown>,
  images: readonly MultipartFile[]
): MultipartFields {
  const fields: MultipartFields = {};
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined) fields[name] = String(value);
  }
  images.slice(0, MAX_MULTIPART_SOURCE_IMAGES).forEach((image, index) => {
    fields[`input_image_${index}`] = image;
  });
  return fields;
}

const JPEG_PREFIX = "/9j/";
const PNG_PREFIX = "iVBORw0KGgo";
const WEBP_PREFIX = "UklGR";
const GIF_PREFIX = "R0lGOD";

/**
 * Sniffs an image media type from the head of its base64. The bytes decide,
 * never the model name: `flux-1-schnell` answers JPEG where every other model
 * in this catalog answers PNG.
 *
 * @experimental This surface is experimental and may change.
 */
export function imageMediaTypeOf(base64: string): string {
  if (base64.startsWith(JPEG_PREFIX)) return "image/jpeg";
  if (base64.startsWith(PNG_PREFIX)) return "image/png";
  if (base64.startsWith(WEBP_PREFIX)) return "image/webp";
  if (base64.startsWith(GIF_PREFIX)) return "image/gif";
  return "image/png";
}
