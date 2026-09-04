import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import { COMPAT_DIAGNOSTIC } from "../../../models/pi-ai/wires/shared";
import {
  anthropicModel,
  anthropicTextEvents,
  asAi,
  collectEvents,
  fakeBinding,
  field,
  groqModel,
  openaiModel,
  responsesTextStream,
  sseEventResponse,
  sseResponse,
  userContext,
  workersAITextStream
} from "./helpers";

/** A model whose host AI Gateway does not serve. */
function unroutedModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    api: "openai-completions",
    baseUrl: "https://api.example.invalid/v1",
    contextWindow: 8192,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: "house-model",
    input: ["text"],
    maxTokens: 1024,
    name: "House",
    provider: "acme",
    reasoning: false,
    ...overrides
  };
}

describe("pi-ai: ids this provider resolves", () => {
  it("resolves a <slug>/<id> id through pi-ai's gateway catalog", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding) });
    const model = ai("anthropic/claude-opus-4-8");
    // The registry's metadata, verbatim: the compat profile is why the request
    // below asks for adaptive thinking.
    expect(model.api).toBe("anthropic-messages");
    expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });

    await collectEvents(
      ai.streamSimple(model, userContext("hi"), { reasoning: "medium" })
    );
    const call = binding.universal[0];
    expect(call?.provider).toBe("anthropic");
    expect(call?.endpoint).toBe("v1/messages");
    // The vendor's own spelling travels in the body, not the catalog id.
    expect(field(call?.query, "model")).toBe("claude-opus-4-8");
    expect(field(call?.query, "thinking.type")).toBe("adaptive");
  });

  it("routes an openai catalog id to the Responses endpoint", async () => {
    const binding = fakeBinding(() => sseResponse(responsesTextStream()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(ai.stream(ai("openai/gpt-5.2"), userContext("hi")));
    expect(binding.universal[0]?.provider).toBe("openai");
    expect(binding.universal[0]?.endpoint).toBe("v1/responses");
    expect(field(binding.universal[0]?.query, "model")).toBe("gpt-5.2");
  });

  it("refuses an id pi-ai's gateway catalog does not list", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => new Response())) });
    expect(() => ai("anthropic/claude-nope")).toThrow(TypeError);
    expect(() => ai("anthropic/claude-nope")).toThrow(
      /not in pi-ai's Cloudflare AI Gateway catalog/
    );
  });

  it("refuses a bare vendor id and names the way in", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => new Response())) });
    expect(() => ai("gpt-5-mini")).toThrow(TypeError);
    expect(() => ai("gpt-5-mini")).toThrow(/getBuiltinModel/);
  });

  it("refuses a workers-ai/ prefix and points at the @cf/ id", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => new Response())) });
    expect(() => ai("workers-ai/@cf/zai-org/glm-4.7-flash")).toThrow(
      /pass its id directly/
    );
  });
});

describe("pi-ai: universal routing", () => {
  it("applies the flat gateway keys given to createAI", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding), cacheTtl: 60, id: "prod" });
    await collectEvents(
      ai.streamSimple(ai("anthropic/claude-opus-4-8"), userContext("hi"))
    );
    const call = binding.universal[0];
    expect(call?.gatewayId).toBe("prod");
    expect(call?.options.gateway).toMatchObject({ cacheTtl: 60, id: "prod" });
  });

  it("puts the gateway options on the call, not in the body", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({
      binding: asAi(binding),
      cacheTtl: 10,
      id: "prod",
      metadata: { app: "test" }
    });
    await collectEvents(
      ai.streamSimple(
        ai("anthropic/claude-opus-4-8", {
          cacheTtl: 60,
          headers: { "x-team": "growth" }
        }),
        userContext("hi"),
        { metadata: { user: "u1" } }
      )
    );
    const call = binding.universal[0];
    expect(call?.gatewayId).toBe("prod");
    expect(call?.options.gateway).toMatchObject({
      cacheTtl: 60,
      metadata: { app: "test", user: "u1" }
    });
    expect(call?.options.extraHeaders).toMatchObject({ "x-team": "growth" });
    expect(field(call?.query, "cacheTtl")).toBeUndefined();
  });

  it("fails the stream when AI Gateway serves no provider for the host", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(unroutedModel()), userContext("hi"))
    );
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(message.errorMessage).toContain("api.example.invalid");
    expect(binding.universal).toHaveLength(0);
  });

  it("names an API it cannot route", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(
        ai(unroutedModel({ api: "bedrock-converse-stream" })),
        userContext("hi")
      )
    );
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(message.errorMessage).toContain("bedrock-converse-stream");
  });
});

