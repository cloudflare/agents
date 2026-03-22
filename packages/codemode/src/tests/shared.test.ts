/**
 * Tests for the shared module (constants and helpers used by both
 * AI SDK and TanStack AI entry points).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_DESCRIPTION, normalizeProviders } from "../shared";
import type { ToolProvider, SimpleToolRecord } from "../executor";

describe("DEFAULT_DESCRIPTION", () => {
  it("should contain the {{types}} placeholder", () => {
    expect(DEFAULT_DESCRIPTION).toContain("{{types}}");
  });

  it("should instruct the LLM to write arrow functions", () => {
    expect(DEFAULT_DESCRIPTION).toContain("async arrow function");
  });
});

describe("normalizeProviders", () => {
  it("should wrap a plain tool record as a single default provider", () => {
    const tools: SimpleToolRecord = {
      myTool: {
        description: "Test",
        execute: async () => ({})
      }
    };

    const providers = normalizeProviders(tools);

    expect(providers).toHaveLength(1);
    expect(providers[0].tools).toBe(tools);
    expect(providers[0].name).toBeUndefined();
  });

  it("should pass through an array of ToolProviders unchanged", () => {
    const providerA: ToolProvider = {
      name: "a",
      tools: {
        toolA: {
          description: "A",
          execute: async () => ({})
        }
      } as SimpleToolRecord
    };
    const providerB: ToolProvider = {
      name: "b",
      tools: {
        toolB: {
          description: "B",
          execute: async () => ({})
        }
      } as SimpleToolRecord
    };

    const providers = normalizeProviders([providerA, providerB]);

    expect(providers).toHaveLength(2);
    expect(providers[0]).toBe(providerA);
    expect(providers[1]).toBe(providerB);
  });

  it("should handle empty array", () => {
    const providers = normalizeProviders([]);
    expect(providers).toEqual([]);
  });
});
