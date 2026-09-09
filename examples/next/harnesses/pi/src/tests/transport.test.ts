import { describe, expect, it } from "vitest";
import type { Connection, LifecycleSockets } from "agents/lifecycle";
import { PiTransport, type PiTransportHost } from "../harness/transport";
import type {
  PiClientMessage,
  PiExtensionUiResponse,
  PiServerMessage
} from "../harness/types";

/** A socket that records what the transport sent it. */
function socket(tag: string) {
  const frames: PiServerMessage[] = [];
  const connection = {
    readyState: 1,
    tags: [tag],
    send: (raw: string) => frames.push(JSON.parse(raw) as PiServerMessage)
  };
  // SAFETY: the transport only reads `readyState`, `tags` and `send`.
  return { frames, connection: connection as unknown as Connection };
}

type Harness = {
  readonly transport: PiTransport;
  readonly answered: { requestId: string; response: PiExtensionUiResponse }[];
};

function transportWith(
  connections: readonly Connection[],
  overrides: Partial<PiTransportHost> = {}
): Harness {
  const answered: { requestId: string; response: PiExtensionUiResponse }[] = [];
  const host = {
    defaultLane: "main",
    streams: {} as PiTransportHost["streams"],
    snapshot: () => Promise.reject(new Error("unused")),
    submit: () => Promise.reject(new Error("unused")),
    abort: () => Promise.reject(new Error("unused")),
    steer: () => Promise.reject(new Error("unused")),
    flags: () => Promise.resolve({ verbose: true, mode: "fast" }),
    resolveUi: (requestId: string, response: PiExtensionUiResponse) => {
      answered.push({ requestId, response });
      return true;
    },
    ...overrides
  } as PiTransportHost;
  const sockets: LifecycleSockets = {
    accept: () => {},
    get: (tag) =>
      connections.filter(
        (connection) => tag === undefined || connection.tags.includes(tag)
      ) as unknown as WebSocket[]
  };
  return { transport: new PiTransport(host, () => sockets), answered };
}

function deliver(
  transport: PiTransport,
  connection: Connection,
  message: PiClientMessage
): Promise<void> {
  const handlers = transport.webSocketOptions().handlers;
  return Promise.resolve(
    handlers?.onMessage?.(connection, JSON.stringify(message))
  ).then(() => undefined);
}

describe("pi transport", () => {
  it("answers get_flags with the host's current flags", async () => {
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection]);

    await deliver(transport, client.connection, { type: "get_flags", id: "1" });

    expect(client.frames).toEqual([
      { type: "flags", id: "1", flags: { verbose: true, mode: "fast" } }
    ]);
  });

  it("reports a missing flags implementation as unsupported", async () => {
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection], {
      flags: undefined
    });

    await deliver(transport, client.connection, { type: "get_flags", id: "1" });

    expect(client.frames).toEqual([
      { type: "error", id: "1", message: "unsupported: get_flags" }
    ]);
  });

  it("tells a lane when one of its dialogs settles", () => {
    const client = socket("pi:main");
    const other = socket("pi:side");
    const { transport } = transportWith([client.connection, other.connection]);

    transport.extensionUiRequest("main", {
      method: "confirm",
      requestId: "r1",
      title: "Sure?",
      message: "really",
      timeoutMs: 1_000
    });
    transport.extensionUiSettled("main", "r1");

    expect(client.frames.at(-1)).toEqual({
      type: "extension_ui_settled",
      lane: "main",
      requestId: "r1"
    });
    expect(other.frames).toEqual([]);
  });

  it("refuses an answer to a dialog that already settled", async () => {
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection], {
      resolveUi: () => false
    });

    await deliver(transport, client.connection, {
      type: "extension_ui_response",
      id: "7",
      requestId: "r1",
      response: { confirmed: true }
    });

    expect(client.frames).toEqual([
      { type: "extension_ui_settled", lane: "main", requestId: "r1" },
      { type: "error", id: "7", message: "stale: extension_ui_response" }
    ]);
  });

  it("cancels a lane's open dialogs when its last subscriber leaves", () => {
    const client = socket("pi:main");
    const { transport, answered } = transportWith([client.connection]);
    const handlers = transport.webSocketOptions().handlers;

    transport.extensionUiRequest("main", {
      method: "input",
      requestId: "r1",
      title: "Name",
      timeoutMs: 60_000
    });
    // A view update never waits for an answer, so it is never cancelled.
    transport.extensionUiRequest("main", {
      method: "notify",
      requestId: "r2",
      message: "saved"
    });

    handlers?.onClose?.(client.connection, 1000, "", true);

    expect(answered).toEqual([
      { requestId: "r1", response: { cancelled: true } }
    ]);
  });

  it("keeps a dialog open while another subscriber is still listening", () => {
    const leaving = socket("pi:main");
    const staying = socket("pi:main");
    const { transport, answered } = transportWith([
      leaving.connection,
      staying.connection
    ]);
    const handlers = transport.webSocketOptions().handlers;

    transport.extensionUiRequest("main", {
      method: "input",
      requestId: "r1",
      title: "Name",
      timeoutMs: 60_000
    });
    handlers?.onClose?.(leaving.connection, 1000, "", true);

    expect(answered).toEqual([]);
  });
});
