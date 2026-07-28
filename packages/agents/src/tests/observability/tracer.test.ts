import { describe, expect, it } from "vitest";
import {
  withInvocationScope,
  writeSpanAttributes
} from "../../observability/tracing/tracer";
import { deferred, RecordingTracer } from "./recording-tracer";

describe("createTracer", () => {
  describe("withSpan (managed lifetime)", () => {
    it("finishes a synchronously returned value and closes the span", () => {
      const tracing = new RecordingTracer();

      const value = tracing.withSpan("op", { a: 1 }, () => 42);

      expect(value).toBe(42);
      expect(tracing.rootSpans[0]?.attributes).toMatchObject({ a: 1 });
      expect(tracing.rootSpans[0]?.ended).toBe(true);
      expect(tracing.rootSpans[0]?.endCount).toBe(1);
    });

    it("finishes after an async result resolves", async () => {
      const tracing = new RecordingTracer();

      const value = await Promise.resolve(
        tracing.withSpan("op", {}, async () => "done")
      );

      expect(value).toBe("done");
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });

    it("keeps an invocation-bounded span open across an async handoff", async () => {
      const tracing = new RecordingTracer();
      const pending = deferred<string>();

      const result = await withInvocationScope(async () => {
        const value = tracing.withSpan(
          "op",
          {},
          async (span) => {
            const resolved = await pending.promise;
            span.finish({ late: resolved });
            return resolved;
          },
          { boundToInvocation: true }
        );

        // The handoff itself must not end the span: the work is still running
        // inside the invocation that owns it.
        expect(tracing.rootSpans[0]?.ended).toBe(false);
        pending.resolve("done");
        return value;
      });

      expect(result).toBe("done");
      expect(tracing.rootSpans[0]?.attributes).toMatchObject({ late: "done" });
      expect(tracing.rootSpans[0]?.ended).toBe(true);
      expect(tracing.rootSpans[0]?.endCount).toBe(1);
    });

    it("truncates an invocation-bounded span whose work outlives the scope", async () => {
      const tracing = new RecordingTracer();
      const pending = deferred<string>();

      const escaped = withInvocationScope(() => {
        const value = tracing.withSpan(
          "op",
          {},
          async (span) => {
            const resolved = await pending.promise;
            span.finish({ late: resolved });
            return resolved;
          },
          { boundToInvocation: true }
        );
        return { value };
      });

      expect(tracing.rootSpans[0]?.ended).toBe(true);
      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "cloudflare.agents.span.truncated": true
      });

      pending.resolve("done");
      await expect(escaped.value).resolves.toBe("done");
      // Work that finishes after the invocation cannot reopen the span.
      expect(tracing.rootSpans[0]?.attributes.late).toBeUndefined();
      expect(tracing.rootSpans[0]?.endCount).toBe(1);
    });

    it("closes a bounded span opened after its invocation already ended", async () => {
      const tracing = new RecordingTracer();
      const resumed = deferred();
      let escaped: Promise<void> | undefined;

      await withInvocationScope(async () => {
        // Started inside the scope but suspended past its end, so it resumes
        // still carrying this context — how work in a later invocation ends up
        // opening spans against an invocation that is already gone.
        escaped = (async () => {
          await resumed.promise;
          tracing.withSpan("late", {}, () => deferred<void>().promise, {
            boundToInvocation: true
          });
        })();
      });

      resumed.resolve();
      await escaped;

      const late = tracing.rootSpans.find((span) => span.name === "late");
      expect(late?.ended).toBe(true);
      expect(late?.attributes).toMatchObject({
        "cloudflare.agents.span.truncated": true
      });
    });

    it("starts a fresh boundary for work that opens a scope under an ended one", async () => {
      const tracing = new RecordingTracer();
      const resumed = deferred();
      const finishWork = deferred();
      let escaped: Promise<void> | undefined;

      await withInvocationScope(async () => {
        // The shape of a Think turn admitted from a timer: it resumes carrying
        // the context of the handler that armed it, long after that handler
        // returned, and declares its own boundary.
        escaped = (async () => {
          await resumed.promise;
          await withInvocationScope(async () => {
            const span = tracing.openSpan("turn", {}, (span) => span, {
              boundToInvocation: true
            });
            await finishWork.promise;
            span.finish({ "gen_ai.usage.input_tokens": 7 });
          });
        })();
      });

      resumed.resolve();
      await Promise.resolve();
      const span = tracing.rootSpans.find((s) => s.name === "turn");
      // Bound to the turn's own boundary, not truncated against the dead one.
      expect(span?.ended).toBe(false);

      finishWork.resolve();
      await escaped;

      expect(span?.attributes).toMatchObject({
        "gen_ai.usage.input_tokens": 7
      });
      expect(
        span?.attributes["cloudflare.agents.span.truncated"]
      ).toBeUndefined();
      expect(span?.ended).toBe(true);
    });

    it("does not cut detached work short when its caller's scope is still live", async () => {
      const tracing = new RecordingTracer();
      const finishWork = deferred();
      let detached: Promise<void> | undefined;

      // A handler that starts work and returns without awaiting it: the work
      // outlives the handler, so the handler's boundary is the wrong one.
      await withInvocationScope(async () => {
        detached = withInvocationScope(
          async () => {
            const span = tracing.openSpan("turn", {}, (span) => span, {
              boundToInvocation: true
            });
            await finishWork.promise;
            span.finish({ "gen_ai.usage.input_tokens": 11 });
          },
          { detached: true }
        );
      });

      const span = tracing.rootSpans.find((s) => s.name === "turn");
      expect(span?.ended).toBe(false);

      finishWork.resolve();
      await detached;

      expect(span?.attributes).toMatchObject({
        "gen_ai.usage.input_tokens": 11
      });
      expect(
        span?.attributes["cloudflare.agents.span.truncated"]
      ).toBeUndefined();
    });

    it("leaves invocation-bounded spans alone outside any scope", async () => {
      const tracing = new RecordingTracer();
      const pending = deferred<string>();

      const result = tracing.withSpan("op", {}, () => pending.promise, {
        boundToInvocation: true
      });

      expect(tracing.rootSpans[0]?.ended).toBe(false);
      pending.resolve("done");
      await expect(result).resolves.toBe("done");
      expect(tracing.rootSpans[0]?.ended).toBe(true);
      expect(
        tracing.rootSpans[0]?.attributes["cloudflare.agents.span.truncated"]
      ).toBeUndefined();
    });

    it("marks the span errored when the sync callback throws", () => {
      const tracing = new RecordingTracer();
      const cause = new TypeError("boom");

      expect(() =>
        tracing.withSpan("op", {}, () => {
          throw cause;
        })
      ).toThrow(cause);

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "error.type": "TypeError"
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.canceled"
      ]);
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });

    it("marks the span errored when the promise rejects", async () => {
      const tracing = new RecordingTracer();
      const cause = new Error("rejected");

      await expect(
        Promise.resolve(
          tracing.withSpan("op", {}, async () => {
            throw cause;
          })
        )
      ).rejects.toBe(cause);

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "error.type": "Error"
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "error.message"
      ]);
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
          })
        )
      ).rejects.toBeDefined();

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "cloudflare.agents.canceled": true
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "otel.status_code"
      ]);
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "error.type"
      ]);
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });

    it("classifies a non-Error AbortError-named cause as canceled", () => {
      const tracing = new RecordingTracer();

      const span = tracing.openSpan("op", {}, (span) => span);
      span.fail({ name: "AbortError" });

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "cloudflare.agents.canceled": true
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "otel.status_code"
      ]);
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "error.type"
      ]);
    });
  });

  describe("openSpan (caller-owned lifetime)", () => {
    it("keeps attributes written during activation on a span whose invocation ended", async () => {
      const tracing = new RecordingTracer();
      const resumed = deferred();
      let escaped: Promise<void> | undefined;

      await withInvocationScope(async () => {
        escaped = (async () => {
          await resumed.promise;
          // Opens with no attributes and writes them lazily, the way the AI
          // operation span stays cheap for untraced calls.
          tracing.openSpan(
            "late",
            {},
            (span) => {
              writeSpanAttributes(span, { "gen_ai.request.model": "m" });
            },
            { boundToInvocation: true }
          );
        })();
      });

      resumed.resolve();
      await escaped;

      const late = tracing.rootSpans.find((span) => span.name === "late");
      expect(late?.attributes).toMatchObject({
        "cloudflare.agents.span.truncated": true,
        "gen_ai.request.model": "m"
      });
      expect(late?.ended).toBe(true);
    });

    it("gives detached work its own boundary inside a live invocation", async () => {
      const tracing = new RecordingTracer();
      const detachedDone = deferred();
      let detached: Promise<void> | undefined;

      await withInvocationScope(async () => {
        // Started inside the handler but deliberately outliving it, the shape
        // of a ctx.waitUntil body or a queue drain.
        detached = withInvocationScope(
          async () => {
            const span = tracing.openSpan("detached", {}, (span) => span, {
              boundToInvocation: true
            });
            await detachedDone.promise;
            span.finish({ late: true });
          },
          { detached: true }
        );
      });

      // The handler has returned; the detached span must still be open.
      const span = tracing.rootSpans.find((s) => s.name === "detached");
      expect(span?.ended).toBe(false);

      detachedDone.resolve();
      await detached;

      expect(span?.attributes).toMatchObject({ late: true });
      expect(
        span?.attributes["cloudflare.agents.span.truncated"]
      ).toBeUndefined();
      expect(span?.ended).toBe(true);
    });

    it("returns the span without ending it until the caller finishes", () => {
      const tracing = new RecordingTracer();

      const span = tracing.openSpan("op", {}, (span) => span);
      expect(tracing.rootSpans[0]?.ended).toBe(false);

      span.finish({ ok: true });
      expect(tracing.rootSpans[0]?.attributes).toMatchObject({ ok: true });
      expect(tracing.rootSpans[0]?.ended).toBe(true);

      // finish/fail after closing are idempotent no-ops.
      span.finish();
      span.fail(new Error("late"));
      expect(tracing.rootSpans[0]?.endCount).toBe(1);
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "otel.status_code"
      ]);
    });

    it("fails the span when the activation callback throws, then rethrows", () => {
      const tracing = new RecordingTracer();
      const cause = new Error("activate failed");

      expect(() =>
        tracing.openSpan("op", {}, () => {
          throw cause;
        })
      ).toThrow(cause);

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "error.type": "Error"
      });
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });
  });

  it("skips attributes when the runtime is not tracing", () => {
    const tracing = new RecordingTracer({ isTraced: false });

    tracing.withSpan("op", { a: 1 }, () => undefined);

    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("a");
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });
});

function abortError(): unknown {
  const controller = new AbortController();
  controller.abort();
  return controller.signal.reason;
}
