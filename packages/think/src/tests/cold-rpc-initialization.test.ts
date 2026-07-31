import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

type ColdRpcStub = {
  addMessages(messages: UIMessage[]): Promise<void>;
  getMessages(): Promise<UIMessage[]>;
  getSessionMessagesForColdRpcTest(): Promise<{
    messages: UIMessage[];
    onStartCount: number;
  }>;
};

function uniqueName(): string {
  return `cold-rpc-${Date.now()}-${crypto.randomUUID()}`;
}

describe("native RPC initialization", () => {
  it("initializes Think before the first inherited RPC method executes", async () => {
    const namespace = env.ThinkProgrammaticTestAgent;
    const stub = namespace.get(
      namespace.idFromName(uniqueName())
    ) as unknown as ColdRpcStub;
    const message: UIMessage = {
      id: "cold-rpc-message",
      role: "user",
      parts: [{ type: "text", text: "hello" }]
    };

    // Deliberately bypass getServerByName()/getAgentByName(): the first contact
    // with this instance is a native Durable Object RPC.
    await stub.addMessages([message]);

    expect(await stub.getMessages()).toEqual([message]);
    expect(await stub.getSessionMessagesForColdRpcTest()).toMatchObject({
      onStartCount: 1
    });
  });

  it("initializes Think before the first subclass RPC method executes", async () => {
    const namespace = env.ThinkProgrammaticTestAgent;
    const stub = namespace.get(
      namespace.idFromName(uniqueName())
    ) as unknown as ColdRpcStub;

    expect(await stub.getSessionMessagesForColdRpcTest()).toEqual({
      messages: [],
      onStartCount: 1
    });
  });

  it("hydrates persisted Think history when native RPC is first after eviction", async () => {
    const namespace = env.ThinkProgrammaticTestAgent;
    const durableStub = namespace.get(namespace.idFromName(uniqueName()));
    const stub = durableStub as unknown as ColdRpcStub;
    const message: UIMessage = {
      id: "evicted-cold-rpc-message",
      role: "user",
      parts: [{ type: "text", text: "survive eviction" }]
    };

    await stub.addMessages([message]);
    await evictDurableObject(durableStub);

    // Reuse the existing native stub directly: no getServerByName()/setName()
    // handshake may initialize the reconstructed instance before this RPC.
    expect(await stub.getSessionMessagesForColdRpcTest()).toEqual({
      messages: [message],
      onStartCount: 1
    });
  });
});
