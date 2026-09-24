import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Connection, LifecycleSockets } from "../../lifecycle";
import { PiTransport, type PiTransportHost } from "../../pi/transport";
import type { PiEvent, PiLaneSnapshot } from "../../pi/types";
import type { StreamHarnessObject } from "../capabilities/streams";

function socket(lane: string) {
  const messages: Array<Record<string, unknown>> = [];
  const connection = {
    id: crypto.randomUUID(),
    uri: null,
    state: null,
    tags: [crypto.randomUUID(), `pi:${lane}`],
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

describe("PiTransport", () => {
  it("replays a completed stream from the requested cursor", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const writer = await instance.streams.open("pi-stream", {
        metadata: { lane: "main", operationId: "op-1" }
      });
      writer.append([
        { type: "message_end", messageId: "first" } satisfies PiEvent
      ]);
      writer.append([
        { type: "message_end", messageId: "second" } satisfies PiEvent
      ]);
      writer.close();
      const host = {
        defaultLane: "main",
        streams: instance.streams,
        snapshot: async () => ({}) as PiLaneSnapshot,
        submit: async () => {
          throw new Error("unused");
        },
        abort: async () => null,
        steer: async () => {
          throw new Error("unused");
        }
      } satisfies PiTransportHost;
      const transport = new PiTransport(
        host,
        () => ({ get: () => [] }) as unknown as LifecycleSockets
      );
      const connection = socket("main");

      await transport.webSocketOptions().handlers?.onMessage?.(
        connection.connection,
        JSON.stringify({
          type: "subscribe",
          streamId: "pi-stream",
          from: 1
        })
      );
      await vi.waitFor(() =>
        expect(
          connection.messages.some((message) => message.type === "stream_end")
        ).toBe(true)
      );

      const replay = connection.messages.find(
        (message) => message.type === "events"
      );
      expect(replay).toMatchObject({
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
      const transport = new PiTransport(
        {
          defaultLane: "main",
          streams: instance.streams,
          snapshot: async () => ({}) as PiLaneSnapshot,
          submit: async () => {
            throw new Error("unused");
          },
          abort: async () => null,
          steer: async () => {
            throw new Error("unused");
          }
        },
        () => ({ get: () => [] }) as unknown as LifecycleSockets
      );
      const connection = socket("main");
      const handler = transport.webSocketOptions().handlers?.onMessage;

      await handler?.(connection.connection, "{");
      await handler?.(
        connection.connection,
        JSON.stringify({ type: "subscribe", streamId: "missing" })
      );
      await vi.waitFor(() => expect(connection.messages).toHaveLength(2));

      expect(connection.messages).toMatchObject([
        { type: "error", message: "Malformed JSON" },
        { type: "error", message: "Unknown stream missing" }
      ]);
    });
  });
});
