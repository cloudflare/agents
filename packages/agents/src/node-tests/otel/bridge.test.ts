import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  createContextKey,
  createTraceState,
  diag,
  DiagLogLevel,
  INVALID_SPAN_CONTEXT,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace
} from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { createOpenTelemetryBridge } from "../../observability/otel/bridge";
import { registerBridge } from "../../observability/otel/register";
import { createFakeTracing } from "./fake-tracing";
import type { FakeSpan } from "./fake-tracing";

const native = createFakeTracing();
const diagnostics: string[] = [];
const key = createContextKey("test-value");
let tracer: ReturnType<typeof trace.getTracer>;

function names(spans: readonly FakeSpan[]): string[] {
  return spans.map((span) => span.name);
}

function only(name: string): FakeSpan {
  const matches = native.recorded.filter((span) => span.name === name);
  expect(matches, name).toHaveLength(1);
  return matches[0];
}

beforeAll(() => {
  const record = (message: string) => diagnostics.push(message);
  diag.setLogger(
    {
      error: record,
      warn: record,
      info: record,
      debug: record,
      verbose: record
    },
    DiagLogLevel.ALL
  );
  expect(registerBridge(createOpenTelemetryBridge({ tracing: native }))).toBe(
    "registered"
  );
  tracer = trace.getTracer("bridge-tests", "1.0.0");
});

afterAll(() => {
  context.disable();
  trace.disable();
  diag.disable();
});

beforeEach(() => {
  native.recorded.length = 0;
});

describe("active spans", () => {
  it("supports every startActiveSpan overload with native nesting", () =>
    native.invocation((root) => {
      const parent = context.active().setValue(key, 123);
      expect(
        tracer.startActiveSpan("one", (span) => {
          expect(trace.getActiveSpan()).toBe(span);
          expect(native.getActiveSpan()?.name).toBe("one");
          span.end();
          return 1;
        })
      ).toBe(1);
      expect(
        tracer.startActiveSpan("two", { attributes: { a: true } }, (span) => {
          span.end();
          return 2;
        })
      ).toBe(2);
      expect(
        tracer.startActiveSpan("three", {}, parent, (span) => {
          expect(context.active().getValue(key)).toBe(123);
          native.platform("kv_get");
          span.end();
          return 3;
        })
      ).toBe(3);

      expect(names(root.children)).toEqual(["one", "two", "three"]);
      expect(only("two").attributes).toEqual({ a: true });
      expect(names(only("three").children)).toEqual(["kv_get"]);
      expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
    }));

  it("leaves end() to the caller, also when the callback throws", async () =>
    native.invocation(async () => {
      let opened: Span | undefined;
      expect(() =>
        tracer.startActiveSpan("sync", (span) => {
          opened = span;
          throw new Error("sync");
        })
      ).toThrow("sync");
      expect(opened?.isRecording()).toBe(true);
      opened?.end();
      await expect(
        tracer.startActiveSpan("async", async (span) => {
          opened = span;
          throw new Error("async");
        })
      ).rejects.toThrow("async");
      expect(opened?.isRecording()).toBe(true);
      opened?.end();
      expect(opened?.isRecording()).toBe(false);
    }));

  it("keeps async children, baggage, and native spans in one tree", async () =>
    native.invocation(async (root) => {
      const baggage = propagation.createBaggage({ tenant: { value: "t" } });
      await context.with(
        propagation.setBaggage(context.active(), baggage),
        () =>
          tracer.startActiveSpan("parent", async (parent) => {
            await Promise.resolve();
            expect(propagation.getBaggage(context.active())).toBe(baggage);
            await native.startActiveSpan("agent span", async (agentSpan) => {
              await Promise.resolve();
              // Native spans opened by other code are the OTel active span too.
              expect(trace.getActiveSpan()?.spanContext()).toEqual(
                agentSpan.spanContext()
              );
              expect(propagation.getBaggage(context.active())).toBe(baggage);
              tracer.startSpan("otel child").end();
              agentSpan.end();
            });
            expect(trace.getActiveSpan()).toBe(parent);
            parent.end();
          })
      );
      expect(names(root.children)).toEqual(["parent"]);
      expect(names(only("parent").children)).toEqual(["agent span"]);
      expect(names(only("agent span").children)).toEqual(["otel child"]);
    }));

  it("isolates concurrent requests and concurrent siblings", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        native.invocation(async (root) => {
          await context.with(context.active().setValue(key, i), () =>
            Promise.all(
              ["a", "b"].map((name) =>
                tracer.startActiveSpan(name, async (span) => {
                  await new Promise((resolve) => setTimeout(resolve, i % 3));
                  expect(context.active().getValue(key)).toBe(i);
                  expect(trace.getActiveSpan()).toBe(span);
                  native.platform(`fetch ${name}`);
                  span.end();
                })
              )
            )
          );
          expect(names(root.children)).toEqual(["a", "b"]);
          for (const child of root.children) {
            expect(names(child.children)).toEqual([`fetch ${child.name}`]);
          }
        })
      )
    );
    expect(context.active().getValue(key)).toBeUndefined();
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it("does not rewind unrelated AsyncLocalStorage values", () =>
    native.invocation(() => {
      const application = new AsyncLocalStorage<string>();
      const captured = application.run("old", () =>
        context.active().setValue(key, "otel")
      );
      application.run("new", () => {
        context.with(captured, () => {
          expect(application.getStore()).toBe("new");
          expect(context.active().getValue(key)).toBe("otel");
        });
        tracer.startActiveSpan("span", (span) => {
          expect(application.getStore()).toBe("new");
          span.end();
        });
      });
    }));
});

