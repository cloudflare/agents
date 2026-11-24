import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import {
  CloudflareAIError as CoreCloudflareAIError,
  normalizeThrownError
} from "../../models/core/errors";
import { CloudflareAIError } from "../../models/ai-sdk/errors";
import { classifyProviderError } from "../provider-errors";

const call = (statusCode: number | undefined, message: string, body?: string) =>
  new APICallError({
    message,
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode,
    responseBody: body
  });

describe("classifyProviderError", () => {
  it("reads an OpenAI context-length error as an overflow", () => {
    expect(
      classifyProviderError(
        call(
          400,
          "This model's maximum context length is 128000 tokens.",
          '{"error":{"code":"context_length_exceeded"}}'
        )
      )
    ).toBe("context_overflow");
  });

  it("reads an Anthropic prompt-too-long error as an overflow", () => {
    expect(
      classifyProviderError(
        call(400, "prompt is too long: 210000 tokens > 200000 maximum")
      )
    ).toBe("context_overflow");
  });

  it("reads an overflow in the response body, and one with no status", () => {
    expect(
      classifyProviderError(
        call(413, "Request failed", '{"message":"input is too long"}')
      )
    ).toBe("context_overflow");
    expect(
      classifyProviderError(new Error("Input token count exceeds the limit"))
    ).toBe("context_overflow");
  });

  it("reads a 429 from AI Gateway or a provider as a rate limit", () => {
    const gateway = new CoreCloudflareAIError({
      message: "Too many requests",
      model: "@cf/meta/llama",
      url: "gateway",
      requestBodyValues: {},
      status: 429,
      code: "rate-limit",
      responseHeaders: { "retry-after": "2" }
    });
    expect(classifyProviderError(gateway)).toBe("rate_limit");
    expect(classifyProviderError(CloudflareAIError.fromCore(gateway))).toBe(
      "rate_limit"
    );
    expect(classifyProviderError(call(429, "Rate limit reached"))).toBe(
      "rate_limit"
    );
  });

  it("reads a Workers AI capacity error as a rate limit", () => {
    // The binding throws `3040: Capacity temporarily exceeded`, which
    // `normalizeThrownError` maps to a 429.
    const capacity = normalizeThrownError(
      new Error("3040: Capacity temporarily exceeded, please try again."),
      { model: "@cf/meta/llama", url: "binding", requestBodyValues: {} }
    );
    expect(classifyProviderError(capacity)).toBe("rate_limit");
  });

  it("reads 5xx, 529, 408 and an in-stream overload as transient", () => {
    expect(classifyProviderError(call(503, "Service unavailable"))).toBe(
      "transient"
    );
    expect(classifyProviderError(call(529, "Overloaded"))).toBe("transient");
    expect(classifyProviderError(call(408, "Request timeout"))).toBe(
      "transient"
    );
    // Anthropic's in-stream error part, with no HTTP status.
    expect(
      classifyProviderError({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" }
      })
    ).toBe("transient");
  });

  it("reads a wrapper whose last error points back at itself without looping", () => {
    const circular: { message: string; lastError?: unknown } = {
      message: "retries ran out"
    };
    circular.lastError = circular;
    expect(classifyProviderError(circular)).toBeUndefined();
  });

  it("reads an AI SDK RetryError by its last error", () => {
    const exhausted = new RetryError({
      message: "Failed after 3 attempts.",
      reason: "maxRetriesExceeded",
      errors: [call(429, "Rate limit"), call(503, "Unavailable")]
    });
    expect(classifyProviderError(exhausted)).toBe("transient");
  });

  it("says nothing about an error it cannot act on", () => {
    expect(classifyProviderError(call(401, "Invalid API key"))).toBeUndefined();
    expect(classifyProviderError(call(400, "Bad tool schema"))).toBeUndefined();
    expect(classifyProviderError(new Error("boom"))).toBeUndefined();
    // An overflow-sounding message at a server error is a server error.
    expect(classifyProviderError(call(500, "context window broke"))).toBe(
      "transient"
    );
  });
});
