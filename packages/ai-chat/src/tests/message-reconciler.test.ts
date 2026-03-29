import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  reconcileMessages,
  resolveToolMergeId,
  assistantContentKey
} from "../message-reconciler";

type ChatMessage = UIMessage;

function userMsg(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }]
  } as ChatMessage;
}

function assistantMsg(
  id: string,
  text: string,
  extra?: Partial<ChatMessage>
): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    ...extra
  } as ChatMessage;
}

function toolAssistantMsg(
  id: string,
  toolCallId: string,
  state: string,
  opts: { output?: unknown; input?: unknown; toolName?: string } = {}
): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: `tool-${opts.toolName ?? "calc"}`,
        toolCallId,
        toolName: opts.toolName ?? "calc",
        state,
        ...(opts.input !== undefined && { input: opts.input }),
        ...(opts.output !== undefined && { output: opts.output })
      } as unknown as ChatMessage["parts"][number]
    ]
  } as ChatMessage;
}

// ── reconcileMessages: tool output merge ──────────────────────────

describe("reconcileMessages — tool output merge", () => {
  it("merges server output into client input-available", () => {
    const server = [
      toolAssistantMsg("srv-1", "tc1", "output-available", {
        output: "result"
      })
    ];
    const client = [
      toolAssistantMsg("srv-1", "tc1", "input-available", { input: { x: 1 } })
    ];
    const result = reconcileMessages(client, server);
    const part = result[0].parts[0] as Record<string, unknown>;
    expect(part.state).toBe("output-available");
    expect(part.output).toBe("result");
  });

  it("merges server output into client approval-requested", () => {
    const server = [
      toolAssistantMsg("srv-1", "tc1", "output-available", { output: 42 })
    ];
    const client = [
      toolAssistantMsg("srv-1", "tc1", "approval-requested", { input: {} })
    ];
    const result = reconcileMessages(client, server);
    expect((result[0].parts[0] as Record<string, unknown>).state).toBe(
      "output-available"
    );
  });

  it("merges server output into client approval-responded", () => {
    const server = [
      toolAssistantMsg("srv-1", "tc1", "output-available", {
        output: "done"
      })
    ];
    const client = [
      toolAssistantMsg("srv-1", "tc1", "approval-responded", { input: {} })
    ];
    const result = reconcileMessages(client, server);
    expect((result[0].parts[0] as Record<string, unknown>).state).toBe(
      "output-available"
    );
    expect((result[0].parts[0] as Record<string, unknown>).output).toBe("done");
  });

  it("passes through when no server tool outputs exist", () => {
    const server = [assistantMsg("srv-1", "Hello")];
    const client = [
      userMsg("u1", "hi"),
      toolAssistantMsg("cli-1", "tc1", "input-available", { input: {} })
    ];
    const result = reconcileMessages(client, server);
    expect((result[1].parts[0] as Record<string, unknown>).state).toBe(
      "input-available"
    );
  });

  it("passes through non-assistant messages unchanged", () => {
    const server = [
      toolAssistantMsg("srv-1", "tc1", "output-available", { output: 1 })
    ];
    const client = [userMsg("u1", "hi")];
    const result = reconcileMessages(client, server);
    expect(result[0]).toBe(client[0]);
  });

  it("does not merge when client tool is already output-available", () => {
    const server = [
      toolAssistantMsg("srv-1", "tc1", "output-available", {
        output: "server"
      })
    ];
    const client = [
      toolAssistantMsg("srv-1", "tc1", "output-available", {
        output: "client"
      })
    ];
    const result = reconcileMessages(client, server);
    expect((result[0].parts[0] as Record<string, unknown>).output).toBe(
      "client"
    );
  });
});

// ── reconcileMessages: ID reconciliation ──────────────────────────

