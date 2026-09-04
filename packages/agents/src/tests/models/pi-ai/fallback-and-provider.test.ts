import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_AI_API,
  CLOUDFLARE_PROVIDER_ID,
  FALLBACK_DIAGNOSTIC,
  createAI
} from "../../../models/pi-ai";
import {
  anthropicModel,
  anthropicTextEvents,
  asAi,
  billingError,
  collectEvents,
  fakeBinding,
  field,
  jsonResponse,
  openaiModel,
  sseEventResponse,
  sseResponse,
  userContext,
  workersAITextStream
} from "./helpers";

const WORKERS_AI = "@cf/zai-org/glm-4.7-flash";

describe("pi-ai: fallback", () => {
  it("falls through from a vendor model to a Workers AI leg", async () => {
    const binding = fakeBinding((call) =>
      call.kind === "universal"
        ? jsonResponse(billingError(), { status: 402 })
        : sseResponse(workersAITextStream())
    );
    const ai = createAI({ binding: asAi(binding) });
    const model = ai(openaiModel("gpt-5-mini"), {
      fallback: [WORKERS_AI],
      metadata: { tenant: "t1" }
    });
    const { events, message } = await collectEvents(
      ai.stream(model, userContext("hi"))
    );

    expect(binding.universal.map((c) => c.provider)).toEqual(["openai"]);
    expect(binding.calls.map((c) => c.model)).toEqual([WORKERS_AI]);
    // The fallback leg keeps the shared options.
    expect(binding.calls[0]?.options.gateway).toMatchObject({
      metadata: { tenant: "t1" }
    });
    expect(events[0]?.type).toBe("start");
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(message.model).toBe(WORKERS_AI);
    expect(message.content).toContainEqual({
      text: "Hello there",
      type: "text"
    });
    expect(
      message.diagnostics?.find((d) => d.type === FALLBACK_DIAGNOSTIC)?.details
    ).toMatchObject({ attempts: [{ model: "gpt-5-mini" }] });
  });

  it("accepts a model object as a fallback leg too", async () => {
    const binding = fakeBinding((call, index) =>
      index === 0
        ? jsonResponse(billingError(), { status: 402 })
        : sseEventResponse(anthropicTextEvents())
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(
        ai(openaiModel("gpt-5-mini"), {
          fallback: [anthropicModel("claude-sonnet-4-5")]
        }),
        userContext("hi")
      )
    );
    expect(binding.universal.map((c) => c.provider)).toEqual([
      "openai",
      "anthropic"
    ]);
    expect(binding.universal[1]?.endpoint).toBe("v1/messages");
    expect(message.model).toBe("claude-sonnet-4-5");
    expect(message.content).toContainEqual({ text: "Hi there!", type: "text" });
  });

  it("prices a leg's answer with the leg's own cost, not the chain's", async () => {
    const binding = fakeBinding((call, index) =>
      index === 0
        ? jsonResponse(billingError(), { status: 402 })
        : sseResponse(workersAITextStream())
    );
    const ai = createAI({ binding: asAi(binding) });
    // The metadata overrides describe the model they were written on. A leg
    // has its own registry entry, and its usage must be billed at its prices.
    const model = ai("@cf/openai/gpt-oss-120b", {
      contextWindow: 999_999,
      cost: { cacheRead: 0, cacheWrite: 0, input: 999, output: 999 },
      fallback: [WORKERS_AI],
      name: "Primary"
    });
    const message = await ai.completeSimple(model, userContext("hi"));

    expect(message.model).toBe(WORKERS_AI);
    const legCost = ai(WORKERS_AI).cost;
    expect(message.usage.cost.input).toBeCloseTo(
      (legCost.input * message.usage.input) / 1_000_000,
      12
    );
    expect(message.usage.cost.output).toBeCloseTo(
      (legCost.output * message.usage.output) / 1_000_000,
      12
    );
    // $999/M would put this in the dollars; the leg's own prices are cents.
    expect(message.usage.cost.total).toBeLessThan(0.01);
  });

  it("sends the chain's gateway to a leg that named its own", async () => {
    const binding = fakeBinding((call) =>
      call.kind === "universal"
        ? jsonResponse(billingError(), { status: 402 })
        : sseResponse(workersAITextStream())
    );
    const ai = createAI({ binding: asAi(binding) });
    const leg = ai(WORKERS_AI, {
      cacheTtl: 0,
      headers: { "x-leg": "yes" },
      id: "cheap",
      metadata: { leg: "yes" }
    });

    await ai.completeSimple(
      ai(openaiModel("gpt-5-mini"), {
        cacheTtl: 60,
        fallback: [leg],
        id: "prod",
        metadata: { chain: "yes" }
      }),
      userContext("hi")
    );

    // A chain and its legs travel through one gateway: the chain's wins, and
    // the metadata of both is on the log entry.
    expect(binding.calls[0]?.options.gateway).toMatchObject({
      cacheTtl: 60,
      id: "prod",
      metadata: { chain: "yes", leg: "yes" }
    });
    // Everything else the leg was built with is still the leg's own.
    expect(binding.calls[0]?.options.extraHeaders).toMatchObject({
      "x-leg": "yes"
    });
  });

  it("reports the last error when every leg fails", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(billingError(), { status: 402 })
    );
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(
        ai(openaiModel("gpt-5-mini"), { fallback: [WORKERS_AI] }),
        userContext("hi")
      )
    );
    expect(binding.universal).toHaveLength(1);
    expect(binding.calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(message.stopReason).toBe("error");
    expect(
      message.diagnostics?.find((d) => d.type === FALLBACK_DIAGNOSTIC)?.details
    ).toMatchObject({ attempts: [{ model: "gpt-5-mini" }] });
  });
});

