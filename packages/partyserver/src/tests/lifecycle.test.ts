import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DurableObjectLifecycle,
  type DurableObjectLifecycleComponent
} from "../durable-object-lifecycle";
import worker from "./worker";

describe("DurableObjectLifecycle", () => {
  it("starts components sequentially in declaration order", async () => {
    const calls: string[] = [];
    const lifecycle = new DurableObjectLifecycle<{ label: string }>(() => [
      {
        async onStart() {
          calls.push("first:start");
          await Promise.resolve();
          calls.push("first:end");
        }
      },
      {
        onStart(context) {
          calls.push(`second:${context.props?.label}`);
        }
      }
    ]);

    await lifecycle.start({ props: { label: "ready" } });

    expect(calls).toEqual(["first:start", "first:end", "second:ready"]);
  });

  it("shares one startup attempt between concurrent callers", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let starts = 0;
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        async onStart() {
          starts++;
          started.resolve();
          await release.promise;
        }
      }
    ]);

    const first = lifecycle.start({ props: undefined });
    await started.promise;
    const second = lifecycle.start({ props: undefined });
    release.resolve();
    await Promise.all([first, second]);

    expect(starts).toBe(1);
  });

  it("retries the complete startup phase after a failure", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const expected = new Error("not ready");
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        onStart() {
          calls.push("first");
        }
      },
      {
        onStart() {
          attempts++;
          calls.push(`second:${attempts}`);
          if (attempts === 1) throw expected;
        }
      }
    ]);

    await expect(lifecycle.start({ props: undefined })).rejects.toBe(expected);
    await lifecycle.start({ props: undefined });

    expect(calls).toEqual(["first", "second:1", "first", "second:2"]);
  });

  it("resolves components lazily and retains the resolved collection", async () => {
    const calls: string[] = [];
    let current: DurableObjectLifecycleComponent = {
      onStart() {
        calls.push("initial");
      },
      onAlarm() {
        calls.push("initial:alarm");
      }
    };
    const lifecycle = new DurableObjectLifecycle(() => [current]);

    current = {
      onStart() {
        calls.push("replacement");
      },
      onAlarm() {
        calls.push("replacement:alarm");
      }
    };
    await lifecycle.start({ props: undefined });

    current = {
      onAlarm() {
        calls.push("late:alarm");
      }
    };
    await lifecycle.alarm();

    expect(calls).toEqual(["replacement", "replacement:alarm"]);
  });

  it("returns the first request response and stops dispatching", async () => {
    const calls: string[] = [];
    const expected = new Response("handled");
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        onRequest() {
          calls.push("miss");
          return undefined;
        }
      },
      {
        onRequest(context) {
          calls.push(context.request.url);
          return expected;
        }
      },
      {
        onRequest() {
          calls.push("too-late");
          return new Response("wrong");
        }
      }
    ]);
    await lifecycle.start({ props: undefined });

    const request = new Request("https://example.com/callback");
    const response = await lifecycle.request({ request });

    expect(response).toBe(expected);
    expect(calls).toEqual(["miss", request.url]);
  });

  it("runs every alarm hook in declaration order", async () => {
    const calls: string[] = [];
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        onAlarm() {
          calls.push("first");
        }
      },
      {
        async onAlarm() {
          await Promise.resolve();
          calls.push("second");
        }
      }
    ]);
    await lifecycle.start({ props: undefined });

    await lifecycle.alarm();

    expect(calls).toEqual(["first", "second"]);
  });

  it("requires startup before request and alarm phases", async () => {
    const lifecycle = new DurableObjectLifecycle(() => []);

    await expect(
      lifecycle.request({ request: new Request("https://example.com") })
    ).rejects.toThrow("before the Durable Object lifecycle has started");
    await expect(lifecycle.alarm()).rejects.toThrow(
      "before the Durable Object lifecycle has started"
    );
  });

  it("disposes components in reverse order exactly once", async () => {
    const calls: string[] = [];
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        onDispose() {
          calls.push("first");
        }
      },
      {
        onDispose() {
          calls.push("second");
        }
      }
    ]);
    await lifecycle.start({ props: undefined });

    await Promise.all([lifecycle.dispose(), lifecycle.dispose()]);

    expect(calls).toEqual(["second", "first"]);
  });

  it("rethrows a single disposal failure after every component runs", async () => {
    const calls: string[] = [];
    const expected = new Error("dispose failed");
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        onDispose() {
          calls.push("first");
        }
      },
      {
        onDispose() {
          calls.push("second");
          throw expected;
        }
      }
    ]);

    await expect(lifecycle.dispose()).rejects.toBe(expected);
    expect(calls).toEqual(["second", "first"]);
  });

  it("disposes every component and aggregates multiple failures", async () => {
    const calls: string[] = [];
    const first = new Error("first failed");
    const second = new Error("second failed");
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        onDispose() {
          calls.push("first");
          throw first;
        }
      },
      {
        onDispose() {
          calls.push("second");
          throw second;
        }
      },
      {
        onDispose() {
          calls.push("third");
        }
      }
    ]);

    let thrown: unknown;
    try {
      await lifecycle.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual(["third", "second", "first"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) {
      throw new Error("Expected AggregateError");
    }
    expect(thrown.errors).toEqual([second, first]);
  });

  it("disposes components after a partial startup failure", async () => {
    const calls: string[] = [];
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        onStart() {
          calls.push("first:start");
        },
        onDispose() {
          calls.push("first:dispose");
        }
      },
      {
        onStart() {
          calls.push("second:start");
          throw new Error("startup failed");
        },
        onDispose() {
          calls.push("second:dispose");
        }
      }
    ]);

    await expect(lifecycle.start({ props: undefined })).rejects.toThrow(
      "startup failed"
    );
    await lifecycle.dispose();

    expect(calls).toEqual([
      "first:start",
      "second:start",
      "second:dispose",
      "first:dispose"
    ]);
  });

  it("rejects work that was waiting for startup when disposal begins", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lifecycle = new DurableObjectLifecycle(() => [
      {
        async onStart() {
          started.resolve();
          await release.promise;
        }
      }
    ]);

    const startup = lifecycle.start({ props: undefined });
    await started.promise;
    const request = lifecycle.request({
      request: new Request("https://example.com")
    });
    const disposal = lifecycle.dispose();
    release.resolve();

    await startup;
    await expect(request).rejects.toThrow("disposed Durable Object lifecycle");
    await disposal;
  });

  it("rejects work after disposal", async () => {
    const lifecycle = new DurableObjectLifecycle(() => []);
    await lifecycle.start({ props: undefined });
    await lifecycle.dispose();

    await expect(lifecycle.start({ props: undefined })).rejects.toThrow(
      "disposed Durable Object lifecycle"
    );
    await expect(
      lifecycle.request({ request: new Request("https://example.com") })
    ).rejects.toThrow("disposed Durable Object lifecycle");
    await expect(lifecycle.alarm()).rejects.toThrow(
      "disposed Durable Object lifecycle"
    );
  });
});

