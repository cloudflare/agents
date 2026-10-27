import {
  context,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  trace
} from "@opentelemetry/api";
import type { ContextManager, Span, Tracer } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeTracing } from "./fake-tracing";

const REGISTRY = Symbol.for("opentelemetry.js.api.1");

function teardown() {
  context.disable();
  trace.disable();
}

/** A fresh copy of the Agents SDK tracer and the native tracing it sits on. */
async function load(): Promise<{
  tracer: typeof import("../../observability/tracing/agents").tracer;
  tracing: FakeTracing;
}> {
  vi.resetModules();
  const { tracer } = await import("../../observability/tracing/agents");
  const { tracing } = await import("./cloudflare-workers");
  return { tracer, tracing };
}

function registered(): boolean {
  const registry = (globalThis as Record<symbol, { trace?: unknown }>)[
    REGISTRY
  ];
  return registry?.trace !== undefined;
}

beforeEach(teardown);
afterEach(teardown);

it("registers the bridge on the first Agents SDK span", async () => {
  const { tracer, tracing } = await load();
  expect(registered()).toBe(false);

  tracing.invocation((root) =>
    tracer.withSpan("invoke_agent weather", {}, () => {
      // Application OTel spans and platform spans nest under the agent span.
      trace.getTracer("app").startActiveSpan("app span", (span) => {
        tracing.platform("kv_get");
        span.end();
      });
      expect(root.children.map((span) => span.name)).toEqual([
        "invoke_agent weather"
      ]);
    })
  );

  expect(registered()).toBe(true);
  const agent = tracing.recorded.find(
    (span) => span.name === "invoke_agent weather"
  );
  expect(agent?.ended).toBe(true);
  expect(agent?.children.map((span) => span.name)).toEqual(["app span"]);
  expect(agent?.children[0]?.children.map((span) => span.name)).toEqual([
    "kv_get"
  ]);
});

it("writes exactly the attributes it is given, and error status on failure", async () => {
  const { tracer, tracing } = await load();
  const attributes = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "weather",
    "instrumentation_scope.name": "agents",
    "instrumentation_scope.version": "1",
    "cloudflare.agents.session.name": undefined,
    "gen_ai.usage.input_tokens": 3,
    "cloudflare.agents.storage.grouped": true
  };

  await tracing.invocation(async () => {
    await expect(
      tracer.withSpan("invoke_agent weather", attributes, async (span) => {
        span.finish({ "gen_ai.usage.output_tokens": 1 });
        throw new TypeError("secret detail");
      })
    ).rejects.toThrow("secret detail");
  });

  const agent = tracing.recorded.find(
    (span) => span.name === "invoke_agent weather"
  );
  expect(agent?.attributes).toEqual({
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "weather",
    "instrumentation_scope.name": "agents",
    "instrumentation_scope.version": "1",
    "gen_ai.usage.input_tokens": 3,
    "cloudflare.agents.storage.grouped": true,
    "gen_ai.usage.output_tokens": 1
  });
  // finish() closed the span before the throw, so nothing else is written.
  expect(agent?.status).toEqual({ code: "unset" });
  expect(agent?.exceptions).toEqual([]);

  await tracing.invocation(async () => {
    await expect(
      tracer.withSpan("chat model", {}, async () => {
        throw new TypeError("secret detail");
      })
    ).rejects.toThrow();
  });
  const chat = tracing.recorded.find((span) => span.name === "chat model");
  expect(chat?.attributes).toEqual({ "error.type": "TypeError" });
  expect(chat?.status).toEqual({ code: "error" });
  expect(chat?.exceptions).toEqual([]);
});

it("records Agents SDK spans in a Durable Object constructor", async () => {
  const { tracer, tracing } = await load();

  tracing.invocation((root) =>
    tracing.constructing(() => {
      // The runtime reports no active span here.
      expect(tracing.getActiveSpan()).toBeUndefined();
      tracer.withSpan("agent_initialization", {}, () =>
        tracer.withSpan("initialize_agent_storage", {}, () => undefined)
      );
      expect(root.children.map((span) => span.name)).toEqual([
        "agent_initialization"
      ]);
      expect(root.children[0]?.children.map((span) => span.name)).toEqual([
        "initialize_agent_storage"
      ]);
    })
  );
  expect(registered()).toBe(true);
});

it("steps aside for an application's own OpenTelemetry SDK", async () => {
  const { tracer, tracing } = await load();
  const started: string[] = [];
  const appTracer: Tracer = {
    startSpan: () =>
      trace.wrapSpanContext({ traceId: "", spanId: "", traceFlags: 0 }),
    startActiveSpan<F extends (span: Span) => unknown>(
      name: string,
      ...rest: unknown[]
    ) {
      started.push(name);
      const fn = rest.at(-1) as F;
      return fn(
        trace.wrapSpanContext({ traceId: "", spanId: "", traceFlags: 0 })
      ) as ReturnType<F>;
    }
  };
  const provider = new ProxyTracerProvider();
  provider.setDelegate({ getTracer: () => appTracer });
  const manager: ContextManager = {
    active: () => ROOT_CONTEXT,
    with: (_context, fn, thisArg, ...args) => fn.apply(thisArg, args),
    bind: (_context, target) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    }
  };
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);

  tracing.invocation((root) => {
    tracer.withSpan("invoke_agent weather", {}, () => undefined);
    expect(root.children).toEqual([]);
  });
  expect(started).toEqual(["invoke_agent weather"]);
});
