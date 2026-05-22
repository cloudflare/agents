import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxSTT } from "../../src/providers/stt.js";

interface MockWebSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  accept: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  simulateMessage(data: unknown): void;
  simulateRawMessage(data: string): void;
  simulateClose(): void;
  simulateError(): void;
}

type MockWebSocketListener = (event: Event | MessageEvent) => void;

function createMockWebSocket(): MockWebSocket {
  const listeners: Record<string, MockWebSocketListener[]> = {};

  return {
    send: vi.fn(),
    close: vi.fn(),
    accept: vi.fn(),
    addEventListener: vi.fn((event: string, handler: MockWebSocketListener) => {
      listeners[event] ??= [];
      listeners[event].push(handler);
    }),
    simulateMessage(data: unknown) {
      for (const handler of listeners.message ?? []) {
        handler(new MessageEvent("message", { data: JSON.stringify(data) }));
      }
    },
    simulateRawMessage(data: string) {
      for (const handler of listeners.message ?? []) {
        handler(new MessageEvent("message", { data }));
      }
    },
    simulateClose() {
      for (const handler of listeners.close ?? []) {
        handler(new Event("close"));
      }
    },
    simulateError() {
      for (const handler of listeners.error ?? []) {
        handler(new Event("error"));
      }
    }
  };
}

let mockWebSockets: MockWebSocket[] = [];

const mockFetch = vi.fn((): Promise<{ webSocket?: MockWebSocket }> => {
  const ws = createMockWebSocket();
  mockWebSockets.push(ws);
  return Promise.resolve({ webSocket: ws });
});

vi.stubGlobal("fetch", mockFetch);

const flushConnection = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mockWebSockets = [];
  mockFetch.mockClear();
  mockFetch.mockImplementation((): Promise<{ webSocket?: MockWebSocket }> => {
    const ws = createMockWebSocket();
    mockWebSockets.push(ws);
    return Promise.resolve({ webSocket: ws });
  });
});

describe("TelnyxSTT", () => {
  describe("config", () => {
    it("creates with just an API key", () => {
      expect(new TelnyxSTT({ apiKey: "test-key" })).toBeDefined();
    });

    it("accepts engine, language, inputFormat, and interimResults overrides", () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        engine: "Deepgram",
        language: "es",
        inputFormat: "wav",
        transcriptionModel: "nova-3",
        interimResults: false
      });

      expect(stt).toBeDefined();
    });
  });

  describe("createSession", () => {
    it("returns a session with feed and close methods", () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();

      expect(typeof session.feed).toBe("function");
      expect(typeof session.close).toBe("function");
    });

    it("calls fetch with the correct URL and Authorization header", async () => {
      new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as unknown as [
        string,
        RequestInit
      ];
      expect(url).toBe(
        "https://api.telnyx.com/v2/speech-to-text/transcription?transcription_engine=Telnyx&input_format=wav&language=en&interim_results=true&token=test-key"
      );
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-key"
      );
      expect((opts.headers as Record<string, string>).Upgrade).toBe(
        "websocket"
      );
    });

    it("includes custom query params in the fetch URL", async () => {
      new TelnyxSTT({
        apiKey: "test-key",
        engine: "Deepgram",
        inputFormat: "mp3",
        transcriptionModel: "nova-3"
      }).createSession({ language: "fr" });
      await flushConnection();

      const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("transcription_engine=Deepgram");
      expect(url).toContain("input_format=mp3");
      expect(url).toContain("language=fr");
      expect(url).toContain("transcription_model=nova-3");
      expect(url).toContain("token=test-key");
    });

    it("omits transcription_model when not provided", async () => {
      new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).not.toContain("transcription_model");
    });

    it("uses sttWsUrl override when provided", async () => {
      new TelnyxSTT({
        apiKey: "test-key",
        sttWsUrl: "wss://localhost:9000/stt"
      }).createSession();
      await flushConnection();

      const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(
        "https://localhost:9000/stt?transcription_engine=Telnyx&input_format=wav&language=en&interim_results=true&token=test-key"
      );
    });

    it("calls accept after registering listeners", async () => {
      new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      expect(ws.accept).toHaveBeenCalledTimes(1);
      expect(ws.addEventListener).toHaveBeenCalledBefore(ws.accept);
    });

    it("sends a 44-byte WAV header before any audio when format is wav", async () => {
      new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      expect(ws.send).toHaveBeenCalledTimes(1);
      const header = ws.send.mock.calls[0]?.[0] as ArrayBuffer;
      expect(header.byteLength).toBe(44);
      const view = new DataView(header);
      expect(view.getUint32(0)).toBe(0x52494646);
      expect(view.getUint32(8)).toBe(0x57415645);
      expect(view.getUint16(22, true)).toBe(1);
      expect(view.getUint32(24, true)).toBe(16000);
    });

    it("does not send WAV header when format is not wav", async () => {
      new TelnyxSTT({
        apiKey: "test-key",
        inputFormat: "webm"
      }).createSession();
      await flushConnection();

      expect(mockWebSockets[0].send).not.toHaveBeenCalled();
    });
  });
});