describe("reconcileMessages — ID reconciliation", () => {
  it("preserves exact ID matches", () => {
    const server = [userMsg("u1", "hi"), assistantMsg("srv-a1", "Hello")];
    const client = [userMsg("u1", "hi"), assistantMsg("srv-a1", "Hello")];
    const result = reconcileMessages(client, server);
    expect(result[1].id).toBe("srv-a1");
  });

  it("adopts server ID for content-key match with different client ID", () => {
    const server = [assistantMsg("srv-a1", "Hello there")];
    const client = [assistantMsg("cli-a1", "Hello there")];
    const result = reconcileMessages(client, server);
    expect(result[0].id).toBe("srv-a1");
  });

  it("maps two identical-content assistants to distinct server IDs (#1008)", () => {
    const server = [
      userMsg("u1", "q1"),
      assistantMsg("srv-a1", "Sure"),
      userMsg("u2", "q2"),
      assistantMsg("srv-a2", "Sure")
    ];
    const client = [
      userMsg("u1", "q1"),
      assistantMsg("cli-a1", "Sure"),
      userMsg("u2", "q2"),
      assistantMsg("cli-a2", "Sure")
    ];
    const result = reconcileMessages(client, server);
    expect(result[1].id).toBe("srv-a1");
    expect(result[3].id).toBe("srv-a2");
  });

  it("skips content matching for tool-bearing assistant messages", () => {
    const server = [
      toolAssistantMsg("srv-a1", "tc1", "output-available", { output: 1 })
    ];
    const client = [
      toolAssistantMsg("cli-a1", "tc1", "output-available", { output: 1 })
    ];
    const result = reconcileMessages(client, server);
    expect(result[0].id).toBe("cli-a1");
  });

  it("passes through when server state is empty", () => {
    const client = [userMsg("u1", "hi"), assistantMsg("cli-a1", "Hello")];
    const result = reconcileMessages(client, []);
    expect(result[0].id).toBe("u1");
    expect(result[1].id).toBe("cli-a1");
  });

  it("passes through when no content matches", () => {
    const server = [assistantMsg("srv-a1", "Response A")];
    const client = [assistantMsg("cli-a1", "Response B")];
    const result = reconcileMessages(client, server);
    expect(result[0].id).toBe("cli-a1");
  });

  it("uses sanitize callback for content key comparison", () => {
    const server = [
      assistantMsg("srv-a1", "Hello", {
        parts: [
          { type: "text", text: "Hello" } as ChatMessage["parts"][number],
          {
            type: "reasoning",
            text: "",
            providerMetadata: { openai: { itemId: "xyz" } }
          } as unknown as ChatMessage["parts"][number]
        ]
      })
    ];
    const client = [
      assistantMsg("cli-a1", "Hello", {
        parts: [{ type: "text", text: "Hello" } as ChatMessage["parts"][number]]
      })
    ];

    const stripReasoning = (msg: ChatMessage): ChatMessage => ({
      ...msg,
      parts: msg.parts.filter(
        (p) => p.type !== "reasoning"
      ) as ChatMessage["parts"]
    });

    const result = reconcileMessages(client, server, stripReasoning);
    expect(result[0].id).toBe("srv-a1");
  });
});

// ── reconcileMessages: composed stages ────────────────────────────

describe("reconcileMessages — composed stages", () => {
  it("applies both tool merge and ID reconciliation in one call", () => {
    const server = [
      toolAssistantMsg("srv-a1", "tc1", "output-available", {
        output: "result"
      }),
      assistantMsg("srv-a2", "Follow up")
    ];
    const client = [
      toolAssistantMsg("cli-a1", "tc1", "input-available", { input: {} }),
      assistantMsg("cli-a2", "Follow up")
    ];
    const result = reconcileMessages(client, server);
    expect((result[0].parts[0] as Record<string, unknown>).state).toBe(
      "output-available"
    );
    expect(result[1].id).toBe("srv-a2");
  });

  it("mixed tool + text parts in same message counts as tool-bearing", () => {
    const msg: ChatMessage = {
      id: "cli-a1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Running tool..."
        } as ChatMessage["parts"][number],
        {
          type: "tool-calc",
          toolCallId: "tc1",
          toolName: "calc",
          state: "input-available",
          input: {}
        } as unknown as ChatMessage["parts"][number]
      ]
    } as ChatMessage;
    const server = [
      {
        ...msg,
        id: "srv-a1"
      }
    ];
    const result = reconcileMessages([msg], server);
    expect(result[0].id).toBe("cli-a1");
  });
});

// ── resolveToolMergeId ────────────────────────────────────────────

