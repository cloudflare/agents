import type { AISDKInstrumentationOptions } from "./options";
import { createAISDKWrapper } from "./wrapper/wrap";
import { tracer } from "../tracing/cloudflare";

/**
 * Wraps an AI SDK namespace with tracing.
 */
export function wrapAISDK<T extends Record<string, unknown>>(
  ai: T,
  options: AISDKInstrumentationOptions = {}
): T {
  return createAISDKWrapper(ai, {
    options,
    tracer
  });
}

export type {
  AISDKInstrumentationOptions,
  AISDKStorageOptions
} from "./options";
