import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

/**
 * Tests for #1008: content-based reconciliation mismatches messages
 * with identical text.
 *
 * When two assistant messages have identical content (e.g. "Sure"),
 * _reconcileAssistantIdsWithServerState must map each incoming message
 * to the correct server message without duplicates or mismatches.
 */
describe("Reconcile identical-content assistant messages (#1008)", () => {
  it("maps two identical-content assistant messages to distinct server IDs", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Server state: two "Sure" assistant messages with server-generated IDs
    const serverMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Can you help?" }]
      },
      {
        id: "assistant_s1",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "One more thing" }]
      },
      {
        id: "assistant_s2",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      }
    ];

    await agentStub.persistMessages(serverMessages);

    // Client sends the same conversation but with nanoid IDs for assistants
    // (simulates reconnection where client regenerated local IDs)
    const clientMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Can you help?" }]
      },
      {
        id: "client_x1",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "One more thing" }]
      },
      {
        id: "client_x2",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      }
    ];

    // Persist with _deleteStaleRows to trigger the full merge + reconcile path
    await agentStub.persistMessages(clientMessages, [], {
      _deleteStaleRows: true
    });

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Should have exactly 4 messages — no duplicates
    expect(persisted.length).toBe(4);

    // The assistant messages should have been remapped to server IDs
    const assistantIds = persisted
      .filter((m) => m.role === "assistant")
      .map((m) => m.id);

    expect(assistantIds).toContain("assistant_s1");
    expect(assistantIds).toContain("assistant_s2");
    // No client nanoid IDs should remain
    expect(assistantIds).not.toContain("client_x1");
    expect(assistantIds).not.toContain("client_x2");

    ws.close(1000);
  });

  it("handles mixed exact-ID and content matches without cursor jumping", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Server state
    const serverMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant_s1",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "Thanks" }]
      },
      {
        id: "assistant_s2",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      }
    ];

    await agentStub.persistMessages(serverMessages);

    // Client has the FIRST assistant with the exact server ID (retained from
    // previous session), but the SECOND with a new nanoid.
    // This is the scenario from #1008: exact-ID match on the first "Sure"
    // should not prevent content matching on the second "Sure".
    const clientMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant_s1",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "Thanks" }]
      },
      {
        id: "client_x2",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      }
    ];

    await agentStub.persistMessages(clientMessages, [], {
      _deleteStaleRows: true
    });

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    expect(persisted.length).toBe(4);

    const assistantIds = persisted
      .filter((m) => m.role === "assistant")
      .map((m) => m.id);

    // Both should map to server IDs
    expect(assistantIds).toContain("assistant_s1");
    expect(assistantIds).toContain("assistant_s2");
    expect(assistantIds).not.toContain("client_x2");

    ws.close(1000);
  });

  it("exact-ID match at wrong position does not steal another message's slot", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Server state: two "Sure" messages
    const serverMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      },
      {
        id: "assistant_s1",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "More" }]
      },
      {
        id: "assistant_s2",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      }
    ];

    await agentStub.persistMessages(serverMessages);

    // Client has assistant_s2 at position 1 (wrong position — should be s1).
    // This can happen after state drift or partial cache corruption.
    // The old single-pass cursor would jump to server index 3, skipping s1.
    const clientMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      },
      {
        id: "assistant_s2",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "More" }]
      },
      {
        id: "client_x1",
        role: "assistant",
        parts: [{ type: "text", text: "Sure" }]
      }
    ];

    await agentStub.persistMessages(clientMessages, [], {
      _deleteStaleRows: true
    });

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Should have 4 messages, no orphans
    expect(persisted.length).toBe(4);

    const ids = persisted.map((m) => m.id);
    // assistant_s2 kept via exact-ID match
    expect(ids).toContain("assistant_s2");
    // client_x1 should be remapped to assistant_s1 (the unclaimed server "Sure")
    expect(ids).toContain("assistant_s1");
    // No client nanoid IDs remaining
    expect(ids).not.toContain("client_x1");

    ws.close(1000);
  });

  it("three identical assistant messages all get unique server IDs", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Server state: three "I understand" messages
    const serverMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Point 1" }]
      },
      {
        id: "a_s1",
        role: "assistant",
        parts: [{ type: "text", text: "I understand" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "Point 2" }]
      },
      {
        id: "a_s2",
        role: "assistant",
        parts: [{ type: "text", text: "I understand" }]
      },
      {
        id: "u3",
        role: "user",
        parts: [{ type: "text", text: "Point 3" }]
      },
      {
        id: "a_s3",
        role: "assistant",
        parts: [{ type: "text", text: "I understand" }]
      }
    ];

    await agentStub.persistMessages(serverMessages);

    // Client sends all with nanoid IDs
    const clientMessages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Point 1" }]
      },
      {
        id: "x1",
        role: "assistant",
        parts: [{ type: "text", text: "I understand" }]
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "Point 2" }]
      },
      {
        id: "x2",
        role: "assistant",
        parts: [{ type: "text", text: "I understand" }]
      },
      {
        id: "u3",
        role: "user",
        parts: [{ type: "text", text: "Point 3" }]
      },
      {
        id: "x3",
        role: "assistant",
        parts: [{ type: "text", text: "I understand" }]
      }
    ];

    await agentStub.persistMessages(clientMessages, [], {
      _deleteStaleRows: true
    });

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    expect(persisted.length).toBe(6);

    const assistantIds = persisted
      .filter((m) => m.role === "assistant")
      .map((m) => m.id);

    // All three should map to distinct server IDs
    expect(assistantIds).toHaveLength(3);
    expect(assistantIds).toContain("a_s1");
    expect(assistantIds).toContain("a_s2");
    expect(assistantIds).toContain("a_s3");
    // No client IDs remaining
    expect(assistantIds).not.toContain("x1");
    expect(assistantIds).not.toContain("x2");
    expect(assistantIds).not.toContain("x3");

    ws.close(1000);
  });
});
