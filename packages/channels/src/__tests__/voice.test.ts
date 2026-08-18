import { describe, expect, it, vi } from "vitest";
import { browserVoice, type BrowserVoiceConnection } from "../voice";

function parseFrame(value: string | ArrayBuffer | ArrayBufferView) {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

describe("browserVoice", () => {
  it("synthesizes and sends one utterance through the Voice protocol", async () => {
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const tts = { synthesize: vi.fn(async () => audio) };
    const connection = { id: "browser-1", send: vi.fn() };
    const channel = browserVoice({
      tts,
      getConnection: () => connection,
      toSpeechText: (message) => message.markdown.replaceAll("**", "")
    });

    const result = await channel.deliver({
      title: "Update",
      markdown: "It **works**"
    });

    expect(result).toMatchObject({ status: "delivered" });
    expect(tts.synthesize).toHaveBeenCalledWith("It works");
    expect(
      connection.send.mock.calls.map(([value]) => parseFrame(value))
    ).toEqual([
      { type: "welcome", protocol_version: 1 },
      { type: "audio_config", format: "mp3", sampleRate: 16_000 },
      { type: "status", status: "speaking" },
      { type: "transcript", role: "assistant", text: "It works" },
      audio,
      { type: "status", status: "idle" }
    ]);
  });

  it("looks up the live connection for availability and delivery", async () => {
    const audio = new ArrayBuffer(1);
    const connection = { id: "browser-1", send: vi.fn() };
    let available: BrowserVoiceConnection | undefined;
    const channel = browserVoice({
      tts: { synthesize: async () => audio },
      getConnection: () => available
    });

    expect(await channel.isAvailable?.()).toBe(false);
    await expect(channel.deliver({ markdown: "First" })).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "BROWSER_VOICE_UNAVAILABLE",
        message: "No browser voice surface is connected"
      }
    });

    available = connection;
    expect(await channel.isAvailable?.()).toBe(true);
    await expect(
      channel.deliver({ markdown: "Second" })
    ).resolves.toMatchObject({ status: "delivered" });
  });

  it.each([
    {
      value: null,
      message: "The text-to-speech provider did not return audio"
    },
    { value: new Error("TTS unavailable"), message: "TTS unavailable" }
  ])(
    "returns a retryable failure when synthesis fails",
    async ({ value, message }) => {
      const connection = { id: "browser-1", send: vi.fn() };
      const channel = browserVoice({
        tts: {
          synthesize: async () => {
            if (value instanceof Error) throw value;
            return value;
          }
        },
        getConnection: () => connection
      });

      await expect(channel.deliver({ markdown: "Hello" })).resolves.toEqual({
        status: "failed",
        retryable: true,
        error: { code: "BROWSER_VOICE_TTS_FAILED", message }
      });
      expect(connection.send).not.toHaveBeenCalled();
    }
  );

  it("classifies a connection closed before the first send as retryable", async () => {
    const connection = {
      id: "stale",
      send: vi.fn(() => {
        throw new TypeError("WebSocket send() after close");
      })
    };
    const channel = browserVoice({
      tts: { synthesize: async () => new ArrayBuffer(1) },
      getConnection: () => connection
    });

    await expect(channel.deliver({ markdown: "Hello" })).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "BROWSER_VOICE_CONNECTION_CLOSED",
        message: "The browser voice surface disconnected before delivery"
      }
    });
  });

  it("keeps setup failures retryable until content delivery starts", async () => {
    let sends = 0;
    const connection = {
      id: "browser-1",
      send() {
        sends += 1;
        if (sends === 2) throw new Error("Unexpected transport error");
      }
    };
    const channel = browserVoice({
      tts: { synthesize: async () => new ArrayBuffer(1) },
      getConnection: () => connection
    });

    await expect(channel.deliver({ markdown: "Hello" })).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "BROWSER_VOICE_DELIVERY_FAILED",
        message: "Unexpected transport error"
      }
    });
  });

  it("treats a failure after content delivery starts as uncertain", async () => {
    let sends = 0;
    const connection = {
      id: "browser-1",
      send() {
        sends += 1;
        if (sends === 5) throw new Error("Unexpected transport error");
      }
    };
    const channel = browserVoice({
      tts: { synthesize: async () => new ArrayBuffer(1) },
      getConnection: () => connection
    });

    await expect(channel.deliver({ markdown: "Hello" })).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "BROWSER_VOICE_DELIVERY_ERROR",
        message: "Unexpected transport error"
      }
    });
  });

  it("declares PCM format and sample rate when configured", async () => {
    const connection = { id: "browser-1", send: vi.fn() };
    const channel = browserVoice({
      tts: { synthesize: async () => new ArrayBuffer(2) },
      getConnection: () => connection,
      audioFormat: "pcm16",
      sampleRate: 24_000
    });

    await channel.deliver({ markdown: "Hello" });

    expect(parseFrame(connection.send.mock.calls[1]?.[0])).toEqual({
      type: "audio_config",
      format: "pcm16",
      sampleRate: 24_000
    });
  });
});
