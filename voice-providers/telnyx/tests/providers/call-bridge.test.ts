import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelnyxCallBridge } from "../../src/providers/call-bridge.js";

type EventHandler = (notification?: unknown) => void;

interface MockTelnyxClient {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  newCall?: ReturnType<typeof vi.fn>;
}

interface MockTelnyxModule {
  TelnyxRTC: ReturnType<typeof vi.fn>;
  __mockClient: MockTelnyxClient;
}

vi.mock("@telnyx/webrtc", () => {
  const mockClient = {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn()
  };

  return {
    TelnyxRTC: vi.fn(function () {
      return mockClient;
    }),
    __mockClient: mockClient
  };
});

async function getMockTelnyx(): Promise<MockTelnyxModule> {
  return (await import("@telnyx/webrtc")) as unknown as MockTelnyxModule;
}

function setReadyOnStart(client: MockTelnyxClient) {
  client.on.mockImplementation((event: string, cb: EventHandler) => {
    if (event === "telnyx.ready") cb();
  });
}

function mockTrack() {
  return {
    kind: "audio",
    readyState: "live",
    enabled: true,
    muted: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
}

describe("TelnyxCallBridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("config and interface", () => {
    it("creates with a login token", () => {
      expect(new TelnyxCallBridge({ loginToken: "test-jwt" })).toBeDefined();
    });

    it("implements VoiceAudioInput interface shape", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });

      expect(typeof bridge.start).toBe("function");
      expect(typeof bridge.stop).toBe("function");
      expect(bridge.onAudioLevel).toBeNull();
      expect(bridge.onAudioData).toBeNull();
    });

    it("exposes connected as false initially", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });

      expect(bridge.connected).toBe(false);
    });

    it("exposes activeCall as null initially", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });

      expect(bridge.activeCall).toBeNull();
    });

    it("accepts optional config overrides", () => {
      expect(
        new TelnyxCallBridge({
          loginToken: "test-jwt",
          autoAnswer: true,
          debug: true
        })
      ).toBeDefined();
    });
  });

  describe("connection lifecycle", () => {
    beforeEach(async () => {
      const { __mockClient } = await getMockTelnyx();
      vi.clearAllMocks();
      delete __mockClient.newCall;
    });

    it("start creates a TelnyxRTC client with login_token from config", async () => {
      const { TelnyxRTC, __mockClient } = await getMockTelnyx();
      setReadyOnStart(__mockClient);

      await new TelnyxCallBridge({ loginToken: "my-token" }).start();

      expect(TelnyxRTC).toHaveBeenCalledWith(
        expect.objectContaining({ login_token: "my-token" })
      );
    });

    it("start resolves when telnyx.ready fires and connected becomes true", async () => {
      const { __mockClient } = await getMockTelnyx();
      setReadyOnStart(__mockClient);
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });

      await bridge.start();

      expect(bridge.connected).toBe(true);
    });

    it("start is idempotent once connected", async () => {
      const { TelnyxRTC, __mockClient } = await getMockTelnyx();
      setReadyOnStart(__mockClient);
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });

      await bridge.start();
      await bridge.start();

      expect(TelnyxRTC).toHaveBeenCalledTimes(1);
      expect(__mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it("stop settles an in-flight start", async () => {
      const { __mockClient } = await getMockTelnyx();
      __mockClient.on.mockImplementation(() => {});
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });

      const startPromise = bridge.start();
      bridge.stop();

      await expect(startPromise).resolves.toBeUndefined();
      expect(__mockClient.disconnect).toHaveBeenCalled();
    });

    it("stop disconnects the client and sets connected to false", async () => {
      const { __mockClient } = await getMockTelnyx();
      setReadyOnStart(__mockClient);
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      await bridge.start();

      bridge.stop();

      expect(bridge.connected).toBe(false);
      expect(__mockClient.disconnect).toHaveBeenCalled();
    });

    it("stop is safe to call without start", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });

      expect(() => bridge.stop()).not.toThrow();
      expect(bridge.connected).toBe(false);
    });
  });

  describe("inbound call handling", () => {
    let bridge: TelnyxCallBridge;
    let notificationHandler: EventHandler;
    let mockCall: Record<string, unknown>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const { __mockClient } = await getMockTelnyx();
      const handlers: Record<string, EventHandler> = {};
      __mockClient.on.mockImplementation((event: string, cb: EventHandler) => {
        handlers[event] = cb;
      });

      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });
      const startPromise = bridge.start();
      handlers["telnyx.ready"]?.();
      await startPromise;
      notificationHandler = handlers["telnyx.notification"];
      mockCall = {
        id: "call-123",
        state: "ringing",
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn(),
        remoteStream: null
      };
    });

    it("sets activeCall when a call starts ringing", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });

      expect(bridge.activeCall).toBe(mockCall);
    });

    it("auto-answers inbound call when autoAnswer is true", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });

      expect(mockCall.answer).toHaveBeenCalled();
    });

    it("does not auto-answer when autoAnswer is false", async () => {
      const { __mockClient } = await getMockTelnyx();
      const handlers: Record<string, EventHandler> = {};
      __mockClient.on.mockImplementation((event: string, cb: EventHandler) => {
        handlers[event] = cb;
      });
      bridge.stop();
      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: false });
      const startPromise = bridge.start();
      handlers["telnyx.ready"]?.();
      await startPromise;

      handlers["telnyx.notification"]?.({ type: "callUpdate", call: mockCall });

      expect(mockCall.answer).not.toHaveBeenCalled();
    });

    it("clears activeCall when call state is destroy", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      mockCall.state = "destroy";
      notificationHandler({ type: "callUpdate", call: mockCall });

      expect(bridge.activeCall).toBeNull();
    });

    it("clears activeCall when call state is hangup", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      mockCall.state = "hangup";
      notificationHandler({ type: "callUpdate", call: mockCall });

      expect(bridge.activeCall).toBeNull();
    });
  });

  describe("audio capture", () => {
    let bridge: TelnyxCallBridge;
    let notificationHandler: EventHandler;
    let workletMessageHandler: ((event: MessageEvent) => void) | null = null;

    const mockWorkletNode = {
      port: {
        onmessage: null as ((event: MessageEvent) => void) | null
      },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const mockSourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const mockAudioContext = {
      audioWorklet: {
        addModule: vi.fn().mockResolvedValue(undefined)
      },
      createMediaStreamSource: vi.fn(() => mockSourceNode),
      close: vi.fn(),
      state: "running",
      resume: vi.fn().mockResolvedValue(undefined),
      sampleRate: 48000,
      destination: {}
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      workletMessageHandler = null;
      Object.defineProperty(mockWorkletNode.port, "onmessage", {
        get: () => workletMessageHandler,
        set: (handler) => {
          workletMessageHandler = handler;
        },
        configurable: true
      });
      vi.stubGlobal(
        "AudioContext",
        vi.fn(function () {
          return mockAudioContext;
        })
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn(function () {
          return mockWorkletNode;
        })
      );
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:mock-url"),
        revokeObjectURL: vi.fn()
      });
      vi.stubGlobal(
        "Blob",
        vi.fn(function () {})
      );
      vi.stubGlobal(
        "MediaStream",
        vi.fn(function () {
          return {};
        })
      );
      const mockAudioEl = {
        srcObject: null,
        autoplay: false,
        volume: 1,
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        remove: vi.fn()
      };
      vi.stubGlobal("document", {
        createElement: vi.fn(() => mockAudioEl),
        body: { appendChild: vi.fn() }
      });

      const { __mockClient } = await getMockTelnyx();
      const handlers: Record<string, EventHandler> = {};
      __mockClient.on.mockImplementation((event: string, cb: EventHandler) => {
        handlers[event] = cb;
      });
      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });
      const startPromise = bridge.start();
      handlers["telnyx.ready"]?.();
      await startPromise;
      notificationHandler = handlers["telnyx.notification"];
    });

    function activeCall() {
      return {
        id: "call-123",
        state: "active",
        remoteStream: { getAudioTracks: () => [mockTrack()] },
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn()
      };
    }

    it("creates AudioContext at 48kHz when call becomes active", async () => {
      notificationHandler({ type: "callUpdate", call: activeCall() });

      await vi.waitFor(() => {
        expect(AudioContext).toHaveBeenCalledWith({ sampleRate: 48000 });
      });
    });

    it("creates MediaStreamSource from remote audio track", async () => {
      notificationHandler({ type: "callUpdate", call: activeCall() });

      await vi.waitFor(() => {
        expect(mockAudioContext.createMediaStreamSource).toHaveBeenCalled();
      });
    });

    it("loads the PCM capture AudioWorklet processor", async () => {
      notificationHandler({ type: "callUpdate", call: activeCall() });

      await vi.waitFor(() => {
        expect(mockAudioContext.audioWorklet.addModule).toHaveBeenCalled();
      });
    });

    it("calls onAudioData with Int16 PCM when worklet posts audio", async () => {
      const audioDataSpy = vi.fn();
      bridge.onAudioData = audioDataSpy;
      notificationHandler({ type: "callUpdate", call: activeCall() });
      await vi.waitFor(() => expect(workletMessageHandler).not.toBeNull());

      workletMessageHandler?.({
        data: new Float32Array([
          0.5, -0.5, 0, 1, 0.5, -0.5, 0, 1, 0.5, -0.5, 0, 1
        ])
      } as MessageEvent);

      expect(audioDataSpy).toHaveBeenCalledTimes(1);
      const pcm = audioDataSpy.mock.calls[0]?.[0] as ArrayBuffer;
      expect(pcm).toBeInstanceOf(ArrayBuffer);
      expect(new Int16Array(pcm)).toHaveLength(4);
    });

    it("calls onAudioLevel with RMS value when worklet posts audio", async () => {
      const audioLevelSpy = vi.fn();
      bridge.onAudioLevel = audioLevelSpy;
      notificationHandler({ type: "callUpdate", call: activeCall() });
      await vi.waitFor(() => expect(workletMessageHandler).not.toBeNull());

      workletMessageHandler?.({
        data: new Float32Array([
          0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5
        ])
      } as MessageEvent);

      expect(audioLevelSpy).toHaveBeenCalledTimes(1);
      expect(audioLevelSpy.mock.calls[0]?.[0]).toBeCloseTo(0.5, 1);
    });
  });

  describe("call actions", () => {
    let bridge: TelnyxCallBridge;
    let notificationHandler: EventHandler;
    let mockClient: MockTelnyxClient;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.stubGlobal(
        "AudioContext",
        vi.fn(function () {
          return {
            audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
            createMediaStreamSource: vi.fn(() => ({
              connect: vi.fn(),
              disconnect: vi.fn()
            })),
            createMediaStreamDestination: vi.fn(() => ({
              stream: { getAudioTracks: () => [] }
            })),
            close: vi.fn(),
            sampleRate: 16000
          };
        })
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn(function () {
          return {
            port: { onmessage: null, postMessage: vi.fn() },
            connect: vi.fn(),
            disconnect: vi.fn()
          };
        })
      );
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:mock"),
        revokeObjectURL: vi.fn()
      });
      vi.stubGlobal(
        "Blob",
        vi.fn(function () {})
      );

      const { __mockClient } = await getMockTelnyx();
      const handlers: Record<string, EventHandler> = {};
      const mockNewCall = vi.fn(() => ({
        id: "outbound-1",
        state: "trying",
        peer: {
          instance: {
            getReceivers: vi.fn(() => []),
            getSenders: vi.fn(() => [])
          }
        },
        remoteStream: null,
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn()
      }));
      __mockClient.on.mockImplementation((event: string, cb: EventHandler) => {
        handlers[event] = cb;
      });
      __mockClient.newCall = mockNewCall;
      mockClient = __mockClient;
      bridge = new TelnyxCallBridge({ loginToken: "jwt" });
      const startPromise = bridge.start();
      handlers["telnyx.ready"]?.();
      await startPromise;
      notificationHandler = handlers["telnyx.notification"];
    });

    it("answer answers the active inbound call", () => {
      const call = {
        id: "call-1",
        state: "ringing",
        answer: vi.fn(),
        hangup: vi.fn(),
        remoteStream: null
      };
      notificationHandler({ type: "callUpdate", call });
      bridge.answer();

      expect(call.answer).toHaveBeenCalled();
    });

    it("answer throws when no active call", () => {
      expect(() => bridge.answer()).toThrow("No active call");
    });

    it("hangup ends the active call", () => {
      const call = {
        id: "call-1",
        state: "ringing",
        answer: vi.fn(),
        hangup: vi.fn(),
        remoteStream: null
      };
      notificationHandler({ type: "callUpdate", call });
      bridge.hangup();

      expect(call.hangup).toHaveBeenCalled();
    });

    it("dial initiates an outbound call", () => {
      const call = bridge.dial("+18005551234", "+15551234567");

      expect(mockClient.newCall).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationNumber: "+18005551234",
          callerNumber: "+15551234567"
        })
      );
      expect(call).toBeDefined();
    });

    it("sendDTMF sends digits to the active call", () => {
      const call = {
        id: "call-1",
        state: "active",
        remoteStream: { getAudioTracks: () => [mockTrack()] },
        peer: { instance: { getSenders: vi.fn(() => []) } },
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn()
      };
      notificationHandler({ type: "callUpdate", call });
      bridge.sendDTMF("1234#");

      expect(call.dtmf).toHaveBeenCalledWith("1234#");
    });
  });

  describe("audio playback", () => {
    let bridge: TelnyxCallBridge;
    let notificationHandler: EventHandler;

    const mockPlaybackWorkletNode = {
      port: {
        onmessage: null,
        postMessage: vi.fn()
      },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const mockDestinationNode = {
      stream: {
        getAudioTracks: () => [{ kind: "audio", id: "mock-track" }]
      }
    };
    const mockSender = {
      track: { kind: "audio" },
      replaceTrack: vi.fn().mockResolvedValue(undefined)
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.stubGlobal(
        "AudioContext",
        vi.fn(function (opts?: { sampleRate?: number }) {
          if (opts?.sampleRate === 16000) {
            return {
              audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
              createMediaStreamSource: vi.fn(() => ({
                connect: vi.fn(),
                disconnect: vi.fn()
              })),
              close: vi.fn(),
              sampleRate: 16000
            };
          }
          return {
            audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
            createMediaStreamDestination: vi.fn(() => mockDestinationNode),
            close: vi.fn(),
            sampleRate: 48000
          };
        })
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn(function () {
          return mockPlaybackWorkletNode;
        })
      );
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:mock-url"),
        revokeObjectURL: vi.fn()
      });
      vi.stubGlobal(
        "Blob",
        vi.fn(function () {})
      );

      const { __mockClient } = await getMockTelnyx();
      const handlers: Record<string, EventHandler> = {};
      __mockClient.on.mockImplementation((event: string, cb: EventHandler) => {
        handlers[event] = cb;
      });
      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });
      const startPromise = bridge.start();
      handlers["telnyx.ready"]?.();
      await startPromise;
      notificationHandler = handlers["telnyx.notification"];
    });

    function playbackCall() {
      return {
        id: "call-123",
        state: "active",
        remoteStream: { getAudioTracks: () => [{ kind: "audio" }] },
        peer: {
          instance: {
            getReceivers: vi.fn(() => []),
            getSenders: vi.fn(() => [mockSender])
          }
        },
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn()
      };
    }

    it("playAudio upsamples 16kHz to 48kHz and sends to worklet", async () => {
      notificationHandler({ type: "callUpdate", call: playbackCall() });
      await vi.waitFor(() => {
        expect(mockPlaybackWorkletNode.connect).toHaveBeenCalled();
      });

      bridge.playAudio(new Int16Array([100, -100, 200, -200]).buffer);

      expect(mockPlaybackWorkletNode.port.postMessage).toHaveBeenCalledTimes(1);
      const posted =
        mockPlaybackWorkletNode.port.postMessage.mock.calls[0]?.[0];
      expect(posted).toBeInstanceOf(Float32Array);
      expect((posted as Float32Array).length).toBe(12);
    });

    it("playAudio replaces the sender track on the peer connection", async () => {
      notificationHandler({ type: "callUpdate", call: playbackCall() });

      await vi.waitFor(() => {
        expect(mockSender.replaceTrack).toHaveBeenCalled();
      });
    });

    it("playAudio is a no-op when no active call", () => {
      expect(() =>
        bridge.playAudio(new Int16Array([100]).buffer)
      ).not.toThrow();
    });
  });

  describe("package exports", () => {
    it("exports TelnyxCallBridge from the browser entrypoint", async () => {
      const mod = await import("../../src/browser.js");

      expect(mod.TelnyxCallBridge).toBeDefined();
    });

    it("keeps browser telephony out of the package root", async () => {
      const mod = await import("../../src/index.js");

      expect("TelnyxCallBridge" in mod).toBe(false);
    });
  });
});
