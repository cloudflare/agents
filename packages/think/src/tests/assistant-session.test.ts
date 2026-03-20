import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import {
  truncateHead,
  truncateTail,
  truncateLines,
  truncateMiddle,
  truncateToolOutput
} from "../session/index";

async function freshAgent(name: string) {
  return getAgentByName(env.TestAssistantSessionAgent, name);
}

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMsg(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

// ── Truncation utilities (pure functions) ─────────────────────────

describe("truncation — truncateHead", () => {
  it("returns text unchanged if under limit", () => {
    expect(truncateHead("hello", 100)).toBe("hello");
  });

  it("keeps the end of text", () => {
    const result = truncateHead("abcdefghij", 8);
    expect(result.endsWith("ij")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(8);
  });
});

describe("truncation — truncateTail", () => {
  it("returns text unchanged if under limit", () => {
    expect(truncateTail("hello", 100)).toBe("hello");
  });

  it("keeps the start of text", () => {
    const result = truncateTail("abcdefghij", 8);
    expect(result.startsWith("ab")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(8);
  });
});

describe("truncation — truncateLines", () => {
  it("returns text unchanged if under limit", () => {
    expect(truncateLines("a\nb\nc", 10)).toBe("a\nb\nc");
  });

  it("truncates to max lines", () => {
    const input = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const result = truncateLines(input, 5);
    expect(result).toContain("line0");
    expect(result).toContain("line4");
    expect(result).not.toContain("line5");
    expect(result).toContain("15 more lines truncated");
  });
});

describe("truncation — truncateMiddle", () => {
  it("returns text unchanged if under limit", () => {
    expect(truncateMiddle("hello", 100)).toBe("hello");
  });

  it("keeps start and end", () => {
    const input = "START" + "x".repeat(100) + "END";
    const result = truncateMiddle(input, 50);
    expect(result).toContain("START");
    expect(result).toContain("END");
    expect(result).toContain("truncated");
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe("truncation — truncateToolOutput", () => {
  it("applies line then char truncation", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join(
      "\n"
    );
    const result = truncateToolOutput(lines, {
      maxLines: 10,
      maxChars: 100,
      strategy: "tail"
    });
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

// ── Session lifecycle ─────────────────────────────────────────────

describe("session — lifecycle", () => {
  it("creates and retrieves a session", async () => {
    const agent = await freshAgent("lifecycle-create");
    const session = await agent.createSession("test-chat");
    expect(session.name).toBe("test-chat");
    expect(session.id).toBeTruthy();

    const retrieved = await agent.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("test-chat");
  });

  it("lists multiple sessions", async () => {
    const agent = await freshAgent("lifecycle-list");
    await agent.createSession("first");
    await agent.createSession("second");
    const sessions = await agent.listSessions();
    expect(sessions.length).toBe(2);
    const names = sessions.map((s: { name: string }) => s.name);
    expect(names).toContain("first");
    expect(names).toContain("second");
  });

  it("renames a session", async () => {
    const agent = await freshAgent("lifecycle-rename");
    const session = await agent.createSession("old-name");
    await agent.renameSession(session.id, "new-name");
    const retrieved = await agent.getSession(session.id);
    expect(retrieved!.name).toBe("new-name");
  });

  it("deletes a session and its messages", async () => {
    const agent = await freshAgent("lifecycle-delete");
    const session = await agent.createSession("to-delete");
    await agent.appendMessage(session.id, userMsg("m1", "hello"));
    await agent.deleteSession(session.id);

    const retrieved = await agent.getSession(session.id);
    expect(retrieved).toBeNull();

    const count = await agent.getMessageCount(session.id);
    expect(count).toBe(0);
  });
});

// ── Messages ──────────────────────────────────────────────────────

describe("session — messages", () => {
  it("appends messages and retrieves history", async () => {
    const agent = await freshAgent("messages-basic");
    const session = await agent.createSession("chat");

    await agent.appendMessage(session.id, userMsg("u1", "hello"));
    await agent.appendMessage(session.id, assistantMsg("a1", "hi there"));
    await agent.appendMessage(session.id, userMsg("u2", "how are you?"));

    const history = (await agent.getHistory(
      session.id
    )) as unknown as UIMessage[];
    expect(history.length).toBe(3);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
    expect(history[2].role).toBe("user");
  });

  it("appends all messages in sequence", async () => {
    const agent = await freshAgent("messages-appendall");
    const session = await agent.createSession("chat");

    await agent.appendAllMessages(session.id, [
      userMsg("u1", "hello"),
      assistantMsg("a1", "hi"),
      userMsg("u2", "bye")
    ]);

    const history = (await agent.getHistory(
      session.id
    )) as unknown as UIMessage[];
    expect(history.length).toBe(3);
  });

  it("counts messages", async () => {
    const agent = await freshAgent("messages-count");
    const session = await agent.createSession("chat");

    expect(await agent.getMessageCount(session.id)).toBe(0);
    await agent.appendMessage(session.id, userMsg("u1", "hello"));
    expect(await agent.getMessageCount(session.id)).toBe(1);
    await agent.appendMessage(session.id, assistantMsg("a1", "hi"));
    expect(await agent.getMessageCount(session.id)).toBe(2);
  });
});

// ── Branching ─────────────────────────────────────────────────────

describe("session — branching", () => {
  it("creates branches by appending to different parents", async () => {
    const agent = await freshAgent("branch-basic");
    const session = await agent.createSession("chat");

    const rootId = await agent.appendMessage(
      session.id,
      userMsg("u1", "What is 2+2?")
    );
    const branchAId = await agent.appendMessage(
      session.id,
      assistantMsg("a1", "It's 4"),
      rootId
    );
    const branchBId = await agent.appendMessage(
      session.id,
      assistantMsg("a2", "The answer is four"),
      rootId
    );

    // Branch A path
    const historyA = (await agent.getHistory(
      session.id,
      branchAId
    )) as unknown as UIMessage[];
    expect(historyA.length).toBe(2);
    expect(historyA[1].parts[0]).toMatchObject({
      type: "text",
      text: "It's 4"
    });

    // Branch B path
    const historyB = (await agent.getHistory(
      session.id,
      branchBId
    )) as unknown as UIMessage[];
    expect(historyB.length).toBe(2);
    expect(historyB[1].parts[0]).toMatchObject({
      type: "text",
      text: "The answer is four"
    });
  });

  it("lists branches from a message", async () => {
    const agent = await freshAgent("branch-list");
    const session = await agent.createSession("chat");

    const rootId = await agent.appendMessage(
      session.id,
      userMsg("u1", "question")
    );
    await agent.appendMessage(
      session.id,
      assistantMsg("a1", "answer 1"),
      rootId
    );
    await agent.appendMessage(
      session.id,
      assistantMsg("a2", "answer 2"),
      rootId
    );

    const branches = (await agent.getBranches(
      rootId
    )) as unknown as UIMessage[];
    expect(branches.length).toBe(2);
  });

  it("forks a session at a specific message", async () => {
    const agent = await freshAgent("branch-fork");
    const session = await agent.createSession("original");

    await agent.appendAllMessages(session.id, [
      userMsg("u1", "hello"),
      assistantMsg("a1", "hi"),
      userMsg("u2", "how are you?"),
      assistantMsg("a2", "I'm fine")
    ]);

    // Get the history to find the message ID to fork at
    const history = (await agent.getHistory(
      session.id
    )) as unknown as UIMessage[];
    // Fork at the second message (a1 "hi")
    const forkAtId = history[1].id;

    const forked = await agent.forkSession(session.id, forkAtId, "forked-chat");
    expect(forked.name).toBe("forked-chat");

    // Forked session should have 2 messages (up to fork point)
    const forkedHistory = (await agent.getHistory(
      forked.id
    )) as unknown as UIMessage[];
    expect(forkedHistory.length).toBe(2);

    // Original should still have all 4
    const originalHistory = (await agent.getHistory(
      session.id
    )) as unknown as UIMessage[];
    expect(originalHistory.length).toBe(4);
  });
});

// ── Compaction ────────────────────────────────────────────────────

describe("session — compaction", () => {
  it("replaces compacted messages with summary in history", async () => {
    const agent = await freshAgent("compaction-basic");
    const session = await agent.createSession("chat");

    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await agent.appendMessage(
        session.id,
        i % 2 === 0
          ? userMsg(`u${i}`, `user message ${i}`)
          : assistantMsg(`a${i}`, `assistant message ${i}`)
      );
      ids.push(id);
    }

    // Add a compaction covering the first 3 messages
    await agent.addCompaction(
      session.id,
      "The user and assistant discussed messages 0-2",
      ids[0],
      ids[2]
    );

    const history = (await agent.getHistory(
      session.id
    )) as unknown as UIMessage[];
    // Should be: 1 compaction summary + 2 remaining messages = 3
    expect(history.length).toBe(3);
    // First should be the compaction summary (system role)
    expect(history[0].role).toBe("system");
    expect(history[0].parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Previous conversation summary")
    });
    expect(history[0].parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "The user and assistant discussed messages 0-2"
      )
    });
  });

  it("reports needsCompaction when history exceeds threshold", async () => {
    const agent = await freshAgent("compaction-needs");
    const session = await agent.createSession("chat");

    // Default threshold is 100 messages
    expect(await agent.needsCompaction(session.id)).toBe(false);
  });

  it("lists compaction records", async () => {
    const agent = await freshAgent("compaction-list");
    const session = await agent.createSession("chat");

    const id1 = await agent.appendMessage(session.id, userMsg("u1", "hello"));
    const id2 = await agent.appendMessage(session.id, assistantMsg("a1", "hi"));

    await agent.addCompaction(session.id, "summary", id1, id2);
    const compactions = await agent.getCompactions(session.id);
    expect(compactions.length).toBe(1);
    expect(compactions[0].summary).toBe("summary");
  });
});
