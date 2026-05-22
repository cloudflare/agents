import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxTTS } from "../../src/providers/tts.js";

const realFetch = globalThis.fetch;
const mockFetch = vi.fn();

function mockAudioResponse(bytes = 4096): Response {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint8Array(buffer);
  view[0] = 0xff;
  view[1] = 0xf3;

  return new Response(buffer, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" }
  });
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  send = vi.fn();
  close = vi.fn();
  accept = vi.fn();
  addEventListener = vi.fn(
    (type: string, handler: (...args: unknown[]) => void) => {
      if (type === "message") this.messageHandlers.push(handler);
      if (type === "close") this.closeHandlers.push(handler);
      if (type === "error") this.errorHandlers.push(handler);
    }
  );
  removeEventListener = vi.fn();

  messageHandlers: ((...args: unknown[]) => void)[] = [];
  closeHandlers: ((...args: unknown[]) => void)[] = [];
  errorHandlers: ((...args: unknown[]) => void)[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateMessage(data: string) {
    const event = { data } as MessageEvent;
    this.messageHandlers.forEach((handler) => handler(event));
  }

  simulateClose() {
    this.closeHandlers.forEach((handler) => handler({} as CloseEvent));
  }
}

describe("TelnyxTTS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  describe("construction", () => {
    it("creates with apiKey via TelnyxClient", () => {
      expect(new TelnyxTTS({ apiKey: "test-key" })).toBeDefined();
    });

    it("accepts custom voice", () => {
      expect(
        new TelnyxTTS({ apiKey: "test-key", voice: "Telnyx.NaturalHD.luna" })
      ).toBeDefined();
    });

    it("accepts websocket backend", () => {
      expect(
        new TelnyxTTS({ apiKey: "test-key", backend: "websocket" })
      ).toBeDefined();
    });
  });

  describe("REST backend synthesize", () => {
    it("sends POST with correct URL, auth, and body", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });
      mockFetch.mockResolvedValueOnce(mockAudioResponse());

      await tts.synthesize("Hello world");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.telnyx.com/v2/text-to-speech/speech");
      expect(opts.method).toBe("POST");
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-key"
      );

      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      expect(body.text).toBe("Hello world");
      expect(body.voice).toBe("Telnyx.NaturalHD.astra");
    });

    it("returns ArrayBuffer on success", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });
      mockFetch.mockResolvedValueOnce(mockAudioResponse(2048));

      const audio = await tts.synthesize("Hello");

      expect(audio).toBeInstanceOf(ArrayBuffer);
      expect(audio?.byteLength).toBe(2048);
    });

    it("returns null for empty text without calling API", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });

      expect(await tts.synthesize("")).toBeNull();
      expect(await tts.synthesize("   ")).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns null on API error", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 })
      );

      expect(await tts.synthesize("Hello")).toBeNull();
      consoleSpy.mockRestore();
    });

    it("returns null when pre-aborted", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });
      const controller = new AbortController();
      controller.abort();
      mockFetch.mockRejectedValueOnce(new DOMException("Aborted"));

      expect(await tts.synthesize("Hello", controller.signal)).toBeNull();
    });

    it("uses custom voice in request body", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        voice: "Telnyx.Ultra.my-voice"
      });
      mockFetch.mockResolvedValueOnce(mockAudioResponse());

      await tts.synthesize("Hello");

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      expect(body.voice).toBe("Telnyx.Ultra.my-voice");
    });
  });

  describe("REST backend synthesizeStream", () => {
    it("yields single chunk from REST response", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });
      mockFetch.mockResolvedValueOnce(mockAudioResponse(4096));
      const chunks: ArrayBuffer[] = [];

      for await (const chunk of tts.synthesizeStream("Hello")) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].byteLength).toBe(4096);
    });

    it("yields nothing for empty text", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });
      const chunks: ArrayBuffer[] = [];

      for await (const chunk of tts.synthesizeStream("")) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
    });
  });

  describe("WebSocket backend", () => {
    it("uses fetch upgrade with Authorization header", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      const mockWs = new MockWebSocket("mock");
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello");

      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("text-to-speech/speech");
      expect((opts.headers as Record<string, string>).Upgrade).toBe(
        "websocket"
      );
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-key"
      );

      mockWs.simulateMessage(
        JSON.stringify({
          audio: btoa("fake-audio"),
          text: null,
          isFinal: false
        })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );

      const audio = await promise;
      expect(audio).toBeInstanceOf(ArrayBuffer);
      expect(audio?.byteLength).toBeGreaterThan(0);
      expect(mockWs.send).toHaveBeenCalledTimes(3);
      expect(JSON.parse(mockWs.send.mock.calls[0]?.[0] as string)).toEqual({
        text: " "
      });
      expect(JSON.parse(mockWs.send.mock.calls[1]?.[0] as string)).toEqual({
        text: "Hello"
      });
      expect(JSON.parse(mockWs.send.mock.calls[2]?.[0] as string)).toEqual({
        text: ""
      });
    });

    it("registers listeners before accept to avoid race", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      const mockWs = new MockWebSocket("mock");
      const callOrder: string[] = [];

      mockWs.addEventListener = vi.fn((...args: unknown[]) => {
        callOrder.push(`addEventListener:${args[0]}`);
        const type = args[0];
        const handler = args[1] as (...a: unknown[]) => void;
        if (type === "message") mockWs.messageHandlers.push(handler);
        if (type === "close") mockWs.closeHandlers.push(handler);
        if (type === "error") mockWs.errorHandlers.push(handler);
      });
      mockWs.accept = vi.fn(() => callOrder.push("accept"));
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello");
      await vi.waitFor(() => expect(mockWs.accept).toHaveBeenCalled());

      const acceptIndex = callOrder.indexOf("accept");
      const messageIndex = callOrder.findIndex((call) =>
        call.startsWith("addEventListener:message")
      );
      expect(messageIndex).toBeLessThan(acceptIndex);

      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );
      await promise;
    });

    it("returns null with clear error when not in Workers runtime", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      mockFetch.mockResolvedValueOnce({ ok: true });
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const audio = await tts.synthesize("Hello");

      expect(audio).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cloudflare Workers runtime")
      );
      consoleSpy.mockRestore();
    });

    it("logs underlying error on connection failure", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      const fetchError = new TypeError("fetch failed");
      mockFetch.mockRejectedValueOnce(fetchError);
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const audio = await tts.synthesize("Hello");

      expect(audio).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[TelnyxTTS] WebSocket connection failed:",
        fetchError
      );
      consoleSpy.mockRestore();
    });

    it("synthesize collects chunks incrementally via WebSocket", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      const mockWs = new MockWebSocket("mock");
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello");
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

      mockWs.simulateMessage(
        JSON.stringify({ audio: btoa("chunk-one"), text: null, isFinal: false })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: btoa("chunk-two"), text: null, isFinal: false })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );

      const audio = await promise;
      expect(audio).toBeInstanceOf(ArrayBuffer);
      expect(audio?.byteLength).toBeGreaterThan(0);
    });

    it("handles abort via signal", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      const controller = new AbortController();
      controller.abort();
      mockFetch.mockResolvedValueOnce({ webSocket: new MockWebSocket("mock") });

      const audio = await tts.synthesize("Hello", controller.signal);

      expect(audio).toBeNull();
    });

    it("unblocks a waiting stream immediately when abort close throws", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      const controller = new AbortController();
      const mockWs = new MockWebSocket("mock");
      mockWs.close.mockImplementation(() => {
        throw new Error("close failed");
      });
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello", controller.signal);
      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(3));
      controller.abort();

      await expect(promise).resolves.toBeNull();
    });

    it("skips blob frames where text is not null", async () => {
      const tts = new TelnyxTTS({ apiKey: "test-key", backend: "websocket" });
      const mockWs = new MockWebSocket("mock");
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello");
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

      mockWs.simulateMessage(
        JSON.stringify({
          audio: btoa("real-audio"),
          text: null,
          isFinal: false
        })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "Hello", isFinal: false })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );

      const audio = await promise;
      expect(audio).toBeInstanceOf(ArrayBuffer);
      expect(audio?.byteLength).toBe(10);
    });
  });
});

