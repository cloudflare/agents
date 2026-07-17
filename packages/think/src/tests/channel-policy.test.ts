import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { collectIngestReply, decodeIngestStream } from "../think";
import type { IngestStreamEvent } from "../think";
import type { ThinkTestAgent } from "./agents/think-session";

async function freshAgent(name: string) {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

function messageText(message: {
  parts: ReadonlyArray<{ type: string; text?: string }>;
}) {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

async function collectEvents(stream: ReadableStream<Uint8Array>) {
  const events: IngestStreamEvent[] = [];
  for await (const event of decodeIngestStream(stream)) events.push(event);
  return events;
}

describe("per-channel policy (Phase 4b)", () => {
  it("prepends channel instructions to the system prompt before beforeTurn", async () => {
    const agent = await freshAgent("policy-instructions");
    await agent.runChannelTurnForTest({ input: "hi", channel: "voice" });
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.system).toContain("VOICE MODE");
  });

  it("narrows the tool set via the channel policy (removes, not just adds)", async () => {
    const agent = await freshAgent("policy-tools");
    await agent.runChannelTurnForTest({ input: "hi", channel: "voice" });
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.toolNames).toEqual([]);
  });

  it("does not apply channel policy for turns on other channels", async () => {
    const agent = await freshAgent("policy-other");
    await agent.runChannelTurnForTest({ input: "hi", channel: "web" });
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.system).not.toContain("VOICE MODE");
  });
});

describe("ingest", () => {
  it("applies voice channel policy through ingest", async () => {
    const agent = await freshAgent(`voice-ingest-${crypto.randomUUID()}`);

    const stream = await agent.ingestTextForTest({
      channelId: "voice",
      text: "hello by voice"
    });
    const reply = await collectIngestReply(stream);

    expect(reply.text).toBe("Hello from the assistant!");
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.system).toContain("VOICE MODE");
    expect(log[log.length - 1]?.toolNames).toEqual([]);
  });

  it("streams through a real DO RPC stub", async () => {
    const agent = await freshAgent(`telegram-ingest-${crypto.randomUUID()}`);
    await agent.setMultiChunkResponse(["Hello ", "from RPC"]);

    const stream = await agent.ingest({
      channelId: "telegram",
      text: "hello from telegram host"
    });
    const events = await collectEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "delta",
      "delta",
      "done"
    ]);
    expect(events[0]).toEqual({ type: "delta", text: "Hello " });
    expect(events[1]).toEqual({ type: "delta", text: "from RPC" });
    const terminal = events[2];
    expect(terminal?.type).toBe("done");
    if (terminal?.type !== "done") throw new Error("expected done event");
    expect(messageText(terminal.message)).toBe("Hello from RPC");
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.system).toContain("TELEGRAM MODE");
  });

  it("honors maxTurns for policy-only channels through ingest", async () => {
    const agent = await freshAgent(
      `telegram-ingest-maxturns-${crypto.randomUUID()}`
    );
    await agent.useLoopToolModelForTest();

    const stream = await agent.ingest({
      channelId: "telegram",
      text: "call a tool"
    });
    await collectIngestReply(stream);

    await expect(agent.getStepLog()).resolves.toHaveLength(1);
  });

  it("runs to completion when the caller cancels the stream early", async () => {
    const agent = await freshAgent(`ingest-cancel-${crypto.randomUUID()}`);
    await agent.setMultiChunkResponse(["first", "second"]);
    await agent.setStreamChunkDelayForTest(5);

    const stream = await agent.ingest({
      channelId: "web",
      text: "hello from custom transport"
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstEvent: IngestStreamEvent | undefined;
    while (!firstEvent) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const line = buffer.split("\n")[0];
      if (line) firstEvent = JSON.parse(line) as IngestStreamEvent;
    }
    expect(firstEvent).toEqual({ type: "delta", text: "first" });
    await reader.cancel();

    await vi.waitFor(async () => {
      expect(await agent.getStoredMessages()).toHaveLength(2);
    });
    const messages = (await agent.getStoredMessages()) as unknown as Array<{
      role: string;
      parts: ReadonlyArray<{ type: string; text?: string }>;
    }>;
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant && messageText(assistant)).toBe("firstsecond");
  });

  it("runs to completion when the caller never reads the stream", async () => {
    const agent = await freshAgent(`ingest-respond-${crypto.randomUUID()}`);

    await agent.ingestTextForTest({
      channelId: "web",
      text: "hello from custom transport"
    });

    await vi.waitFor(async () => {
      expect(await agent.getStoredMessages()).toHaveLength(2);
    });
  });

  it("emits a terminal error frame on turn failure", async () => {
    const agent = await freshAgent(`ingest-error-${crypto.randomUUID()}`);
    await agent.setInBandErrorResponse("provider exploded", ["partial"]);

    const stream = await agent.ingest({
      channelId: "web",
      text: "trigger failure"
    });
    const events = await collectEvents(stream);

    expect(events).toEqual([
      { type: "delta", text: "partial" },
      { type: "error", message: "provider exploded" }
    ]);
  });
});
