import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createMessageStore } from "./store.js";
import type { ChatMessage, ToolPart } from "./model.js";
import { userMessage } from "./model.js";

describe("createMessageStore", () => {
  it("append adds messages and all() returns them in insertion order", () => {
    const kv = createMemoryKeyValueStore();
    const store = createMessageStore(kv);
    store.append(userMessage("first", "1"));
    store.append(userMessage("second", "2"));
    expect(store.all().map((m) => m.id)).toEqual(["1", "2"]);
    expect(store.count()).toBe(2);
  });

  it("get() returns a message by id or undefined", () => {
    const kv = createMemoryKeyValueStore();
    const store = createMessageStore(kv);
    store.append(userMessage("hi", "1"));
    expect(store.get("1")?.parts).toEqual([{ type: "text", text: "hi" }]);
    expect(store.get("missing")).toBeUndefined();
  });

  it("save() upserts by id, keeping stable order across updates", () => {
    const kv = createMemoryKeyValueStore();
    const store = createMessageStore(kv);
    store.save([userMessage("A", "a"), userMessage("B", "b")]);
    // Update b's content and add a new message c; b must keep its position.
    store.save([userMessage("B updated", "b"), userMessage("C", "c")]);

    const all = store.all();
    expect(all.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(all[1]!.parts).toEqual([{ type: "text", text: "B updated" }]);
  });

  it("clear() wipes all messages", () => {
    const kv = createMemoryKeyValueStore();
    const store = createMessageStore(kv);
    store.append(userMessage("hi", "1"));
    store.clear();
    expect(store.all()).toEqual([]);
    expect(store.count()).toBe(0);
    expect(store.get("1")).toBeUndefined();
  });

  it("persists across a second store instance over the same KV (eviction survival)", () => {
    const kv = createMemoryKeyValueStore();
    const store1 = createMessageStore(kv);
    store1.append(userMessage("hi", "1"));
    store1.append(userMessage("there", "2"));

    const store2 = createMessageStore(kv);
    expect(store2.all().map((m) => m.id)).toEqual(["1", "2"]);
    expect(store2.count()).toBe(2);
  });

  it("sanitizes messages before persisting (drops transient/unknown fields)", () => {
    const kv = createMemoryKeyValueStore();
    const store = createMessageStore(kv);
    const msg = {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      _ephemeral: { chunkId: "x" },
    } as unknown as ChatMessage;
    store.append(msg);
    expect(store.get("1")).toEqual({ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] });
  });

  it("compacts the largest tool output when a row exceeds maxRowBytes, keeping other parts intact", () => {
    const kv = createMemoryKeyValueStore();
    let oversizeInfo: { messageId: string; originalBytes: number } | undefined;
    const store = createMessageStore(kv, {
      maxRowBytes: 300,
      onOversize: (info) => {
        oversizeInfo = info;
      },
    });

    const bigOutput = { data: "x".repeat(1000) };
    const message: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [
        { type: "text", text: "here you go" },
        {
          type: "tool-search",
          toolCallId: "call_1",
          state: "output-available",
          input: { q: "x" },
          output: bigOutput,
        },
      ],
    };

    store.append(message);
    const stored = store.get("1")!;

    // Message now fits (or is at least dramatically smaller than the raw output).
    expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(message).length);

    // Other parts intact.
    expect(stored.parts[0]).toEqual({ type: "text", text: "here you go" });

    // Tool output replaced with a truncation marker; the message is never dropped.
    const toolPart = stored.parts[1] as ToolPart;
    expect(toolPart.toolCallId).toBe("call_1");
    expect(toolPart.output).toMatchObject({ truncated: true });
    expect((toolPart.output as { originalBytes: number }).originalBytes).toBeGreaterThan(0);
    expect(typeof (toolPart.output as { preview: string }).preview).toBe("string");

    expect(oversizeInfo).toBeDefined();
    expect(oversizeInfo!.messageId).toBe("1");
    expect(oversizeInfo!.originalBytes).toBeGreaterThan(300);
  });

  it("compacts the largest of multiple oversize tool outputs first", () => {
    const kv = createMemoryKeyValueStore();
    const store = createMessageStore(kv, { maxRowBytes: 400 });

    const message: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [
        {
          type: "tool-a",
          toolCallId: "call_1",
          state: "output-available",
          input: {},
          output: { data: "a".repeat(500) },
        },
        {
          type: "tool-b",
          toolCallId: "call_2",
          state: "output-available",
          input: {},
          output: { data: "b".repeat(50) },
        },
      ],
    };

    store.append(message);
    const stored = store.get("1")!;
    const partA = stored.parts[0] as ToolPart;
    const partB = stored.parts[1] as ToolPart;

    // The larger output (call_1) gets compacted first; if that alone brings
    // the row under budget, the smaller one is left alone.
    expect(partA.output).toMatchObject({ truncated: true });
    if (JSON.stringify(stored).length <= 400) {
      expect(partB.output).toEqual({ data: "b".repeat(50) });
    }
  });

  it("does not persist maxRowBytes-sized rows unchanged (no-op when already within budget)", () => {
    const kv = createMemoryKeyValueStore();
    const store = createMessageStore(kv);
    const message = userMessage("small message");
    store.append(message);
    expect(store.get(message.id)).toEqual(message);
  });
});
