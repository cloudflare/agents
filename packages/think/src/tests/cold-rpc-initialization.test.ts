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
  _hostGetMessages(): Promise<
    Array<{ id: string; role: string; content: string }>
  >;
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

  it("hydrates persisted Think history before a cold host-bridge RPC", async () => {
    const namespace = env.ThinkProgrammaticTestAgent;
    const durableStub = namespace.get(namespace.idFromName(uniqueName()));
    const stub = durableStub as unknown as ColdRpcStub;
    const message: UIMessage = {
      id: "host-bridge-cold-rpc-message",
      role: "user",
      parts: [{ type: "text", text: "hydrate for host bridge" }]
    };

    await stub.addMessages([message]);
    await evictDurableObject(durableStub);

    // HostBridgeLoopback reconstructs the already-named Agent stub from its
    // string id, so startup must still resolve the object's name.
    const hostStub = namespace.get(
      namespace.idFromString(durableStub.id.toString())
    ) as unknown as ColdRpcStub;
    expect(await hostStub._hostGetMessages()).toEqual([
      {
        id: message.id,
        role: message.role,
        content: "hydrate for host bridge"
      }
    ]);
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

    // Reuse the existing native stub directly: no getAgentByName() handshake
    // may initialize the reconstructed instance before this RPC.
    expect(await stub.getSessionMessagesForColdRpcTest()).toEqual({
      messages: [message],
      onStartCount: 1
    });
  });
});