describe("startSpan and later activation", () => {
  it("opens the span at once without activating it", () =>
    native.invocation((root) => {
      const span = tracer.startSpan("manual");
      expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
      expect(native.getActiveSpan()).toBe(root);
      native.platform("sibling");
      span.end();
      expect(names(root.children)).toEqual(["manual", "sibling"]);
      expect(only("manual").ended).toBe(true);
    }));

  it("records the MCP server pattern: startSpan, then context.with around the handler", async () =>
    native.invocation(async (root) => {
      // What @modelcontextprotocol/server does for every inbound request.
      const active = context.active();
      const span = tracer.startSpan(
        "tools/call get-weather",
        {
          kind: SpanKind.SERVER,
          attributes: {
            "mcp.method.name": "tools/call",
            "gen_ai.tool.name": "get-weather"
          },
          links: []
        },
        active
      );
      const result = await context.with(
        trace.setSpan(active, span),
        async () => {
          expect(trace.getActiveSpan()).toBe(span);
          await Promise.resolve();
          native.platform("kv_get");
          await tracer.startActiveSpan("look up forecast", async (child) => {
            child.setAttribute("weather.city", "Lisbon");
            child.end();
          });
          return "sunny";
        }
      );
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      expect(result).toBe("sunny");
      expect(names(root.children)).toEqual(["tools/call get-weather"]);
      const call = only("tools/call get-weather");
      expect(call.attributes).toEqual({
        "mcp.method.name": "tools/call",
        "gen_ai.tool.name": "get-weather"
      });
      expect(names(call.children)).toEqual(["kv_get", "look up forecast"]);
      expect(only("look up forecast").attributes).toEqual({
        "weather.city": "Lisbon"
      });
      expect(call.ended).toBe(true);
      expect(call.status).toEqual({ code: "ok" });
      // Kind has no native representation and is not invented as an attribute.
      expect(Object.keys(call.attributes)).not.toContain("span.kind");
    }));

  it("records the MCP client pattern: inject, then send inside a second context.with", async () =>
    native.invocation(async (root) => {
      const parent = context.active();
      const span = tracer.startSpan(
        "tools/call get-weather",
        { kind: SpanKind.CLIENT },
        parent
      );
      const spanContext = trace.setSpan(parent, span);
      const carrier: Record<string, string> = {};
      context.with(spanContext, () =>
        propagation.inject(context.active(), carrier)
      );
      await context.with(spanContext, async () => {
        await Promise.resolve();
        native.platform("fetch");
      });
      span.end();

      expect(carrier).toEqual({});
      expect(names(root.children)).toEqual(["tools/call get-weather"]);
      expect(names(only("tools/call get-weather").children)).toEqual(["fetch"]);
    }));

  it("nests children under an inactive explicit parent", () =>
    native.invocation((root) => {
      const parent = tracer.startSpan("parent");
      const child = tracer.startSpan(
        "child",
        {},
        trace.setSpan(context.active(), parent)
      );
      expect(native.getActiveSpan()).toBe(root);
      child.end();
      parent.end();
      expect(names(root.children)).toEqual(["parent"]);
      expect(names(only("parent").children)).toEqual(["child"]);
    }));

  it("activates through context.bind, keeping this and arguments", () =>
    native.invocation(() => {
      const span = tracer.startSpan("bound");
      const receiver = { n: 3 };
      const bound = context.bind(
        trace.setSpan(context.active(), span),
        function (this: typeof receiver, n: number) {
          native.platform("inside");
          expect(trace.getActiveSpan()).toBe(span);
          return this.n + n;
        }
      );
      expect(bound.call(receiver, 4)).toBe(7);
      span.end();
      expect(names(only("bound").children)).toEqual(["inside"]);
    }));

  it("lets an ended active span keep parenting work that is still running", () =>
    native.invocation(() => {
      tracer.startActiveSpan("parent", (parent) => {
        parent.end();
        expect(trace.getActiveSpan()).toBe(parent);
        tracer.startSpan("after end").end();
      });
      expect(names(only("parent").children)).toEqual(["after end"]);
    }));

  it("preserves context.with return values, this, arguments and errors", () =>
    native.invocation(() => {
      const ctx = context.active().setValue(key, "bound");
      const receiver = { n: 3 };
      function callback(this: typeof receiver, n: number) {
        expect(context.active()).toBe(ctx);
        return this.n + n;
      }
      expect(context.with(ctx, callback, receiver, 4)).toBe(7);
      const error = new Error("unchanged");
      expect(() =>
        context.with(ctx, () => {
          throw error;
        })
      ).toThrow(error);
      expect(context.active().getValue(key)).toBeUndefined();
    }));
});

