import { describe, expect, it } from "vitest";
import { resolveCloudflareSpanRuntime } from "../../observability/tracing/cloudflare";
import { createTracer } from "../../observability/tracing/tracer";

describe("resolveCloudflareSpanRuntime", () => {
  it("uses native tracing only when startActiveSpan is available", () => {
    const nativeRuntime = { startActiveSpan() {} };
    expect(resolveCloudflareSpanRuntime(nativeRuntime)).toBe(nativeRuntime);

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
