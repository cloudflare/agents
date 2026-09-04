/**
 * Workers AI text-to-image requests and answers, shared by both framework
 * modules.
 *
 * Two things about this catalog are easy to get wrong in one module and right
 * in the other, so neither module owns them: the flux-1 models take a two-key
 * subset of the common input shape, and the media type of a JSON answer is in
 * the bytes rather than in the model name (flux-1-schnell answers JPEG while
 * every other model here answers PNG).
 *
 * @experimental This surface is experimental and may change.
 */

import type { CompatWarning } from "./chat-completions";

/**
 * `flux-1-schnell` takes `{ prompt, steps }` and nothing else — no size, no
 * seed, no guidance. Sending those anyway would be silently ignored, so they
 * come back as warnings instead.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
 */
const PROMPT_AND_STEPS_ONLY = /^@cf\/black-forest-labs\/flux-1/;

/**
 * The generation knobs Workers AI text-to-image models share, in this
 * package's own spelling. Each module maps its own call options onto them.
 *
 * @experimental This surface is experimental and may change.
 */
export interface ImageGenerationSettings {
  width?: number;
  height?: number;
  /** Diffusion steps. Sent as `num_steps`, or `steps` on the flux-1 models. */
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
 * A run-path image body with the knobs the model could not take reported.
 *
 * @experimental This surface is experimental and may change.
 */
export interface BuiltImageRequest {
  input: Record<string, unknown>;
  warnings: CompatWarning[];
  /**
   * The model takes `{ prompt, steps }` only, so the caller must not attach a
   * source image or a mask either.
   */
  minimal: boolean;
}

/**
 * Builds the run-path body for a text-to-image model: `prompt`, `width`,
 * `height`, `num_steps`, `guidance`, `strength`, `negative_prompt` and `seed`,
 * or the flux-1 two-key subset with a warning for everything dropped.
 *
 * @experimental This surface is experimental and may change.
 */
export function buildImageInput(
  modelId: string,
  prompt: string,
  settings: ImageGenerationSettings
): BuiltImageRequest {
  const warnings: CompatWarning[] = [];
  const input: Record<string, unknown> = { prompt };

  if (PROMPT_AND_STEPS_ONLY.test(modelId)) {
    if (settings.steps !== undefined) input.steps = settings.steps;
    for (const [feature, value] of [
      ["size", settings.width ?? settings.height],
      ["seed", settings.seed],
      ["guidance", settings.guidance],
      ["negativePrompt", settings.negativePrompt],
      ["strength", settings.strength],
      ["files", settings.sourceImage === true ? true : undefined],
      ["mask", settings.mask === true ? true : undefined]
    ] as const) {
      if (value !== undefined) {
        warnings.push({
          feature,
          message: `${modelId} takes only a prompt and steps.`
        });
      }
    }
    return { input, minimal: true, warnings };
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
  return { input, minimal: false, warnings };
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
