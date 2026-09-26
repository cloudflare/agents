import { describe, expect, it } from "vitest";
import {
  ChannelHost,
  fanout,
  type Channel,
  type ChannelChunk,
  type DeliveryResult
} from "../../channels";
import { Streams } from "../../streams";
import { withCapabilityHarness } from "../shared/capability-harness";

const surface = {
  channelKey: "collect",
  version: 1,
  address: null,
  label: "Collecting Channel"
} as const;

function streamOf(
  chunks: readonly ChannelChunk[],
  error?: unknown
): ReadableStream<ChannelChunk> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
        return;
      }
      if (error !== undefined) controller.error(error);
      else controller.close();
    }
  });
}

async function collect(
  chunks: ReadableStream<ChannelChunk>
): Promise<ChannelChunk[]> {
  const collected: ChannelChunk[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return collected;
}

async function replay(
  streams: Streams,
  responseId: string
): Promise<ChannelChunk[]> {
  const chunks: ChannelChunk[] = [];
  for await (const entry of streams.read(responseId)) {
    chunks.push(entry.chunk as ChannelChunk);
  }
  return chunks;
}

function collectingChannel(received: ChannelChunk[]): Channel {
  return {
    async stream(_surface, chunks): Promise<DeliveryResult> {
      received.push(...(await collect(chunks)));
      return { status: "delivered" };
    }
  };
}

describe("ChannelHost durable response streams", () => {
  it("records the normalized response before delivering it", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: streams } = install(new Streams());
      const received: ChannelChunk[] = [];
      const host = new ChannelHost({
        channels: { collect: collectingChannel(received) },
        streams
      });
      const source: ChannelChunk[] = [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
        { type: "source", url: "https://example.com" }
      ];

      await expect(
        host.stream(surface, streamOf(source), {
          response: {
            id: "response-1",
            conversationId: "conversation-1",
            messageId: "assistant-1"
          }
        })
      ).resolves.toEqual({ status: "delivered" });

      const expected: ChannelChunk[] = [
        { type: "message-start", messageId: "assistant-1" },
        { type: "text-start", id: "assistant-1:part:1" },
        { type: "text", id: "assistant-1:part:1", text: "Hello " },
        { type: "text", id: "assistant-1:part:1", text: "world" },
        { type: "text-end", id: "assistant-1:part:1" },
        {
          type: "source",
          id: "assistant-1:part:2",
          url: "https://example.com"
        }
      ];
      expect(received).toEqual(expected);
      await expect(replay(streams, "response-1")).resolves.toEqual(expected);
      await expect(streams.status("response-1")).resolves.toMatchObject({
        state: "completed",
        tag: "conversation-1",
        metadata: {
          owner: "channels",
          channelKey: "collect",
          conversationId: "conversation-1",
          messageId: "assistant-1"
        }
      });
    });
  });

  it("lets a late reader replay the prefix and follow the live tail", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: streams } = install(new Streams());
      const replayed: ChannelChunk[] = [];
      const channel: Channel = {
        async stream(_surface, chunks) {
          const reader = chunks.getReader();
          expect((await reader.read()).value).toEqual({
            type: "message-start",
            messageId: "assistant-live"
          });
          expect((await reader.read()).value).toEqual({
            type: "text-start",
            id: "assistant-live:part:1"
          });
          expect((await reader.read()).value).toEqual({
            type: "text",
            id: "assistant-live:part:1",
            text: "prefix"
          });

          const catchingUp = (async () => {
            for await (const entry of streams.read("response-live")) {
              replayed.push(entry.chunk as ChannelChunk);
            }
          })();
          await new Promise((resolve) => setTimeout(resolve, 0));

          while (!(await reader.read()).done) {
            // Pull the remaining source through the durable response log.
          }
          reader.releaseLock();
          await catchingUp;
          return { status: "delivered" };
        }
      };
      const host = new ChannelHost({ channels: { collect: channel }, streams });

      await host.stream(
        surface,
        streamOf([
          { type: "text", text: "prefix" },
          { type: "text", text: " and tail" }
        ]),
        {
          response: {
            id: "response-live",
            conversationId: "conversation-1",
            messageId: "assistant-live"
          }
        }
      );

      expect(replayed).toEqual([
        { type: "message-start", messageId: "assistant-live" },
        { type: "text-start", id: "assistant-live:part:1" },
        { type: "text", id: "assistant-live:part:1", text: "prefix" },
        { type: "text", id: "assistant-live:part:1", text: " and tail" },
        { type: "text-end", id: "assistant-live:part:1" }
      ]);
    });
  });

  it("normalizes an opening message ID and rejects a conflicting one", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: streams } = install(new Streams());
      const host = new ChannelHost({
        channels: { collect: collectingChannel([]) },
        streams
      });

      await expect(
        host.stream(
          surface,
          streamOf([{ type: "message-start", messageId: "different" }]),
          {
            response: {
              id: "response-conflict",
              conversationId: "conversation-1",
              messageId: "assistant-expected"
            }
          }
        )
      ).rejects.toThrow("does not match stream message ID");
      await expect(streams.status("response-conflict")).resolves.toMatchObject({
        state: "errored",
        cursor: 0
      });
    });
  });

  it("requires durable response identity when Streams are configured", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: streams } = install(new Streams());
      const host = new ChannelHost({
        channels: { collect: collectingChannel([]) },
        streams
      });

      await expect(
        host.stream(surface, streamOf([{ type: "text", text: "Hello" }]))
      ).rejects.toThrow(
        "ChannelHost.stream requires options.response when Streams are configured"
      );
    });
  });

  it("records once before a fanout delivery", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: streams } = install(new Streams());
      const first: ChannelChunk[] = [];
      const second: ChannelChunk[] = [];
      const host = new ChannelHost({
        channels: {
          first: collectingChannel(first),
          second: collectingChannel(second)
        },
        streams
      });

      await host.stream(
        fanout([
          { ...surface, channelKey: "first", label: "First" },
          { ...surface, channelKey: "second", label: "Second" }
        ]),
        streamOf([{ type: "text", text: "Shared" }]),
        {
          response: {
            id: "response-fanout",
            conversationId: "conversation-1",
            messageId: "assistant-fanout"
          }
        }
      );

      const expected: ChannelChunk[] = [
        { type: "message-start", messageId: "assistant-fanout" },
        { type: "text-start", id: "assistant-fanout:part:1" },
        { type: "text", id: "assistant-fanout:part:1", text: "Shared" },
        { type: "text-end", id: "assistant-fanout:part:1" }
      ];
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
      await expect(replay(streams, "response-fanout")).resolves.toEqual(
        expected
      );
      await expect(streams.status("response-fanout")).resolves.toMatchObject({
        state: "completed",
        cursor: 4
      });
    });
  });

  it("retains the partial response and error settlement", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: streams } = install(new Streams());
      const received: ChannelChunk[] = [];
      const channel: Channel = {
        async stream(_surface, chunks) {
          try {
            received.push(...(await collect(chunks)));
          } catch {
            return {
              status: "uncertain",
              error: { code: "SOURCE_FAILED", message: "generation failed" }
            };
          }
          return { status: "delivered" };
        }
      };
      const host = new ChannelHost({ channels: { collect: channel }, streams });

      await expect(
        host.stream(
          surface,
          streamOf(
            [{ type: "text", text: "Partial answer" }],
            new Error("generation failed")
          ),
          {
            response: {
              id: "response-error",
              conversationId: "conversation-1",
              messageId: "assistant-error"
            }
          }
        )
      ).resolves.toMatchObject({ status: "uncertain" });

      const expected: ChannelChunk[] = [
        { type: "message-start", messageId: "assistant-error" },
        { type: "text-start", id: "assistant-error:part:1" },
        {
          type: "text",
          id: "assistant-error:part:1",
          text: "Partial answer"
        }
      ];
      expect(received).toEqual([]);
      await expect(replay(streams, "response-error")).resolves.toEqual(
        expected
      );
      await expect(streams.status("response-error")).resolves.toMatchObject({
        state: "errored",
        error: "generation failed",
        cursor: 3
      });
    });
  });
});
