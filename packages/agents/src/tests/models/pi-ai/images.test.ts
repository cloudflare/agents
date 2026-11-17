import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import { asAi, fakeBinding, jsonResponse } from "./helpers";

const FLUX = "@cf/black-forest-labs/flux-1-schnell";
/** A diffusion model on the JSON body, answering raw PNG bytes. */
const SD_IMG2IMG = "@cf/runwayml/stable-diffusion-v1-5-img2img";
const FLUX_2_KLEIN = "@cf/black-forest-labs/flux-2-klein-9b";

/** The first bytes of a JPEG, as flux-1-schnell's base64 starts. */
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/";
/** A PNG signature, as the raw-bytes models answer with. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function binaryResponse(bytes: Uint8Array, mediaType: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: { "content-type": mediaType },
    status: 200
  });
}

const prompt = { input: [{ text: "a cat", type: "text" as const }] };

describe("pi-ai: image generation", () => {
  it("reads the media type off the bytes, not the model name", async () => {
    // The live flux-1-schnell body: JSON whose base64 is a JPEG.
    const binding = fakeBinding(() => jsonResponse({ image: JPEG_BASE64 }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.generateImages(ai.images(FLUX), prompt);

    expect(result.stopReason).toBe("stop");
    expect(result.output[0]).toMatchObject({
      data: JPEG_BASE64,
      mimeType: "image/jpeg",
      type: "image"
    });
  });

  it("keeps the content type of a raw-bytes answer", async () => {
    const binding = fakeBinding(() => binaryResponse(PNG_BYTES, "image/png"));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.generateImages(ai.images(SD_IMG2IMG), prompt);
    expect(result.output[0]).toMatchObject({ mimeType: "image/png" });
  });

  it("sends flux-1 a prompt and steps, and nothing else", async () => {
    const binding = fakeBinding(() => jsonResponse({ image: JPEG_BASE64 }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.generateImages(ai.images(FLUX), prompt, {
      guidance: 8,
      height: 512,
      seed: 3,
      steps: 8,
      width: 1024
    });

    expect(binding.calls[0]?.input).toEqual({ prompt: "a cat", steps: 8 });
    const warnings = result.diagnostics?.[0]?.details.warnings;
    expect(warnings?.map((warning) => warning.feature)).toEqual([
      "size",
      "seed",
      "guidance"
    ]);
  });

  it("sends the full knob set to a model that takes it", async () => {
    const binding = fakeBinding(() => binaryResponse(PNG_BYTES, "image/png"));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.generateImages(ai.images(SD_IMG2IMG), prompt, {
      guidance: 8,
      height: 512,
      negativePrompt: "blurry",
      seed: 3,
      steps: 8,
      width: 1024
    });

    expect(binding.calls[0]?.input).toEqual({
      guidance: 8,
      height: 512,
      negative_prompt: "blurry",
      num_steps: 8,
      prompt: "a cat",
      seed: 3,
      width: 1024
    });
    expect(result.diagnostics).toBeUndefined();
  });

  it("sends FLUX.2 multipart form data, reference images as files", async () => {
    const binding = fakeBinding(() => jsonResponse({ image: JPEG_BASE64 }));
    const ai = createAI({ binding: asAi(binding) });
    const image = {
      data: "AAEC",
      mimeType: "image/png",
      type: "image" as const
    };
    const result = await ai.generateImages(
      ai.images(FLUX_2_KLEIN, { width: 512 }),
      {
        input: [
          { text: "put the cat in the snow", type: "text" },
          image,
          image,
          image,
          image,
          image
        ]
      },
      { negativePrompt: "blurry", seed: 3, steps: 8 }
    );

    const input = binding.calls[0]?.input as {
      multipart: { body: ReadableStream; contentType: string };
    };
    expect(Object.keys(input)).toEqual(["multipart"]);
    const form = await new Response(input.multipart.body, {
      headers: { "content-type": input.multipart.contentType }
    }).formData();
    expect(form.get("prompt")).toBe("put the cat in the snow");
    expect(form.get("width")).toBe("512");
    expect(form.get("seed")).toBe("3");
    expect(form.has("steps")).toBe(false);
    const first = form.get("input_image_0") as File;
    expect(first.type).toBe("image/png");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2])
    );
    expect(form.has("input_image_3")).toBe(true);
    expect(form.has("input_image_4")).toBe(false);
    expect(binding.calls[0]?.options).not.toHaveProperty("gateway");

    expect(result.stopReason).toBe("stop");
    expect(result.output[0]).toMatchObject({
      data: JPEG_BASE64,
      mimeType: "image/jpeg"
    });
    const warnings = result.diagnostics?.[0]?.details.warnings;
    expect(warnings?.map((warning) => warning.feature)).toEqual([
      "negativePrompt",
      "steps",
      "images"
    ]);
  });

  it("warns that gateway options do not apply to FLUX.2", async () => {
    const binding = fakeBinding(() => jsonResponse({ image: JPEG_BASE64 }));
    const ai = createAI({ binding: asAi(binding), cacheTtl: 60 });
    const result = await ai.generateImages(ai.images(FLUX_2_KLEIN), prompt);
    const warnings = result.diagnostics?.[0]?.details.warnings;
    expect(warnings?.map((warning) => warning.feature)).toEqual(["gateway"]);
  });

  it("reports a JSON answer without an image as an error, not a throw", async () => {
    const binding = fakeBinding(() => jsonResponse({ result: {} }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.generateImages(ai.images(SD_IMG2IMG), prompt);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("without an image field");
    expect(result.output).toEqual([]);
  });

  it("reports a failed run as an error", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({ errors: [{ code: 1, message: "nope" }] }, { status: 500 })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.generateImages(ai.images(SD_IMG2IMG), prompt);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("nope");
  });
});
