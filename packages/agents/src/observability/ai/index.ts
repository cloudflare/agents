import type { AISDKInstrumentationOptions } from "./options";
import { createAISDKV6Wrapper } from "./v6/wrap";
import { createAISDKV7Telemetry } from "./v7/telemetry";
import type { AISDKV7Telemetry } from "./v7/types";
import { tracer } from "../tracing/cloudflare";

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
export function createAISDKTelemetry(): AISDKV7Telemetry {
  return createAISDKV7Telemetry({ tracer });
}

export type { AISDKInstrumentationOptions } from "./options";
