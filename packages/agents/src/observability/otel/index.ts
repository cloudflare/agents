import * as cloudflareWorkers from "cloudflare:workers";
import { diag } from "@opentelemetry/api";
import { createOpenTelemetryBridge } from "./bridge";
import type { OpenTelemetryBridge } from "./bridge";
import { resolveNativeTracing } from "./native";
import { registerBridge } from "./register";

// Accessed via the namespace because this loads with the main `agents` entry,
// and runtimes can omit `tracing` or expose an older version of it.
const nativeTracing = resolveNativeTracing(
  (cloudflareWorkers as { tracing?: unknown }).tracing
);

let bridge: OpenTelemetryBridge | undefined;
/** Whether automatic registration has run (or can never run). */
let settled = false;

function register(): void {
  if (nativeTracing === undefined) {
    return;
  }
  bridge ??= createOpenTelemetryBridge({ tracing: nativeTracing });
  registerBridge(bridge);
}

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
 * The Agents SDK registers automatically when it records its first span, so
 * Workers that run Agents, Think, or `wrapAISDK` do not need this call. Call
 * it to record OpenTelemetry spans before or without any Agents SDK span.
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
  register();
}

/**
 * INTERNAL: registers the bridge the first time the Agents SDK records a span.
 * Agents SDK spans start in request handlers and Durable Object constructors,
 * after module evaluation, so an application's own module-scope OpenTelemetry
 * setup registers first and the bridge steps aside. (`getActiveSpan()` cannot
 * tell the two apart: it is `undefined` in Durable Object constructors too.)
 * Never throws: a partial setup is reported through `diag`.
 */
export function ensureOpenTelemetry(): void {
  if (settled) {
    return;
  }
  settled = true;
  if (nativeTracing === undefined) {
    return;
  }
  try {
    register();
  } catch (cause: unknown) {
    diag.error(
      `agents/observability: Agents SDK spans could not be connected to Workers tracing. ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}
