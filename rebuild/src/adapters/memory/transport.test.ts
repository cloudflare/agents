import { describe, expect, it } from "vitest";
import { createMemoryConnection, createMemoryConnectionRegistry } from "./transport.js";

describe("createMemoryConnection", () => {
  it("records sent messages", () => {
    const conn = createMemoryConnection("c1");
    conn.send("hello");
    conn.send("world");
    expect(conn.sent).toEqual(["hello", "world"]);
  });

  it("exposes readonly state", () => {
    const conn = createMemoryConnection("c1", { userId: "u1" });
    expect(conn.state).toEqual({ userId: "u1" });
  });

  it("close() marks the connection closed", () => {
    const conn = createMemoryConnection("c1");
    expect(conn.closed).toBe(false);
    conn.close(1000, "done");
    expect(conn.closed).toBe(true);
  });

  it("receive() dispatches to registered onReceive handlers", () => {
    const conn = createMemoryConnection("c1");
    const received: string[] = [];
    conn.onReceive((msg) => received.push(msg));
    conn.receive("ping");
    expect(received).toEqual(["ping"]);
  });

  it("onReceive() returns an unsubscribe function", () => {
    const conn = createMemoryConnection("c1");
    const received: string[] = [];
    const unsubscribe = conn.onReceive((msg) => received.push(msg));
    conn.receive("a");
    unsubscribe();
    conn.receive("b");
    expect(received).toEqual(["a"]);
  });
});

describe("createMemoryConnectionRegistry", () => {
  it("get() returns a registered connection by id", () => {
    const registry = createMemoryConnectionRegistry();
    const conn = createMemoryConnection("c1");
    registry.add(conn);
    expect(registry.get("c1")).toBe(conn);
  });

  it("get() returns undefined for an unknown id", () => {
    const registry = createMemoryConnectionRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });

  it("connections() iterates all registered connections", () => {
    const registry = createMemoryConnectionRegistry();
    registry.add(createMemoryConnection("c1"));
    registry.add(createMemoryConnection("c2"));
    expect([...registry.connections()].map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("remove() drops a connection", () => {
    const registry = createMemoryConnectionRegistry();
    registry.add(createMemoryConnection("c1"));
    registry.remove("c1");
    expect(registry.get("c1")).toBeUndefined();
  });

  it("broadcast() sends to every connection", () => {
    const registry = createMemoryConnectionRegistry();
    const c1 = createMemoryConnection("c1");
    const c2 = createMemoryConnection("c2");
    registry.add(c1);
    registry.add(c2);
    registry.broadcast("hi");
    expect(c1.sent).toEqual(["hi"]);
    expect(c2.sent).toEqual(["hi"]);
  });

  it("broadcast() excludes listed connection ids", () => {
    const registry = createMemoryConnectionRegistry();
    const c1 = createMemoryConnection("c1");
    const c2 = createMemoryConnection("c2");
    registry.add(c1);
    registry.add(c2);
    registry.broadcast("hi", ["c1"]);
    expect(c1.sent).toEqual([]);
    expect(c2.sent).toEqual(["hi"]);
  });
});
