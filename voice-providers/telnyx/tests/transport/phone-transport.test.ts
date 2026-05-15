import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxPhoneTransport } from "../../src/transport/phone-transport.js";
import type { VoiceTransport } from "@cloudflare/voice/client";
import type { TelnyxCallBridge } from "../../src/providers/call-bridge.js";

type MockTransport = VoiceTransport & {
  _connected: boolean;
  _fireMessage: (data: string | ArrayBuffer | Blob) => void;
  _fireOpen: () => void;
  _fireClose: () => void;
  _fireError: (err?: unknown) => void;
  sendJSON: ReturnType<typeof vi.fn>;
  sendBinary: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MockBridge = TelnyxCallBridge & {
  playAudio: ReturnType<typeof vi.fn>;
};

function createMockTransport(): MockTransport {
  const transport = {
    _connected: false,
    get connected() {
      return this._connected;
    },
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as ((error?: unknown) => void) | null,
    onmessage: null as ((data: string | ArrayBuffer | Blob) => void) | null,
    sendJSON: vi.fn(),
    sendBinary: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    _fireMessage(data: string | ArrayBuffer | Blob) {
      transport.onmessage?.(data);
    },
    _fireOpen() {
      transport.onopen?.();
    },
    _fireClose() {
      transport.onclose?.();
    },
    _fireError(err?: unknown) {
      transport.onerror?.(err);
    }
  };

  return transport as MockTransport;
}

function createMockBridge(): MockBridge {
  return {
    playAudio: vi.fn(),
    onAudioLevel: null,
    onAudioData: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    connected: false,
    activeCall: null,
    answer: vi.fn(),
    hangup: vi.fn(),
    dial: vi.fn(),
    sendDTMF: vi.fn(),
    clearPlaybackBuffer: vi.fn()
  } as unknown as MockBridge;
}

describe("TelnyxPhoneTransport", () => {
  let inner: MockTransport;
  let bridge: MockBridge;
  let transport: TelnyxPhoneTransport;

  beforeEach(() => {
    inner = createMockTransport();
    bridge = createMockBridge();
    transport = new TelnyxPhoneTransport({ inner, bridge });
  });

  describe("VoiceTransport delegation", () => {
    it("delegates sendJSON to inner transport", () => {
      transport.sendJSON({ type: "hello" });

      expect(inner.sendJSON).toHaveBeenCalledWith({ type: "hello" });
    });

    it("delegates sendBinary to inner transport", () => {
      const data = new ArrayBuffer(16);
      transport.sendBinary(data);

      expect(inner.sendBinary).toHaveBeenCalledWith(data);
    });

    it("delegates connect to inner transport", () => {
      transport.connect();

      expect(inner.connect).toHaveBeenCalled();
    });

    it("delegates disconnect to inner transport", () => {
      transport.disconnect();

      expect(inner.disconnect).toHaveBeenCalled();
    });

    it("reads connected from inner transport", () => {
      expect(transport.connected).toBe(false);
      inner._connected = true;
      expect(transport.connected).toBe(true);
    });
  });

  describe("callback proxying", () => {
    it("proxies onopen to VoiceClient handler", () => {
      const onopen = vi.fn();
      transport.onopen = onopen;
      transport.connect();
      inner._fireOpen();

      expect(onopen).toHaveBeenCalled();
    });

    it("proxies onclose to VoiceClient handler", () => {
      const onclose = vi.fn();
      transport.onclose = onclose;
      transport.connect();
      inner._fireClose();

      expect(onclose).toHaveBeenCalled();
    });

    it("proxies onerror to VoiceClient handler", () => {
      const onerror = vi.fn();
      transport.onerror = onerror;
      transport.connect();
      inner._fireError("fail");

      expect(onerror).toHaveBeenCalledWith("fail");
    });

    it("forwards JSON messages to VoiceClient handler", () => {
      const onmessage = vi.fn();
      transport.onmessage = onmessage;
      transport.connect();
      inner._fireMessage('{"type":"status","status":"listening"}');

      expect(onmessage).toHaveBeenCalledWith(
        '{"type":"status","status":"listening"}'
      );
    });

    it("forwards binary messages to VoiceClient handler", () => {
      const onmessage = vi.fn();
      transport.onmessage = onmessage;
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');
      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);

      expect(onmessage).toHaveBeenCalledWith(audio);
    });
  });

  describe("audio routing to bridge", () => {
    it("routes pcm16 audio to bridge.playAudio", () => {
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');
      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);

      expect(bridge.playAudio).toHaveBeenCalledWith(audio);
    });

    it("routes audio before audio_config by assuming pcm16", () => {
      transport.onmessage = vi.fn();
      transport.connect();
      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);

      expect(bridge.playAudio).toHaveBeenCalledWith(audio);
    });

    it("does not route non-pcm16 audio to bridge", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      inner._fireMessage(new ArrayBuffer(320));

      expect(bridge.playAudio).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Server audio format is "mp3"')
      );
      warnSpy.mockRestore();
    });

    it("warns only once for non-pcm16 format", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      inner._fireMessage(new ArrayBuffer(320));
      inner._fireMessage(new ArrayBuffer(320));
      inner._fireMessage(new ArrayBuffer(320));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("resets warning when audio_config changes", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      inner._fireMessage(new ArrayBuffer(320));
      expect(warnSpy).toHaveBeenCalledTimes(1);

      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');
      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);
      expect(bridge.playAudio).toHaveBeenCalledWith(audio);
      warnSpy.mockRestore();
    });

    it("routes Blob audio to bridge after converting to ArrayBuffer", async () => {
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
      inner._fireMessage(blob);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(bridge.playAudio).toHaveBeenCalled();
    });
  });

  describe("onServerAudio callback", () => {
    it("calls onServerAudio for every binary frame regardless of format", () => {
      const onServerAudio = vi.fn();
      transport = new TelnyxPhoneTransport({ inner, bridge, onServerAudio });
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);

      expect(onServerAudio).toHaveBeenCalledWith(audio);
      expect(bridge.playAudio).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does not call onServerAudio for JSON messages", () => {
      const onServerAudio = vi.fn();
      transport = new TelnyxPhoneTransport({ inner, bridge, onServerAudio });
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage('{"type":"status","status":"speaking"}');

      expect(onServerAudio).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("handles malformed JSON gracefully", () => {
      transport.onmessage = vi.fn();
      transport.connect();
      inner._fireMessage("not json at all {{{");

      expect(transport.onmessage).toHaveBeenCalledWith("not json at all {{{");
    });

    it("works when no onmessage handler is set", () => {
      transport.connect();
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');
      inner._fireMessage(new ArrayBuffer(320));

      expect(bridge.playAudio).toHaveBeenCalled();
    });
  });
});
