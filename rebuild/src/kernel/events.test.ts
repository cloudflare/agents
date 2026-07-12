import { describe, expect, it, vi } from "vitest";
import { channelForType, createEventBus } from "./events.js";

describe("channelForType", () => {
  it("routes known types to their taxonomy channel", () => {
    expect(channelForType("state:update")).toBe("state");
    expect(channelForType("rpc")).toBe("rpc");
    expect(channelForType("rpc:error")).toBe("rpc");
    expect(channelForType("message:request")).toBe("message");
    expect(channelForType("tool:result")).toBe("message");
    expect(channelForType("tool:approval")).toBe("message");
    expect(channelForType("chat:recovery:attempt")).toBe("chat");
    expect(channelForType("chat:stream:stalled")).toBe("chat");
    expect(channelForType("chat:transcript:repaired")).toBe("transcript");
    expect(channelForType("fiber:run:started")).toBe("fiber");
    expect(channelForType("fiber:recovery:handled")).toBe("fiber");
    expect(channelForType("agent_tool:recovery:begin")).toBe("agentTool");
    expect(channelForType("schedule:execute")).toBe("schedule");
    expect(channelForType("queue:create")).toBe("schedule");
    expect(channelForType("connect")).toBe("lifecycle");
    expect(channelForType("disconnect")).toBe("lifecycle");
    expect(channelForType("destroy")).toBe("lifecycle");
    expect(channelForType("workflow:start")).toBe("workflow");
    expect(channelForType("email:receive")).toBe("email");
    expect(channelForType("tool:fetch")).toBe("tool");
    expect(channelForType("channel:resolved")).toBe("channel");
    expect(channelForType("notice:delivered")).toBe("channel");
  });

  it("routes unknown types to 'misc'", () => {
    expect(channelForType("something:unheard-of")).toBe("misc");
  });
});

describe("createEventBus", () => {
  it("stamps agent and name from the source", () => {
    const bus = createEventBus({ agent: "Think", name: "session-1" });
    const received: unknown[] = [];
    bus.subscribe("*", (e) => received.push(e));
    bus.emit("state:update", { foo: "bar" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "state:update",
      agent: "Think",
      name: "session-1",
      payload: { foo: "bar" },
    });
  });

  it("uses the injected clock for the timestamp", () => {
    const bus = createEventBus({ agent: "Think", name: "s1" }, () => 12345);
    let seen: number | undefined;
    bus.subscribe("*", (e) => (seen = e.timestamp));
    bus.emit("state:update");
    expect(seen).toBe(12345);
  });

  it("routes events by channel to channel-specific subscribers", () => {
    const bus = createEventBus({ agent: "A", name: "n" });
    const stateEvents: unknown[] = [];
    const chatEvents: unknown[] = [];
    bus.subscribe("state", (e) => stateEvents.push(e));
    bus.subscribe("chat", (e) => chatEvents.push(e));
    bus.emit("state:update");
    bus.emit("chat:recovery:attempt");
    expect(stateEvents).toHaveLength(1);
    expect(chatEvents).toHaveLength(1);
  });

  it("a '*' subscription sees everything", () => {
    const bus = createEventBus({ agent: "A", name: "n" });
    const all: unknown[] = [];
    bus.subscribe("*", (e) => all.push(e));
    bus.emit("state:update");
    bus.emit("chat:recovery:attempt");
    bus.emit("something:unheard-of");
    expect(all).toHaveLength(3);
  });

  it("defaults payload to an empty object", () => {
    const bus = createEventBus({ agent: "A", name: "n" });
    let payload: unknown;
    bus.subscribe("*", (e) => (payload = e.payload));
    bus.emit("state:update");
    expect(payload).toEqual({});
  });

  it("does not throw when there are no subscribers", () => {
    const bus = createEventBus({ agent: "A", name: "n" });
    expect(() => bus.emit("state:update", { a: 1 })).not.toThrow();
  });

  it("isolates a throwing subscriber from other subscribers", () => {
    const bus = createEventBus({ agent: "A", name: "n" });
    const calls: string[] = [];
    bus.subscribe("*", () => {
      calls.push("first");
      throw new Error("boom");
    });
    bus.subscribe("*", () => {
      calls.push("second");
    });
    expect(() => bus.emit("state:update")).not.toThrow();
    expect(calls).toEqual(["first", "second"]);
  });

  it("subscribe returns an unsubscribe function", () => {
    const bus = createEventBus({ agent: "A", name: "n" });
    const fn = vi.fn();
    const unsubscribe = bus.subscribe("*", fn);
    bus.emit("state:update");
    unsubscribe();
    bus.emit("state:update");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
