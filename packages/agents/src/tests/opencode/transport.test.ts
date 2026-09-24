import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Connection, LifecycleSockets } from "../../lifecycle";
import {
  OpenCodeTransport,
  type OpenCodeTransportHost
} from "../../opencode/transport";
import type { OCEvent, OCSnapshot } from "../../opencode/types";
import type { StreamHarnessObject } from "../capabilities/streams";

function socket() {
  const messages: Array<Record<string, unknown>> = [];
  const connection = {
    id: crypto.randomUUID(),
    uri: null,
    state: null,
    tags: [crypto.randomUUID()],
    readyState: 1,
    send(value: string) {
      messages.push(JSON.parse(value) as Record<string, unknown>);
    },
    setState(value: unknown) {
      return value;
    }
  } as unknown as Connection;
  return { connection, messages };
}

function host(streams: StreamHarnessObject["streams"]): OpenCodeTransportHost {
  return {
    streams,
    snapshot: async () => ({}) as OCSnapshot,
    submit: async () => {
      throw new Error("unused");
    },
    abort: async () => null,
    steer: async () => {},
    replyPermission: async () => {}
  };
}

describe("OpenCodeTransport", () => {
  it("replays a completed stream from the requested cursor", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const writer = await instance.streams.open("oc-stream", {
        metadata: { sessionId: "session", operationId: "op-1" }
      });
      writer.append([
        { type: "message_end", messageId: "first" } satisfies OCEvent
      ]);
      writer.append([
        { type: "message_end", messageId: "second" } satisfies OCEvent
      ]);
      writer.close();
      const transport = new OpenCodeTransport(
        host(instance.streams),
        () => ({ get: () => [] }) as unknown as LifecycleSockets
      );
      const connection = socket();

      await transport.webSocketOptions().handlers?.onMessage?.(
        connection.connection,
        JSON.stringify({
          type: "subscribe",
          streamId: "oc-stream",
          from: 1
        })
      );
      await vi.waitFor(() =>
        expect(
          connection.messages.some((message) => message.type === "stream_end")
        ).toBe(true)
      );

      expect(
        connection.messages.find((message) => message.type === "events")
      ).toMatchObject({
        seq: 1,
        lastSeq: 1,
        operationId: "op-1",
        events: [{ type: "message_end", messageId: "second" }]
      });
    });
  });

  it("rejects malformed messages and unknown streams", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const transport = new OpenCodeTransport(
        host(instance.streams),
        () => ({ get: () => [] }) as unknown as LifecycleSockets
      );
      const connection = socket();
      const handler = transport.webSocketOptions().handlers?.onMessage;

      await handler?.(connection.connection, "{");
      await handler?.(
        connection.connection,
        JSON.stringify({ type: "subscribe", streamId: "missing" })
      );
      await vi.waitFor(() => expect(connection.messages).toHaveLength(2));

      expect(connection.messages).toMatchObject([
        { type: "error", message: "Malformed message" },
        { type: "error", message: "Unknown stream missing" }
      ]);
    });
  });
});
