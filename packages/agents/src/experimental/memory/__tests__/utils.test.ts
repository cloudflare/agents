import { describe, expect, it } from "vitest";
import {
  hydrateEvent,
  dehydrateEvent,
  eventToMessage,
  messageToEvent,
} from "../utils";
import { EventAction } from "../types";
import type { StoredEvent, SessionEvent, ContextMessage } from "../types";

// ---------------------------------------------------------------------------
// hydrateEvent
// ---------------------------------------------------------------------------

describe("hydrateEvent", () => {
  it("hydrates a user_message row", () => {
    const row: StoredEvent = {
      id: "e1",
      session_id: "s1",
      seq: 0,
      action: "user_message",
      content: "Hello",
      metadata: null,
      created_at: 1000,
    };
    const event = hydrateEvent(row);
    expect(event).toEqual({
      id: "e1",
      sessionId: "s1",
      seq: 0,
      timestamp: 1000,
      action: EventAction.USER_MESSAGE,
      content: "Hello",
    });
  });

  it("hydrates an agent_message row with model metadata", () => {
    const row: StoredEvent = {
      id: "e2",
      session_id: "s1",
      seq: 1,
      action: "agent_message",
      content: "Hi there",
      metadata: JSON.stringify({ model: "llama-3" }),
      created_at: 2000,
    };
    const event = hydrateEvent(row);
    expect(event.action).toBe(EventAction.AGENT_MESSAGE);
    if (event.action === EventAction.AGENT_MESSAGE) {
      expect(event.content).toBe("Hi there");
      expect(event.model).toBe("llama-3");
    }
  });

  it("hydrates a tool_call_request row", () => {
    const toolCalls = [{ id: "tc1", name: "search", arguments: { q: "test" } }];
    const row: StoredEvent = {
      id: "e3",
      session_id: "s1",
      seq: 2,
      action: "tool_call_request",
      content: "",
      metadata: JSON.stringify({ toolCalls }),
      created_at: 3000,
    };
    const event = hydrateEvent(row);
    expect(event.action).toBe(EventAction.TOOL_CALL_REQUEST);
    if (event.action === EventAction.TOOL_CALL_REQUEST) {
      expect(event.toolCalls).toEqual(toolCalls);
    }
  });

  it("hydrates a tool_result row", () => {
    const row: StoredEvent = {
      id: "e4",
      session_id: "s1",
      seq: 3,
      action: "tool_result",
      content: "result data",
      metadata: JSON.stringify({
        toolCallId: "tc1",
        toolName: "search",
        isSuccess: true,
      }),
      created_at: 4000,
    };
    const event = hydrateEvent(row);
    expect(event.action).toBe(EventAction.TOOL_RESULT);
    if (event.action === EventAction.TOOL_RESULT) {
      expect(event.toolCallId).toBe("tc1");
      expect(event.toolName).toBe("search");
      expect(event.isSuccess).toBe(true);
    }
  });

  it("hydrates a compaction row", () => {
    const row: StoredEvent = {
      id: "e5",
      session_id: "s1",
      seq: 4,
      action: "compaction",
      content: "Summary of prior conversation.",
      metadata: JSON.stringify({ compactedEventCount: 20 }),
      created_at: 5000,
    };
    const event = hydrateEvent(row);
    expect(event.action).toBe(EventAction.COMPACTION);
    if (event.action === EventAction.COMPACTION) {
      expect(event.compactedEventCount).toBe(20);
    }
  });

  it("hydrates a system_instruction row", () => {
    const row: StoredEvent = {
      id: "e6",
      session_id: "s1",
      seq: 5,
      action: "system_instruction",
      content: "You are helpful.",
      metadata: null,
      created_at: 6000,
    };
    const event = hydrateEvent(row);
    expect(event.action).toBe(EventAction.SYSTEM_INSTRUCTION);
    expect(event.content).toBe("You are helpful.");
  });

  it("treats unknown action as user_message", () => {
    const row: StoredEvent = {
      id: "e7",
      session_id: "s1",
      seq: 6,
      action: "unknown_action",
      content: "some content",
      metadata: null,
      created_at: 7000,
    };
    const event = hydrateEvent(row);
    expect(event.action).toBe(EventAction.USER_MESSAGE);
    expect(event.content).toBe("some content");
  });

  it("handles null content as empty string", () => {
    const row: StoredEvent = {
      id: "e8",
      session_id: "s1",
      seq: 7,
      action: "user_message",
      content: null,
      metadata: null,
      created_at: 8000,
    };
    const event = hydrateEvent(row);
    expect(event.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// dehydrateEvent
// ---------------------------------------------------------------------------

describe("dehydrateEvent", () => {
  it("dehydrates a user_message event", () => {
    const event: SessionEvent = {
      id: "e1",
      sessionId: "s1",
      seq: 0,
      timestamp: 1000,
      action: EventAction.USER_MESSAGE,
      content: "Hello",
    };
    const row = dehydrateEvent(event);
    expect(row).toEqual({
      id: "e1",
      session_id: "s1",
      seq: 0,
      action: "user_message",
      content: "Hello",
      metadata: null,
      created_at: 1000,
    });
  });

  it("dehydrates an agent_message with model", () => {
    const event: SessionEvent = {
      id: "e2",
      sessionId: "s1",
      seq: 1,
      timestamp: 2000,
      action: EventAction.AGENT_MESSAGE,
      content: "Hi",
      model: "llama-3",
    };
    const row = dehydrateEvent(event);
    expect(row.metadata).toBe(JSON.stringify({ model: "llama-3" }));
  });

  it("dehydrates agent_message without model (null metadata)", () => {
    const event: SessionEvent = {
      id: "e2b",
      sessionId: "s1",
      seq: 1,
      timestamp: 2000,
      action: EventAction.AGENT_MESSAGE,
      content: "Hi",
    };
    const row = dehydrateEvent(event);
    expect(row.metadata).toBeNull();
  });

  it("dehydrates a tool_call_request event", () => {
    const event: SessionEvent = {
      id: "e3",
      sessionId: "s1",
      seq: 2,
      timestamp: 3000,
      action: EventAction.TOOL_CALL_REQUEST,
      content: "",
      toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }],
    };
    const row = dehydrateEvent(event);
    expect(JSON.parse(row.metadata!)).toEqual({
      toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }],
    });
  });

  it("dehydrates a tool_result event", () => {
    const event: SessionEvent = {
      id: "e4",
      sessionId: "s1",
      seq: 3,
      timestamp: 4000,
      action: EventAction.TOOL_RESULT,
      content: "result",
      toolCallId: "tc1",
      toolName: "search",
      isSuccess: true,
    };
    const row = dehydrateEvent(event);
    expect(JSON.parse(row.metadata!)).toEqual({
      toolCallId: "tc1",
      toolName: "search",
      isSuccess: true,
    });
  });

  it("roundtrips hydrate → dehydrate → hydrate", () => {
    const original: StoredEvent = {
      id: "e10",
      session_id: "s1",
      seq: 10,
      action: "tool_call_request",
      content: "",
      metadata: JSON.stringify({
        toolCalls: [{ id: "tc5", name: "calc", arguments: { x: 42 } }],
      }),
      created_at: 10000,
    };

    const hydrated = hydrateEvent(original);
    const dehydrated = dehydrateEvent(hydrated);
    const rehydrated = hydrateEvent(dehydrated);

    expect(rehydrated).toEqual(hydrated);
  });
});

// ---------------------------------------------------------------------------
// eventToMessage
// ---------------------------------------------------------------------------

describe("eventToMessage", () => {
  it("maps user_message to user role", () => {
    const event: SessionEvent = {
      id: "e1",
      sessionId: "s1",
      seq: 0,
      timestamp: 1000,
      action: EventAction.USER_MESSAGE,
      content: "Hello",
    };
    const msg = eventToMessage(event);
    expect(msg).toEqual({ role: "user", content: "Hello" });
  });

  it("maps agent_message to assistant role", () => {
    const event: SessionEvent = {
      id: "e2",
      sessionId: "s1",
      seq: 1,
      timestamp: 2000,
      action: EventAction.AGENT_MESSAGE,
      content: "Hi there",
    };
    const msg = eventToMessage(event);
    expect(msg).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("maps tool_call_request to assistant role with toolCalls", () => {
    const event: SessionEvent = {
      id: "e3",
      sessionId: "s1",
      seq: 2,
      timestamp: 3000,
      action: EventAction.TOOL_CALL_REQUEST,
      content: "",
      toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }],
    };
    const msg = eventToMessage(event);
    expect(msg).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }],
    });
  });

  it("maps tool_result to tool role with toolCallId and name", () => {
    const event: SessionEvent = {
      id: "e4",
      sessionId: "s1",
      seq: 3,
      timestamp: 4000,
      action: EventAction.TOOL_RESULT,
      content: "result data",
      toolCallId: "tc1",
      toolName: "search",
      isSuccess: true,
    };
    const msg = eventToMessage(event);
    expect(msg).toEqual({
      role: "tool",
      content: "result data",
      toolCallId: "tc1",
      name: "search",
    });
  });

  it("maps system_instruction to system role", () => {
    const event: SessionEvent = {
      id: "e5",
      sessionId: "s1",
      seq: 4,
      timestamp: 5000,
      action: EventAction.SYSTEM_INSTRUCTION,
      content: "Be helpful.",
    };
    const msg = eventToMessage(event);
    expect(msg).toEqual({ role: "system", content: "Be helpful." });
  });

  it("maps compaction to system role", () => {
    const event: SessionEvent = {
      id: "e6",
      sessionId: "s1",
      seq: 5,
      timestamp: 6000,
      action: EventAction.COMPACTION,
      content: "Summary of prior 20 messages.",
      compactedEventCount: 20,
    };
    const msg = eventToMessage(event);
    expect(msg).toEqual({
      role: "system",
      content: "Summary of prior 20 messages.",
    });
  });
});

