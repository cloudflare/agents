import * as cloudflareWorkers from "cloudflare:workers";
import { createTracer } from "./tracer";
import type { SpanRuntime, SpanWriter, AgentTracer } from "./tracer";
import { resolveNativeTracing } from "./native";
import type { NativeTracing } from "./native";

const noopSpan: SpanWriter = {
  isTraced: false,
  setAttribute() {},
  end() {}
};

const noopRuntime: SpanRuntime = {
  startActiveSpan(_name, run) {
    return run(noopSpan);
  }
};

// Accessed via the namespace because this loads with the main `agents` entry.
// Runtimes can omit `tracing` or expose it without `startActiveSpan`; both
// degrade to no-op tracing instead of breaking Agent behavior.
const workersTracing = (cloudflareWorkers as { tracing?: unknown }).tracing;
const runtime = resolveCloudflareSpanRuntime(workersTracing);

/** Selects native Cloudflare tracing or a no-op for unsupported runtimes. */
export function resolveCloudflareSpanRuntime(runtime: unknown): SpanRuntime {
  const candidate = runtime as Partial<SpanRuntime> | null | undefined;
  return typeof candidate?.startActiveSpan === "function"
    ? (candidate as SpanRuntime)
    : noopRuntime;
}

export const tracer: AgentTracer = createTracer(runtime);

/**
 * Workers native tracing, when the runtime can carry the OpenTelemetry bridge
 * (`startActiveSpan` and `getActiveSpan`). `undefined` on older runtimes.
 */
export const nativeTracing: NativeTracing | undefined =
  resolveNativeTracing(workersTracing);