describe("span data", () => {
  it("forwards scalar attributes and drops everything else without serializing", () =>
    native.invocation(() => {
      const span = tracer.startSpan("attributes", {
        attributes: { scalar: 1, array: ["x", "y"], skipped: undefined }
      });
      const toJSON = vi.fn(() => {
        throw new Error("must not run");
      });
      const set = span.setAttribute.bind(span) as (
        key: string,
        value: unknown
      ) => Span;
      for (const value of [
        Object.assign([1], { toJSON }),
        { a: 1 },
        null,
        1n
      ]) {
        expect(set("dropped", value)).toBe(span);
      }
      expect(
        span
          .setAttributes({ empty: "", no: false, zero: 0, nan: Number.NaN })
          .setAttribute("", "ignored")
      ).toBe(span);
      expect(toJSON).not.toHaveBeenCalled();
      expect(only("attributes").attributes).toEqual({
        scalar: 1,
        empty: "",
        no: false,
        zero: 0,
        nan: Number.NaN
      });
      span.end();
    }));

  it("forwards status to the runtime, which applies OTel's rules", () =>
    native.invocation(() => {
      const failing = tracer.startSpan("failing");
      failing.setStatus({ code: SpanStatusCode.ERROR, message: "failed" });
      failing.setStatus({ code: SpanStatusCode.UNSET });
      expect(only("failing").status).toEqual({
        code: "error",
        message: "failed"
      });

      const ok = tracer.startSpan("ok");
      ok.setStatus({ code: SpanStatusCode.OK, message: "ignored" });
      ok.setStatus({ code: SpanStatusCode.ERROR, message: "too late" });
      expect(only("ok").status).toEqual({ code: "ok" });
    }));

  it("renames, records exceptions, and ends idempotently", () =>
    native.invocation(() => {
      const span = tracer.startSpan("old");
      expect(span.updateName("new")).toBe(span);
      const error = new Error("original");
      span.recordException(error);
      span.recordException("as text");
      const ids = span.spanContext();
      span.end();
      span.end();
      span.setAttribute("late", true).updateName("late");

      const recorded = only("new");
      expect(recorded.exceptions).toEqual([error, "as text"]);
      expect(recorded.attributes.late).toBeUndefined();
      expect(span.isRecording()).toBe(false);
      expect(span.spanContext()).toEqual(ids);
      expect(ids.spanId).toBe(recorded.spanId);
    }));

  it("exposes the invocation root span; end() leaves it to the runtime", () =>
    native.invocation((root) => {
      const span = trace.getActiveSpan();
      expect(span?.spanContext()).toEqual(root.spanContext());
      span
        ?.setAttribute("http.route", "/weather/:city")
        .updateName("GET /weather/:city")
        .end();
      expect(root.ended).toBe(false);
      expect(root.attributes).toEqual({ "http.route": "/weather/:city" });
      expect(root.name).toBe("GET /weather/:city");
    }));

  it("records the span and drops creation links", () =>
    native.invocation((root) => {
      tracer
        .startSpan("linked", { links: [{ context: root.spanContext() }] })
        .end();
      expect(only("linked").ended).toBe(true);
    }));

  it("keeps the application running when the runtime rejects a value", () =>
    native.invocation(() => {
      const span = tracer.startSpan("rejecting");
      const recorded = only("rejecting");
      recorded.setAttribute = () => {
        throw new TypeError("rejected");
      };
      expect(() => span.setAttribute("key", "value")).not.toThrow();
      span.end();
    }));

  it("does not record attributes when observability is disabled, but still nests", () =>
    native.invocation(
      (root) => {
        const span = trace.getActiveSpan();
        expect(span?.isRecording()).toBe(false);
        span?.setAttribute("ignored", true);
        expect(root.attributes).toEqual({});
        tracer.startActiveSpan("child", (child) => {
          expect(child.isRecording()).toBe(false);
          child.end();
        });
        expect(names(root.children)).toEqual(["child"]);
      },
      { traced: false }
    ));
});