const hasApiKey = !!process.env.TELNYX_API_KEY;

describe.skipIf(!hasApiKey)("TelnyxTTS integration REST", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  it("synthesize returns real mp3 audio", async () => {
    const tts = new TelnyxTTS({ apiKey: process.env.TELNYX_API_KEY! });
    const audio = await tts.synthesize("Hello world");

    expect(audio).toBeInstanceOf(ArrayBuffer);
    expect(audio?.byteLength).toBeGreaterThan(1000);
    const header = new Uint8Array(audio!, 0, 2);
    expect(header[0]).toBe(0xff);
    expect(header[1] & 0xe0).toBe(0xe0);
  });

  it("synthesizeStream yields audio", async () => {
    const tts = new TelnyxTTS({ apiKey: process.env.TELNYX_API_KEY! });
    const chunks: ArrayBuffer[] = [];

    for await (const chunk of tts.synthesizeStream("Testing stream")) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].byteLength).toBeGreaterThan(1000);
  });

  it("custom voice works", async () => {
    const tts = new TelnyxTTS({
      apiKey: process.env.TELNYX_API_KEY!,
      voice: "Telnyx.NaturalHD.luna"
    });
    const audio = await tts.synthesize("Custom voice test");

    expect(audio).toBeInstanceOf(ArrayBuffer);
    expect(audio?.byteLength).toBeGreaterThan(1000);
  });
});
