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
  message: PiClientMessage | Record<string, unknown>
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

  it("refuses an answer from a client on another lane", async () => {
    const owner = socket("pi:main");
    const intruder = socket("pi:side");
    const { transport, answered } = transportWith([
      owner.connection,
      intruder.connection
    ]);

    transport.extensionUiRequest("main", {
      method: "confirm",
      requestId: "r1",
      title: "Delete everything?",
      message: "really",
      timeoutMs: 60_000
    });
    await deliver(transport, intruder.connection, {
      type: "extension_ui_response",
      id: "9",
      requestId: "r1",
      response: { confirmed: true }
    });

    // Nothing was resolved, and the dialog stays open for its own lane.
    expect(answered).toEqual([]);
    expect(intruder.frames).toEqual([
      {
        type: "error",
        id: "9",
        message: 'Dialog "r1" does not belong to lane "side"'
      }
    ]);
    expect(owner.frames.at(-1)).toMatchObject({
      type: "extension_ui_request",
      requestId: "r1"
    });
  });

  it("accepts the answer from the lane that owns the dialog", async () => {
    const owner = socket("pi:main");
    const { transport, answered } = transportWith([owner.connection]);

    transport.extensionUiRequest("main", {
      method: "confirm",
      requestId: "r1",
      title: "Sure?",
      message: "really",
      timeoutMs: 60_000
    });
    await deliver(transport, owner.connection, {
      type: "extension_ui_response",
      id: "9",
      requestId: "r1",
      response: { confirmed: true }
    });

    expect(answered).toEqual([
      { requestId: "r1", response: { confirmed: true } }
    ]);
    expect(owner.frames.at(-1)).toEqual({
      type: "result",
      id: "9",
      result: true
    });
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

describe("pi transport frame validation", () => {
  it("rejects a submit whose request is not a pi operation", async () => {
    const submitted: unknown[] = [];
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection], {
      submit: (request) => {
        submitted.push(request);
        return Promise.resolve({
          operationId: "op",
          lane: "main",
          accepted: true
        });
      }
    });

    await deliver(transport, client.connection, {
      type: "submit",
      id: "1",
      request: { kind: "sudo", prompt: "hi" }
    });

    expect(submitted).toEqual([]);
    expect(client.frames).toEqual([
      { type: "error", id: "1", message: "Malformed submit message" }
    ]);
  });

  it("rejects a submit missing the field its kind requires", async () => {
    const submitted: unknown[] = [];
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection], {
      submit: (request) => {
        submitted.push(request);
        return Promise.resolve({
          operationId: "op",
          lane: "main",
          accepted: true
        });
      }
    });

    await deliver(transport, client.connection, {
      type: "submit",
      id: "2",
      request: { kind: "navigation" }
    });

    expect(submitted).toEqual([]);
    expect(client.frames).toEqual([
      { type: "error", id: "2", message: "Malformed submit message" }
    ]);
  });

  it("rejects a set_flag whose value is neither a string nor a boolean", async () => {
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection], {
      setFlag: () => Promise.reject(new Error("must not run"))
    });

    await deliver(transport, client.connection, {
      type: "set_flag",
      id: "3",
      name: "verbose",
      value: 1
    });

    expect(client.frames).toEqual([
      { type: "error", id: "3", message: "Malformed set_flag message" }
    ]);
  });

  it("rejects a subscribe with no stream id", async () => {
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection]);

    await deliver(transport, client.connection, {
      type: "subscribe",
      id: "4"
    });

    expect(client.frames).toEqual([
      { type: "error", id: "4", message: "Malformed subscribe message" }
    ]);
  });

  it("names an unknown frame type and keeps the id", async () => {
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection]);

    await deliver(transport, client.connection, {
      type: "drop_table",
      id: "5"
    });

    expect(client.frames).toEqual([
      {
        type: "error",
        id: "5",
        message: 'Unknown pi message type "drop_table"'
      }
    ]);
  });

  it("rejects a frame that is not an object", async () => {
    const client = socket("pi:main");
    const { transport } = transportWith([client.connection]);
    const handlers = transport.webSocketOptions().handlers;

    await handlers?.onMessage?.(client.connection, JSON.stringify(["submit"]));

    expect(client.frames).toEqual([
      { type: "error", message: "Malformed pi message" }
    ]);
  });
});
