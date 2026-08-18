import { describe, expect, it } from "vitest";
import { resolveCloudflareSpanRuntime } from "../../observability/tracing/cloudflare";
import { createTracer } from "../../observability/tracing/tracer";
import type { SpanRuntime } from "../../observability/tracing/tracer";

describe("resolveCloudflareSpanRuntime", () => {
  it("uses native tracing only when startActiveSpan is available", () => {
    let nativeTracingUsed = false;
    const nativeRuntime: SpanRuntime = {
      startActiveSpan(_name, run) {
        nativeTracingUsed = true;
        return run({
          isTraced: false,
          setAttribute() {},
          end() {}
        });
      }
    };

    createTracer(resolveCloudflareSpanRuntime(nativeRuntime)).withSpan(
      "operation",
      {},
      () => undefined
    );

    expect(nativeTracingUsed).toBe(true);

    const tracer = createTracer(
      resolveCloudflareSpanRuntime({
        enterSpan() {
          throw new Error("enterSpan should not be adapted");
        }
      })
    );

    expect(tracer.withSpan("operation", {}, () => "application result")).toBe(
      "application result"
    );
  });
});