describe("Server lifecycle integration", () => {
  it("runs component startup and request hooks before user hooks", async () => {
    const name = crypto.randomUUID();
    const response = await worker.fetch(
      new Request(
        `https://example.com/lifecycle-parties/lifecycle-probe/${name}`
      ),
      env,
      createExecutionContext()
    );

    expect(await response.json()).toEqual([
      "first:start:routed",
      "second:start",
      "user:start",
      "first:request",
      "second:request",
      "user:request"
    ]);
  });

  it("lets a component intercept a request before the user hook", async () => {
    const name = crypto.randomUUID();
    const response = await worker.fetch(
      new Request(
        `https://example.com/lifecycle-parties/lifecycle-probe/${name}?intercept`
      ),
      env,
      createExecutionContext()
    );

    expect(await response.json()).toEqual([
      "first:start:routed",
      "second:start",
      "user:start",
      "first:request",
      "second:request"
    ]);
  });

  it("runs component alarm hooks before the user alarm hook", async () => {
    const name = crypto.randomUUID();
    await worker.fetch(
      new Request(
        `https://example.com/lifecycle-parties/lifecycle-probe/${name}`
      ),
      env,
      createExecutionContext()
    );
    const stub = env.LifecycleProbe.getByName(name);
    await stub.scheduleAlarm();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getCalls()).toEqual([
      "first:start:routed",
      "second:start",
      "user:start",
      "first:request",
      "second:request",
      "user:request",
      "first:alarm",
      "second:alarm",
      "user:alarm"
    ]);
  });

  it("exposes reverse-order disposal to the host", async () => {
    const name = crypto.randomUUID();
    await worker.fetch(
      new Request(
        `https://example.com/lifecycle-parties/lifecycle-probe/${name}`
      ),
      env,
      createExecutionContext()
    );
    const stub = env.LifecycleProbe.getByName(name);

    expect(await stub.disposeForTest()).toEqual([
      "first:start:routed",
      "second:start",
      "user:start",
      "first:request",
      "second:request",
      "user:request",
      "second:dispose",
      "first:dispose"
    ]);
  });
});
