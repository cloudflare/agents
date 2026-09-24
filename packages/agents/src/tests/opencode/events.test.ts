import { describe, expect, it } from "vitest";
import { OperationStreamWriter, projectEvent } from "../../opencode/events";
import type { StreamWriter } from "../../streams";

describe("OperationStreamWriter", () => {
  it("propagates durable append failures so projection can retry", () => {
    const appended: unknown[] = [];
    let failing = true;
    const durable = {
      append(value: unknown) {
        if (failing) throw new Error("append failed");
        appended.push(value);
        return 1;
      },
      close() {}
    } as unknown as StreamWriter;
    const writer = new OperationStreamWriter({
      streamId: "stream",
      operationId: "operation",
      writer: durable
    });
    writer.push({
      type: "text_delta",
      messageId: "message",
      partId: "part",
      delta: "hello"
    });

    expect(() => writer.flush()).toThrow("append failed");
    failing = false;
    writer.push({
      type: "text_delta",
      messageId: "message",
      partId: "part",
      delta: "hello"
    });
    writer.flush();

    expect(appended).toEqual([
      [
        {
          type: "text_delta",
          messageId: "message",
          partId: "part",
          delta: "hello"
        }
      ]
    ]);
  });

  it("reports whether durable projection is available", () => {
    const missing = new OperationStreamWriter({
      streamId: "stream",
      operationId: "operation",
      writer: undefined
    });
    const durable = new OperationStreamWriter({
      streamId: "stream",
      operationId: "operation",
      writer: {
        append: () => 1,
        close() {}
      } as unknown as StreamWriter
    });

    expect(missing.writable).toBe(false);
    expect(durable.writable).toBe(true);
    durable.close();
    expect(durable.writable).toBe(false);
  });
});

describe("OpenCode event projection", () => {
  it("projects current text and reasoning delta identifiers", () => {
    expect(
      projectEvent({
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          ordinal: 2,
          delta: "hello"
        }
      })
    ).toEqual({
      type: "text_delta",
      messageId: "assistant",
      partId: "2",
      delta: "hello"
    });
    expect(
      projectEvent({
        type: "session.reasoning.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          ordinal: 1,
          delta: "thinking"
        }
      })
    ).toEqual({
      type: "reasoning_delta",
      messageId: "assistant",
      partId: "1",
      delta: "thinking"
    });
  });

  it("projects current tool and permission identifiers", () => {
    expect(
      projectEvent({
        type: "session.tool.called",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          id: "call-1",
          name: "search",
          input: { query: "workers" },
          executed: false
        }
      })
    ).toEqual({
      type: "tool_start",
      toolCallId: "call-1",
      name: "search",
      input: { query: "workers" }
    });
    expect(
      projectEvent({
        type: "permission.replied",
        data: {
          sessionID: "session",
          requestID: "permission-1",
          reply: "once"
        }
      })
    ).toEqual({
      type: "permission_replied",
      permissionId: "permission-1"
    });
  });

  it("projects terminal message and tool errors", () => {
    expect(
      projectEvent({
        type: "session.step.ended",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant"
        }
      })
    ).toEqual({ type: "message_end", messageId: "assistant" });
    expect(
      projectEvent({
        type: "session.tool.failed",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          id: "call-1",
          name: "search",
          error: { type: "tool", message: "failed" },
          executed: false
        }
      })
    ).toEqual({
      type: "tool_end",
      toolCallId: "call-1",
      name: "search",
      error: true,
      output: "failed"
    });
  });
});