describe("pi-ai: models and the provider", () => {
  it("builds a Workers AI model with registry metadata when known", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => new Response())) });
    const model = ai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(model.api).toBe(CLOUDFLARE_AI_API);
    expect(model.provider).toBe(CLOUDFLARE_PROVIDER_ID);
    expect(model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.cost.input).toBeGreaterThan(0);
    // Options never leak into JSON.
    expect(JSON.stringify(model)).not.toContain("fallback");
  });

  it("falls back to usable defaults for an unlisted @cf/ id", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => new Response())) });
    const unknown = ai("@cf/acme/brand-new-model");
    expect(unknown.contextWindow).toBe(128000);
    expect(unknown.input).toEqual(["text"]);
    const tuned = ai("@cf/acme/brand-new-model", {
      contextWindow: 4096,
      name: "Acme",
      reasoning: false
    });
    expect(tuned).toMatchObject({
      contextWindow: 4096,
      name: "Acme",
      reasoning: false
    });
  });

  it("keeps a caller's model object untouched", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => new Response())) });
    const source = anthropicModel("claude-opus-4-8");
    const wrapped = ai(source, { cacheTtl: 30 });
    expect(wrapped).not.toBe(source);
    expect(Object.keys(source)).not.toContain("cacheTtl");
    expect(wrapped).toMatchObject({
      api: "anthropic-messages",
      baseUrl: source.baseUrl,
      compat: source.compat,
      cost: source.cost,
      id: "claude-opus-4-8",
      provider: "anthropic",
      thinkingLevelMap: source.thinkingLevelMap
    });
    expect(JSON.stringify(wrapped)).not.toContain("cacheTtl");
  });

  it("lists Workers AI ids and pi's gateway catalog on the provider", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const models = createModels();
    models.setProvider(ai.provider);

    expect(ai.provider.id).toBe("cloudflare");
    const ids = ai.provider.getModels().map((entry) => entry.id);
    expect(ids).toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(ids).toContain("anthropic/claude-opus-4-8");
    expect(ids).toContain("openai/gpt-5.2");
    // `/compat` entries alias Workers AI ids; they stay on the run path.
    expect(ids.some((id) => id.startsWith("workers-ai/"))).toBe(false);
    expect(
      models.getModel("cloudflare", "anthropic/claude-opus-4-8")
    ).toBeDefined();

    const message = await models
      .streamSimple(ai(WORKERS_AI), userContext("hi"))
      .result();
    expect(message.content).toContainEqual({
      text: "Hello there",
      type: "text"
    });
    expect(binding.calls).toHaveLength(1);
  });

  it("carries the gateway settings onto the Workers AI run call", async () => {
    const binding = fakeBinding(() =>
      sseResponse(workersAITextStream(), {
        headers: { "cf-aig-log-id": "run-log" }
      })
    );
    const ai = createAI({
      binding: asAi(binding),
      cacheTtl: 30,
      id: "gw"
    });
    const message = await ai.completeSimple(ai(WORKERS_AI), userContext("hi"));
    const call = binding.calls[0];
    expect(call?.model).toBe(WORKERS_AI);
    expect(call?.options.gateway).toMatchObject({ cacheTtl: 30, id: "gw" });
    expect(field(call?.input, "stream")).toBe(true);
    expect(message.content).toContainEqual({
      text: "Hello there",
      type: "text"
    });
    expect(
      message.diagnostics?.find((d) => d.type === "cloudflare")?.details
    ).toMatchObject({ logId: "run-log" });
  });
});
