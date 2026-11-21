import { describe, it, expect, beforeEach } from "vitest";
import {
  ChatRequestContext,
  clientRequestContext,
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

  it("a tool result replaces the stored tools only when it settled its call", async () => {
    context.set({ clientTools: tools });
    const other = [{ name: "choose", description: "Choose" }];
    const applied: string[] = [];
    const applying = (status: "changed" | "unchanged" | "missing") =>
      context.applyingToolResult(other, async () => {
        // The stored tools are untouched while the result is applied.
        applied.push(context.clientTools?.[0]?.name ?? "none");
        return status === "changed" ? { status, messageId: "a1" } : { status };
      });

    // A duplicate from another tab, and a result for a call that is gone.
    expect(await applying("unchanged")()).toEqual({ status: "unchanged" });
    expect(await applying("missing")()).toEqual({ status: "missing" });
    expect(context.clientTools).toEqual(tools);

    expect(await applying("changed")()).toEqual({
      status: "changed",
      messageId: "a1"
    });
    expect(context.clientTools).toEqual(other);
    expect(applied).toEqual(["pick", "pick", "pick"]);
  });

  it.each([
    ["a clear", (c: ChatRequestContext) => c.clear(), undefined],
    [
      "a request whose turn started",
      (c: ChatRequestContext) => c.set({ clientTools: tools }),
      tools
    ]
  ])(
    "a tool result applied across %s does not bring its tools back",
    async (_name, replace, expected) => {
      context.set({ clientTools: tools });
      let finishApply!: () => void;
      const applying = context.applyingToolResult(
        [{ name: "choose", description: "Choose" }],
        () =>
          new Promise((resolve) => {
            finishApply = () => resolve({ status: "changed", messageId: "a1" });
          })
      )();

      // The message write is still in flight when the context is replaced.
      replace(context);
      finishApply();
      await applying;

      expect(context.clientTools).toEqual(expected);
      expect(store.rows.get("lastClientTools")).toBe(
        expected ? JSON.stringify(expected) : undefined
      );
    }
  );

  it("a failed apply leaves the stored tools", async () => {
    context.set({ clientTools: tools });
    await expect(
      context.applyingToolResult([{ name: "choose" }], async () => {
        throw new Error("storage failed");
      })()
    ).rejects.toThrow("storage failed");
    expect(context.clientTools).toEqual(tools);
  });

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

  it("snapshots what an interrupted turn should be recovered with", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    expect(context.snapshot()).toEqual({
      lastClientTools: tools,
      lastBody: { model: "fast" }
    });
    context.clear();
    expect(context.snapshot()).toEqual({
      lastClientTools: undefined,
      lastBody: undefined
    });
  });

  it("a clear drops both", () => {
    context.set({ clientTools: tools, body: { model: "fast" } });
    context.clear();
    expect(context.clientTools).toBeUndefined();
    expect(context.body).toBeUndefined();
    expect(store.rows.size).toBe(0);
  });
});

describe("clientRequestContext", () => {
  it("stores the tools and body the request sent", () => {
    expect(
      clientRequestContext({ clientTools: tools, body: { model: "fast" } })
    ).toEqual({ clientTools: tools, body: { model: "fast" } });
  });

  it("stores no tools for a request that sends none, with or without the key", () => {
    expect(clientRequestContext({ body: {} })).toEqual({
      clientTools: undefined,
      body: undefined
    });
    expect(clientRequestContext({ clientTools: [] }).clientTools).toBe(
      undefined
    );
    expect(clientRequestContext({ clientTools: null }).clientTools).toBe(
      undefined
    );
  });

  it("ignores a clientTools value that is not a list", () => {
    expect(
      clientRequestContext({
        clientTools: "pick" as unknown as []
      }).clientTools
    ).toBe(undefined);
  });
});