describe("what native tracing cannot represent", () => {
  it("never records under a remote parent, keeping its context for descendants", () =>
    native.invocation((root) => {
      const remote = {
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        traceFlags: 1,
        isRemote: true,
        traceState: createTraceState("vendor=value")
      };
      context.with(trace.setSpanContext(context.active(), remote), () => {
        const span = tracer.startSpan("remote child");
        expect(span.isRecording()).toBe(false);
        expect(span.spanContext()).toEqual(remote);
        expect(
          tracer.startActiveSpan("remote active", (active) => {
            expect(trace.getActiveSpan()).toBe(active);
            expect(tracer.startSpan("descendant").isRecording()).toBe(false);
            return 42;
          })
        ).toBe(42);
      });
      expect(native.recorded).toEqual([root]);
    }));

  it("refuses new roots, missing parents, explicit start times, and spans outside requests", () => {
    expect(tracer.startSpan("outside").spanContext()).toEqual(
      INVALID_SPAN_CONTEXT
    );
    native.invocation((root) => {
      for (const parent of [ROOT_CONTEXT, trace.deleteSpan(context.active())]) {
        context.with(parent, () => {
          expect(trace.getActiveSpan()).toBeUndefined();
          expect(tracer.startSpan("detached").spanContext()).toEqual(
            INVALID_SPAN_CONTEXT
          );
        });
      }
      tracer.startActiveSpan("root", { root: true }, (span) => {
        expect(span.spanContext()).toEqual(INVALID_SPAN_CONTEXT);
        expect(tracer.startSpan("root child").isRecording()).toBe(false);
      });
      const backdated = tracer.startSpan("backdated", { startTime: 0 });
      expect(backdated.isRecording()).toBe(false);
      expect(backdated.spanContext()).toEqual(root.spanContext());
      expect(native.recorded).toEqual([root]);
    });
  });

  it("does not reuse a span from another request as a parent", async () => {
    const first = native.invocation(() => tracer.startSpan("first request"));
    native.invocation((root) => {
      const child = tracer.startSpan(
        "child",
        {},
        trace.setSpan(context.active(), first)
      );
      expect(child.isRecording()).toBe(false);
      context.with(trace.setSpan(context.active(), first), () => {
        expect(native.getActiveSpan()).toBe(root);
      });
      expect(root.children).toEqual([]);
    });
    first.end();
  });

  it("preserves promise identity and synchronous errors of non-recording spans", () =>
    native.invocation(() => {
      const promise = Promise.resolve(1);
      expect(
        tracer.startActiveSpan("root", { root: true }, () => promise)
      ).toBe(promise);
      const error = new Error("application failure");
      expect(() =>
        tracer.startActiveSpan("root", { root: true }, () => {
          throw error;
        })
      ).toThrow(error);
    }));

  it("reports unsupported features without span names or values", () =>
    native.invocation(() => {
      const span = tracer.startSpan("private-name");
      span
        .addEvent("private-event", { private: "secret" })
        .addLink({ context: span.spanContext() })
        .setAttribute("private-key", ["private-value"]);
      span.recordException("private-error", 0);
      span.end(0);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.join("\n")).not.toContain("private");
    }));
});

