import { describe, expect, it } from "vitest";
import { WorkingContext, buildWorkingContext } from "../context";
import { EventAction } from "../types";
import type { SessionEvent, ContextMessage } from "../types";

// ---------------------------------------------------------------------------
// WorkingContext
// ---------------------------------------------------------------------------

describe("WorkingContext", () => {
  it("initializes with empty messages and instructions", () => {
    const ctx = new WorkingContext();
    expect(ctx.messages).toEqual([]);
    expect(ctx.systemInstructions).toEqual([]);
    expect(ctx.getNewMessages()).toEqual([]);
  });

  it("initializes with provided messages and instructions", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" }
    ];
    const ctx = new WorkingContext(["Be helpful."], msgs);
    expect(ctx.systemInstructions).toEqual(["Be helpful."]);
    expect(ctx.messages).toHaveLength(2);
    // Initial messages are NOT new
    expect(ctx.getNewMessages()).toEqual([]);
  });

  it("tracks new messages added after construction", () => {
    const initial: ContextMessage[] = [{ role: "user", content: "Hello" }];
    const ctx = new WorkingContext([], initial);

    ctx.addMessage({ role: "assistant", content: "Hi" });
    ctx.addMessage({ role: "user", content: "How are you?" });

    expect(ctx.messages).toHaveLength(3);
    expect(ctx.getNewMessages()).toHaveLength(2);
    expect(ctx.getNewMessages()[0]).toEqual({
      role: "assistant",
      content: "Hi"
    });
    expect(ctx.getNewMessages()[1]).toEqual({
      role: "user",
      content: "How are you?"
    });
  });

  it("returns empty new messages when nothing was added", () => {
    const ctx = new WorkingContext(
      ["system"],
      [{ role: "user", content: "Hello" }]
    );
    expect(ctx.getNewMessages()).toEqual([]);
  });

  it("handles addMessage on empty context", () => {
    const ctx = new WorkingContext();
    ctx.addMessage({ role: "user", content: "First" });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.getNewMessages()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildWorkingContext
// ---------------------------------------------------------------------------

describe("buildWorkingContext", () => {
  const makeEvent = (
    action: SessionEvent["action"],
    content: string,
    seq: number
  ): SessionEvent => {
    const base = {
      id: `e${seq}`,
      sessionId: "s1",
      seq,
      timestamp: seq * 1000
    };

    switch (action) {
      case EventAction.USER_MESSAGE:
        return { ...base, action, content };
      case EventAction.AGENT_MESSAGE:
        return { ...base, action, content };
      case EventAction.TOOL_CALL_REQUEST:
        return { ...base, action, content, toolCalls: [] };
      case EventAction.TOOL_RESULT:
        return {
          ...base,
          action,
          content,
          toolCallId: "tc1",
          toolName: "test",
          isSuccess: true
        };
      case EventAction.SYSTEM_INSTRUCTION:
        return { ...base, action, content };
      case EventAction.COMPACTION:
        return { ...base, action, content, compactedEventCount: 0 };
      default:
        return { ...base, action: EventAction.USER_MESSAGE, content };
    }
  };

  it("builds context from a sequence of events", () => {
    const events: SessionEvent[] = [
      makeEvent(EventAction.USER_MESSAGE, "Hello", 0),
      makeEvent(EventAction.AGENT_MESSAGE, "Hi there", 1),
      makeEvent(EventAction.USER_MESSAGE, "What's 2+2?", 2)
    ];

    const ctx = buildWorkingContext(events);

    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(ctx.messages[1]).toEqual({ role: "assistant", content: "Hi there" });
    expect(ctx.messages[2]).toEqual({ role: "user", content: "What's 2+2?" });
    expect(ctx.systemInstructions).toEqual([]);
    // All loaded messages are initial — no new messages
    expect(ctx.getNewMessages()).toEqual([]);
  });

  it("sets system instructions from options", () => {
    const ctx = buildWorkingContext([], {
      systemInstructions: ["Be helpful.", "Be concise."]
    });
    expect(ctx.systemInstructions).toEqual(["Be helpful.", "Be concise."]);
    expect(ctx.messages).toEqual([]);
  });

  it("uses custom eventToMessage mapper", () => {
    const events: SessionEvent[] = [
      makeEvent(EventAction.USER_MESSAGE, "Hello", 0),
      makeEvent(EventAction.AGENT_MESSAGE, "Hi", 1)
    ];

    const ctx = buildWorkingContext(events, {
      eventToMessage: (event) => {
        // Only include user messages, skip agent messages
        if (event.action === EventAction.USER_MESSAGE) {
          return { role: "user", content: `[custom] ${event.content}` };
        }
        return null;
      }
    });

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]).toEqual({
      role: "user",
      content: "[custom] Hello"
    });
  });

  it("handles empty events array", () => {
    const ctx = buildWorkingContext([]);
    expect(ctx.messages).toEqual([]);
    expect(ctx.getNewMessages()).toEqual([]);
  });

  it("handles tool call events correctly", () => {
    const toolCallEvent: SessionEvent = {
      id: "e1",
      sessionId: "s1",
      seq: 0,
      timestamp: 1000,
      action: EventAction.TOOL_CALL_REQUEST,
      content: "",
      toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }]
    };
    const toolResultEvent: SessionEvent = {
      id: "e2",
      sessionId: "s1",
      seq: 1,
      timestamp: 2000,
      action: EventAction.TOOL_RESULT,
      content: "search results",
      toolCallId: "tc1",
      toolName: "search",
      isSuccess: true
    };

    const ctx = buildWorkingContext([toolCallEvent, toolResultEvent]);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }]
    });
    expect(ctx.messages[1]).toEqual({
      role: "tool",
      content: "search results",
      toolCallId: "tc1",
      name: "search"
    });
  });

  it("new messages added after build are tracked", () => {
    const events: SessionEvent[] = [
      makeEvent(EventAction.USER_MESSAGE, "Hello", 0)
    ];
    const ctx = buildWorkingContext(events, {
      systemInstructions: ["Be helpful."]
    });

    expect(ctx.getNewMessages()).toEqual([]);

    ctx.addMessage({ role: "assistant", content: "Hi!" });
    ctx.addMessage({ role: "user", content: "Follow up" });

    expect(ctx.getNewMessages()).toHaveLength(2);
    expect(ctx.messages).toHaveLength(3);
  });
});
