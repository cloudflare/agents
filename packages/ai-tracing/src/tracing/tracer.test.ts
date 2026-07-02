import { describe, expect, it } from "vitest";
import { RecordingTracer } from "../test-support/recording-tracer.js";

describe("createTracer", () => {
  describe("withSpan (managed lifetime)", () => {
    it("finishes a synchronously returned value and closes the span", () => {
      const tracing = new RecordingTracer();

      const value = tracing.withSpan("op", { "a": 1 }, () => 42);

      expect(value).toBe(42);
      expect(tracing.rootSpans[0]?.attributes).toMatchObject({ "a": 1 });
      expect(tracing.rootSpans[0]?.ended).toBe(true);
      expect(tracing.rootSpans[0]?.endCount).toBe(1);
    });

    it("finishes after an async result resolves", async () => {
      const tracing = new RecordingTracer();

      const value = await Promise.resolve(
        tracing.withSpan("op", {}, async () => "done"),
      );

      expect(value).toBe("done");
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });

    it("marks the span errored when the sync callback throws", () => {
      const tracing = new RecordingTracer();
      const cause = new TypeError("boom");

      expect(() =>
        tracing.withSpan("op", {}, () => {
          throw cause;
        }),
      ).toThrow(cause);

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "error": true,
        "error.type": "TypeError",
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("canceled");
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });

    it("marks the span errored when the promise rejects", async () => {
      const tracing = new RecordingTracer();
      const cause = new Error("rejected");

      await expect(
        Promise.resolve(
          tracing.withSpan("op", {}, async () => {
            throw cause;
          }),
        ),
      ).rejects.toBe(cause);

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "error": true,
        "error.type": "Error",
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("error.message");
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });
  });

  describe("cancellation classification", () => {
    it("records an aborted promise as canceled, not errored", async () => {
      const tracing = new RecordingTracer();

      await expect(
        Promise.resolve(
          tracing.withSpan("op", {}, async () => {
            throw abortError();
          }),
        ),
      ).rejects.toBeDefined();

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({ "canceled": true });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("error");
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("error.type");
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });

    it("classifies a non-Error AbortError-named cause as canceled", () => {
      const tracing = new RecordingTracer();

      const span = tracing.startSpan("op", {}, (span) => span);
      span.fail({ name: "AbortError" });

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({ "canceled": true });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("error");
    });
  });

  describe("startSpan (caller-owned lifetime)", () => {
    it("returns the span without ending it until the caller finishes", () => {
      const tracing = new RecordingTracer();

      const span = tracing.startSpan("op", {}, (span) => span);
      expect(tracing.rootSpans[0]?.ended).toBe(false);

      span.finish({ "ok": true });
      expect(tracing.rootSpans[0]?.attributes).toMatchObject({ "ok": true });
      expect(tracing.rootSpans[0]?.ended).toBe(true);

      // finish/fail after closing are idempotent no-ops.
      span.finish();
      span.fail(new Error("late"));
      expect(tracing.rootSpans[0]?.endCount).toBe(1);
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("error");
    });

    it("fails the span when the activation callback throws, then rethrows", () => {
      const tracing = new RecordingTracer();
      const cause = new Error("activate failed");

      expect(() =>
        tracing.startSpan("op", {}, () => {
          throw cause;
        }),
      ).toThrow(cause);

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "error": true,
        "error.type": "Error",
      });
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });
  });

  it("skips attributes when the runtime is not tracing", () => {
    const tracing = new RecordingTracer({ isTraced: false });

    tracing.withSpan("op", { "a": 1 }, () => undefined);

    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("a");
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });
});

function abortError(): unknown {
  const controller = new AbortController();
  controller.abort();
  return controller.signal.reason;
}
