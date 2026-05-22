import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelnyxPhoneClient } from "../src/phone-client.js";
import type { VoiceTransport } from "@cloudflare/voice/client";
import type { TelnyxCallBridge } from "../src/providers/call-bridge.js";

type MockTransport = VoiceTransport & {
  _fireOpen: () => void;
  _fireClose: () => void;
  _fireError: (err?: unknown) => void;
  _fireMessage: (data: string | ArrayBuffer | Blob) => void;
  _connected: boolean;
  sendJSON: ReturnType<typeof vi.fn>;
  sendBinary: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MockBridge = TelnyxCallBridge & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  playAudio: ReturnType<typeof vi.fn>;
  clearPlaybackBuffer: ReturnType<typeof vi.fn>;
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
    _fireOpen() {
      transport._connected = true;
      transport.onopen?.();
    },
    _fireClose() {
      transport._connected = false;
      transport.onclose?.();
    },
    _fireError(err?: unknown) {
      transport.onerror?.(err);
    },
    _fireMessage(data: string | ArrayBuffer | Blob) {
      transport.onmessage?.(data);
    }
  };

  return transport as MockTransport;
}

function createMockBridge(): MockBridge {
  return {
    onAudioLevel: null,
    onAudioData: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    playAudio: vi.fn(),
    clearPlaybackBuffer: vi.fn(),
    connected: false,
    activeCall: null,
    answer: vi.fn(),
    hangup: vi.fn(),
    dial: vi.fn(),
    sendDTMF: vi.fn()
  } as unknown as MockBridge;
}

function connectClient(client: TelnyxPhoneClient, transport: MockTransport) {
  client.connect();
  transport._fireOpen();
}

async function startCall(client: TelnyxPhoneClient, transport: MockTransport) {
  connectClient(client, transport);
  await client.startCall();
}

function jsonMessageType(call: unknown): unknown {
  const [message] = call as [Record<string, unknown>];
  return message.type;
}

