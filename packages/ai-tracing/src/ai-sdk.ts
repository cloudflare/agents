import type { AISDKInstrumentationOptions } from "./adapters/ai-sdk/options.js";
import { createAISDKV6Wrapper } from "./adapters/ai-sdk/v6/wrap.js";
import { createAISDKV7Telemetry } from "./adapters/ai-sdk/v7/telemetry.js";
import type { AISDKV7Telemetry } from "./adapters/ai-sdk/v7/types.js";
import { tracer } from "./tracing/cloudflare.js";

/**
 * Wraps an AI SDK namespace with tracing.
 */
export function wrapAISDK<T extends Record<string, unknown>>(
  ai: T,
  options: AISDKInstrumentationOptions = {}
): T {
  return createAISDKV6Wrapper(ai, {
    options,
    tracer
  });
}

/**
 * Creates an AI SDK v7 telemetry adapter for use with `registerTelemetry` or
 * per-call telemetry configuration.
 */
export function createAISDKTelemetry(
  options: AISDKInstrumentationOptions = {}
): AISDKV7Telemetry {
  return createAISDKV7Telemetry({
    options,
    tracer
  });
}

export type { AISDKV7Telemetry } from "./adapters/ai-sdk/v7/types.js";
