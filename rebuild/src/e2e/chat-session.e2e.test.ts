import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel } from "../adapters/memory/fake-model.js";
import { createMemoryConnectionRegistry } from "../adapters/memory/transport.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelClient } from "../ports/model.js";
import type { ConversationEvent, StoredEvent } from "../domain/events/log.js";
import type { ToolSet } from "../domain/tools/types.js";
import type { AgentHost } from "../app/agent.js";
import { Think } from "../app/think.js";
import { attachChatTransport } from "../adapters/websocket-chat/adapter.js";
import { connectChatClient } from "../adapters/websocket-chat/test-helpers.js";

/**
 * Scenario 1 (audit 24 §1): the everyday chat turn — a Think subclass with a
 * system prompt, one user tool, and workspace tools on. Rewired in wave R3
 * to drive the turn through `attachChatTransport` + `connectChatClient`:
 * frame in (`cf_agent_use_chat_request`) -> Think method -> pipeline ->
 * event log -> frame out (`cf_agent_use_chat_response`), the full path the
 * WS adapter exists for. This is broader than think.test.ts's "text
 * turn"/"client tool suspension" cases: it exercises a *server-executed*
 * tool (no suspension) alongside the workspace tool bundle, and checks that
 * both `history()` and a newly-connecting second client see the settled
 * tool output.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

function eventsOfType<T extends ConversationEvent["type"]>(
  events: StoredEvent[],
  type: T,
): Array<Extract<ConversationEvent, { type: T }>> {
  return events.map((e) => e.event).filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);
}

function framesOfType(frames: unknown[], type: string): Array<Record<string, unknown>> {
  return frames.filter(
    (f): f is Record<string, unknown> => typeof f === "object" && f !== null && (f as { type?: unknown }).type === type,
  );
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
  it("streams a tool-call turn end to end over the WS chat transport, validates + executes the tool, persists it, and both history() and a newly-connecting client see it", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "add", input: { a: 7, b: 5 }, id: "call_1" },
      { kind: "text", text: "7 + 5 is 12." },
    ]);
    await agent.start();

    const busEvents: string[] = [];
    agent.bus.subscribe("message", (e) => busEvents.push(e.type));
    const events: StoredEvent[] = [];
    agent.events().subscribe("live", (e) => events.push(e));

    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    // Frame in: the client sends the chat request over the wire, not agent.chat() directly.
    await client.send({ type: "cf_agent_use_chat_request", id: "req_1", input: "what is 7 + 5?" });

    await vi.waitFor(() => {
      expect(framesOfType(client.frames, "cf_agent_use_chat_response").some((f) => (f.chunk as { type: string }).type === "finish")).toBe(true);
    });

    // Chunk events stream in order: start ... tool-input -> tool-output ... finish.
    const chunkTypes = eventsOfType(events, "chunk").map((e) => e.chunk.type);
    expect(chunkTypes[0]).toBe("start");
    expect(chunkTypes[chunkTypes.length - 1]).toBe("finish");
    const idxInput = chunkTypes.indexOf("tool-input-available");
    const idxOutput = chunkTypes.indexOf("tool-output-available");
    expect(idxInput).toBeGreaterThan(0);
    expect(idxOutput).toBeGreaterThan(idxInput);

    // Frame out: the same chunk sequence reached the client, tagged with the request id.
    const responseFrames = framesOfType(client.frames, "cf_agent_use_chat_response");
    expect(responseFrames.every((f) => f.id === "req_1")).toBe(true);
    expect(responseFrames.map((f) => (f.chunk as { type: string }).type)).toEqual(chunkTypes);

    // The tool ran server-side (no client suspension) with validated input.
    const chunks = eventsOfType(events, "chunk").map((e) => e.chunk);
    const inputChunk = chunks.find((c) => c.type === "tool-input-available")!;
    expect(inputChunk).toMatchObject({ executor: "server", input: { a: 7, b: 5 } });
    const outputChunk = chunks.find((c) => c.type === "tool-output-available")!;
    expect(outputChunk).toMatchObject({ output: 12, isError: false });

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

    // A fresh history() read (what a newly-connecting adapter client would sync) sees the settled history.
    const history = await agent.history();
    expect(history).toHaveLength(2);
    const syncedToolPart = history[1]!.parts.find((p) => p.type === "tool-add");
    expect(syncedToolPart).toMatchObject({ state: "output-available", output: 12 });

    // And a second live connection, joining after the fact, gets the same settled history on connect.
    const second = await connectChatClient(transport, registry);
    const sync = framesOfType(second.frames, "cf_agent_chat_messages")[0];
    expect(sync?.messages).toHaveLength(2);
    const secondSyncedToolPart = (sync?.messages as typeof messages)[1]!.parts.find((p) => p.type === "tool-add");
    expect(secondSyncedToolPart).toMatchObject({ state: "output-available", output: 12 });

    expect(busEvents).toContain("message:response");
    expect(eventsOfType(events, "turn:settled")[0]).toMatchObject({ requestId: "req_1", outcome: "completed" });
  });
});
