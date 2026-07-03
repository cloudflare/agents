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

// Accessed via the namespace so runtimes that predate the `tracing` export
// degrade to a no-op tracer instead of failing at module-link time — this
// module loads with the main `agents` entry, not just for tracing users.
const runtime: SpanRuntime =
  (cloudflareWorkers as { tracing?: SpanRuntime }).tracing ?? noopRuntime;

export const tracer: AgentTracer = createTracer(runtime);
