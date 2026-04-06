import { describe, it, expect } from "vitest";
import { parseProtocolMessage } from "../parse-protocol";
import { CHAT_MESSAGE_TYPES } from "../protocol";

describe("parseProtocolMessage", () => {
  it("returns null for non-JSON input", () => {
    expect(parseProtocolMessage("not json")).toBeNull();
    expect(parseProtocolMessage("")).toBeNull();
    expect(parseProtocolMessage("{broken")).toBeNull();
  });

  it("returns null for JSON without type field", () => {
    expect(parseProtocolMessage(JSON.stringify({ id: "abc" }))).toBeNull();
  });

  it("returns null for unrecognized type", () => {
    expect(
      parseProtocolMessage(JSON.stringify({ type: "unknown_type" }))
    ).toBeNull();
  });

  it("parses chat-request", () => {
    const msg = {
      type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
      id: "req-1",
      init: { method: "POST", body: '{"messages":[]}' }
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({
      type: "chat-request",
      id: "req-1",
      init: { method: "POST", body: '{"messages":[]}' }
    });
  });

  it("parses chat-request with missing init", () => {
    const msg = {
      type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
      id: "req-1"
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({
      type: "chat-request",
      id: "req-1",
      init: {}
    });
  });

  it("parses clear", () => {
    const msg = { type: CHAT_MESSAGE_TYPES.CHAT_CLEAR };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({ type: "clear" });
  });

  it("parses cancel", () => {
    const msg = {
      type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
      id: "req-1"
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({ type: "cancel", id: "req-1" });
  });

  it("parses tool-result with all fields", () => {
    const msg = {
      type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
      toolCallId: "tc1",
      toolName: "getWeather",
      output: { temp: 72 },
      state: "output-available",
      errorText: undefined,
      autoContinue: true,
      clientTools: [{ name: "tool1", description: "desc" }]
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "getWeather",
      output: { temp: 72 },
      state: "output-available",
      autoContinue: true,
      clientTools: [{ name: "tool1", description: "desc" }]
    });
  });

  it("parses tool-result with minimal fields", () => {
    const msg = {
      type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
      toolCallId: "tc1",
      output: "result"
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool-result");
    if (event?.type === "tool-result") {
      expect(event.toolCallId).toBe("tc1");
      expect(event.toolName).toBe("");
      expect(event.output).toBe("result");
      expect(event.autoContinue).toBeUndefined();
      expect(event.clientTools).toBeUndefined();
    }
  });

  it("parses tool-approval", () => {
    const msg = {
      type: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
      toolCallId: "tc1",
      approved: true,
      autoContinue: true
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({
      type: "tool-approval",
      toolCallId: "tc1",
      approved: true,
      autoContinue: true
    });
  });

  it("parses stream-resume-request", () => {
    const msg = { type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({ type: "stream-resume-request" });
  });

  it("parses stream-resume-ack", () => {
    const msg = {
      type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
      id: "req-1"
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({ type: "stream-resume-ack", id: "req-1" });
  });

  it("parses messages", () => {
    const msgs = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }
    ];
    const msg = {
      type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
      messages: msgs
    };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({ type: "messages", messages: msgs });
  });

  it("parses messages with missing messages field", () => {
    const msg = { type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES };
    const event = parseProtocolMessage(JSON.stringify(msg));
    expect(event).toEqual({ type: "messages", messages: [] });
  });

  it("does not parse server-to-client types", () => {
    expect(
      parseProtocolMessage(
        JSON.stringify({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE })
      )
    ).toBeNull();
    expect(
      parseProtocolMessage(
        JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING })
      )
    ).toBeNull();
    expect(
      parseProtocolMessage(
        JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE })
      )
    ).toBeNull();
    expect(
      parseProtocolMessage(
        JSON.stringify({ type: CHAT_MESSAGE_TYPES.MESSAGE_UPDATED })
      )
    ).toBeNull();
  });
});