describe("TelnyxSTTSession", () => {
  describe("feed", () => {
    it("buffers audio chunks before connection is established", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      const chunk = new ArrayBuffer(1024);

      session.feed(chunk);
      if (mockWebSockets.length > 0) {
        expect(mockWebSockets[0].send).not.toHaveBeenCalledWith(chunk);
      }

      await flushConnection();
      const ws = mockWebSockets[0];
      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(ws.send).toHaveBeenNthCalledWith(2, chunk);
    });

    it("flushes buffered chunks when connection is established", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      const chunk1 = new ArrayBuffer(1024);
      const chunk2 = new ArrayBuffer(512);

      session.feed(chunk1);
      session.feed(chunk2);
      await flushConnection();

      const ws = mockWebSockets[0];
      expect(ws.send).toHaveBeenCalledTimes(3);
      expect(ws.send).toHaveBeenNthCalledWith(2, chunk1);
      expect(ws.send).toHaveBeenNthCalledWith(3, chunk2);
    });

    it("sends chunks directly when connection is already open", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      const chunk = new ArrayBuffer(2048);
      session.feed(chunk);

      expect(mockWebSockets[0].send).toHaveBeenCalledWith(chunk);
    });

    it("does nothing after close", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      session.close();
      ws.send.mockClear();
      session.feed(new ArrayBuffer(1024));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("does nothing after WebSocket error", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateError();
      ws.send.mockClear();
      session.feed(new ArrayBuffer(1024));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("does nothing after fetch fails", async () => {
      mockFetch.mockImplementationOnce(() =>
        Promise.reject(new Error("network error"))
      );
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();
      session.feed(new ArrayBuffer(1024));

      expect(mockWebSockets).toHaveLength(0);
      consoleSpy.mockRestore();
    });

    it("does nothing when fetch returns no webSocket", async () => {
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({ webSocket: undefined } as {
          webSocket?: MockWebSocket;
        })
      );
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();
      session.feed(new ArrayBuffer(1024));

      expect(mockWebSockets).toHaveLength(0);
      consoleSpy.mockRestore();
    });
  });

  describe("transcript callbacks", () => {
    it("fires onInterim for non-final transcripts", async () => {
      const onInterim = vi.fn();
      new TelnyxSTT({ apiKey: "test-key" }).createSession({ onInterim });
      await flushConnection();

      mockWebSockets[0].simulateMessage({
        transcript: "Hello",
        is_final: false,
        confidence: 0.8
      });

      expect(onInterim).toHaveBeenCalledWith("Hello");
    });

    it("fires onUtterance for final transcripts", async () => {
      const onUtterance = vi.fn();
      new TelnyxSTT({ apiKey: "test-key" }).createSession({ onUtterance });
      await flushConnection();

      mockWebSockets[0].simulateMessage({
        transcript: "Hello world",
        is_final: true,
        confidence: 0.95
      });

      expect(onUtterance).toHaveBeenCalledWith("Hello world");
    });

    it("fires onInterim multiple times as transcript builds up", async () => {
      const onInterim = vi.fn();
      new TelnyxSTT({ apiKey: "test-key" }).createSession({ onInterim });
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ transcript: "Hel", is_final: false });
      ws.simulateMessage({ transcript: "Hello", is_final: false });
      ws.simulateMessage({ transcript: "Hello wor", is_final: false });

      expect(onInterim).toHaveBeenCalledTimes(3);
      expect(onInterim).toHaveBeenNthCalledWith(1, "Hel");
      expect(onInterim).toHaveBeenNthCalledWith(2, "Hello");
      expect(onInterim).toHaveBeenNthCalledWith(3, "Hello wor");
    });

    it("ignores empty, missing, and unparseable transcripts", async () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      new TelnyxSTT({ apiKey: "test-key" }).createSession({
        onInterim,
        onUtterance
      });
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ transcript: "", is_final: false });
      ws.simulateMessage({ error: "something went wrong" });
      ws.simulateRawMessage("not json");

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });

    it("works without callbacks", async () => {
      new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      expect(() => {
        mockWebSockets[0].simulateMessage({
          transcript: "Hello",
          is_final: false
        });
        mockWebSockets[0].simulateMessage({
          transcript: "Hello",
          is_final: true
        });
      }).not.toThrow();
    });
  });

  describe("close", () => {
    it("closes a WebSocket that resolves after the session is closed", async () => {
      const ws = createMockWebSocket();
      let resolveFetch:
        | ((value: { webSocket?: MockWebSocket }) => void)
        | undefined;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise<{ webSocket?: MockWebSocket }>((resolve) => {
            resolveFetch = resolve;
          })
      );

      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      session.close();
      resolveFetch?.({ webSocket: ws });
      await flushConnection();

      expect(ws.accept).toHaveBeenCalledTimes(1);
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("closes the WebSocket", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      session.close();

      expect(mockWebSockets[0].close).toHaveBeenCalledTimes(1);
    });

    it("clears pending buffer on close before connection", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      session.feed(new ArrayBuffer(1024));
      session.feed(new ArrayBuffer(1024));

      session.close();
      await flushConnection();

      if (mockWebSockets.length > 0) {
        expect(mockWebSockets[0].send).not.toHaveBeenCalled();
      }
    });

    it("is idempotent", async () => {
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession();
      await flushConnection();

      expect(() => {
        session.close();
        session.close();
      }).not.toThrow();
      expect(mockWebSockets[0].close).toHaveBeenCalledTimes(1);
    });

    it("stops firing callbacks after close", async () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      const session = new TelnyxSTT({ apiKey: "test-key" }).createSession({
        onInterim,
        onUtterance
      });
      await flushConnection();

      session.close();
      mockWebSockets[0].simulateMessage({
        transcript: "Hello",
        is_final: false
      });
      mockWebSockets[0].simulateMessage({
        transcript: "Hello",
        is_final: true
      });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });
  });
});
