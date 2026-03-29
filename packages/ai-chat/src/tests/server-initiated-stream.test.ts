import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { ChatResponseResult } from "../";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

/**
 * Integration tests for server-initiated streaming.
 * Verifies the full round-trip: server calls saveMessages → onChatMessage
 * → stream chunks broadcast to connected clients → onChatResponse fires.
 */
describe("Server-initiated streaming integration", () => {
  it("broadcasts stream chunks to an observer WebSocket when saveMessages triggers onChatMessage", async () => {
    const room = crypto.randomUUID();

    // Connect an observer WebSocket — this simulates a "different tab"
    // that will receive the server-initiated stream broadcast
    const { ws: observer } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const chunks: unknown[] = [];
    let doneReceived = false;
    const donePromise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      observer.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (isUseChatResponseMessage(data)) {
          chunks.push(data);
          if (data.done) {
            doneReceived = true;
            clearTimeout(timeout);
            resolve(true);
          }
        }
      });
    });

    // Trigger a server-initiated stream via saveMessages (RPC call)
    const agentStub = await getAgentByName(env.ResponseAgent, room);
    await agentStub.saveSyntheticUserMessage("Server-initiated hello");

    const done = await donePromise;
    expect(done).toBe(true);
    expect(doneReceived).toBe(true);

    // Should have received stream chunks before the done signal
    const nonEmptyChunks = chunks.filter(
      (c) =>
        isUseChatResponseMessage(c) &&
        typeof c.body === "string" &&
        c.body.trim().length > 0
    );
    expect(nonEmptyChunks.length).toBeGreaterThanOrEqual(1);

    // onChatResponse should have fired with "completed"
    await new Promise((r) => setTimeout(r, 200));
    const results =
      (await agentStub.getChatResponseResults()) as ChatResponseResult[];
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");

    observer.close(1000);
  });

  it("observer client receives stream from multi-connection scenario", async () => {
    const room = crypto.randomUUID();

    // Connect two clients to the same agent
    const { ws: client1 } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    const { ws: client2 } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    // Client 2 is the observer — track what it receives
    const client2Chunks: unknown[] = [];
    const client2Done = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      client2.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (isUseChatResponseMessage(data)) {
          client2Chunks.push(data);
          if (data.done) {
            clearTimeout(timeout);
            resolve(true);
          }
        }
      });
    });

    // Client 1 sends a chat request — client 2 should see the broadcast
    const client1Done = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      client1.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (isUseChatResponseMessage(data) && data.done) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
    });

    client1.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-multi-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg-multi-1",
                role: "user",
                parts: [{ type: "text", text: "Hello from client 1" }]
              }
            ],
            chunkCount: 3,
            chunkDelayMs: 10
          })
        }
      })
    );

    expect(await client1Done).toBe(true);
    expect(await client2Done).toBe(true);

    // Client 2 should have received stream chunks (text events)
    expect(client2Chunks.length).toBeGreaterThanOrEqual(1);

    // onChatResponse should have fired exactly once
    const agentStub = await getAgentByName(env.ResponseAgent, room);
    await new Promise((r) => setTimeout(r, 200));
    const results =
      (await agentStub.getChatResponseResults()) as ChatResponseResult[];
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
    expect(results[0].requestId).toBe("req-multi-1");

    client1.close(1000);
    client2.close(1000);
  });

  it("sequential saveMessages calls each fire onChatResponse", async () => {
    const room = crypto.randomUUID();
    const { ws: observer } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.ResponseAgent, room);

    // First saveMessages
    let doneCount = 0;
    observer.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (isUseChatResponseMessage(data) && data.done) {
        doneCount++;
      }
    });

    await agentStub.saveSyntheticUserMessage("First server message");
    await agentStub.waitForIdleForTest();
    await new Promise((r) => setTimeout(r, 200));

    await agentStub.saveSyntheticUserMessage("Second server message");
    await agentStub.waitForIdleForTest();
    await new Promise((r) => setTimeout(r, 200));

    const results =
      (await agentStub.getChatResponseResults()) as ChatResponseResult[];
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("completed");
    expect(results[1].status).toBe("completed");

    // Both streams should have sent done signals to the observer
    expect(doneCount).toBeGreaterThanOrEqual(2);

    observer.close(1000);
  });
});
