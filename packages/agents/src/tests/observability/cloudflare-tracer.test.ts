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

  it("fails spans on runtimes without setStatus, and when setStatus throws", () => {
    for (const setStatus of [
      undefined,
      () => {
        throw new TypeError("rejected");
      }
    ]) {
      const ended: string[] = [];
      const tracer = createTracer({
        startActiveSpan: (name, run) =>
          run({
            isTraced: true,
            setAttribute() {},
            end: () => ended.push(name),
            ...(setStatus === undefined ? {} : { setStatus })
          })
      });
      const failure = new Error("application failure");

      expect(() =>
        tracer.withSpan("operation", {}, () => {
          throw failure;
        })
      ).toThrow(failure);
      expect(ended).toEqual(["operation"]);
    }
  });
});
