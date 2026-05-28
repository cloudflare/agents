import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssemblyAISTT,
  _buildConnectionUrl,
  type AssemblyAISTTOptions
} from "../src/index";

function parse(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

// --- WebSocket / fetch test infrastructure (shared by all session tests) ---

class MockWebSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setupMockFetch(): { ws: MockWebSocket; calls: MockFetchCall[] } {
  const ws = new MockWebSocket();
  const calls: MockFetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // Cloudflare's fetch-upgrade returns a Response-shaped object with a
      // webSocket property. Cast to mirror the runtime.
      return { webSocket: ws } as unknown as Response;
    })
  );
  return { ws, calls };
}

// Flush microtasks so the session's async #connect() runs.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  // Default no-op fetch so any test that doesn't set up its own mock never
  // makes a real network call (the session constructor connects on its own).
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => ({ webSocket: new MockWebSocket() }) as unknown as Response
    )
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("_buildConnectionUrl — always-present params", () => {
  it("uses the AssemblyAI streaming host by default", () => {
    const url = new URL(_buildConnectionUrl({ apiKey: "k" }));
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("streaming.assemblyai.com");
    expect(url.pathname).toBe("/v3/ws");
  });

  it("hardcodes speech_model, sample_rate, encoding", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k" }));
    expect(p.get("speech_model")).toBe("u3-rt-pro");
    expect(p.get("sample_rate")).toBe("16000");
    expect(p.get("encoding")).toBe("pcm_s16le");
  });

  it("never sends format_turns or the API key in the query", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "secret" }));
    expect(p.has("format_turns")).toBe(false);
    expect(p.has("token")).toBe(false);
    expect(p.has("apikey")).toBe(false);
    expect(p.has("ApiKey")).toBe(false);
  });
});

describe("_buildConnectionUrl — conditional params (only when set)", () => {
  it("omits all conditional params when none set", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k" }));
    for (const k of [
      "domain",
      "keyterms_prompt",
      "prompt",
      "min_turn_silence",
      "max_turn_silence",
      "interruption_delay",
      "vad_threshold",
      "continuous_partials",
      "language_detection"
    ]) {
      expect(p.has(k)).toBe(false);
    }
  });

  it("forwards domain", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k", domain: "medical-v1" }));
    expect(p.get("domain")).toBe("medical-v1");
  });

  it("JSON-encodes keyterms into keyterms_prompt", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        keyterms: ["metoprolol", "Skyrizi"]
      })
    );
    expect(p.get("keyterms_prompt")).toBe('["metoprolol","Skyrizi"]');
  });

  it("forwards prompt", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        prompt: "Transcribe Spanish."
      })
    );
    expect(p.get("prompt")).toBe("Transcribe Spanish.");
  });

  it("forwards turn-detection and barge-in knobs", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        minTurnSilence: 200,
        maxTurnSilence: 2000,
        interruptionDelay: 0,
        vadThreshold: 0.3
      })
    );
    expect(p.get("min_turn_silence")).toBe("200");
    expect(p.get("max_turn_silence")).toBe("2000");
    expect(p.get("interruption_delay")).toBe("0");
    expect(p.get("vad_threshold")).toBe("0.3");
  });

  it("forwards continuousPartials and languageDetection as booleans", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        continuousPartials: true,
        languageDetection: true
      })
    );
    expect(p.get("continuous_partials")).toBe("true");
    expect(p.get("language_detection")).toBe("true");
  });
});

describe("_buildConnectionUrl — baseUrl override", () => {
  it("baseUrl replaces the default host", () => {
    const url = new URL(
      _buildConnectionUrl({
        apiKey: "k",
        baseUrl: "wss://streaming.eu.assemblyai.com/v3/ws"
      })
    );
    expect(url.host).toBe("streaming.eu.assemblyai.com");
    expect(url.pathname).toBe("/v3/ws");
  });

  it("baseUrl keeps the same hardcoded query params", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        baseUrl: "wss://gateway.example.com/v1/acct/gw/assemblyai/v3/ws"
      })
    );
    expect(p.get("speech_model")).toBe("u3-rt-pro");
    expect(p.get("sample_rate")).toBe("16000");
    expect(p.get("encoding")).toBe("pcm_s16le");
  });
});

// Type-only check so AssemblyAISTTOptions is used in this file.
const _typeCheck: AssemblyAISTTOptions = { apiKey: "x" };
void _typeCheck;
void flush;
void setupMockFetch;

describe("AssemblyAISTT class shape", () => {
  it("createSession returns an object with feed() and close()", () => {
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    expect(typeof session.feed).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});

describe("AssemblyAISession — connect", () => {
  it("calls fetch with the built URL and Authorization header, then accepts the WebSocket", async () => {
    const { ws, calls } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "MY_KEY" });

    provider.createSession();
    await flush();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(_buildConnectionUrl({ apiKey: "MY_KEY" }));
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Upgrade).toBe("websocket");
    expect(headers?.Authorization).toBe("MY_KEY");
    // Raw key — no Bearer or Token prefix.
    expect(headers?.Authorization).not.toMatch(/^Bearer /);
    expect(headers?.Authorization).not.toMatch(/^Token /);

    expect(ws.accept).toHaveBeenCalledTimes(1);
  });
});
