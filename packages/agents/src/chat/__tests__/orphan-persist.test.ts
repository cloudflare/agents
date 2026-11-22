import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { persistReconstructedOrphan } from "../orphan-persist";
import type { OrphanPersistStore } from "../orphan-store";

function memoryStore(initial: UIMessage[] = []) {
  const messages = new Map(initial.map((message) => [message.id, message]));
  const store: OrphanPersistStore = {
    getMessage: (id) => messages.get(id) ?? null,
    appendMessage: (message) => {
      messages.set(message.id, message);
    },
    updateMessage: (message) => {
      messages.set(message.id, message);
    }
  };
  return { store, messages };
}

const chunks = (...bodies: Array<Record<string, unknown>>) =>
  bodies.map((body) => ({ body: JSON.stringify(body) }));

const continuationChunks = chunks(
  { type: "start", messageId: "provider-id", messageMetadata: { b: 2 } },
  { type: "text-start", id: "t2" },
  { type: "text-delta", id: "t2", delta: "continued" },
  { type: "text-end", id: "t2" }
);

const leaf = {
  id: "leaf",
  role: "assistant",
  parts: [{ type: "text", text: "earlier", state: "done" }],
  metadata: { a: 1 }
} as UIMessage;

const persist = (
  store: OrphanPersistStore,
  options: { continues?: { messageId: string; basePartCount: number } } = {}
) =>
  persistReconstructedOrphan(continuationChunks, {
    store,
    fallbackId: "fallback",
    prepare: (message) => message,
    merge: (_existing, incoming) => incoming,
    ...options
  });

describe("persistReconstructedOrphan", () => {
  it("adopts a provider start id for a stream with its own message", async () => {
    const { store, messages } = memoryStore();

    await persist(store);

    expect([...messages.keys()]).toEqual(["provider-id"]);
  });

  it("replays a continuation onto the continued message's earlier parts, however often", async () => {
    const { store, messages } = memoryStore([leaf]);

    await persist(store, {
      continues: { messageId: "leaf", basePartCount: 1 }
    });
    await persist(store, {
      continues: { messageId: "leaf", basePartCount: 1 }
    });

    expect([...messages.keys()]).toEqual(["leaf"]);
    expect(messages.get("leaf")).toMatchObject({
      parts: [
        { type: "text", text: "earlier" },
        { type: "text", text: "continued" }
      ],
      metadata: { a: 1, b: 2 }
    });
  });

  it("leaves the store's own copy of the continued message as it was", async () => {
    const stored = {
      id: "leaf",
      role: "assistant",
      parts: [
        {
          type: "tool-t",
          toolCallId: "c1",
          state: "input-available",
          input: {}
        }
      ]
    } as unknown as UIMessage;
    const { store, messages } = memoryStore([stored]);

    await persistReconstructedOrphan(
      chunks({ type: "tool-output-available", toolCallId: "c1", output: 1 }),
      {
        store,
        fallbackId: "fallback",
        prepare: (message) => message,
        merge: (_existing, incoming) => incoming,
        continues: { messageId: "leaf", basePartCount: 1 }
      }
    );

    // The host compares against its copy to decide whether to write.
    expect(stored.parts[0]).toMatchObject({ state: "input-available" });
    expect(messages.get("leaf")?.parts[0]).toMatchObject({
      state: "output-available"
    });
  });

  it("writes nothing for a continuation whose message was deleted, however often", async () => {
    const { store, messages } = memoryStore();

    const wrote = await persist(store, {
      continues: { messageId: "leaf", basePartCount: 1 }
    });
    await persist(store, {
      continues: { messageId: "leaf", basePartCount: 1 }
    });

    expect(wrote).toBe(false);
    expect(messages.size).toBe(0);
  });
});
