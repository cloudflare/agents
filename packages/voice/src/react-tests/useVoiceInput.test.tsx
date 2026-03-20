/**
 * Tests for useVoiceInput React hook.
 * Mocks PartySocket to isolate from real WebSocket connections.
 * VoiceClient's real protocol/state logic runs — only the network is mocked.
 *
 * Unlike useVoiceAgent, useVoiceInput is optimised for dictation:
 * - Accumulates user transcripts into a single string
 * - Exposes start/stop instead of startCall/endCall
 * - Provides a clear() action to reset the transcript
 * - Ignores assistant responses / TTS
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { useEffect, act } from "react";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Mock plumbing ---

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
  PartySocket: vi.fn(function () {
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
    socketInstance = instance;
    queueMicrotask(() => {
      instance.onopen?.();
    });
    return instance;
  })
}));

// Import after mock is set up (vitest hoists vi.mock)
import {
  useVoiceInput,
  type UseVoiceInputReturn,
  type UseVoiceInputOptions
} from "../voice-react";

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
    vi.fn(function () {
      return mockAudioCtx;
    })
  );

  vi.stubGlobal(
    "AudioWorkletNode",
    vi.fn(function () {
      return mockAudioCtx._mockWorkletNode;
    })
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

function TestVoiceInputComponent({
  options,
  onResult
}: {
  options: UseVoiceInputOptions;
  onResult: (result: UseVoiceInputReturn) => void;
}) {
  const result = useVoiceInput(options);

  useEffect(() => {
    onResult(result);
  }, [
    result.transcript,
    result.interimTranscript,
    result.isListening,
    result.audioLevel,
    result.isMuted,
    result.error,
    onResult,
    result
  ]);

  return (
    <div>
      <span data-testid="transcript">{result.transcript}</span>
      <span data-testid="interim">{result.interimTranscript ?? ""}</span>
      <span data-testid="listening">{String(result.isListening)}</span>
      <span data-testid="muted">{String(result.isMuted)}</span>
      <span data-testid="error">{result.error ?? ""}</span>
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

async function renderHook(
  overrides: Partial<UseVoiceInputOptions> = {}
): Promise<{ container: HTMLElement; getResult: () => UseVoiceInputReturn }> {
  let latestResult: UseVoiceInputReturn | null = null;
  const onResult = vi.fn((r: UseVoiceInputReturn) => {
    latestResult = r;
  });

  const { container } = await render(
    <TestVoiceInputComponent
      options={{ agent: "voice-input-agent", ...overrides }}
      onResult={onResult}
    />
  );
  await sleep(10);

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

describe("useVoiceInput", () => {
  describe("initial state", () => {
    it("should start with empty transcript and not listening", async () => {
      const { container } = await renderHook();

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("");
        expect(
          container.querySelector('[data-testid="listening"]')?.textContent
        ).toBe("false");
        expect(
          container.querySelector('[data-testid="muted"]')?.textContent
        ).toBe("false");
      });
    });
  });

  describe("transcript accumulation", () => {
    it("should accumulate user transcripts into a single string", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "hello" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("hello");
      });

      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "world" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("hello world");
      });
    });

    it("should ignore assistant transcripts", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "hello" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("hello");
      });

      // Assistant transcript should be ignored
      act(() => {
        fireJSON({ type: "transcript", role: "assistant", text: "hi there" });
      });

      // Send another user transcript to trigger a re-render
      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "world" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("hello world");
      });
    });
  });

  describe("interim transcript", () => {
    it("should show interim transcript from streaming STT", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "transcript_interim", text: "hel" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="interim"]')?.textContent
        ).toBe("hel");
      });

      act(() => {
        fireJSON({ type: "transcript_interim", text: "hello wor" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="interim"]')?.textContent
        ).toBe("hello wor");
      });
    });

    it("should clear interim when final transcript arrives", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "transcript_interim", text: "hello wor" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="interim"]')?.textContent
        ).toBe("hello wor");
      });

      // The mixin sends transcript_interim with empty text before the final
      act(() => {
        fireJSON({ type: "transcript_interim", text: "" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="interim"]')?.textContent
        ).toBe("");
      });
    });
  });

  describe("listening state", () => {
    it("should set isListening=true when status is listening", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "status", status: "listening" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="listening"]')?.textContent
        ).toBe("true");
      });
    });

    it("should set isListening=true when status is thinking", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "status", status: "thinking" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="listening"]')?.textContent
        ).toBe("true");
      });
    });

    it("should set isListening=false when status is idle", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "status", status: "listening" });
      });
      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="listening"]')?.textContent
        ).toBe("true");
      });

      act(() => {
        fireJSON({ type: "status", status: "idle" });
      });
      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="listening"]')?.textContent
        ).toBe("false");
      });
    });
  });

  describe("actions — start/stop", () => {
    it("should send start_call on start()", async () => {
      const { getResult } = await renderHook();

      await act(async () => {
        await getResult().start();
      });

      expect(socketSend).toHaveBeenCalledWith(
        JSON.stringify({ type: "start_call" })
      );
    });

    it("should send end_call on stop()", async () => {
      const { getResult } = await renderHook();

      await act(async () => {
        await getResult().start();
      });

      act(() => {
        getResult().stop();
      });

      expect(socketSend).toHaveBeenCalledWith(
        JSON.stringify({ type: "end_call" })
      );
    });

    it("should stop microphone tracks on stop()", async () => {
      const { getResult } = await renderHook();

      await act(async () => {
        await getResult().start();
      });

      act(() => {
        getResult().stop();
      });

      expect(mockTrackStop).toHaveBeenCalled();
    });
  });

  describe("actions — clear", () => {
    it("should reset the accumulated transcript", async () => {
      const { container, getResult } = await renderHook();

      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "hello world" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("hello world");
      });

      act(() => {
        getResult().clear();
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("");
      });
    });
  });

  describe("actions — toggleMute", () => {
    it("should toggle isMuted", async () => {
      const { container, getResult } = await renderHook();

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

  describe("error handling", () => {
    it("should show error from server", async () => {
      const { container } = await renderHook();

      act(() => {
        fireJSON({ type: "error", message: "STT failed" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="error"]')?.textContent
        ).toBe("STT failed");
      });
    });

    it("should show error on connection error", async () => {
      const { container } = await renderHook();

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

  describe("reconnect on option change", () => {
    it("should reconnect when agent name changes", async () => {
      const { container } = await renderHook({ agent: "agent-a" });

      act(() => {
        fireJSON({ type: "transcript", role: "user", text: "from agent a" });
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("from agent a");
      });

      // Re-render with different agent — should create new connection
      cleanup();
      await sleep(50);
      const { container: container2 } = await renderHook({ agent: "agent-b" });

      // Transcript should be reset (new connection)
      await vi.waitFor(() => {
        expect(
          container2.querySelector('[data-testid="transcript"]')?.textContent
        ).toBe("");
      });
    });
  });
});
