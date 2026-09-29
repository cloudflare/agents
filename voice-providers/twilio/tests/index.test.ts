import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TwilioAdapter } from "../src/index.js";

type Handler = (event: { data?: unknown }) => void | Promise<void>;

class FakeWebSocket {
  readyState = 1;
  sent: unknown[] = [];
  private handlers = new Map<string, Handler[]>();

  accept() {}

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  addEventListener(event: string, handler: Handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async emit(event: string, payload: { data?: unknown } = {}) {
    await Promise.all(
      (this.handlers.get(event) ?? []).map((handler) => handler(payload))
    );
  }

  get jsonSent(): Record<string, unknown>[] {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }
}

const OriginalResponse = globalThis.Response;
let serverSocket: FakeWebSocket | null = null;

beforeAll(() => {
  Object.assign(globalThis, {
    WebSocketPair: function (this: Record<number, FakeWebSocket>) {
      this[0] = new FakeWebSocket();
      this[1] = new FakeWebSocket();
      serverSocket = this[1];
    },
    Response: class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      }
    }
  });
});

afterAll(() => {
  Object.assign(globalThis, { Response: OriginalResponse });
  delete (globalThis as Record<string, unknown>).WebSocketPair;
});

interface Harness {
  agentSocket: FakeWebSocket;
  serverSocket: FakeWebSocket;
  getAgentRequest(): Request | null;
  startCall(): Promise<void>;
  sendInbound(payload: string): Promise<void>;
}

function createHarness(): Harness {
  const agentSocket = new FakeWebSocket();
  let agentRequest: Request | null = null;
  const env = {
    MyAgent: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          fetch: async (request: Request) => {
            agentRequest = request;
            return { webSocket: agentSocket };
          }
        };
      }
    }
  };

  TwilioAdapter.handleRequest(
    new Request("https://example.com/twilio", {
      headers: { Upgrade: "websocket" }
    }),
    env,
    "MyAgent"
  );

  if (!serverSocket) throw new Error("WebSocketPair was not constructed");
  const activeServerSocket = serverSocket;

  return {
    agentSocket,
    serverSocket: activeServerSocket,
    getAgentRequest: () => agentRequest,
    startCall: () =>
      activeServerSocket.emit("message", {
        data: JSON.stringify({
          event: "start",
          streamSid: "stream-1",
          start: {
            streamSid: "stream-1",
            accountSid: "account-1",
            callSid: "call-1",
            tracks: ["inbound"],
            customParameters: {},
            mediaFormat: {
              encoding: "audio/x-mulaw",
              sampleRate: 8000,
              channels: 1
            }
          }
        })
      }),
    sendInbound: (payload: string) =>
      activeServerSocket.emit("message", {
        data: JSON.stringify({
          event: "media",
          streamSid: "stream-1",
          media: {
            track: "inbound",
            chunk: "1",
            timestamp: "0",
            payload
          }
        })
      })
  };
}

describe("TwilioAdapter.handleRequest", () => {
  it("opens the VoiceAgent WebSocket through an HTTPS Durable Object request", async () => {
    const harness = createHarness();

    await harness.startCall();

    expect(harness.getAgentRequest()?.url).toBe(
      "https://example.com/agents/myagent/call-1"
    );
    expect(harness.getAgentRequest()?.headers.get("Upgrade")).toBe("websocket");
    expect(harness.agentSocket.jsonSent).toEqual([{ type: "start_call" }]);
  });

  it("forwards VoiceAgent audio delivered as a Blob to Twilio", async () => {
    const harness = createHarness();
    await harness.startCall();

    await harness.agentSocket.emit("message", {
      data: new Blob([new Int16Array([0, 0, 0, 0]).buffer])
    });

    expect(harness.serverSocket.jsonSent).toEqual([
      {
        event: "media",
        streamSid: "stream-1",
        media: { payload: "//8=" }
      }
    ]);
  });

  it("clears Twilio playback when the VoiceAgent reports an interruption", async () => {
    const harness = createHarness();
    await harness.startCall();

    await harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });

    expect(harness.serverSocket.jsonSent).toContainEqual({
      event: "clear",
      streamSid: "stream-1"
    });
  });

  it("preserves Blob audio ordering across an interruption", async () => {
    const harness = createHarness();
    await harness.startCall();

    let finishConversion: (() => void) | undefined;
    class DelayedBlob extends Blob {
      async arrayBuffer(): Promise<ArrayBuffer> {
        await new Promise<void>((resolve) => {
          finishConversion = resolve;
        });
        return super.arrayBuffer();
      }
    }

    const audioDelivery = harness.agentSocket.emit("message", {
      data: new DelayedBlob([new Int16Array([0, 0, 0, 0]).buffer])
    });
    await Promise.resolve();
    const interruptDelivery = harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });

    finishConversion?.();
    await Promise.all([audioDelivery, interruptDelivery]);

    expect(harness.serverSocket.jsonSent).toEqual([
      {
        event: "media",
        streamSid: "stream-1",
        media: { payload: "//8=" }
      },
      { event: "clear", streamSid: "stream-1" }
    ]);
  });

  it("interrupts buffered playback after sustained caller speech", async () => {
    const harness = createHarness();
    await harness.startCall();
    const agentAudio = new Int16Array(320).fill(5_000).buffer;
    await harness.agentSocket.emit("message", { data: agentAudio });

    // G.711 mulaw byte 0xce decodes to 988, above the speech threshold.
    const callerSpeech = btoa(
      String.fromCharCode(...new Uint8Array(160).fill(0xce))
    );
    await harness.sendInbound(callerSpeech);
    await harness.sendInbound(callerSpeech);
    expect(
      harness.serverSocket.jsonSent.filter(
        (message) => message.event === "clear"
      )
    ).toHaveLength(0);

    await harness.sendInbound(callerSpeech);

    expect(harness.serverSocket.jsonSent).toContainEqual({
      event: "clear",
      streamSid: "stream-1"
    });
    expect(harness.agentSocket.jsonSent).toContainEqual({ type: "interrupt" });

    await harness.agentSocket.emit("message", { data: agentAudio });
    expect(
      harness.serverSocket.jsonSent.filter(
        (message) => message.event === "media"
      )
    ).toHaveLength(1);

    await harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "status", status: "listening" })
    });
    await harness.agentSocket.emit("message", { data: agentAudio });
    expect(
      harness.serverSocket.jsonSent.filter(
        (message) => message.event === "media"
      )
    ).toHaveLength(2);
  });
});
