import type {
  AISDKInstrumentationOptions,
  ContentRecordingOptions
} from "./options";
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
 *
 * `options.recordInputs`/`recordOutputs` opt in to recording raw prompts,
 * messages, and tool inputs/outputs on the spans. Both default to `false`
 * because that content is potentially PII; leave them unset for
 * metadata-only spans.
 */
export function createAISDKTelemetry(
  options: ContentRecordingOptions = {}
): AISDKV7Telemetry {
  return createAISDKV7Telemetry({ options, tracer });
}

export type {
  AISDKInstrumentationOptions,
  ContentRecordingOptions
} from "./options";
