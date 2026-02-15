/**
 * Tests for useVoiceAgent React hook.
 * Mocks PartySocket to isolate from real WebSocket connections.
 * VoiceClient's real protocol/state logic runs — only the network is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { useEffect, act } from "react";

// --- Mock plumbing ---

// The mock PartySocket instance (set synchronously during construction)
let socketInstance: {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
} | null = null;

let socketSend: ReturnType<typeof vi.fn>;
let socketReadyState: number;
let socketClose: ReturnType<typeof vi.fn>;

vi.mock("partysocket", () => ({
  PartySocket: vi.fn(() => {
    const instance = {
      get readyState() {
        return socketReadyState;
      },
      send: socketSend,
      close: socketClose,
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null
    };
    // Expose immediately so tests can fire events
    socketInstance = instance;
    // Auto-fire open after handlers are attached (next microtask)
    queueMicrotask(() => {
      instance.onopen?.();
    });
    return instance;
  })
}));

// Import after mock is set up (vitest hoists vi.mock)
import {
  useVoiceAgent,
  type UseVoiceAgentReturn,
  type UseVoiceAgentOptions
} from "../experimental/voice/voice-react";

// --- Audio API mocks ---

let workletPortOnMessage: ((event: MessageEvent) => void) | null = null;

function createMockAudioContext() {
  const mockSource = {
    connect: vi.fn(),
    buffer: null as AudioBuffer | null,
    onended: null as (() => void) | null,
    start: vi.fn(function (this: { onended: (() => void) | null }) {
      queueMicrotask(() => this.onended?.());
    }),
    stop: vi.fn()
  };

  const mockWorkletNode = {
    port: {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        workletPortOnMessage = handler;
      },
      get onmessage() {
        return workletPortOnMessage;
      }
    },
    connect: vi.fn(),
    disconnect: vi.fn()
  };

  return {
    state: "running" as string,
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    destination: {},
    audioWorklet: {
      addModule: vi.fn(async () => {})
    },
    createMediaStreamSource: vi.fn(() => mockSource),
    createBufferSource: vi.fn(() => mockSource),
    decodeAudioData: vi.fn(async () => ({
      duration: 0.5,
      length: 24000,
      sampleRate: 48000,
      numberOfChannels: 1,
      getChannelData: vi.fn(() => new Float32Array(24000))
    })),
    _mockSource: mockSource,
    _mockWorkletNode: mockWorkletNode
  };
}

let mockAudioCtx: ReturnType<typeof createMockAudioContext>;
const mockTrackStop = vi.fn();

function setupAudioMocks() {
  mockAudioCtx = createMockAudioContext();
  workletPortOnMessage = null;

  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => mockAudioCtx)
  );

  vi.stubGlobal(
    "AudioWorkletNode",
    vi.fn(() => mockAudioCtx._mockWorkletNode)
  );

  const mockStream = {
    getTracks: () => [{ stop: mockTrackStop }]
  };
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => mockStream) },
      configurable: true
    });
  } else {
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(
      mockStream as unknown as MediaStream
    );
  }

  vi.stubGlobal(
    "URL",
    Object.assign({}, URL, {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn()
    })
  );
}

// --- Test component ---

function TestVoiceComponent({
  options,
  onResult
}: {
  options: UseVoiceAgentOptions;
  onResult: (result: UseVoiceAgentReturn) => void;
}) {
  const result = useVoiceAgent(options);

  useEffect(() => {
    onResult(result);
  }, [
    result.status,
    result.connected,
    result.error,
    result.isMuted,
    result.transcript,
    result.metrics,
    result.audioLevel,
    onResult,
    result
  ]);

  return (
    <div>
      <span data-testid="status">{result.status}</span>
      <span data-testid="connected">{String(result.connected)}</span>
      <span data-testid="error">{result.error ?? ""}</span>
      <span data-testid="muted">{String(result.isMuted)}</span>
      <span data-testid="transcript-count">{result.transcript.length}</span>
    </div>
  );
}

// --- Helpers ---

function fireMessage(data: string | ArrayBuffer | Blob) {
  socketInstance?.onmessage?.(new MessageEvent("message", { data }));
}

function fireJSON(msg: Record<string, unknown>) {
  fireMessage(JSON.stringify(msg));
}

function renderHook(overrides: Partial<UseVoiceAgentOptions> = {}): {
  container: HTMLElement;
  getResult: () => UseVoiceAgentReturn;
} {
  let latestResult: UseVoiceAgentReturn | null = null;
  const onResult = vi.fn((r: UseVoiceAgentReturn) => {
    latestResult = r;
  });

  const { container } = render(
    <TestVoiceComponent
      options={{ agent: "voice-agent", ...overrides }}
      onResult={onResult}
    />
  );

  return {
    container,
    getResult: () => {
      if (!latestResult) throw new Error("Hook has not rendered yet");
      return latestResult;
    }
  };
}

// --- Test suites ---

beforeEach(() => {
  socketSend = vi.fn();
  socketClose = vi.fn();
  socketReadyState = WebSocket.OPEN;
  socketInstance = null;
  setupAudioMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useVoiceAgent", () => {
  describe("initial state", () => {
    it("should start with idle status and empty transcript", async () => {
      const { container } = renderHook();

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="status"]')?.textContent
        ).toBe("idle");
        expect(
          container.querySelector('[data-testid="transcript-count"]')
            ?.textContent
        ).toBe("0");
      });
    });
  });

  describe("connection lifecycle", () => {
    it("should set connected=true on open", async () => {
      const { container } = renderHook();

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="connected"]')?.textContent
        ).toBe("true");
      });
    });

    it("should set connected=false on close", async () => {
      const { container } = renderHook();

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="connected"]')?.textContent
        ).toBe("true");
      });

      act(() => {
        socketInstance?.onclose?.();
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="connected"]')?.textContent
        ).toBe("false");
      });
    });

    it("should set error on connection error", async () => {
      const { container } = renderHook();

      act(() => {
        socketInstance?.onerror?.();
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="error"]')?.textContent
        ).toBe("Connection lost. Reconnecting...");
      });
    });
  });

  describe("voice protocol — status messages", () => {
    it("should update status from server message", async () => {
      const { container } = renderHook();

      act(() => {
        fireJSON({ type: "status", status: "listening" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="status"]')?.textContent
        ).toBe("listening");
      });
    });

    it("should cycle through all statuses", async () => {
      const { container } = renderHook();

      for (const s of ["listening", "thinking", "speaking", "idle"] as const) {
        act(() => {
          fireJSON({ type: "status", status: s });
        });
        await vi.waitFor(() => {
          expect(
            container.querySelector('[data-testid="status"]')?.textContent
          ).toBe(s);
        });
      }
    });

    it("should clear error when status becomes listening", async () => {
      const { container } = renderHook();

      act(() => {
        fireJSON({ type: "error", message: "something broke" });
      });
      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="error"]')?.textContent
        ).toBe("something broke");
      });

      act(() => {
        fireJSON({ type: "status", status: "listening" });
      });
      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="error"]')?.textContent
        ).toBe("");
      });
    });
  });

  describe("voice protocol — transcript", () => {
    it("should add a complete transcript message", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "Hello agent" });
      });

      await vi.waitFor(() => {
        const t = getResult().transcript;
        expect(t).toHaveLength(1);
        expect(t[0].role).toBe("user");
        expect(t[0].text).toBe("Hello agent");
        expect(t[0].timestamp).toBeTypeOf("number");
      });
    });

    it("should handle streaming transcript (start -> delta -> end)", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      act(() => {
        fireJSON({ type: "transcript_start" });
      });
      await vi.waitFor(() => {
        const t = getResult().transcript;
        expect(t).toHaveLength(1);
        expect(t[0].role).toBe("assistant");
        expect(t[0].text).toBe("");
      });

      act(() => {
        fireJSON({ type: "transcript_delta", text: "Hello" });
      });
      await vi.waitFor(() => {
        expect(getResult().transcript[0].text).toBe("Hello");
      });

      act(() => {
        fireJSON({ type: "transcript_delta", text: " world" });
      });
      await vi.waitFor(() => {
        expect(getResult().transcript[0].text).toBe("Hello world");
      });

      act(() => {
        fireJSON({
          type: "transcript_end",
          text: "Hello world, how are you?"
        });
      });
      await vi.waitFor(() => {
        expect(getResult().transcript[0].text).toBe(
          "Hello world, how are you?"
        );
      });
    });

    it("should handle interleaved user and assistant messages", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "What time?" });
      });
      act(() => {
        fireJSON({ type: "transcript_start" });
      });
      act(() => {
        fireJSON({ type: "transcript_delta", text: "It is 3pm" });
      });
      act(() => {
        fireJSON({ type: "transcript_end", text: "It is 3pm." });
      });
      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "Thanks!" });
      });

      await vi.waitFor(() => {
        const t = getResult().transcript;
        expect(t).toHaveLength(3);
        expect(t[0]).toMatchObject({ role: "user", text: "What time?" });
        expect(t[1]).toMatchObject({ role: "assistant", text: "It is 3pm." });
        expect(t[2]).toMatchObject({ role: "user", text: "Thanks!" });
      });
    });

    it("should ignore transcript_delta when transcript is empty", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      act(() => {
        fireJSON({ type: "transcript_delta", text: "orphan delta" });
      });

      await vi.waitFor(() => {
        expect(getResult().transcript).toHaveLength(0);
      });
    });
  });

  describe("voice protocol — metrics", () => {
    it("should store pipeline metrics from server", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      act(() => {
        fireJSON({
          type: "metrics",
          vad_ms: 120,
          stt_ms: 350,
          llm_ms: 800,
          tts_ms: 200,
          first_audio_ms: 1470,
          total_ms: 1600
        });
      });

      await vi.waitFor(() => {
        const m = getResult().metrics;
        expect(m).not.toBeNull();
        expect(m!.vad_ms).toBe(120);
        expect(m!.stt_ms).toBe(350);
        expect(m!.llm_ms).toBe(800);
        expect(m!.tts_ms).toBe(200);
        expect(m!.first_audio_ms).toBe(1470);
        expect(m!.total_ms).toBe(1600);
      });
    });
  });

  describe("voice protocol — error messages", () => {
    it("should set error from server error message", async () => {
      const { container } = renderHook();

      act(() => {
        fireJSON({ type: "error", message: "Pipeline failed" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="error"]')?.textContent
        ).toBe("Pipeline failed");
      });
    });
  });

  describe("voice protocol — non-JSON messages", () => {
    it("should not crash on non-JSON string messages", async () => {
      const { container } = renderHook();

      act(() => {
        fireMessage("this is not json {{{");
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="status"]')?.textContent
        ).toBe("idle");
      });
    });
  });

  describe("actions — toggleMute", () => {
    it("should toggle isMuted on and off", async () => {
      const { container, getResult } = renderHook();

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="muted"]')?.textContent
        ).toBe("false");
      });

      act(() => {
        getResult().toggleMute();
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="muted"]')?.textContent
        ).toBe("true");
      });

      act(() => {
        getResult().toggleMute();
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="muted"]')?.textContent
        ).toBe("false");
      });
    });
  });

  describe("actions — startCall", () => {
    it("should send start_call message to agent", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      await act(async () => {
        await getResult().startCall();
      });

      expect(socketSend).toHaveBeenCalledWith(
        JSON.stringify({ type: "start_call" })
      );
    });

    it("should request microphone access", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      await act(async () => {
        await getResult().startCall();
      });

      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: expect.objectContaining({
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        })
      });
    });

    it("should clear previous error and metrics", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      act(() => {
        fireJSON({ type: "error", message: "old error" });
        fireJSON({
          type: "metrics",
          vad_ms: 1,
          stt_ms: 1,
          llm_ms: 1,
          tts_ms: 1,
          first_audio_ms: 1,
          total_ms: 1
        });
      });

      await vi.waitFor(() => {
        expect(getResult().error).toBe("old error");
        expect(getResult().metrics).not.toBeNull();
      });

      await act(async () => {
        await getResult().startCall();
      });

      await vi.waitFor(() => {
        expect(getResult().error).toBeNull();
        expect(getResult().metrics).toBeNull();
      });
    });

    it("should not send if WebSocket is not open", async () => {
      socketReadyState = WebSocket.CLOSED;
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult).not.toThrow();
      });

      await act(async () => {
        await getResult().startCall();
      });

      const startCallSent = socketSend.mock.calls.some(
        (args: unknown[]) =>
          typeof args[0] === "string" &&
          (args[0] as string).includes("start_call")
      );
      expect(startCallSent).toBe(false);
    });
  });

  describe("actions — endCall", () => {
    it("should send end_call message and reset status to idle", async () => {
      const { container, getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      act(() => {
        fireJSON({ type: "status", status: "listening" });
      });
      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="status"]')?.textContent
        ).toBe("listening");
      });

      act(() => {
        getResult().endCall();
      });

      expect(socketSend).toHaveBeenCalledWith(
        JSON.stringify({ type: "end_call" })
      );

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="status"]')?.textContent
        ).toBe("idle");
      });
    });

    it("should stop microphone tracks on endCall", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      await act(async () => {
        await getResult().startCall();
      });

      act(() => {
        getResult().endCall();
      });

      expect(mockTrackStop).toHaveBeenCalled();
    });
  });

  describe("binary audio messages", () => {
    it("should handle ArrayBuffer messages without crashing", async () => {
      const { getResult } = renderHook();

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      const fakeAudio = new ArrayBuffer(100);

      act(() => {
        fireMessage(fakeAudio);
      });

      await vi.waitFor(() => {
        expect(getResult().status).toBe("idle");
      });
    });
  });

  describe("configurable thresholds", () => {
    it("should accept custom silence and interrupt thresholds", async () => {
      const { getResult } = renderHook({
        silenceThreshold: 0.05,
        silenceDurationMs: 1000,
        interruptThreshold: 0.1,
        interruptChunks: 5
      });

      await vi.waitFor(() => {
        expect(getResult().connected).toBe(true);
      });

      expect(getResult().status).toBe("idle");
    });
  });
});
