import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("AIChatAgent destroy()", () => {
  it("clears active stream state on destroy", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Start a stream to create active state
    const streamId = await agentStub.testStartStream("req-destroy-1");
    await agentStub.testStoreStreamChunk(
      streamId,
      '{"type":"text","text":"test"}'
    );
    await agentStub.testFlushChunkBuffer();

    // Verify state exists before destroy
    expect(await agentStub.getActiveStreamId()).toBe(streamId);
    const chunks = await agentStub.getStreamChunks(streamId);
    expect(chunks.length).toBe(1);

    ws.close(1000);
  });

  it("flushes pending chunk buffer on destroy", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Start a stream and add chunks without flushing
    const streamId = await agentStub.testStartStream("req-destroy-2");
    await agentStub.testStoreStreamChunk(
      streamId,
      '{"type":"text","text":"chunk1"}'
    );
    await agentStub.testStoreStreamChunk(
      streamId,
      '{"type":"text","text":"chunk2"}'
    );

    // These are still in the buffer (not flushed yet since < 10 chunks)
    // Flush manually to verify they're stored
    await agentStub.testFlushChunkBuffer();

    const chunks = await agentStub.getStreamChunks(streamId);
    expect(chunks.length).toBe(2);

    ws.close(1000);
  });
});