describe("Durable Object constructors", () => {
  it("records spans where the runtime reports no active span but still parents to the request", () =>
    native.invocation((root) => {
      native.constructing(() => {
        expect(native.getActiveSpan()).toBeUndefined();
        expect(trace.getActiveSpan()).toBeUndefined();
        tracer.startActiveSpan("agent_initialization", (span) => {
          expect(span.isRecording()).toBe(true);
          tracer.startSpan("initialize_agent_storage").end();
          span.end();
        });
        tracer.startSpan("manual").end();
        // An explicit new root is still refused.
        expect(tracer.startSpan("root", { root: true }).isRecording()).toBe(
          false
        );
        expect(
          tracer.startSpan("explicit", {}, ROOT_CONTEXT).isRecording()
        ).toBe(false);
      });
      expect(names(root.children)).toEqual(["agent_initialization", "manual"]);
      expect(names(only("agent_initialization").children)).toEqual([
        "initialize_agent_storage"
      ]);
    }));
});

describe("older runtimes", () => {
  it("nests spans without spanContext, setStatus or updateName", () => {
    const legacy = createFakeTracing({ legacy: true });
    const bridge = createOpenTelemetryBridge({ tracing: legacy });
    const legacyTracer = bridge.tracerProvider.getTracer("legacy");
    legacy.invocation((root) => {
      const span = legacyTracer.startSpan(
        "server",
        {},
        bridge.contextManager.active()
      );
      expect(span.spanContext()).toEqual(INVALID_SPAN_CONTEXT);
      bridge.contextManager.with(
        trace.setSpan(bridge.contextManager.active(), span),
        () => legacy.platform("kv_get")
      );
      expect(() =>
        span
          .setStatus({ code: SpanStatusCode.ERROR })
          .updateName("renamed")
          .end()
      ).not.toThrow();
      expect(names(root.children)).toEqual(["server"]);
      expect(names(root.children[0].children)).toEqual(["kv_get"]);
    });
  });
});
