import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/ai-sdk";
import {
  asAi,
  callOptions,
  fakeBinding,
  jsonResponse,
  sseResponse
} from "./helpers";

const ROUTE = "dynamic/support";

/**
 * A dynamic route answers in the chat-completions shape whichever model the
 * route picked; this one served an OpenAI model (cloudflare/ai#585 checked
 * `dynamic/gemma-4-fallback` and `dynamic/anty` live in this shape).
 */
const routeBody = {
  choices: [
    {
      finish_reason: "stop",
      index: 0,
      message: { content: "Hello from the route", role: "assistant" }
    }
  ],
  created: 0,
  id: "chatcmpl-route",
  model: "gpt-4o",
  object: "chat.completion",
  usage: { completion_tokens: 6, prompt_tokens: 4, total_tokens: 10 }
};

/** OpenAI's own stream shape: usage only on a final `choices: []` chunk. */
const routeStream = [
  JSON.stringify({
    choices: [{ delta: { content: "Hello", role: "assistant" }, index: 0 }],
    id: "chatcmpl-route",
    model: "gpt-4o",
    object: "chat.completion.chunk"
  }),
  JSON.stringify({
    choices: [{ delta: { content: " there" }, index: 0 }],
    id: "chatcmpl-route",
    model: "gpt-4o",
    object: "chat.completion.chunk"
  }),
  JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
    id: "chatcmpl-route",
    model: "gpt-4o",
    object: "chat.completion.chunk"
  }),
  JSON.stringify({
    choices: [],
    id: "chatcmpl-route",
    model: "gpt-4o",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 }
  }),
  "[DONE]"
];

describe("AI Gateway dynamic routes", () => {
  it("runs the route on env.AI.run under the gateway", async () => {
    const binding = fakeBinding(() => jsonResponse(routeBody));
    const ai = createAI({ binding: asAi(binding), id: "prod", cacheTtl: 60 });
    const result = await ai(ROUTE).doGenerate(callOptions());

    const call = binding.calls[0];
    expect(call.model).toBe(ROUTE);
    // The route picks the model; the body names none.
    expect(call.input).not.toHaveProperty("model");
    expect(call.options).toMatchObject({
      gateway: { cacheTtl: 60, id: "prod" },
      returnRawResponse: true
    });
    expect(result.content).toEqual([
      { text: "Hello from the route", type: "text" }
    ]);
    expect(result.usage.inputTokens.total).toBe(4);
    expect(result.usage.outputTokens.total).toBe(6);
  });

  it("parses a streamed answer in OpenAI's shape", async () => {
    const binding = fakeBinding(() => sseResponse(routeStream));
    const ai = createAI({ binding: asAi(binding) });
    const result = streamText({ model: ai(ROUTE), prompt: "hi" });

    expect(await result.text).toBe("Hello there");
    expect((await result.usage).outputTokens).toBe(2);
    expect(binding.calls[0].options).toMatchObject({
      gateway: { id: "default" }
    });
  });

  it("drops the Workers AI chat template with a warning", async () => {
    // The route may land on any model, so the request is strict OpenAI.
    const binding = fakeBinding(() => jsonResponse(routeBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(ROUTE, {
      chatTemplateKwargs: { enable_thinking: false }
    }).doGenerate(callOptions());

    expect(binding.calls[0].input).not.toHaveProperty("chat_template_kwargs");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "chat-template-kwargs" })
    );
  });

  it("works through generateText", async () => {
    const binding = fakeBinding(() => jsonResponse(routeBody));
    const ai = createAI({ binding: asAi(binding) });
    const { text } = await generateText({ model: ai(ROUTE), prompt: "hi" });
    expect(text).toBe("Hello from the route");
  });

  it("is a fallback leg, per model and per call", async () => {
    const binding = fakeBinding((call) =>
      call.model === ROUTE
        ? jsonResponse(routeBody)
        : jsonResponse(
            { errors: [{ code: 1, message: "nope" }] },
            { status: 500 }
          )
    );
    const ai = createAI({ binding: asAi(binding) });

    const perModel = await ai("@cf/zai-org/glm-4.7-flash", {
      fallback: [ROUTE]
    }).doGenerate(callOptions());
    const perCall = await ai("@cf/zai-org/glm-4.7-flash").doGenerate(
      callOptions({ providerOptions: { cloudflare: { fallback: [ROUTE] } } })
    );

    expect(binding.calls.map((call) => call.model)).toEqual([
      "@cf/zai-org/glm-4.7-flash",
      ROUTE,
      "@cf/zai-org/glm-4.7-flash",
      ROUTE
    ]);
    expect(perModel.content).toEqual(perCall.content);
  });

  it("resolves through languageModel, as a registry would", async () => {
    const binding = fakeBinding(() => jsonResponse(routeBody));
    const ai = createAI({ binding: asAi(binding) });
    const model = ai.languageModel(ROUTE as string);
    await model.doGenerate(callOptions());
    expect(binding.calls[0].model).toBe(ROUTE);
  });

  it("needs a route name", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => jsonResponse({}))) });
    expect(() => ai("dynamic/" as never)).toThrow(
      /not a model id this provider knows.*"dynamic\/<route>"/
    );
  });

  it("is not a fallback leg for the modality models", async () => {
    const binding = fakeBinding(() => jsonResponse({}));
    const ai = createAI({ binding: asAi(binding) });
    const MODEL = "@cf/baai/bge-base-en-v1.5";

    expect(() => ai.embedding(MODEL, { fallback: [ROUTE as never] })).toThrow(
      /dynamic route/
    );
    await expect(
      ai.embedding(MODEL).doEmbed({
        providerOptions: { cloudflare: { fallback: [ROUTE] } },
        values: ["hi"]
      })
    ).rejects.toThrow(/dynamic route/);
    expect(binding.calls).toHaveLength(0);
  });

  it("is not offered as an id where it would be refused", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => jsonResponse({}))) });
    let message = "";
    try {
      ai.embedding("@cf/baai/bge-base-en-v1.5", {
        fallback: ["openai/text-embedding-3-small" as never]
      });
    } catch (error) {
      message = (error as TypeError).message;
    }
    expect(message).toMatch(/not a Workers AI model id/);
    expect(message).not.toMatch(/dynamic/);
  });
});