describe("TelnyxPhoneClient", () => {
  let transport: MockTransport;
  let bridge: MockBridge;
  let client: TelnyxPhoneClient;

  beforeEach(() => {
    transport = createMockTransport();
    bridge = createMockBridge();
    client = new TelnyxPhoneClient({ transport, bridge });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("connect / disconnect", () => {
    it("calls transport.connect on connect", () => {
      client.connect();

      expect(transport.connect).toHaveBeenCalled();
    });

    it("sends hello message on transport open", () => {
      connectClient(client, transport);

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "hello",
        protocol_version: 1
      });
    });

    it("emits connectionchange true on open", () => {
      const handler = vi.fn();
      client.addEventListener("connectionchange", handler);
      connectClient(client, transport);

      expect(handler).toHaveBeenCalledWith(true);
      expect(client.connected).toBe(true);
    });

    it("emits connectionchange false on close", () => {
      const handler = vi.fn();
      connectClient(client, transport);
      client.addEventListener("connectionchange", handler);
      transport._fireClose();

      expect(handler).toHaveBeenCalledWith(false);
      expect(client.connected).toBe(false);
    });

    it("emits error on transport error", () => {
      const handler = vi.fn();
      client.addEventListener("error", handler);
      connectClient(client, transport);
      transport._fireError();

      expect(handler).toHaveBeenCalledWith("Connection lost. Reconnecting...");
    });

    it("disconnect calls transport.disconnect", () => {
      connectClient(client, transport);
      client.disconnect();

      expect(transport.disconnect).toHaveBeenCalled();
    });

    it("disconnect sends end_call if in a call", async () => {
      await startCall(client, transport);
      transport.sendJSON.mockClear();
      client.disconnect();

      expect(transport.sendJSON).toHaveBeenCalledWith({ type: "end_call" });
    });

    it("tracks serverProtocolVersion from welcome message", () => {
      connectClient(client, transport);
      transport._fireMessage('{"type":"welcome","protocol_version":1}');

      expect(client.serverProtocolVersion).toBe(1);
    });

    it("re-sends preferred audio format when reconnecting during a call", async () => {
      await startCall(client, transport);
      transport.sendJSON.mockClear();

      transport._fireClose();
      transport._fireOpen();

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "hello",
        protocol_version: 1
      });
      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "start_call",
        preferred_format: "pcm16"
      });
    });
  });

  describe("startCall / endCall", () => {
    it("sends start_call with preferredFormat", async () => {
      await startCall(client, transport);

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "start_call",
        preferred_format: "pcm16"
      });
    });

    it("calls bridge.start", async () => {
      await startCall(client, transport);

      expect(bridge.start).toHaveBeenCalled();
    });

    it("wires bridge callbacks", async () => {
      await startCall(client, transport);

      expect(bridge.onAudioLevel).toBeTypeOf("function");
      expect(bridge.onAudioData).toBeTypeOf("function");
    });

    it("emits error when startCall runs before connect", async () => {
      const handler = vi.fn();
      client.addEventListener("error", handler);

      await client.startCall();

      expect(handler).toHaveBeenCalledWith(
        "Cannot start call: not connected. Call connect() first."
      );
    });

    it("endCall sends end_call and resets state", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"status","status":"listening"}');
      transport.sendJSON.mockClear();
      client.endCall();

      expect(transport.sendJSON).toHaveBeenCalledWith({ type: "end_call" });
      expect(bridge.onAudioLevel).toBeNull();
      expect(bridge.onAudioData).toBeNull();
      expect(bridge.stop).not.toHaveBeenCalled();
      expect(client.status).toBe("idle");
    });
  });

  describe("audio routing", () => {
    it("sends bridge audio to server via transport", async () => {
      await startCall(client, transport);
      const pcm = new ArrayBuffer(320);
      bridge.onAudioData?.(pcm);

      expect(transport.sendBinary).toHaveBeenCalledWith(pcm);
    });

    it("does not send audio when muted", async () => {
      await startCall(client, transport);
      client.toggleMute();
      bridge.onAudioData?.(new ArrayBuffer(320));

      expect(transport.sendBinary).not.toHaveBeenCalled();
    });

    it("routes pcm16 server audio to bridge.playAudio", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"audio_config","format":"pcm16"}');
      const audio = new ArrayBuffer(640);
      transport._fireMessage(audio);

      expect(bridge.playAudio).toHaveBeenCalledWith(audio);
    });

    it("routes audio to bridge before audio_config by assuming pcm16", async () => {
      await startCall(client, transport);
      const audio = new ArrayBuffer(640);
      transport._fireMessage(audio);

      expect(bridge.playAudio).toHaveBeenCalledWith(audio);
    });

    it("warns when non-pcm16 audio decode fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await startCall(client, transport);
      transport._fireMessage('{"type":"audio_config","format":"mp3"}');
      transport._fireMessage(new ArrayBuffer(640));

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to decode "mp3" audio'),
        expect.any(Error)
      );
    });

    it("handles Blob audio", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"audio_config","format":"pcm16"}');
      transport._fireMessage(new Blob([new Uint8Array([1, 2, 3, 4])]));

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(bridge.playAudio).toHaveBeenCalled();
    });
  });

  describe("silence / speech detection", () => {
    it("sends start_of_speech when RMS exceeds threshold", async () => {
      await startCall(client, transport);
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "start_of_speech"
      });
    });

    it("does not send start_of_speech twice", async () => {
      await startCall(client, transport);
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);
      bridge.onAudioLevel?.(0.1);

      const startCalls = transport.sendJSON.mock.calls.filter(
        (call) => jsonMessageType(call) === "start_of_speech"
      );
      expect(startCalls).toHaveLength(1);
    });

    it("sends end_of_speech after silence duration", async () => {
      vi.useFakeTimers();
      await startCall(client, transport);
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);
      bridge.onAudioLevel?.(0.01);
      vi.advanceTimersByTime(500);

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "end_of_speech"
      });
    });

    it("cancels end_of_speech if speech resumes", async () => {
      vi.useFakeTimers();
      await startCall(client, transport);
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);
      bridge.onAudioLevel?.(0.01);
      vi.advanceTimersByTime(200);
      bridge.onAudioLevel?.(0.1);
      vi.advanceTimersByTime(500);

      const endCalls = transport.sendJSON.mock.calls.filter(
        (call) => jsonMessageType(call) === "end_of_speech"
      );
      expect(endCalls).toHaveLength(0);
    });

    it("emits audiolevelchange on each RMS update", async () => {
      await startCall(client, transport);
      const handler = vi.fn();
      client.addEventListener("audiolevelchange", handler);
      bridge.onAudioLevel?.(0.05);

      expect(handler).toHaveBeenCalledWith(0.05);
    });

    it("does not process audio levels when muted", async () => {
      await startCall(client, transport);
      client.toggleMute();
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);

      expect(transport.sendJSON).not.toHaveBeenCalledWith({
        type: "start_of_speech"
      });
    });

    it("uses custom silence thresholds", async () => {
      client = new TelnyxPhoneClient({
        transport,
        bridge,
        silenceThreshold: 0.1
      });
      await startCall(client, transport);
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.08);

      const startCalls = transport.sendJSON.mock.calls.filter(
        (call) => jsonMessageType(call) === "start_of_speech"
      );
      expect(startCalls).toHaveLength(0);
    });
  });

  describe("interrupt detection", () => {
    it("sends interrupt when user speaks over agent", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"status","status":"speaking"}');
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);
      bridge.onAudioLevel?.(0.1);

      expect(transport.sendJSON).toHaveBeenCalledWith({ type: "interrupt" });
    });

    it("clears bridge playback buffer on interrupt", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"status","status":"speaking"}');
      bridge.onAudioLevel?.(0.1);
      bridge.onAudioLevel?.(0.1);

      expect(bridge.clearPlaybackBuffer).toHaveBeenCalled();
    });

    it("does not interrupt when agent is not speaking", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"status","status":"listening"}');
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);
      bridge.onAudioLevel?.(0.1);

      const interrupts = transport.sendJSON.mock.calls.filter(
        (call) => jsonMessageType(call) === "interrupt"
      );
      expect(interrupts).toHaveLength(0);
    });

    it("resets chunk count when RMS drops below threshold", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"status","status":"speaking"}');
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.1);
      bridge.onAudioLevel?.(0.01);
      bridge.onAudioLevel?.(0.1);

      const interrupts = transport.sendJSON.mock.calls.filter(
        (call) => jsonMessageType(call) === "interrupt"
      );
      expect(interrupts).toHaveLength(0);
    });

    it("uses custom interrupt thresholds", async () => {
      client = new TelnyxPhoneClient({
        transport,
        bridge,
        interruptThreshold: 0.2,
        interruptChunks: 3
      });
      await startCall(client, transport);
      transport._fireMessage('{"type":"status","status":"speaking"}');
      transport.sendJSON.mockClear();
      bridge.onAudioLevel?.(0.25);
      bridge.onAudioLevel?.(0.25);

      let interrupts = transport.sendJSON.mock.calls.filter(
        (call) => jsonMessageType(call) === "interrupt"
      );
      expect(interrupts).toHaveLength(0);

      bridge.onAudioLevel?.(0.25);
      interrupts = transport.sendJSON.mock.calls.filter(
        (call) => jsonMessageType(call) === "interrupt"
      );
      expect(interrupts).toHaveLength(1);
    });
  });

  describe("transcript", () => {
    it("accumulates transcript messages", async () => {
      await startCall(client, transport);
      transport._fireMessage(
        '{"type":"transcript","role":"user","text":"Hello"}'
      );
      transport._fireMessage(
        '{"type":"transcript","role":"assistant","text":"Hi there"}'
      );

      expect(client.transcript).toHaveLength(2);
      expect(client.transcript[0].text).toBe("Hello");
      expect(client.transcript[1].text).toBe("Hi there");
    });

    it("handles streaming transcript", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"transcript_start","role":"assistant"}');
      transport._fireMessage('{"type":"transcript_delta","text":"Hello "}');
      transport._fireMessage('{"type":"transcript_delta","text":"world"}');
      transport._fireMessage('{"type":"transcript_end","text":"Hello world!"}');

      expect(client.transcript[0].text).toBe("Hello world!");
    });

    it("tracks interim transcripts", async () => {
      await startCall(client, transport);
      const handler = vi.fn();
      client.addEventListener("interimtranscript", handler);
      transport._fireMessage('{"type":"transcript_interim","text":"hel"}');

      expect(client.interimTranscript).toBe("hel");
      expect(handler).toHaveBeenCalledWith("hel");
    });

    it("clears interim on final transcript", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"transcript_interim","text":"hello"}');
      transport._fireMessage(
        '{"type":"transcript","role":"user","text":"hello"}'
      );

      expect(client.interimTranscript).toBeNull();
    });

    it("emits transcriptchange on each update", async () => {
      await startCall(client, transport);
      const handler = vi.fn();
      client.addEventListener("transcriptchange", handler);
      transport._fireMessage('{"type":"transcript","role":"user","text":"hi"}');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toHaveLength(1);
    });

    it("trims transcript to maxTranscriptMessages", async () => {
      client = new TelnyxPhoneClient({
        transport,
        bridge,
        maxTranscriptMessages: 3
      });
      await startCall(client, transport);
      for (let i = 0; i < 5; i++) {
        transport._fireMessage(
          `{"type":"transcript","role":"user","text":"msg ${i}"}`
        );
      }

      expect(client.transcript).toHaveLength(3);
      expect(client.transcript[0].text).toBe("msg 2");
    });
  });

  describe("status and metrics", () => {
    it("tracks status changes", async () => {
      await startCall(client, transport);
      const handler = vi.fn();
      client.addEventListener("statuschange", handler);
      transport._fireMessage('{"type":"status","status":"listening"}');

      expect(client.status).toBe("listening");
      expect(handler).toHaveBeenCalledWith("listening");
    });

    it("tracks metrics", async () => {
      await startCall(client, transport);
      const handler = vi.fn();
      client.addEventListener("metricschange", handler);
      transport._fireMessage(
        '{"type":"metrics","llm_ms":100,"tts_ms":50,"first_audio_ms":150,"total_ms":200}'
      );

      expect(client.metrics).toEqual({
        llm_ms: 100,
        tts_ms: 50,
        first_audio_ms: 150,
        total_ms: 200
      });
      expect(handler).toHaveBeenCalled();
    });

    it("clears error on listening or idle status", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"error","message":"something broke"}');
      expect(client.error).toBe("something broke");
      transport._fireMessage('{"type":"status","status":"listening"}');

      expect(client.error).toBeNull();
    });

    it("tracks audio format from audio_config", async () => {
      await startCall(client, transport);
      transport._fireMessage('{"type":"audio_config","format":"pcm16"}');

      expect(client.audioFormat).toBe("pcm16");
    });
  });

  describe("mute", () => {
    it("toggleMute flips isMuted", () => {
      expect(client.isMuted).toBe(false);
      client.toggleMute();
      expect(client.isMuted).toBe(true);
      client.toggleMute();
      expect(client.isMuted).toBe(false);
    });

    it("emits mutechange", () => {
      const handler = vi.fn();
      client.addEventListener("mutechange", handler);
      client.toggleMute();

      expect(handler).toHaveBeenCalledWith(true);
    });

    it("sends end_of_speech when muted during speech", async () => {
      await startCall(client, transport);
      bridge.onAudioLevel?.(0.1);
      transport.sendJSON.mockClear();
      client.toggleMute();

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "end_of_speech"
      });
    });

    it("resets audio level to 0 when muted", () => {
      const handler = vi.fn();
      client.addEventListener("audiolevelchange", handler);
      client.toggleMute();

      expect(handler).toHaveBeenCalledWith(0);
    });
  });

  describe("messaging", () => {
    it("sendText sends text_message", () => {
      connectClient(client, transport);
      client.sendText("hello");

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "text_message",
        text: "hello"
      });
    });

    it("sendJSON sends arbitrary data", () => {
      connectClient(client, transport);
      client.sendJSON({ type: "custom", data: 42 });

      expect(transport.sendJSON).toHaveBeenCalledWith({
        type: "custom",
        data: 42
      });
    });

    it("tracks custom messages from server", () => {
      connectClient(client, transport);
      const handler = vi.fn();
      client.addEventListener("custommessage", handler);
      transport._fireMessage('{"type":"my_event","payload":"data"}');

      expect(client.lastCustomMessage).toEqual({
        type: "my_event",
        payload: "data"
      });
      expect(handler).toHaveBeenCalled();
    });

    it("ignores malformed JSON", () => {
      connectClient(client, transport);

      expect(() => transport._fireMessage("not json {{{")).not.toThrow();
    });
  });

  describe("events", () => {
    it("removeEventListener stops receiving events", () => {
      const handler = vi.fn();
      client.addEventListener("connectionchange", handler);
      client.removeEventListener("connectionchange", handler);
      connectClient(client, transport);

      expect(handler).not.toHaveBeenCalled();
    });

    it("multiple listeners receive events", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      client.addEventListener("connectionchange", h1);
      client.addEventListener("connectionchange", h2);
      connectClient(client, transport);

      expect(h1).toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });
  });
});
