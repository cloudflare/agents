import type {
  AISDKInstrumentationOptions,
  AISDKStorageOptions
} from "./options";
import { createAISDKV6Wrapper } from "./v6/wrap";
import { createAISDKV7Telemetry } from "./v7/telemetry";
import type { AISDKV7Telemetry } from "./v7/types";
import { tracer } from "../tracing/cloudflare";

const agentsAISDKTelemetryBrand = Symbol.for(
  "cloudflare.agents.ai-sdk-telemetry"
);

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
  options: AISDKStorageOptions = {}
): AISDKV7Telemetry {
  const telemetry = createAISDKV7Telemetry({ options, tracer });
  Object.defineProperty(telemetry, agentsAISDKTelemetryBrand, { value: true });
  return telemetry;
}

export type {
  AISDKInstrumentationOptions,
  AISDKStorageOptions
} from "./options";
