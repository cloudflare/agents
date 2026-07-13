import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryConnection, type MemoryConnection } from "../adapters/memory/transport.js";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel } from "../adapters/memory/fake-model.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelClient } from "../ports/model.js";
import type { ToolSet } from "../domain/tools/types.js";
import type { AgentHost } from "../app/agent.js";
import { Think } from "../app/think.js";

/**
 * Scenario 1 (audit 24 §1): the everyday chat turn — a Think subclass with a
 * system prompt, one user tool, and workspace tools on, driven entirely
 * through the `cf_agent_*` WebSocket protocol over MemoryConnections. This is
 * broader than think.test.ts's "text turn"/"client tool suspension" cases: it
 * exercises a *server-executed* tool (no suspension) alongside the workspace
 * tool bundle, and checks a second connection's full-history sync includes
 * the settled tool output.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    connections: mem.connections,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

function connectionFrames(conn: MemoryConnection): Array<Record<string, unknown>> {
  return conn.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
}

function framesOfType(conn: MemoryConnection, type: string): Array<Record<string, unknown>> {
  return connectionFrames(conn).filter((f) => f.type === type);
}

class ChatSessionThink extends Think<unknown> {
  model!: ModelClient;

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getSystemPrompt(): string {
    return "You are a careful assistant with a calculator tool.";
  }

  protected override getTools(): ToolSet {
    return {
      add: {
        description: "Adds two numbers",
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: (input: { a: number; b: number }) => input.a + input.b,
      },
    };
  }
}

function makeAgent(): { agent: ChatSessionThink; mem: MemoryHost } {
  const mem = createMemoryHost({ agent: "ChatSessionThink", name: "session-1" });
  const host = toHost(mem, { className: "ChatSessionThink", name: "session-1" });
  const agent = new ChatSessionThink(host);
  mem.attachAgent(agent);
  return { agent, mem };
}

describe("e2e: chat session", () => {
  it("streams a tool-call turn end to end, validates + executes the tool, persists it, and syncs a fresh connection", async () => {
    const { agent, mem } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "add", input: { a: 7, b: 5 }, id: "call_1" },
      { kind: "text", text: "7 + 5 is 12." },
    ]);
    await agent.start();

    const events: string[] = [];
    agent.events.subscribe("message", (e) => events.push(e.type));

    const conn1 = createMemoryConnection("c1");
    mem.connections.add(conn1);
    await agent.onConnect(conn1);

    await agent.onMessage(
      conn1,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "what is 7 + 5?" }),
    );

    // Chunk frames stream in order: start ... tool-input -> tool-output ... finish.
    const responseFrames = framesOfType(conn1, "cf_agent_use_chat_response");
    const chunkTypes = responseFrames.map((f) => (f.chunk as { type: string }).type);
    expect(chunkTypes[0]).toBe("start");
    expect(chunkTypes[chunkTypes.length - 1]).toBe("finish");
    const idxInput = chunkTypes.indexOf("tool-input-available");
    const idxOutput = chunkTypes.indexOf("tool-output-available");
    expect(idxInput).toBeGreaterThan(0);
    expect(idxOutput).toBeGreaterThan(idxInput);

    // The tool ran server-side (no client suspension) with validated input.
    const inputFrame = responseFrames.find((f) => (f.chunk as { type: string }).type === "tool-input-available")!;
    expect(inputFrame.chunk).toMatchObject({ executor: "server", input: { a: 7, b: 5 } });
    const outputFrame = responseFrames.find((f) => (f.chunk as { type: string }).type === "tool-output-available")!;
    expect(outputFrame.chunk).toMatchObject({ output: 12, isError: false });

    // Final assistant message persisted with both the tool part and the text.
    const messages = await agent.getMessages();
    expect(messages).toHaveLength(2);
    const assistant = messages[1]!;
    expect(assistant.parts.find((p) => p.type === "tool-add")).toMatchObject({
      state: "output-available",
      output: 12,
    });
    expect(assistant.parts.find((p) => p.type === "text")).toMatchObject({ text: "7 + 5 is 12." });

    // Workspace tools (on by default) are offered to the model alongside "add".
    const fakeModel = agent.model as unknown as { requests: Array<{ tools: Array<{ name: string }> }> };
    const toolNames = fakeModel.requests[0]!.tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["add", "read", "write", "edit", "list", "find", "grep", "delete"]),
    );

    // A second, freshly-connected client receives the full settled history.
    const conn2 = createMemoryConnection("c2");
    mem.connections.add(conn2);
    await agent.onConnect(conn2);
    const sync = framesOfType(conn2, "cf_agent_chat_messages");
    expect(sync).toHaveLength(1);
    const syncedMessages = sync[0]!.messages as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(syncedMessages).toHaveLength(2);
    const syncedToolPart = syncedMessages[1]!.parts.find((p) => p.type === "tool-add");
    expect(syncedToolPart).toMatchObject({ state: "output-available", output: 12 });

    expect(events).toContain("message:response");
  });
});
