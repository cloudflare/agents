import { describe, it, expect, beforeEach } from "vitest";
import {
  ChatRequestContext,
  type RequestContextKey,
  type RequestContextStore
} from "../request-context";

/** A store that counts its writes. */
class FakeStore implements RequestContextStore {
  rows = new Map<RequestContextKey, string>();
  writes: string[] = [];
  get(key: RequestContextKey) {
    return this.rows.get(key);
  }
  set(key: RequestContextKey, json: string) {
    this.writes.push(`set ${key}`);
    this.rows.set(key, json);
  }
  delete(key: RequestContextKey) {
    this.writes.push(`delete ${key}`);
    this.rows.delete(key);
  }
}

const tools = [{ name: "pick", description: "Pick one" }];

describe("ChatRequestContext", () => {
  let store: FakeStore;
  let context: ChatRequestContext;

  beforeEach(() => {
    store = new FakeStore();
    context = new ChatRequestContext(store);
  });

  it("a request replaces the context and writes it through", () => {
    expect(
      context.set({ clientTools: tools, body: { model: "fast" } })
    ).toEqual({ clientTools: tools, body: { model: "fast" } });
    expect(context.clientTools).toEqual(tools);
    expect(context.body).toEqual({ model: "fast" });
    expect(store.rows.get("lastClientTools")).toBe(JSON.stringify(tools));
    expect(store.rows.get("lastBody")).toBe('{"model":"fast"}');
    expect([...context.clientToolNames()]).toEqual(["pick"]);
  });

  it("a request that sends no tools clears the stored ones", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    context.set({ body: {} });
    expect(context.clientTools).toBeUndefined();
    expect(context.body).toBeUndefined();
    expect(store.rows.size).toBe(0);
    expect(context.clientToolNames().size).toBe(0);
  });

  it("does not write a value equal to what is stored", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    store.writes = [];
    context.set({ clientTools: [...tools], body: { model: "fast" } });
    context.persist();
    expect(store.writes).toEqual([]);
    context.set({ clientTools: tools, body: { model: "slow" } });
    expect(store.writes).toEqual(["set lastBody"]);
  });

  it("a tool result that lists tools replaces the stored ones", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    const newer = [{ name: "choose", description: "Choose" }];
    context.replaceClientTools(newer);
    expect(context.clientTools).toEqual(newer);
    expect(context.body).toEqual({ model: "fast" });
    expect(store.rows.get("lastClientTools")).toBe(JSON.stringify(newer));
  });

  it.each([[undefined], [null], [[]], ["pick"], [{ length: 1 }]])(
    "a tool result that lists no tools (%j) leaves the stored ones",
    (listed) => {
      context.set({ clientTools: tools });
      store.writes = [];
      context.replaceClientTools(listed);
      expect(context.clientTools).toEqual(tools);
      expect(store.writes).toEqual([]);
    }
  );

  it("restores what was stored, and a later equal value is not rewritten", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    const woken = new ChatRequestContext(store);
    woken.restore();
    expect(woken.clientTools).toEqual(tools);
    expect(woken.body).toEqual({ model: "fast" });
    store.writes = [];
    woken.set({ clientTools: tools, body: { model: "fast" } });
    expect(store.writes).toEqual([]);
  });

  it("restores one key and leaves the other in memory", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    const woken = new ChatRequestContext(store);
    woken.body = { model: "in-memory" };
    woken.restore("lastClientTools");
    expect(woken.clientTools).toEqual(tools);
    expect(woken.body).toEqual({ model: "in-memory" });
  });

  it("reads a corrupted value as none, and a missing one leaves memory alone", () => {
    store.rows.set("lastClientTools", "{not json");
    context.body = { kept: true };
    context.restore();
    expect(context.clientTools).toBeUndefined();
    expect(context.body).toEqual({ kept: true });
  });

  it("applies a recovered turn's context, key by key", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    context.applyRecovered({ lastBody: null });
    expect(context.clientTools).toEqual(tools);
    expect(context.body).toBeUndefined();
    expect(store.rows.has("lastBody")).toBe(false);

    context.applyRecovered({ lastClientTools: null, lastBody: { a: 1 } });
    expect(context.clientTools).toBeUndefined();
    expect(context.body).toEqual({ a: 1 });

    context.applyRecovered(undefined);
    expect(context.body).toEqual({ a: 1 });
  });

  it("a clear drops both", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    context.clear();
    expect(context.clientTools).toBeUndefined();
    expect(context.body).toBeUndefined();
    expect(store.rows.size).toBe(0);
  });
});
