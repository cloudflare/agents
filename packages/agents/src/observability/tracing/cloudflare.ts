import * as cloudflareWorkers from "cloudflare:workers";
import { createTracer } from "./tracer";
import type { SpanRuntime, SpanWriter, AgentTracer } from "./tracer";

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
const runtime = resolveCloudflareSpanRuntime(
  (cloudflareWorkers as { tracing?: unknown }).tracing
);

/** Selects native Cloudflare tracing or a no-op for unsupported runtimes. */
export function resolveCloudflareSpanRuntime(runtime: unknown): SpanRuntime {
  return isSpanRuntime(runtime) ? runtime : noopRuntime;
}

function isSpanRuntime(runtime: unknown): runtime is SpanRuntime {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    "startActiveSpan" in runtime &&
    typeof runtime.startActiveSpan === "function"
  );
}

export const tracer: AgentTracer = createTracer(runtime);