// ---------------------------------------------------------------------------
// messageToEvent
// ---------------------------------------------------------------------------

describe("messageToEvent", () => {
  it("converts a user message", () => {
    const msg: ContextMessage = { role: "user", content: "Hello" };
    const event = messageToEvent("s1", msg);
    expect(event.action).toBe(EventAction.USER_MESSAGE);
    expect(event.content).toBe("Hello");
    expect(event.sessionId).toBe("s1");
    expect(event.seq).toBe(0); // placeholder
    expect(event.id).toBeTruthy();
  });

  it("converts an assistant message without tool calls", () => {
    const msg: ContextMessage = { role: "assistant", content: "Hi there" };
    const event = messageToEvent("s1", msg);
    expect(event.action).toBe(EventAction.AGENT_MESSAGE);
  });

  it("converts an assistant message WITH tool calls to tool_call_request", () => {
    const msg: ContextMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }],
    };
    const event = messageToEvent("s1", msg);
    expect(event.action).toBe(EventAction.TOOL_CALL_REQUEST);
    if (event.action === EventAction.TOOL_CALL_REQUEST) {
      expect(event.toolCalls).toEqual([
        { id: "tc1", name: "search", arguments: { q: "test" } },
      ]);
    }
  });

  it("converts a tool message", () => {
    const msg: ContextMessage = {
      role: "tool",
      content: "result",
      toolCallId: "tc1",
      name: "search",
    };
    const event = messageToEvent("s1", msg);
    expect(event.action).toBe(EventAction.TOOL_RESULT);
    if (event.action === EventAction.TOOL_RESULT) {
      expect(event.toolCallId).toBe("tc1");
      expect(event.toolName).toBe("search");
    }
  });

  it("converts a system message", () => {
    const msg: ContextMessage = { role: "system", content: "Be helpful." };
    const event = messageToEvent("s1", msg);
    expect(event.action).toBe(EventAction.SYSTEM_INSTRUCTION);
  });

  it("generates unique IDs for each call", () => {
    const msg: ContextMessage = { role: "user", content: "test" };
    const e1 = messageToEvent("s1", msg);
    const e2 = messageToEvent("s1", msg);
    expect(e1.id).not.toBe(e2.id);
  });
});
