import { describe, expect, it } from "vitest";
import { createMemoryHost } from "./host.js";

describe("createMemoryHost", () => {
  it("assembles clock, store, alarms, connections, and bus", () => {
    const host = createMemoryHost();
    expect(host.clock).toBeDefined();
    expect(host.store).toBeDefined();
    expect(host.alarms).toBeDefined();
    expect(host.connections).toBeDefined();
    expect(host.bus).toBeDefined();
  });

  it("the alarm timer is wired to the same clock", () => {
    const host = createMemoryHost();
    let fired = false;
    host.alarms.onAlarm(() => {
      fired = true;
    });
    host.alarms.set(1000);
    host.clock.advance(1000);
    expect(fired).toBe(true);
  });

  it("store/alarms/connections/bus are independent per host", () => {
    const a = createMemoryHost();
    const b = createMemoryHost();
    a.store.put("x", 1);
    expect(b.store.get("x")).toBeUndefined();
  });

  it("the event bus timestamp is driven by the host's clock", () => {
    const host = createMemoryHost();
    host.clock.set(999);
    let seenTimestamp: number | undefined;
    host.bus.subscribe("*", (e) => {
      seenTimestamp = e.timestamp;
    });
    host.bus.emit("state:update");
    expect(seenTimestamp).toBe(999);
  });

  it("accepts an injected clock", () => {
    const host = createMemoryHost({ clock: (() => {
      const c = createMemoryHost().clock;
      c.set(42);
      return c;
    })() });
    expect(host.clock.now()).toBe(42);
  });

  it("accepts agent/name for the event bus stamp", () => {
    const host = createMemoryHost({ agent: "Think", name: "session-1" });
    let seen: unknown;
    host.bus.subscribe("*", (e) => (seen = e));
    host.bus.emit("state:update");
    expect(seen).toMatchObject({ agent: "Think", name: "session-1" });
  });
});
