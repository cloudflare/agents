import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeWebSockets {
    readonly handlers: Record<string, (...args: never[]) => unknown>;
    readonly connections = new Map<string, unknown>();

    constructor(options: {
      handlers: Record<string, (...args: never[]) => unknown>;
    }) {
      this.handlers = options.handlers;
    }

    getConnection(id: string) {
      return this.connections.get(id);
    }
  }
  return { FakeWebSockets };
});

vi.mock("agents/websockets", () => ({ WebSockets: mocks.FakeWebSockets }));

import { ChannelHost, type ChannelChunk, type DeliveryResult } from "..";
import { web } from "../adapters/web";

function streamOf(...chunks: ChannelChunk[]): ReadableStream<ChannelChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

describe("web Channel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("dispatches browser turns through ChannelHost and streams the reply", async () => {
    const channel = web();
    const capability = channel.webSockets as unknown as InstanceType<
      typeof mocks.FakeWebSockets
    >;
    const send = vi.fn();
    const connection = { id: "browser-1", send };
    capability.connections.set(connection.id, connection);
    const onMessage = vi.fn();
    let result: DeliveryResult | undefined;
    let host!: ChannelHost;
    host = new ChannelHost({
      channels: { browser: channel },
      async onMessage(event) {
        onMessage(event);
        result = await host.stream(
          event.message.replySurface!,
          streamOf(
            { type: "reasoning", text: "Brief thought" },
            { type: "text", text: "Hello" }
          )
        );
      }
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              }
            ]
          })
        }
      }) as never
    );

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "browser",
        route: "browser-1",
        message: expect.objectContaining({
          message: { id: "message-1", text: "Hi" },
          replySurface: {
            channelKey: "browser",
            version: 1,
            address: { connectionId: "browser-1", requestId: "turn-1" },
            label: "Web chat"
          }
        })
      })
    );
    expect(result).toEqual({
      status: "delivered",
      reference: "web:browser-1:request:turn-1"
    });
    expect(send.mock.calls.map(([frame]) => JSON.parse(frame))).toEqual([
      {
        body: JSON.stringify({
          type: "reasoning-start",
          id: "turn-1:reasoning:1"
        }),
        done: false,
        id: "turn-1",
        type: "cf_agent_use_chat_response"
      },
      {
        body: JSON.stringify({
          type: "reasoning-delta",
          id: "turn-1:reasoning:1",
          delta: "Brief thought"
        }),
        done: false,
        id: "turn-1",
        type: "cf_agent_use_chat_response"
      },
      {
        body: JSON.stringify({
          type: "reasoning-end",
          id: "turn-1:reasoning:1"
        }),
        done: false,
        id: "turn-1",
        type: "cf_agent_use_chat_response"
      },
      {
        body: JSON.stringify({ type: "text-start", id: "turn-1:text:2" }),
        done: false,
        id: "turn-1",
        type: "cf_agent_use_chat_response"
      },
      {
        body: JSON.stringify({
          type: "text-delta",
          id: "turn-1:text:2",
          delta: "Hello"
        }),
        done: false,
        id: "turn-1",
        type: "cf_agent_use_chat_response"
      },
      {
        body: JSON.stringify({ type: "text-end", id: "turn-1:text:2" }),
        done: false,
        id: "turn-1",
        type: "cf_agent_use_chat_response"
      },
      {
        body: "",
        done: true,
        id: "turn-1",
        type: "cf_agent_use_chat_response"
      }
    ]);
  });

  it("answers resume probes without inventing durable replay", async () => {
    const channel = web();
    const capability = channel.webSockets as unknown as InstanceType<
      typeof mocks.FakeWebSockets
    >;
    const send = vi.fn();

    await capability.handlers.onMessage!(
      { id: "browser-1", send } as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-1"
      }) as never
    );

    expect(JSON.parse(send.mock.calls[0]![0])).toEqual({
      type: "cf_agent_stream_resume_none",
      reason: "idle",
      probeId: "probe-1"
    });
  });
});
