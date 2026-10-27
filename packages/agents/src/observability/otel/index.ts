import { diag } from "@opentelemetry/api";
import { nativeTracing } from "../tracing/cloudflare";
import { createOpenTelemetryBridge } from "./bridge";
import type { OpenTelemetryBridge } from "./bridge";
import { registerBridge } from "./register";

let bridge: OpenTelemetryBridge | undefined;

/**
 * Connects the OpenTelemetry API (`@opentelemetry/api`) to Workers tracing.
 * Call once at module scope:
 *
 * ```ts
 * import { registerOpenTelemetry } from "agents/observability";
 *
 * registerOpenTelemetry();
 * ```
 *
 * Afterwards, libraries instrumented with the OpenTelemetry API (the MCP SDK,
 * AI SDK telemetry, your own `trace.getTracer(...)` spans) record native
 * Workers spans. They nest with the Agents SDK's spans and the automatic
 * fetch, KV, D1 and Durable Object spans, and export through
 * `observability.traces.destinations`. Enable `observability.traces` in your
 * Wrangler configuration for anything to be recorded.
 *
 * Safe to call more than once. When OpenTelemetry is already fully registered,
 * by your own SDK setup or natively by the Workers runtime, this leaves it in
 * place and does nothing. Throws when only part of an OpenTelemetry setup is
 * registered.
 *
 * @see https://github.com/cloudflare/agents/blob/main/docs/agents/observability.md#opentelemetry
 */
export function registerOpenTelemetry(): void {
  if (nativeTracing === undefined) {
    diag.warn(
      "agents/observability: this runtime has no native tracing; registerOpenTelemetry() did nothing."
    );
    return;
  }
  bridge ??= createOpenTelemetryBridge({ tracing: nativeTracing });
  registerBridge(bridge);
}
