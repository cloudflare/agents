import {
  context,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  trace
} from "@opentelemetry/api";
import type { ContextManager } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpenTelemetryBridge } from "../../observability/otel/bridge";
import { registerBridge } from "../../observability/otel/register";
import { createFakeTracing } from "./fake-tracing";

const native = createFakeTracing();

function teardown() {
  context.disable();
  trace.disable();
}
beforeEach(teardown);
afterEach(teardown);

function otherManager(): ContextManager {
  return {
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
}

function expectBridged() {
  native.invocation((root) => {
    expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
  });
}

it("registers once, and is idempotent while registered", () => {
  const bridge = createOpenTelemetryBridge({ tracing: native });
  const earlyTracer = trace.getTracer("acquired-before-registration");
  expect(registerBridge(bridge)).toBe("registered");
  expect(registerBridge(bridge)).toBe("already-registered");
  expectBridged();
  native.invocation((root) => {
    earlyTracer.startSpan("early").end();
    expect(root.children.map((span) => span.name)).toEqual(["early"]);
  });
});

it("steps aside when OpenTelemetry is already fully registered", () => {
  const manager = otherManager();
  const provider = new ProxyTracerProvider();
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);

  const bridge = createOpenTelemetryBridge({ tracing: native });
  expect(registerBridge(bridge)).toBe("deferred");
  expect(registerBridge(bridge)).toBe("deferred");
  // The existing setup is untouched.
  native.invocation(() => expect(context.active()).toBe(ROOT_CONTEXT));
  expect((trace.getTracerProvider() as ProxyTracerProvider).getDelegate()).toBe(
    provider
  );
});

it("throws on a partial setup, leaving it untouched", () => {
  expect(context.setGlobalContextManager(otherManager())).toBe(true);
  const bridge = createOpenTelemetryBridge({ tracing: native });
  expect(() => registerBridge(bridge)).toThrow(
    "context manager is already registered without its tracer provider"
  );
  native.invocation(() => expect(context.active()).toBe(ROOT_CONTEXT));

  teardown();
  expect(trace.setGlobalTracerProvider(new ProxyTracerProvider())).toBe(true);
  expect(() => registerBridge(bridge)).toThrow(
    "tracer provider is already registered without its context manager"
  );
  // Nothing of ours was left behind: another manager can still register.
  expect(context.setGlobalContextManager(otherManager())).toBe(true);
});

it("registers again after a full teardown, and refuses a partial one", () => {
  const bridge = createOpenTelemetryBridge({ tracing: native });
  expect(registerBridge(bridge)).toBe("registered");
  teardown();
  expect(registerBridge(bridge)).toBe("registered");
  expectBridged();

  trace.disable();
  expect(() => registerBridge(bridge)).toThrow("already registered");
  teardown();
  expect(registerBridge(bridge)).toBe("registered");
  expectBridged();
});

it("explains a registry created by another @opentelemetry/api version", () => {
  const key = Symbol.for("opentelemetry.js.api.1");
  const registry = globalThis as Record<symbol, unknown>;
  const previous = registry[key];
  registry[key] = { version: "1.0.0" };
  try {
    expect(() =>
      registerBridge(createOpenTelemetryBridge({ tracing: native }))
    ).toThrow("globals were created by @opentelemetry/api 1.0.0");
  } finally {
    registry[key] = previous;
  }
});
