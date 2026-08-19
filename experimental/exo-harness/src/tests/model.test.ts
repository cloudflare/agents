import { describe, expect, it } from "vitest";
import {
  createBindingRunFetch,
  openaiResponsesModelId,
  parseJsonRequestBody,
  parseModelSpec,
  publicModelError
} from "../kernel/model";

describe("parseModelSpec", () => {
  it("accepts the offline mock driver", () => {
    expect(parseModelSpec("mock")).toEqual({ kind: "mock" });
  });

  it("keeps the workers-ai: prefix as a Workers AI id", () => {
    expect(parseModelSpec("workers-ai:@cf/moonshotai/kimi-k2.7-code")).toEqual({
      kind: "workers-ai",
      id: "@cf/moonshotai/kimi-k2.7-code"
    });
  });

  it("treats a bare @cf/ id as Workers AI, not a catalog slug", () => {
    expect(parseModelSpec("@cf/moonshotai/kimi-k2.7-code")).toEqual({
      kind: "workers-ai",
      id: "@cf/moonshotai/kimi-k2.7-code"
    });
  });

  it("accepts AI Gateway catalog slugs", () => {
    expect(parseModelSpec("openai/gpt-5.4")).toEqual({
      kind: "catalog",
      slug: "openai/gpt-5.4"
    });
    expect(parseModelSpec("anthropic/claude-sonnet-4-5")).toEqual({
      kind: "catalog",
      slug: "anthropic/claude-sonnet-4-5"
    });
  });

  it("accepts provider:model as a catalog slug", () => {
    expect(parseModelSpec("openai:gpt-5.4")).toEqual({
      kind: "catalog",
      slug: "openai/gpt-5.4"
    });
  });

  it("rejects empty and unknown shapes", () => {
    expect(() => parseModelSpec("")).toThrow(/empty/);
    expect(() => parseModelSpec("workers-ai:")).toThrow(/empty/);
    expect(() => parseModelSpec("gpt-5.4")).toThrow(/Unknown model/);
  });
});

describe("openaiResponsesModelId", () => {
  it("strips the openai/ prefix for Responses-API catalog slugs", () => {
    expect(openaiResponsesModelId("openai/gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(openaiResponsesModelId("anthropic/claude-sonnet-4-5")).toBeNull();
    expect(openaiResponsesModelId("openai/")).toBeNull();
  });
});

describe("publicModelError", () => {
  it("returns a one-line message without stacking", () => {
    expect(publicModelError(new Error("Invalid input\n    at foo"))).toBe(
      "Invalid input"
    );
    expect(publicModelError("plain")).toBe("plain");
  });
});

describe("parseJsonRequestBody", () => {
  it("parses string and byte bodies", () => {
    expect(parseJsonRequestBody('{"input":"hi"}')).toEqual({ input: "hi" });
    expect(
      parseJsonRequestBody(new TextEncoder().encode('{"n":1}'))
    ).toEqual({ n: 1 });
    expect(parseJsonRequestBody(undefined)).toEqual({});
  });
});

describe("createBindingRunFetch", () => {
  it("forwards the Responses body to env.AI.run on the Unified Billing path", async () => {
    const calls: {
      model: string;
      inputs: Record<string, unknown>;
      options: Record<string, unknown> | undefined;
    }[] = [];
    const fetchImpl = createBindingRunFetch({
      slug: "openai/gpt-5.6-luna",
      gateway: "exo-harness",
      binding: {
        async run(model, inputs, options) {
          calls.push({ model, inputs, options });
          return new Response(JSON.stringify({ id: "resp_test" }), {
            status: 200
          });
        }
      }
    });

    const resp = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        input: "pong",
        max_output_tokens: 16,
        stream: true
      })
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ id: "resp_test" });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("openai/gpt-5.6-luna");
    expect(calls[0].inputs).toEqual({
      input: "pong",
      max_output_tokens: 16,
      stream: true
    });
    expect(calls[0].options).toEqual({
      gateway: { id: "exo-harness" },
      returnRawResponse: true
    });
  });
});