describe("pi-ai: the endpoint follows the vendor's own base URL", () => {
  it("strips a provider's own path prefix (groq)", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.stream(ai(groqModel("llama-3.1-8b-instant")), userContext("hi"))
    );
    const call = binding.universal[0];
    expect(call?.provider).toBe("groq");
    // `https://api.groq.com/openai/v1/chat/completions` minus groq's own base.
    expect(call?.endpoint).toBe("chat/completions");
  });

  it("keeps `v1/messages` and `v1/responses` for the vendors that use them", async () => {
    const binding = fakeBinding((call) =>
      call.kind === "universal" && call.endpoint === "v1/messages"
        ? sseEventResponse(anthropicTextEvents())
        : sseResponse(responsesTextStream())
    );
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.stream(ai(anthropicModel("claude-sonnet-4-5")), userContext("hi"))
    );
    await collectEvents(
      ai.stream(ai(openaiModel("gpt-5-mini")), userContext("hi"))
    );
    expect(binding.universal.map((call) => call.endpoint)).toEqual([
      "v1/messages",
      "v1/responses"
    ]);
  });
});

describe("pi-ai: a model that lost its symbol tags", () => {
  /** What DO storage or `Agent` state does to a model held in it. */
  const rehydrate = (model: Model<Api>): Model<Api> =>
    JSON.parse(JSON.stringify(model)) as Model<Api>;

  it("still sends the vendor's own spelling after a JSON round-trip", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.stream(rehydrate(ai("anthropic/claude-opus-4-8")), userContext("hi"))
    );
    const call = binding.universal[0];
    expect(call?.provider).toBe("anthropic");
    expect(call?.endpoint).toBe("v1/messages");
    expect(field(call?.query, "model")).toBe("claude-opus-4-8");
    expect(binding.universal).toHaveLength(1);
  });

  it("still sends the vendor's own spelling after structuredClone", async () => {
    const binding = fakeBinding(() => sseResponse(responsesTextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(structuredClone(ai("openai/gpt-5.2")), userContext("hi"))
    );
    const call = binding.universal[0];
    expect(call?.provider).toBe("openai");
    expect(call?.endpoint).toBe("v1/responses");
    expect(field(call?.query, "model")).toBe("gpt-5.2");
    // The specifier still reaches the diagnostics.
    expect(
      message.diagnostics?.find((d) => d.type === "cloudflare")?.details
    ).toMatchObject({ specifier: "openai/gpt-5.2" });
  });

  it("survives a round-trip through the pi-ai Models registry", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding) });
    const listed = ai.provider
      .getModels()
      .find((entry) => entry.id === "anthropic/claude-opus-4-8");
    expect(listed).toBeDefined();
    await collectEvents(
      ai.stream(rehydrate(listed as Model<Api>), userContext("hi"))
    );
    expect(field(binding.universal[0]?.query, "model")).toBe("claude-opus-4-8");
  });
});

describe("pi-ai: string legs and Workers AI knobs on vendor models", () => {
  it("resolves a string leg like ai(string): Workers AI or registry-known only", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => sseResponse([]))) });
    expect(() =>
      ai("@cf/zai-org/glm-4.7-flash", {
        fallback: ["anthropic/claude-opus-4-8"]
      })
    ).not.toThrow();
    expect(() =>
      ai("@cf/zai-org/glm-4.7-flash", { fallback: ["openai/gpt-5-mini"] })
    ).toThrow(TypeError);
    expect(() =>
      ai("@cf/zai-org/glm-4.7-flash", { fallback: ["gpt-5-mini"] })
    ).toThrow(TypeError);
  });

  it("records the Workers AI knobs an Anthropic model cannot take", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.streamSimple(
        ai(anthropicModel("claude-opus-4-8"), {
          chatTemplateKwargs: { enable_thinking: false },
          reasoningEffort: "low"
        }),
        userContext("hi")
      )
    );
    const body = binding.universal[0]?.query as Record<string, unknown>;
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("chat_template_kwargs");
    const diagnostic = message.diagnostics?.find(
      (d) => d.type === COMPAT_DIAGNOSTIC
    );
    const details = diagnostic?.details as
      | { warnings: { feature: string }[] }
      | undefined;
    expect(details?.warnings.map((w) => w.feature)).toEqual([
      "reasoning-effort",
      "chat-template-kwargs"
    ]);
  });
});
