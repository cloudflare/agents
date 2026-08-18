import { describe, expect, it } from "vitest";
import {
  openaiResponsesModelId,
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