describe("resolveToolMergeId", () => {
  it("adopts server ID when toolCallId matches a different server message", () => {
    const server = [
      toolAssistantMsg("srv-a1", "tc1", "output-available", { output: 1 })
    ];
    const msg = toolAssistantMsg("cli-a1", "tc1", "input-available", {
      input: {}
    });
    const result = resolveToolMergeId(msg, server);
    expect(result.id).toBe("srv-a1");
  });

  it("returns message unchanged when toolCallId matches same ID", () => {
    const server = [
      toolAssistantMsg("a1", "tc1", "output-available", { output: 1 })
    ];
    const msg = toolAssistantMsg("a1", "tc1", "input-available", {
      input: {}
    });
    const result = resolveToolMergeId(msg, server);
    expect(result.id).toBe("a1");
    expect(result).toBe(msg);
  });

  it("returns message unchanged when no matching toolCallId", () => {
    const server = [
      toolAssistantMsg("srv-a1", "tc-other", "output-available", { output: 1 })
    ];
    const msg = toolAssistantMsg("cli-a1", "tc1", "input-available", {
      input: {}
    });
    const result = resolveToolMergeId(msg, server);
    expect(result.id).toBe("cli-a1");
    expect(result).toBe(msg);
  });

  it("returns non-assistant messages unchanged", () => {
    const server = [
      toolAssistantMsg("srv-a1", "tc1", "output-available", { output: 1 })
    ];
    const msg = userMsg("u1", "hi");
    const result = resolveToolMergeId(msg, server);
    expect(result).toBe(msg);
  });

  it("returns message unchanged with empty server array", () => {
    const msg = toolAssistantMsg("cli-a1", "tc1", "input-available", {
      input: {}
    });
    const result = resolveToolMergeId(msg, []);
    expect(result).toBe(msg);
  });

  it("uses first matching tool part when multiple exist", () => {
    const server = [
      toolAssistantMsg("srv-a1", "tc1", "output-available", { output: 1 }),
      toolAssistantMsg("srv-a2", "tc2", "output-available", { output: 2 })
    ];
    const msg: ChatMessage = {
      id: "cli-a1",
      role: "assistant",
      parts: [
        {
          type: "tool-calc",
          toolCallId: "tc1",
          toolName: "calc",
          state: "input-available",
          input: {}
        } as unknown as ChatMessage["parts"][number],
        {
          type: "tool-calc",
          toolCallId: "tc2",
          toolName: "calc",
          state: "input-available",
          input: {}
        } as unknown as ChatMessage["parts"][number]
      ]
    } as ChatMessage;
    const result = resolveToolMergeId(msg, server);
    expect(result.id).toBe("srv-a1");
  });
});

// ── assistantContentKey ───────────────────────────────────────────

describe("assistantContentKey", () => {
  it("returns JSON of parts for assistant messages", () => {
    const msg = assistantMsg("a1", "Hello");
    const key = assistantContentKey(msg);
    expect(key).toBe(JSON.stringify(msg.parts));
  });

  it("returns undefined for user messages", () => {
    expect(assistantContentKey(userMsg("u1", "hi"))).toBeUndefined();
  });

  it("returns undefined for system messages", () => {
    const msg: ChatMessage = {
      id: "s1",
      role: "system",
      parts: [{ type: "text", text: "prompt" }]
    } as ChatMessage;
    expect(assistantContentKey(msg)).toBeUndefined();
  });

  it("applies sanitize callback before computing key", () => {
    const msg = assistantMsg("a1", "Hello", {
      parts: [
        { type: "text", text: "Hello" } as ChatMessage["parts"][number],
        { type: "text", text: "EXTRA" } as ChatMessage["parts"][number]
      ]
    });

    const stripExtra = (m: ChatMessage): ChatMessage => ({
      ...m,
      parts: m.parts.filter(
        (p) => (p as { text: string }).text !== "EXTRA"
      ) as ChatMessage["parts"]
    });

    const key = assistantContentKey(msg, stripExtra);
    const expected = JSON.stringify([{ type: "text", text: "Hello" }]);
    expect(key).toBe(expected);
  });

  it("produces same key for messages with identical parts", () => {
    const a = assistantMsg("a1", "Sure");
    const b = assistantMsg("a2", "Sure");
    expect(assistantContentKey(a)).toBe(assistantContentKey(b));
  });

  it("produces different keys for messages with different parts", () => {
    const a = assistantMsg("a1", "Yes");
    const b = assistantMsg("a2", "No");
    expect(assistantContentKey(a)).not.toBe(assistantContentKey(b));
  });
});
