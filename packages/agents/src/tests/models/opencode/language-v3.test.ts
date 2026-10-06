import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { asLanguageModelV3 } from "../../../models/opencode/language-v3";

const USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
};

/** A V4 model that records the call options it got and streams `parts`. */
function recordingModel(parts: readonly LanguageModelV4StreamPart[]): {
  readonly model: LanguageModelV4;
  readonly calls: LanguageModelV4CallOptions[];
} {
  const calls: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    async doGenerate(options) {
      calls.push(options);
      return {
        content: [
          { type: "text", text: "hi" },
          { type: "custom", kind: "test.custom", providerMetadata: {} }
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [{ type: "deprecated", setting: "seed", message: "gone" }]
      };
    },
    async doStream(options) {
      calls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          }
        })
      };
    }
  };
  return { model, calls };
}

async function read(
  stream: ReadableStream<LanguageModelV3StreamPart>
): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const IMAGE = new Uint8Array([1, 2, 3]);

const OPTIONS: LanguageModelV3CallOptions = {
  prompt: [
    { role: "system", content: "be brief" },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "file", mediaType: "image/png", data: IMAGE },
        {
          type: "file",
          mediaType: "image/png",
          data: new URL("https://example.com/a.png")
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "screenshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "here" },
              { type: "image-data", data: "AQID", mediaType: "image/png" },
              { type: "file-url", url: "https://example.com/b.pdf" }
            ]
          }
        }
      ]
    }
  ]
};

describe("asLanguageModelV3", () => {
  it("carries files to the V4 model in V4's tagged form", async () => {
    const { model, calls } = recordingModel([]);
    await asLanguageModelV3(model).doStream(OPTIONS);
    const [call] = calls;
    expect(call?.prompt[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: IMAGE }
        },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "url", url: new URL("https://example.com/a.png") }
        }
      ]
    });
    const tool = call?.prompt[2];
    expect(tool?.role === "tool" && tool.content[0]).toMatchObject({
      type: "tool-result",
      output: {
        type: "content",
        value: [
          { type: "text", text: "here" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "AQID" }
          },
          {
            type: "file",
            mediaType: "application/octet-stream",
            data: { type: "url", url: new URL("https://example.com/b.pdf") }
          }
        ]
      }
    });
  });

  it("streams V3 parts, dropping the kinds V3 has no slot for", async () => {
    const { model } = recordingModel([
      {
        type: "stream-start",
        warnings: [{ type: "deprecated", setting: "seed", message: "gone" }]
      },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "hello" },
      { type: "text-end", id: "t" },
      { type: "custom", kind: "test.custom", providerMetadata: {} },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: IMAGE }
      },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "url", url: new URL("https://example.com/c.png") }
      },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE
      }
    ]);
    const { stream } = await asLanguageModelV3(model).doStream(OPTIONS);
    expect(await read(stream)).toEqual([
      {
        type: "stream-start",
        warnings: [{ type: "other", message: "seed: gone" }]
      },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "hello" },
      { type: "text-end", id: "t" },
      { type: "file", mediaType: "image/png", data: IMAGE },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE
      }
    ]);
  });

  it("generates V3 content and warnings", async () => {
    const { model } = recordingModel([]);
    const v3 = asLanguageModelV3(model);
    expect(v3.specificationVersion).toBe("v3");
    const result = await v3.doGenerate(OPTIONS);
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.warnings).toEqual([{ type: "other", message: "seed: gone" }]);
  });
});
