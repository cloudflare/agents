import { describe, expect, it } from "vitest";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import { callable, createCallableRegistry, scanCallables, type StreamingResponse } from "./callable.js";

function makeBus() {
  const bus = createEventBus({ agent: "test", name: "test" });
  const events: ObservabilityEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  return { bus, events };
}

describe("createCallableRegistry", () => {
  it("registers and dispatches a non-streaming method", async () => {
    const { bus } = makeBus();
    const registry = createCallableRegistry({ bus });
    registry.register("add", (a: unknown, b: unknown) => (a as number) + (b as number), {
      description: "adds two numbers",
    });

    const responses: unknown[] = [];
    await registry.dispatch({ id: "1", method: "add", args: [2, 3] }, (r) => responses.push(r));

    expect(responses).toEqual([{ type: "rpc", id: "1", success: true, result: 5, done: true }]);
  });

  it("exposes registered method metadata", () => {
    const { bus } = makeBus();
    const registry = createCallableRegistry({ bus });
    registry.register("add", () => 1, { description: "adds" });
    registry.register("stream", () => undefined, { streaming: true });

    const methods = registry.callableMethods();
    expect(methods.get("add")).toEqual({ description: "adds" });
    expect(methods.get("stream")).toEqual({ streaming: true });
  });

  it("responds with an error frame for an unknown method", async () => {
    const { bus } = makeBus();
    const registry = createCallableRegistry({ bus });

    const responses: unknown[] = [];
    await registry.dispatch({ id: "1", method: "nope", args: [] }, (r) => responses.push(r));

    expect(responses).toHaveLength(1);
    const response = responses[0] as { success: boolean; error: string; done: boolean };
    expect(response.success).toBe(false);
    expect(response.done).toBe(true);
    expect(response.error).toMatch(/not callable/i);
  });

  it("responds with an error frame and emits rpc:error when the method throws", async () => {
    const { bus, events } = makeBus();
    const registry = createCallableRegistry({ bus });
    registry.register("boom", () => {
      throw new Error("kaboom");
    });

    const responses: unknown[] = [];
    await registry.dispatch({ id: "1", method: "boom", args: [] }, (r) => responses.push(r));

    expect(responses).toEqual([{ type: "rpc", id: "1", success: false, error: "kaboom", done: true }]);
    expect(events.some((e) => e.type === "rpc:error")).toBe(true);
  });

  it("emits an rpc event on successful non-streaming dispatch", async () => {
    const { bus, events } = makeBus();
    const registry = createCallableRegistry({ bus });
    registry.register("ping", () => "pong");

    await registry.dispatch({ id: "1", method: "ping", args: [] }, () => {});

    const rpcEvent = events.find((e) => e.type === "rpc");
    expect(rpcEvent?.payload).toEqual({ method: "ping" });
  });

  it("streams chunks via send() and finishes with end()", async () => {
    const { bus } = makeBus();
    const registry = createCallableRegistry({ bus });
    registry.register(
      "count",
      async (stream: unknown) => {
        const s = stream as StreamingResponse;
        s.send(1);
        s.send(2);
        s.end(3);
      },
      { streaming: true }
    );

    const responses: unknown[] = [];
    await registry.dispatch({ id: "1", method: "count", args: [] }, (r) => responses.push(r));

    expect(responses).toEqual([
      { type: "rpc", id: "1", success: true, result: 1, done: false },
      { type: "rpc", id: "1", success: true, result: 2, done: false },
      { type: "rpc", id: "1", success: true, result: 3, done: true },
    ]);
  });

  it("passes the stream handle before the call args", async () => {
    const { bus } = makeBus();
    const registry = createCallableRegistry({ bus });
    const received: unknown[] = [];
    registry.register(
      "echo",
      async (stream: unknown, ...args: unknown[]) => {
        received.push(stream, ...args);
        (stream as StreamingResponse).end();
      },
      { streaming: true }
    );

    await registry.dispatch({ id: "1", method: "echo", args: ["a", "b"] }, () => {});

    expect(received).toHaveLength(3);
    expect(received[0]).toHaveProperty("send");
    expect(received[0]).toHaveProperty("end");
    expect(received.slice(1)).toEqual(["a", "b"]);
  });

  it("ends with an error frame if the streaming method throws after partial sends", async () => {
    const { bus, events } = makeBus();
    const registry = createCallableRegistry({ bus });
    registry.register(
      "flaky",
      async (stream: unknown) => {
        const s = stream as StreamingResponse;
        s.send("partial");
        throw new Error("stream broke");
      },
      { streaming: true }
    );

    const responses: unknown[] = [];
    await registry.dispatch({ id: "1", method: "flaky", args: [] }, (r) => responses.push(r));

    expect(responses).toEqual([
      { type: "rpc", id: "1", success: true, result: "partial", done: false },
      { type: "rpc", id: "1", success: false, error: "stream broke", done: true },
    ]);
    expect(events.some((e) => e.type === "rpc:error")).toBe(true);
  });
});

describe("callable decorator + scanCallables", () => {
  it("tags decorated methods so a scan can find and register them", async () => {
    class Api {
      calls: number[] = [];

      @callable({ description: "adds two numbers" })
      add(a: number, b: number) {
        return a + b;
      }

      @callable({ streaming: true })
      async stream(response: StreamingResponse) {
        response.send("chunk");
        response.end("done");
      }

      // Not decorated — must not show up in the scan.
      internal() {
        return "hidden";
      }
    }

    const instance = new Api();
    const tags = scanCallables(instance);

    expect([...tags.keys()].sort()).toEqual(["add", "stream"]);
    expect(tags.get("add")?.opts).toEqual({ description: "adds two numbers" });
    expect(tags.get("stream")?.opts).toEqual({ streaming: true });

    expect(tags.get("add")?.fn(2, 3)).toBe(5);
  });

  it("registers scanned methods on a real registry and dispatches through them", async () => {
    const { bus } = makeBus();
    const registry = createCallableRegistry({ bus });

    class Api {
      @callable({ description: "greets" })
      greet(name: string) {
        return `hello ${name}`;
      }
    }

    const instance = new Api();
    for (const [name, { fn, opts }] of scanCallables(instance)) {
      registry.register(name, fn, opts);
    }

    const responses: unknown[] = [];
    await registry.dispatch({ id: "1", method: "greet", args: ["world"] }, (r) => responses.push(r));

    expect(responses).toEqual([{ type: "rpc", id: "1", success: true, result: "hello world", done: true }]);
  });
});
